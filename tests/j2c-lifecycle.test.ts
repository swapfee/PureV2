import { describe, expect, test } from "bun:test";

import { createCreationLifecycle } from "../src/lib/j2c/creation-lifecycle.ts";
import { createDeletionLifecycle, EMPTY_CHANNEL_DELAY_MS } from "../src/lib/j2c/deletion-lifecycle.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { createJ2cMetrics } from "../src/lib/j2c/metrics.ts";
import {
  createMemoryCreationReservationRepository,
  createMemoryGuildConfigRepository,
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { createReconciler } from "../src/lib/j2c/reconciliation.ts";
import { createReservationService } from "../src/lib/j2c/reservation-service.ts";
import { creationRequestId } from "../src/lib/j2c/request-ids.ts";
import { createManualTimerScheduler } from "../src/lib/j2c/time.ts";
import { createVoiceOccupancyTracker } from "../src/lib/j2c/voice-occupancy.ts";
import { createLogger } from "../src/lib/logger.ts";

function readyOccupancy() {
  const occupancy = createVoiceOccupancyTracker();
  occupancy.markReady();
  return occupancy;
}

const guildId = "123456789012345678";
const memberId = "999999999999999999";
const lobbyId = "222222222222222222";
const categoryId = "333333333333333333";

function testLogger() {
  return createLogger({ service: "purev2", role: "test", level: "error", write: () => undefined });
}

async function seedConfig(
  configs: ReturnType<typeof createMemoryGuildConfigRepository>,
): Promise<void> {
  await configs.upsert({
    guildId,
    enabled: true,
    lobbyChannelId: lobbyId,
    categoryId,
    channelNameTemplate: "{username}'s channel",
  });
}

function buildCreation(options: {
  configs: ReturnType<typeof createMemoryGuildConfigRepository>;
  channels: ReturnType<typeof createMemoryTemporaryChannelRepository>;
  reservations: ReturnType<typeof createMemoryCreationReservationRepository>;
  discord: ReturnType<typeof createFakeDiscord>["discord"];
  metrics: ReturnType<typeof createJ2cMetrics>;
  now?: () => Date;
}) {
  const reservationService = createReservationService({
    reservations: options.reservations,
    channels: options.channels,
    metrics: options.metrics,
    ...(options.now ? { now: options.now } : {}),
  });
  return createCreationLifecycle({
    configs: options.configs,
    channels: options.channels,
    reservations: options.reservations,
    reservationService,
    discord: options.discord,
    metrics: options.metrics,
    logger: testLogger(),
    ...(options.now ? { clock: { now: options.now } } : {}),
  });
}

describe("creation lifecycle", () => {
  test("creates a temporary channel with stable REST request ids", async () => {
    const configs = createMemoryGuildConfigRepository();
    await seedConfig(configs);
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord();
    controls.voiceByUser.set(`${guildId}:${memberId}`, lobbyId);

    const creation = buildCreation({ configs, channels, reservations, discord, metrics });
    const eventId = "event-create-1";
    const outcome = await creation.handleVoiceJoin({
      eventId,
      guildId,
      memberId,
      joinedChannelId: lobbyId,
      username: "Ada",
    });

    expect(outcome.kind).toBe("created");
    expect(controls.createCalls[0]?.requestId).toBe(creationRequestId(eventId));
    expect(controls.moveCalls[0]?.requestId).toBe(`j2c-move:${eventId}`);
    expect(metrics.snapshot().creationSuccesses).toBe(1);
    expect(metrics.snapshot().activeTemporaryChannels).toBe(1);
  });

  test("cancels when the user leaves the lobby before channel creation", async () => {
    const configs = createMemoryGuildConfigRepository();
    await seedConfig(configs);
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord();
    controls.voiceByUser.set(`${guildId}:${memberId}`, null);

    const creation = buildCreation({ configs, channels, reservations, discord, metrics });
    const outcome = await creation.handleVoiceJoin({
      eventId: "event-left",
      guildId,
      memberId,
      joinedChannelId: lobbyId,
    });

    expect(outcome.kind).toBe("cancelled");
    expect(controls.createCalls).toHaveLength(0);
    expect(metrics.snapshot().creationFailures).toBe(1);
  });

  test("handles channel creation failure without persisting a channel", async () => {
    const configs = createMemoryGuildConfigRepository();
    await seedConfig(configs);
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord({
      failNextCreate: { kind: "forbidden" },
    });
    controls.voiceByUser.set(`${guildId}:${memberId}`, lobbyId);

    const creation = buildCreation({ configs, channels, reservations, discord, metrics });
    const outcome = await creation.handleVoiceJoin({
      eventId: "event-create-fail",
      guildId,
      memberId,
      joinedChannelId: lobbyId,
    });

    expect(outcome.kind).toBe("failed");
    expect(await channels.countByStatus("active")).toBe(0);
    expect(metrics.snapshot().creationFailures).toBe(1);
  });

  test("compensates when member move fails after creation", async () => {
    const configs = createMemoryGuildConfigRepository();
    await seedConfig(configs);
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord({
      failNextMove: { kind: "transient", message: "move_failed" },
    });
    controls.voiceByUser.set(`${guildId}:${memberId}`, lobbyId);

    const creation = buildCreation({ configs, channels, reservations, discord, metrics });
    const outcome = await creation.handleVoiceJoin({
      eventId: "event-move-fail",
      guildId,
      memberId,
      joinedChannelId: lobbyId,
    });

    expect(outcome.kind).toBe("failed");
    expect(controls.deleteCalls.length).toBe(1);
    expect(controls.deleteCalls[0]?.requestId.startsWith("j2c-compensate:")).toBe(true);
    expect(metrics.snapshot().compensatingDeletions).toBe(1);
    expect(await channels.countByStatus("active")).toBe(0);
  });

  test("preserves orphan when compensating deletion fails", async () => {
    const configs = createMemoryGuildConfigRepository();
    await seedConfig(configs);
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord({
      failNextMove: { kind: "forbidden" },
      failCompensationDeletes: true,
    });
    controls.voiceByUser.set(`${guildId}:${memberId}`, lobbyId);

    const creation = buildCreation({ configs, channels, reservations, discord, metrics });
    const outcome = await creation.handleVoiceJoin({
      eventId: "event-orphan",
      guildId,
      memberId,
      joinedChannelId: lobbyId,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.orphanChannelId).toBeDefined();
      const stale = await channels.findByChannelId(outcome.orphanChannelId!);
      expect(stale?.status).toBe("stale");
    }
    expect(metrics.snapshot().poisonedLifecycleOperations).toBe(1);
  });

  test("prevents concurrent duplicate creations for one owner", async () => {
    const configs = createMemoryGuildConfigRepository();
    await seedConfig(configs);
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord();
    controls.voiceByUser.set(`${guildId}:${memberId}`, lobbyId);
    const creation = buildCreation({ configs, channels, reservations, discord, metrics });

    const [a, b] = await Promise.all([
      creation.handleVoiceJoin({
        eventId: "event-dup-a",
        guildId,
        memberId,
        joinedChannelId: lobbyId,
      }),
      creation.handleVoiceJoin({
        eventId: "event-dup-b",
        guildId,
        memberId,
        joinedChannelId: lobbyId,
      }),
    ]);

    const created = [a, b].filter((result) => result.kind === "created");
    const prevented = [a, b].filter(
      (result) => result.kind === "duplicate_prevented" || result.kind === "failed",
    );
    expect(created.length + prevented.length).toBe(2);
    expect(created.length).toBeLessThanOrEqual(1);
    expect(controls.createCalls.length).toBeLessThanOrEqual(1);
  });

  test("replays return existing reservation without a second Discord create", async () => {
    const configs = createMemoryGuildConfigRepository();
    await seedConfig(configs);
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord();
    controls.voiceByUser.set(`${guildId}:${memberId}`, lobbyId);
    const creation = buildCreation({ configs, channels, reservations, discord, metrics });

    const first = await creation.handleVoiceJoin({
      eventId: "event-replay",
      guildId,
      memberId,
      joinedChannelId: lobbyId,
    });
    expect(first.kind).toBe("created");

    const second = await creation.handleVoiceJoin({
      eventId: "event-replay",
      guildId,
      memberId,
      joinedChannelId: lobbyId,
    });
    expect(second.kind).toBe("duplicate_prevented");
    expect(controls.createCalls).toHaveLength(1);
  });
});

describe("empty-channel deletion lifecycle", () => {
  test("waits three seconds, rechecks membership, and deletes", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    const timers = createManualTimerScheduler();
    const { discord, controls } = createFakeDiscord();
    const channelId = "444444444444444444";
    controls.channels.set(channelId, { id: channelId, name: "temp", guildId, permissionOverwrites: [] });

    await channels.create({
      guildId,
      channelId,
      ownerId: memberId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-del",
      creationRequestId: "req-del",
      occupantIds: [memberId],
    });

    const deletion = createDeletionLifecycle({
      channels,
      discord,
      metrics,
      logger: testLogger(),
      timers,
      occupancy: readyOccupancy(),
      clock: { now: () => new Date(timers.nowMs()) },
    });

    await deletion.onOccupantsChanged(channelId, []);
    expect(timers.pendingCount()).toBe(1);
    expect(controls.deleteCalls).toHaveLength(0);

    await timers.advance(EMPTY_CHANNEL_DELAY_MS - 1);
    expect(controls.deleteCalls).toHaveLength(0);

    await timers.advance(1);
    expect(controls.deleteCalls).toHaveLength(1);
    expect(await channels.findByChannelId(channelId)).toBeUndefined();
    expect(metrics.snapshot().deletionSuccesses).toBe(1);
  });

  test("cancels deletion when a user rejoins during the delay", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    const timers = createManualTimerScheduler();
    const { discord, controls } = createFakeDiscord();
    const channelId = "555555555555555555";
    controls.channels.set(channelId, { id: channelId, name: "temp", guildId, permissionOverwrites: [] });

    await channels.create({
      guildId,
      channelId,
      ownerId: memberId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-rejoin",
      creationRequestId: "req-rejoin",
      occupantIds: [memberId],
    });

    const deletion = createDeletionLifecycle({
      channels,
      discord,
      metrics,
      logger: testLogger(),
      timers,
      occupancy: readyOccupancy(),
      clock: { now: () => new Date(timers.nowMs()) },
    });

    await deletion.onOccupantsChanged(channelId, []);
    await deletion.onOccupantsChanged(channelId, [memberId]);
    await timers.advance(EMPTY_CHANNEL_DELAY_MS);
    expect(controls.deleteCalls).toHaveLength(0);
    expect((await channels.findByChannelId(channelId))?.status).toBe("active");
  });

  test("treats already-missing Discord channels as successful cleanup", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    const timers = createManualTimerScheduler();
    const { discord } = createFakeDiscord({
      missingChannels: new Set(["666666666666666666"]),
    });
    const channelId = "666666666666666666";

    await channels.create({
      guildId,
      channelId,
      ownerId: memberId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-missing",
      creationRequestId: "req-missing",
      occupantIds: [],
    });

    const deletion = createDeletionLifecycle({
      channels,
      discord,
      metrics,
      logger: testLogger(),
      timers,
      occupancy: readyOccupancy(),
      clock: { now: () => new Date(1_000) },
    });

    await deletion.onOccupantsChanged(channelId, []);
    await timers.advance(EMPTY_CHANNEL_DELAY_MS);
    expect(await channels.findByChannelId(channelId)).toBeUndefined();
    expect(metrics.snapshot().deletionSuccesses).toBe(1);
  });

  test("prevents duplicate deletes from concurrent beginDeleting races", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    const timers = createManualTimerScheduler();
    const { discord, controls } = createFakeDiscord();
    const channelId = "777777777777777777";
    controls.channels.set(channelId, { id: channelId, name: "temp", guildId, permissionOverwrites: [] });

    await channels.create({
      guildId,
      channelId,
      ownerId: memberId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-race",
      creationRequestId: "req-race",
      occupantIds: [],
    });

    const deletion = createDeletionLifecycle({
      channels,
      discord,
      metrics,
      logger: testLogger(),
      timers,
      occupancy: readyOccupancy(),
      clock: { now: () => new Date(2_000) },
    });

    await deletion.onOccupantsChanged(channelId, []);
    // Second schedule after first emptied — still one pending timer until flush.
    await deletion.onOccupantsChanged(channelId, []);
    await timers.advance(EMPTY_CHANNEL_DELAY_MS);
    expect(controls.deleteCalls.length).toBe(1);
  });
});

describe("startup reconciliation", () => {
  test("removes missing channels, recovers stuck creating, and bounds concurrency", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord();

    const missingId = "101010101010101010";
    const creatingId = "121212121212121212";
    controls.channels.set(creatingId, { id: creatingId, name: "creating", guildId, permissionOverwrites: [] });

    await channels.create({
      guildId,
      channelId: missingId,
      ownerId: "888888888888888888",
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-missing",
      creationRequestId: "req-missing",
    });
    await channels.create({
      guildId,
      channelId: creatingId,
      ownerId: memberId,
      lobbyChannelId: lobbyId,
      status: "creating",
      reservationId: "res-creating",
      creationRequestId: "req-creating",
    });

    // Make creating record look stuck.
    const stuck = await channels.findByChannelId(creatingId);
    expect(stuck).toBeDefined();

    let inFlight = 0;
    let maxInFlight = 0;
    const instrumentedDiscord = {
      ...discord,
      async getChannel(request: { readonly channelId: string }) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await discord.getChannel(request);
        } finally {
          inFlight -= 1;
        }
      },
    };

    const reconciler = createReconciler({
      channels,
      reservations,
      discord: instrumentedDiscord,
      metrics,
      logger: testLogger(),
      concurrency: 2,
      clock: { now: () => new Date("2099-01-01T00:00:00.000Z") },
      stuckAfterMs: 0,    });

    const result = await reconciler.run();
    expect(await channels.findByChannelId(missingId)).toBeUndefined();
    expect((await channels.findByChannelId(creatingId))?.status).toBe("active");
    expect(result.findings.some((finding) => finding.kind === "missing_discord_channel")).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(metrics.snapshot().reconciliationFindings).toBeGreaterThan(0);
  });

  test("expires reservations during reconciliation", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository(() => new Date(now));
    const metrics = createJ2cMetrics();
    const { discord } = createFakeDiscord();

    await reservations.acquire({
      reservationId: "res-exp",
      guildId,
      memberId,
      eventId: "event-exp",
      creationRequestId: "req-exp",
      expiresAt: new Date(now + 1_000),
    });
    now += 5_000;

    const reconciler = createReconciler({
      channels,
      reservations,
      discord,
      metrics,
      logger: testLogger(),
      clock: { now: () => new Date(now) },
    });
    const result = await reconciler.run();
    expect(result.findings.some((finding) => finding.kind === "expired_reservation")).toBe(true);
  });
});
