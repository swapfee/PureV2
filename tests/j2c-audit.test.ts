import { describe, expect, test } from "bun:test";

import { createJ2cMetrics } from "../src/lib/j2c/metrics.ts";
import {
  createMemoryCreationReservationRepository,
  createMemoryGuildConfigRepository,
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { createReservationService } from "../src/lib/j2c/reservation-service.ts";
import { createVoiceOccupancyTracker } from "../src/lib/j2c/voice-occupancy.ts";
import { createDeletionLifecycle, EMPTY_CHANNEL_DELAY_MS } from "../src/lib/j2c/deletion-lifecycle.ts";
import { createManualTimerScheduler } from "../src/lib/j2c/time.ts";
import { createJ2cRuntime } from "../src/lib/j2c/runtime.ts";
import { verifyRequiredIndexSpecs, hasRequiredJ2cIndexes } from "../src/lib/j2c/index-requirements.ts";
import {
  createWorkerBotAdapter,
  isSyntheticWorkerToken,
  SYNTHETIC_WORKER_TOKEN_MARKER,
} from "../src/lib/worker/synthetic-token.ts";
import { createLogger } from "../src/lib/logger.ts";

const guildId = "123456789012345678";
const ownerId = "999999999999999999";
const otherId = "888888888888888888";
const lobbyId = "222222222222222222";
const channelId = "444444444444444444";

function testLogger(lines?: string[]) {
  return createLogger({
    service: "purev2",
    role: "test",
    level: "info",
    sensitiveValues: ["real-discord-token", "mongodb://prod"],
    write: (line) => lines?.push(line),
  });
}

describe("structural MongoDB index verification", () => {
  const valid = [
    {
      modelName: "GuildConfig",
      indexes: [{ name: "guild_configs_guildId_unique", key: { guildId: 1 }, unique: true }],
    },
    {
      modelName: "TemporaryChannel",
      indexes: [
        { name: "temporary_channels_channelId_unique", key: { channelId: 1 }, unique: true },
        {
          name: "temporary_channels_one_active_owner",
          key: { guildId: 1, ownerId: 1 },
          unique: true,
          partialFilterExpression: { status: { $in: ["creating", "active", "deleting"] } },
        },
        { name: "temporary_channels_status_updatedAt", key: { status: 1, updatedAt: 1 } },
        { name: "temporary_channels_guild_status", key: { guildId: 1, status: 1 } },
      ],
    },
    {
      modelName: "CreationReservation",
      indexes: [
        {
          name: "creation_reservations_one_active",
          key: { guildId: 1, memberId: 1 },
          unique: true,
          partialFilterExpression: { status: "reserved" },
        },
        { name: "creation_reservations_expiresAt", key: { expiresAt: 1 } },
        { name: "creation_reservations_eventId", key: { eventId: 1 } },
      ],
    },
    {
      modelName: "OwnerBlockList",
      indexes: [
        {
          name: "owner_block_lists_guild_owner_unique",
          key: { guildId: 1, ownerId: 1 },
          unique: true,
        },
      ],
    },
  ];

  test("accepts a valid index set", () => {
    expect(verifyRequiredIndexSpecs(valid).ok).toBe(true);
  });

  test("rejects correct name with incorrect keys", () => {
    const broken = structuredClone(valid);
    const owner = broken[1]!.indexes[1]!;
    owner.key = { ownerId: 1, guildId: 1 };
    const result = verifyRequiredIndexSpecs(broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.reason === "incorrect_keys")).toBe(true);
  });

  test("rejects correct keys with missing unique option", () => {
    const broken = structuredClone(valid);
    delete broken[0]!.indexes[0]!.unique;
    const result = verifyRequiredIndexSpecs(broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.reason === "incorrect_unique_option")).toBe(true);
  });

  test("rejects incorrect partial filter", () => {
    const broken = structuredClone(valid);
    const indexes = broken[1]!.indexes;
    const ownerIndex = indexes.find((index) => index.name === "temporary_channels_one_active_owner");
    expect(ownerIndex).toBeDefined();
    if (!ownerIndex || !("partialFilterExpression" in ownerIndex)) {
      throw new Error("expected owner uniqueness index");
    }
    Reflect.set(ownerIndex, "partialFilterExpression", { status: { $in: ["creating", "active"] } });
    const result = verifyRequiredIndexSpecs(broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.reason === "incorrect_partial_filter")).toBe(true);
  });

  test("rejects missing required index", () => {
    const broken = structuredClone(valid);
    broken[1]!.indexes = broken[1]!.indexes.slice(0, 1);
    const result = verifyRequiredIndexSpecs(broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.reason === "missing_required_index")).toBe(true);
  });

  test("name-only helper still detects missing names", () => {
    expect(
      hasRequiredJ2cIndexes([{ modelName: "GuildConfig", indexes: ["_id_"] }]).ok,
    ).toBe(false);
  });
});

describe("owner uniqueness while deleting", () => {
  test("blocks creation while previous channel is deleting", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    await channels.create({
      guildId,
      channelId,
      ownerId,
      lobbyChannelId: lobbyId,
      status: "deleting",
      reservationId: "res-old",
      creationRequestId: "req-old",
    });

    const service = createReservationService({ reservations, channels, metrics });
    const decision = await service.beginCreation({
      reservationId: "res-new",
      guildId,
      memberId: ownerId,
      eventId: "event-new",
      creationRequestId: "req-new",
    });
    expect(decision.outcome).toBe("owner_has_channel");

    try {
      await channels.create({
        guildId,
        channelId: "555555555555555555",
        ownerId,
        lobbyChannelId: lobbyId,
        status: "creating",
        reservationId: "res-race",
        creationRequestId: "req-race",
      });
      throw new Error("expected uniqueness failure");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").toMatch(/already has an active channel/);
    }
  });
});

describe("voice occupancy tracker", () => {
  test("tracks two users and ignores stale leave after newer join", () => {
    const occupancy = createVoiceOccupancyTracker();
    occupancy.seedGuildVoiceStates(guildId, []);
    occupancy.markReady();
    occupancy.apply({ guildId, userId: ownerId, channelId, sequence: 1 });
    occupancy.apply({ guildId, userId: otherId, channelId, sequence: 2 });
    expect(occupancy.getOccupants(guildId, channelId)).toEqual({
      kind: "known",
      userIds: [ownerId, otherId],
    });

    occupancy.apply({ guildId, userId: otherId, channelId: null, sequence: 3 });
    expect(occupancy.getOccupants(guildId, channelId)).toEqual({
      kind: "known",
      userIds: [ownerId],
    });

    // Stale leave for owner after a newer join
    occupancy.apply({ guildId, userId: ownerId, channelId, sequence: 5 });
    occupancy.apply({ guildId, userId: ownerId, channelId: null, sequence: 4 });
    expect(occupancy.getOccupants(guildId, channelId)).toEqual({
      kind: "known",
      userIds: [ownerId],
    });
  });

  test("unknown occupancy refuses deletion and marks for reconciliation", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    const timers = createManualTimerScheduler();
    const { discord, controls } = createFakeDiscord();
    controls.channels.set(channelId, { id: channelId, name: "temp", guildId, permissionOverwrites: [] });
    await channels.create({
      guildId,
      channelId,
      ownerId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-1",
      creationRequestId: "req-1",
      occupantIds: [],
    });

    const occupancy = createVoiceOccupancyTracker(); // not ready
    const deletion = createDeletionLifecycle({
      channels,
      discord,
      metrics,
      logger: testLogger(),
      timers,
      occupancy,
      clock: { now: () => new Date(timers.nowMs()) },
    });

    await deletion.onOccupantsChanged(channelId, []);
    await timers.advance(EMPTY_CHANNEL_DELAY_MS);
    expect(controls.deleteCalls).toHaveLength(0);
    expect((await channels.findByChannelId(channelId))?.status).toBe("stale");
  });

  test("unseeded guild stays unknown even when tracker is ready", () => {
    const occupancy = createVoiceOccupancyTracker();
    occupancy.markReady();
    expect(occupancy.getOccupants(guildId, channelId).kind).toBe("unknown");
  });

  test("one leave while one remains does not delete", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    const timers = createManualTimerScheduler();
    const { discord, controls } = createFakeDiscord();
    controls.channels.set(channelId, { id: channelId, name: "temp", guildId, permissionOverwrites: [] });
    await channels.create({
      guildId,
      channelId,
      ownerId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-1",
      creationRequestId: "req-1",
      occupantIds: [ownerId, otherId],
    });

    const occupancy = createVoiceOccupancyTracker();
    occupancy.seedGuildVoiceStates(guildId, [
      { userId: ownerId, channelId },
      { userId: otherId, channelId },
    ]);
    occupancy.markReady();

    const deletion = createDeletionLifecycle({
      channels,
      discord,
      metrics,
      logger: testLogger(),
      timers,
      occupancy,
      clock: { now: () => new Date(timers.nowMs()) },
    });

    occupancy.apply({ guildId, userId: ownerId, channelId: null, sequence: 3 });
    await deletion.onOccupantsChanged(channelId, [otherId]);
    await timers.advance(EMPTY_CHANNEL_DELAY_MS);
    expect(controls.deleteCalls).toHaveLength(0);

    // Even if Mongo says empty, occupancy cache blocks delete
    await deletion.onOccupantsChanged(channelId, []);
    await timers.advance(EMPTY_CHANNEL_DELAY_MS);
    expect(controls.deleteCalls).toHaveLength(0);
  });

  test("worker restart leaves occupancy not ready until warm-up", async () => {
    const occupancy = createVoiceOccupancyTracker();
    expect(occupancy.isReady()).toBe(false);
    expect(occupancy.getOccupants(guildId, channelId).kind).toBe("unknown");
    occupancy.seedGuildVoiceStates(guildId, [{ userId: ownerId, channelId }]);
    occupancy.markReady();
    expect(occupancy.getOccupants(guildId, channelId)).toEqual({
      kind: "known",
      userIds: [ownerId],
    });
  });

  test("duplicate voice events are ignored", () => {
    const occupancy = createVoiceOccupancyTracker();
    occupancy.seedGuildVoiceStates(guildId, [{ userId: ownerId, channelId }]);
    occupancy.markReady();
    occupancy.apply({ guildId, userId: ownerId, channelId, sequence: 1 });
    occupancy.apply({ guildId, userId: ownerId, channelId, sequence: 1 });
    occupancy.apply({ guildId, userId: ownerId, channelId: null, sequence: 1 });
    expect(occupancy.getOccupants(guildId, channelId)).toEqual({
      kind: "known",
      userIds: [ownerId],
    });
  });

  test("empty seed replaces prior high-sequence occupants (leave while offline)", () => {
    const occupancy = createVoiceOccupancyTracker();
    // First contact marks the guild seeded while a high-seq VSU still shows presence.
    occupancy.seedGuildVoiceStates(guildId, [{ userId: ownerId, channelId }]);
    occupancy.markReady();
    occupancy.apply({ guildId, userId: ownerId, channelId, sequence: 50 });
    expect(occupancy.getOccupants(guildId, channelId)).toEqual({
      kind: "known",
      userIds: [ownerId],
    });

    // Authoritative empty GUILD_CREATE snapshot must clear them despite seq 50.
    occupancy.seedGuildVoiceStates(guildId, []);
    expect(occupancy.getOccupants(guildId, channelId)).toEqual({
      kind: "known",
      userIds: [],
    });
  });

  test("post-seed leave with low gateway sequence still clears occupancy", () => {
    const occupancy = createVoiceOccupancyTracker();
    occupancy.seedGuildVoiceStates(guildId, [
      { userId: ownerId, channelId },
      { userId: otherId, channelId },
    ]);
    occupancy.markReady();
    // Coordinator voiceSequence after GUILD_CREATE is often smaller than a
    // naive seed counter would have been; sequence 1 must still win over seed.
    occupancy.apply({ guildId, userId: ownerId, channelId: null, sequence: 1 });
    expect(occupancy.getOccupants(guildId, channelId)).toEqual({
      kind: "known",
      userIds: [otherId],
    });
  });
});

describe("j2c readiness after occupancy warm-up", () => {
  test("j2cReady requires occupancy reconciliation after gateway warm-up", async () => {
    const runtime = createJ2cRuntime({
      configs: createMemoryGuildConfigRepository(),
      channels: createMemoryTemporaryChannelRepository(),
      reservations: createMemoryCreationReservationRepository(),
      discord: createFakeDiscord().discord,
      logger: testLogger(),
    });

    runtime.markModelsInitialized();
    runtime.markIndexesVerified(true);
    await runtime.reconcileDatabaseRest();
    expect(runtime.readiness().ready).toBe(false);

    runtime.markOccupancyReady(true);
    expect(runtime.readiness().ready).toBe(false);

    await runtime.reconcileOccupancy();
    expect(runtime.readiness().ready).toBe(true);
  });
});

describe("synthetic worker token adapter", () => {
  test("is marked synthetic, distinct from coordinator tokens, and redacted from logs", () => {
    const lines: string[] = [];
    const adapter = createWorkerBotAdapter({ applicationId: "123456789012345678" });
    expect(isSyntheticWorkerToken(adapter.token)).toBe(true);
    expect(adapter.token.includes(SYNTHETIC_WORKER_TOKEN_MARKER)).toBe(true);
    expect(adapter.token).not.toBe("real-discord-token");
    expect(adapter.purpose).toBe("local_discordeno_construction_only");

    const logger = testLogger(lines);
    logger.info("worker boot", {
      token: adapter.token,
      discordToken: "real-discord-token",
    });
    // Synthetic token itself is not a secret value, but must not look like the real token.
    expect(lines.some((line) => line.includes("real-discord-token"))).toBe(false);
    expect(adapter.neverSendToDiscord).toBe(true);
    expect(adapter.neverForwardOverIpc).toBe(true);
  });
});
