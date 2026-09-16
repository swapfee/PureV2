import { describe, expect, test } from "bun:test";
import { BitwisePermissionFlags } from "discordeno";

import { createCooldownStore } from "../src/handlers/cooldowns.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import {
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { createOwnershipService } from "../src/lib/j2c/ownership.ts";
import { createVcCommandService, VC_COOLDOWNS_MS } from "../src/lib/j2c/vc-command-service.ts";
import { createVcMetrics } from "../src/lib/j2c/vc-metrics.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { InteractionCreatePayload } from "../src/lib/runtime-types.ts";

const guildId = "123456789012345678";
const ownerId = "999999999999999999";
const targetId = "888888888888888888";
const botUserId = "777777777777777777";
const channelId = "444444444444444444";
const lobbyId = "222222222222222222";

function interaction(
  partial: {
    readonly id?: string;
    readonly token?: string;
    readonly userId?: string;
    readonly guildId?: string | null;
    readonly channelId?: string;
    readonly options?: InteractionCreatePayload["options"];
  },
): InteractionCreatePayload {
  return {
    id: partial.id ?? "100000000000000001",
    token: partial.token ?? "interaction-token",
    type: 2,
    applicationId: "555555555555555555",
    userId: partial.userId ?? ownerId,
    commandName: "vc",
    ...(partial.guildId ? { guildId: partial.guildId } : {}),
    ...(partial.channelId ? { channelId: partial.channelId } : {}),
    ...(partial.options ? { options: partial.options } : {}),
  };
}

async function setup() {
  const lines: string[] = [];
  const logger = createLogger({
    service: "purev2",
    role: "test",
    level: "info",
    sensitiveValues: ["secret-token"],
    write: (line) => lines.push(line),
  });
  const channels = createMemoryTemporaryChannelRepository();
  await channels.create({
    guildId,
    channelId,
    ownerId,
    lobbyChannelId: lobbyId,
    status: "active",
    reservationId: "res-1",
    creationRequestId: "req-1",
    occupantIds: [ownerId],
  });
  const { discord, controls } = createFakeDiscord();
  controls.channels.set(channelId, {
    id: channelId,
    name: "owner-room",
    guildId,
    permissionOverwrites: [
      { id: guildId, type: 0, allow: "0", deny: "0" },
      {
        id: targetId,
        type: 1,
        allow: BitwisePermissionFlags.STREAM.toString(),
        deny: "0",
      },
    ],
  });
  controls.voiceByUser.set(`${guildId}:${ownerId}`, channelId);
  controls.users.set(targetId, { id: targetId, bot: false });
  controls.users.set(botUserId, { id: botUserId, bot: true });
  controls.users.set(ownerId, { id: ownerId, bot: false });

  const metrics = createVcMetrics();
  const cooldowns = createCooldownStore();
  const completed = new Set<string>();
  const vc = createVcCommandService({
    ownership: createOwnershipService(channels),
    channels,
    discord,
    logger,
    metrics,
    cooldowns,
    completedInteractions: completed,
  });

  return { vc, controls, metrics, cooldowns, completed, lines, channels };
}

describe("/vc command family", () => {
  test("rejects DMs", async () => {
    const { vc, controls, metrics } = await setup();
    await vc.execute(
      interaction({
        options: [{ name: "lock", type: 1 }],
      }),
    );
    expect(controls.deferredInteractions).toHaveLength(1);
    expect(controls.editedInteractions[0]?.content).toMatch(/server/i);
    expect(metrics.snapshot().authorizationFailures).toBe(1);
  });

  test("rejects when caller has no active channel", async () => {
    const { vc, controls, metrics } = await setup();
    await vc.execute(
      interaction({
        guildId,
        userId: targetId,
        options: [{ name: "lock", type: 1 }],
      }),
    );
    expect(controls.editedInteractions[0]?.content).toMatch(/do not own/i);
    expect(metrics.snapshot().authorizationFailures).toBe(1);
  });

  test("rejects when owner is not connected to owned channel", async () => {
    const { vc, controls, metrics } = await setup();
    controls.voiceByUser.set(`${guildId}:${ownerId}`, lobbyId);
    await vc.execute(
      interaction({
        guildId,
        options: [{ name: "lock", type: 1 }],
      }),
    );
    expect(controls.editedInteractions[0]?.content).toMatch(/connected/i);
    expect(metrics.snapshot().authorizationFailures).toBe(1);
  });

  test("rejects when Discord channel is missing", async () => {
    const { vc, controls, metrics } = await setup();
    controls.missingChannels.add(channelId);
    await vc.execute(
      interaction({
        guildId,
        options: [{ name: "lock", type: 1 }],
      }),
    );
    expect(controls.editedInteractions[0]?.content).toMatch(/no longer exists/i);
    expect(metrics.snapshot().authorizationFailures).toBe(1);
  });

  test("owner invite preserves unrelated overwrite bits and rejects self/bots", async () => {
    const { vc, controls, metrics } = await setup();

    await vc.execute(
      interaction({
        id: "invite-self",
        guildId,
        options: [
          {
            name: "invite",
            type: 1,
            options: [{ name: "user", type: 6, value: ownerId }],
          },
        ],
      }),
    );
    expect(controls.editedInteractions.at(-1)?.content).toMatch(/yourself/i);

    await vc.execute(
      interaction({
        id: "invite-bot",
        guildId,
        options: [
          {
            name: "invite",
            type: 1,
            options: [{ name: "user", type: 6, value: botUserId }],
          },
        ],
      }),
    );
    expect(controls.editedInteractions.at(-1)?.content).toMatch(/bots/i);

    await vc.execute(
      interaction({
        id: "invite-ok",
        guildId,
        options: [
          {
            name: "invite",
            type: 1,
            options: [{ name: "user", type: 6, value: targetId }],
          },
        ],
      }),
    );
    const call = controls.overwriteCalls.find((entry) => entry.requestId === "vc:invite:invite-ok");
    expect(call).toBeDefined();
    const allow = BigInt(call!.allow);
    expect((allow & BitwisePermissionFlags.VIEW_CHANNEL) !== 0n).toBe(true);
    expect((allow & BitwisePermissionFlags.CONNECT) !== 0n).toBe(true);
    expect((allow & BitwisePermissionFlags.STREAM) !== 0n).toBe(true);
    expect(metrics.snapshot().successes.invite).toBe(1);
  });

  test("rename validates and applies cooldown with stable request ids", async () => {
    const { vc, controls, metrics, cooldowns } = await setup();
    await vc.execute(
      interaction({
        id: "rename-1",
        guildId,
        options: [
          {
            name: "rename",
            type: 1,
            options: [{ name: "name", type: 3, value: "   " }],
          },
        ],
      }),
    );
    expect(metrics.snapshot().validationFailures).toBe(1);

    await vc.execute(
      interaction({
        id: "rename-2",
        guildId,
        options: [
          {
            name: "rename",
            type: 1,
            options: [{ name: "name", type: 3, value: "New Room" }],
          },
        ],
      }),
    );
    expect(controls.editCalls[0]?.requestId).toBe("vc:rename:rename-2");
    expect(controls.channels.get(channelId)?.name).toBe("New Room");

    await vc.execute(
      interaction({
        id: "rename-3",
        guildId,
        options: [
          {
            name: "rename",
            type: 1,
            options: [{ name: "name", type: 3, value: "Another" }],
          },
        ],
      }),
    );
    expect(controls.editedInteractions.at(-1)?.content).toMatch(/wait/i);
    expect(metrics.snapshot().cooldownRejections).toBe(1);
    expect(VC_COOLDOWNS_MS.rename).toBeGreaterThan(0);
    expect(cooldowns.size()).toBeGreaterThan(0);
  });

  test("limit accepts zero and rejects out of range", async () => {
    const { vc, controls, metrics } = await setup();
    await vc.execute(
      interaction({
        id: "limit-bad",
        guildId,
        options: [
          {
            name: "limit",
            type: 1,
            options: [{ name: "amount", type: 4, value: -1 }],
          },
        ],
      }),
    );
    expect(metrics.snapshot().validationFailures).toBe(1);

    await vc.execute(
      interaction({
        id: "limit-zero",
        guildId,
        options: [
          {
            name: "limit",
            type: 1,
            options: [{ name: "amount", type: 4, value: 0 }],
          },
        ],
      }),
    );
    expect(controls.editCalls.at(-1)?.userLimit).toBe(0);
    expect(controls.editedInteractions.at(-1)?.content).toMatch(/removed/i);
  });

  test("lock and unlock are idempotent and preserve invitations", async () => {
    const { vc, controls } = await setup();
    await vc.execute(interaction({ id: "lock-1", guildId, options: [{ name: "lock", type: 1 }] }));
    await vc.execute(interaction({ id: "lock-2", guildId, options: [{ name: "lock", type: 1 }] }));
    const locked = controls.channels.get(channelId)!;
    const everyone = locked.permissionOverwrites.find((overwrite) => overwrite.id === guildId)!;
    expect((BigInt(everyone.deny) & BitwisePermissionFlags.CONNECT) !== 0n).toBe(true);
    const invite = locked.permissionOverwrites.find((overwrite) => overwrite.id === targetId)!;
    expect((BigInt(invite.allow) & BitwisePermissionFlags.STREAM) !== 0n).toBe(true);

    await vc.execute(interaction({ id: "unlock-1", guildId, options: [{ name: "unlock", type: 1 }] }));
    await vc.execute(interaction({ id: "unlock-2", guildId, options: [{ name: "unlock", type: 1 }] }));
    const unlocked = controls.channels.get(channelId)!;
    const everyoneAfter = unlocked.permissionOverwrites.find((overwrite) => overwrite.id === guildId)!;
    expect((BigInt(everyoneAfter.deny) & BitwisePermissionFlags.CONNECT) === 0n).toBe(true);
    expect(unlocked.permissionOverwrites.find((overwrite) => overwrite.id === targetId)).toBeDefined();
  });

  test("replays do not mutate twice and defer before work", async () => {
    const { vc, controls, metrics, completed } = await setup();
    const payload = interaction({
      id: "replay-1",
      guildId,
      options: [{ name: "lock", type: 1 }],
    });
    await vc.execute(payload);
    const overwriteCount = controls.overwriteCalls.length;
    await vc.execute(payload);
    expect(controls.overwriteCalls.length).toBe(overwriteCount);
    expect(metrics.snapshot().replayDedups).toBe(1);
    expect(completed.has("replay-1")).toBe(true);
    expect(controls.deferredInteractions[0]).toBe("replay-1");
  });

  test("REST failures return safe ephemeral messages", async () => {
    const { vc, controls, metrics } = await setup();
    controls.failNextOverwrite = { kind: "transient", message: "rate" };
    await vc.execute(interaction({ id: "lock-fail", guildId, options: [{ name: "lock", type: 1 }] }));
    expect(controls.editedInteractions.at(-1)?.content).toMatch(/Could not lock/i);
    expect(metrics.snapshot().restFailures).toBe(1);
  });

  test("cooldown cleanup stays bounded", () => {
    const store = createCooldownStore({ maxEntries: 3 });
    for (let i = 0; i < 10; i += 1) {
      store.touch(`k${i}`, 60_000, 1_000 + i);
    }
    expect(store.size()).toBeLessThanOrEqual(3);
    expect(store.cleanup(1_000_000)).toBeGreaterThan(0);
    expect(store.size()).toBe(0);
  });

  test("logs omit secrets and use safe identifiers", async () => {
    const { vc, lines } = await setup();
    await vc.execute(interaction({ id: "lock-log", guildId, options: [{ name: "lock", type: 1 }] }));
    expect(lines.some((line) => line.includes("secret-token"))).toBe(false);
    expect(lines.some((line) => line.includes(channelId))).toBe(true);
    expect(lines.some((line) => line.includes("vc:lock:lock-log"))).toBe(true);
  });
});
