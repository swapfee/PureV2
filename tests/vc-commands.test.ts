import { describe, expect, test } from "bun:test";
import { BitwisePermissionFlags } from "discordeno";

import { createCooldownStore } from "../src/handlers/cooldowns.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import {
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
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

function embedText(
  entry: { content?: string; embeds?: readonly { description: string }[] } | undefined,
): string {
  return entry?.embeds?.[0]?.description ?? entry?.content ?? "";
}

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
    userLimit: 0,
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
    expect(embedText(controls.editedInteractions[0])).toMatch(/server/i);
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
    expect(embedText(controls.editedInteractions[0])).toMatch(/managed voice channel/i);
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
    expect(embedText(controls.editedInteractions[0])).toMatch(/managed voice channel/i);
    expect(metrics.snapshot().authorizationFailures).toBe(1);
  });

  test("rejects Join to Create lobby for invite and owner commands", async () => {
    const { vc, controls, metrics } = await setup();
    controls.voiceByUser.set(`${guildId}:${ownerId}`, lobbyId);
    controls.channels.set(lobbyId, {
      id: lobbyId,
      name: "Join to Create",
      guildId,
      permissionOverwrites: [],
    });

    await vc.execute(
      interaction({
        id: "lobby-lock",
        guildId,
        options: [{ name: "lock", type: 1 }],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/managed voice channel/i);

    await vc.execute(
      interaction({
        id: "lobby-invite",
        guildId,
        options: [
          {
            name: "invite",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/managed voice channel/i);
    expect(controls.dmCalls).toHaveLength(0);
    expect(metrics.snapshot().authorizationFailures).toBeGreaterThanOrEqual(2);
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
    expect(embedText(controls.editedInteractions[0])).toMatch(/no longer exists/i);
    expect(metrics.snapshot().authorizationFailures).toBe(1);
  });

  test("owner permit preserves unrelated overwrite bits and rejects self/bots", async () => {
    const { vc, controls, metrics } = await setup();

    await vc.execute(
      interaction({
        id: "permit-self",
        guildId,
        options: [
          {
            name: "permit",
            type: 1,
            options: [{ name: "member", type: 6, value: ownerId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/yourself/i);

    await vc.execute(
      interaction({
        id: "permit-bot",
        guildId,
        options: [
          {
            name: "permit",
            type: 1,
            options: [{ name: "member", type: 6, value: botUserId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/bots/i);

    await vc.execute(
      interaction({
        id: "permit-ok",
        guildId,
        options: [
          {
            name: "permit",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    const call = controls.overwriteCalls.find((entry) => entry.requestId === "vc:permit:permit-ok");
    expect(call).toBeDefined();
    const allow = BigInt(call!.allow);
    expect((allow & BitwisePermissionFlags.VIEW_CHANNEL) !== 0n).toBe(true);
    expect((allow & BitwisePermissionFlags.CONNECT) !== 0n).toBe(true);
    expect((allow & BitwisePermissionFlags.STREAM) !== 0n).toBe(true);
    expect(metrics.snapshot().successes.permit).toBe(1);
  });

  test("invite sends a DM link for connected members", async () => {
    const { vc, controls, metrics, channels } = await setup();
    controls.voiceByUser.set(`${guildId}:${targetId}`, channelId);
    await channels.setOccupants(channelId, [ownerId, targetId], null);

    await vc.execute(
      interaction({
        id: "invite-self",
        guildId,
        userId: targetId,
        options: [
          {
            name: "invite",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/yourself/i);

    await vc.execute(
      interaction({
        id: "invite-ok",
        guildId,
        userId: targetId,
        options: [
          {
            name: "invite",
            type: 1,
            options: [{ name: "member", type: 6, value: ownerId }],
          },
        ],
      }),
    );
    // owner is already connected — refuse
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/already connected/i);

    const outsider = "666666666666666666";
    controls.users.set(outsider, { id: outsider, bot: false });
    await vc.execute(
      interaction({
        id: "invite-dm",
        guildId,
        userId: targetId,
        options: [
          {
            name: "invite",
            type: 1,
            options: [{ name: "member", type: 6, value: outsider }],
          },
        ],
      }),
    );
    expect(controls.dmCalls.at(-1)?.userId).toBe(outsider);
    expect(controls.dmCalls.at(-1)?.content).toContain(channelId);
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
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/wait/i);
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
            options: [{ name: "limit", type: 4, value: -1 }],
          },
        ],
      }),
    );
    expect(metrics.snapshot().validationFailures).toBe(1);

    await vc.execute(
      interaction({
        id: "limit-five",
        guildId,
        options: [
          {
            name: "limit",
            type: 1,
            options: [{ name: "limit", type: 4, value: 5 }],
          },
        ],
      }),
    );
    expect(controls.editCalls.at(-1)?.userLimit).toBe(5);

    const again = await setup();
    again.controls.channels.get(channelId)!.userLimit = 5;
    await again.vc.execute(
      interaction({
        id: "limit-clear",
        guildId,
        options: [
          {
            name: "limit",
            type: 1,
            options: [{ name: "limit", type: 4, value: 0 }],
          },
        ],
      }),
    );
    expect(again.controls.editCalls.at(-1)?.userLimit).toBe(0);
    expect(embedText(again.controls.editedInteractions.at(-1))).toMatch(/removed/i);
  });

  test("lock unlock hide and unhide update overwrites and locked flag", async () => {
    const { vc, controls, channels, metrics, cooldowns } = await setup();
    await vc.execute(interaction({ id: "lock-1", guildId, options: [{ name: "lock", type: 1 }] }));
    cooldowns.clear();
    await vc.execute(interaction({ id: "lock-2", guildId, options: [{ name: "lock", type: 1 }] }));
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/already locked/i);
    expect(metrics.snapshot().validationFailures).toBeGreaterThanOrEqual(1);
    const locked = controls.channels.get(channelId)!;
    const everyone = locked.permissionOverwrites.find((overwrite) => overwrite.id === guildId)!;
    expect((BigInt(everyone.deny) & BitwisePermissionFlags.CONNECT) !== 0n).toBe(true);
    expect((await channels.findByChannelId(channelId))?.locked).toBe(true);
    const invite = locked.permissionOverwrites.find((overwrite) => overwrite.id === targetId)!;
    expect((BigInt(invite.allow) & BitwisePermissionFlags.STREAM) !== 0n).toBe(true);

    cooldowns.clear();
    await vc.execute(interaction({ id: "unlock-1", guildId, options: [{ name: "unlock", type: 1 }] }));
    expect((await channels.findByChannelId(channelId))?.locked).toBe(false);
    cooldowns.clear();
    await vc.execute(interaction({ id: "unlock-2", guildId, options: [{ name: "unlock", type: 1 }] }));
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/already unlocked/i);

    cooldowns.clear();
    await vc.execute(interaction({ id: "hide-1", guildId, options: [{ name: "hide", type: 1 }] }));
    const hidden = controls.channels.get(channelId)!;
    const everyoneHidden = hidden.permissionOverwrites.find((overwrite) => overwrite.id === guildId)!;
    expect((BigInt(everyoneHidden.deny) & BitwisePermissionFlags.VIEW_CHANNEL) !== 0n).toBe(true);
    cooldowns.clear();
    await vc.execute(interaction({ id: "hide-2", guildId, options: [{ name: "hide", type: 1 }] }));
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/already hidden/i);

    cooldowns.clear();
    await vc.execute(interaction({ id: "unhide-1", guildId, options: [{ name: "unhide", type: 1 }] }));
    const unhidden = controls.channels.get(channelId)!;
    const everyoneVisible = unhidden.permissionOverwrites.find((overwrite) => overwrite.id === guildId)!;
    expect((BigInt(everyoneVisible.deny) & BitwisePermissionFlags.VIEW_CHANNEL) === 0n).toBe(true);
    cooldowns.clear();
    await vc.execute(interaction({ id: "unhide-2", guildId, options: [{ name: "unhide", type: 1 }] }));
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/already visible/i);
  });

  test("permit and reject report already-applied member state", async () => {
    const { vc, controls, channels, cooldowns } = await setup();

    await vc.execute(
      interaction({
        id: "permit-first",
        guildId,
        options: [
          {
            name: "permit",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    cooldowns.clear();
    await vc.execute(
      interaction({
        id: "permit-again",
        guildId,
        options: [
          {
            name: "permit",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/already permitted/i);

    cooldowns.clear();
    await vc.execute(
      interaction({
        id: "reject-first",
        guildId,
        options: [
          {
            name: "reject",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect((await channels.findByChannelId(channelId))?.rejectedUserIds).toContain(targetId);

    cooldowns.clear();
    await vc.execute(
      interaction({
        id: "reject-again",
        guildId,
        options: [
          {
            name: "reject",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/already rejected/i);
  });

  test("lock still repairs when Mongo and Discord disagree", async () => {
    const { vc, controls, channels } = await setup();
    await channels.setLocked(channelId, true);
    // Discord still unlocked — should not treat as already locked.
    await vc.execute(interaction({ id: "lock-repair", guildId, options: [{ name: "lock", type: 1 }] }));
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/Channel locked/i);
    const everyone = controls.channels.get(channelId)!.permissionOverwrites.find(
      (overwrite) => overwrite.id === guildId,
    )!;
    expect((BigInt(everyone.deny) & BitwisePermissionFlags.CONNECT) !== 0n).toBe(true);
  });

  test("reject stores denial disconnects and permit clears reject list", async () => {
    const { vc, controls, channels } = await setup();
    controls.voiceByUser.set(`${guildId}:${targetId}`, channelId);

    await vc.execute(
      interaction({
        id: "reject-1",
        guildId,
        options: [
          {
            name: "reject",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    const record = await channels.findByChannelId(channelId);
    expect(record?.rejectedUserIds).toContain(targetId);
    expect(controls.moveCalls.some((call) => call.userId === targetId && call.channelId === null)).toBe(
      true,
    );

    await vc.execute(
      interaction({
        id: "permit-1",
        guildId,
        options: [
          {
            name: "permit",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect((await channels.findByChannelId(channelId))?.rejectedUserIds).not.toContain(targetId);
  });

  test("mute and unmute server-mute a connected member", async () => {
    const { vc, controls, metrics, cooldowns } = await setup();
    controls.voiceByUser.set(`${guildId}:${targetId}`, channelId);
    controls.serverMuteByUser.set(`${guildId}:${targetId}`, false);

    await vc.execute(
      interaction({
        id: "mute-absent",
        guildId,
        options: [
          {
            name: "mute",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    // clear and set voice after verifying absent fails first without voice - actually target has voice
    expect(controls.muteCalls[0]?.mute).toBe(true);
    expect(controls.serverMuteByUser.get(`${guildId}:${targetId}`)).toBe(true);
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/server muted/i);

    cooldowns.clear();
    await vc.execute(
      interaction({
        id: "mute-again",
        guildId,
        options: [
          {
            name: "mute",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/already muted/i);

    cooldowns.clear();
    await vc.execute(
      interaction({
        id: "unmute-1",
        guildId,
        options: [
          {
            name: "unmute",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(controls.muteCalls.at(-1)?.mute).toBe(false);
    expect(controls.serverMuteByUser.get(`${guildId}:${targetId}`)).toBe(false);

    cooldowns.clear();
    await vc.execute(
      interaction({
        id: "unmute-again",
        guildId,
        options: [
          {
            name: "unmute",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/already unmuted/i);

    cooldowns.clear();
    controls.voiceByUser.delete(`${guildId}:${targetId}`);
    await vc.execute(
      interaction({
        id: "mute-disconnected",
        guildId,
        options: [
          {
            name: "mute",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/must be connected/i);
    expect(metrics.snapshot().successes.mute).toBe(1);
    expect(metrics.snapshot().successes.unmute).toBe(1);
  });

  test("transfer requires connected non-bot member and updates owner", async () => {
    const { vc, channels } = await setup();
    await vc.execute(
      interaction({
        id: "transfer-absent",
        guildId,
        options: [
          {
            name: "transfer",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect((await channels.findByChannelId(channelId))?.ownerId).toBe(ownerId);

    const { vc: vc2, controls, channels: channels2 } = await setup();
    controls.voiceByUser.set(`${guildId}:${targetId}`, channelId);
    await vc2.execute(
      interaction({
        id: "transfer-ok",
        guildId,
        options: [
          {
            name: "transfer",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect((await channels2.findByChannelId(channelId))?.ownerId).toBe(targetId);
  });

  test("info works for connected non-owner and delete removes channel", async () => {
    const { vc, controls, channels, metrics } = await setup();
    controls.voiceByUser.set(`${guildId}:${targetId}`, channelId);
    await channels.setOccupants(channelId, [ownerId, targetId], null);

    await vc.execute(
      interaction({
        id: "info-1",
        guildId,
        userId: targetId,
        options: [{ name: "info", type: 1 }],
      }),
    );
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/Channel Info/i);
    expect(embedText(controls.editedInteractions.at(-1))).toContain(ownerId);
    expect(metrics.snapshot().successes.info).toBe(1);

    await vc.execute(interaction({ id: "delete-1", guildId, options: [{ name: "delete", type: 1 }] }));
    expect(controls.deleteCalls.some((call) => call.channelId === channelId)).toBe(true);
    expect(await channels.findByChannelId(channelId)).toBeUndefined();
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
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/Could not lock/i);
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
