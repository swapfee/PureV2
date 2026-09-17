import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { BitwisePermissionFlags } from "discordeno";

import { createCooldownStore } from "../src/handlers/cooldowns.ts";
import { createDeletionLifecycle, EMPTY_CHANNEL_DELAY_MS } from "../src/lib/j2c/deletion-lifecycle.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { createJ2cMetrics } from "../src/lib/j2c/metrics.ts";
import { createMemoryTemporaryChannelRepository } from "../src/lib/j2c/memory-repositories.ts";
import { createManualTimerScheduler } from "../src/lib/j2c/time.ts";
import { createVcCommandService } from "../src/lib/j2c/vc-command-service.ts";
import {
  buildJoinRequestCustomId,
  buildJoinRequestKey,
  cancelPendingJoinRequestsForChannel,
  finalizeJoinRequestMessage,
  hasPendingJoinRequest,
  registerPendingJoinRequest,
  resetJoinRequestStoreForTests,
  setJoinRequestMessageDeleteAfterMsForTests,
  VC_JOIN_REQUEST_PREFIX,
  VC_JOIN_REQUEST_TTL_MS,
} from "../src/lib/j2c/vc-join-request.ts";
import { createVcMetrics } from "../src/lib/j2c/vc-metrics.ts";
import { createVoiceOccupancyTracker } from "../src/lib/j2c/voice-occupancy.ts";
import { createVoicePanelInteractionHandler } from "../src/lib/j2c/voice-panel-interactions.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { InteractionCreatePayload } from "../src/lib/runtime-types.ts";

const guildId = "123456789012345678";
const ownerId = "999999999999999999";
const requesterId = "888888888888888888";
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
    readonly messageId?: string;
    readonly customId?: string;
    readonly options?: InteractionCreatePayload["options"];
    readonly commandName?: string;
  },
): InteractionCreatePayload {
  return {
    id: partial.id ?? "100000000000000001",
    token: partial.token ?? "interaction-token",
    type: partial.customId ? 3 : 2,
    applicationId: "555555555555555555",
    userId: partial.userId ?? requesterId,
    commandName: partial.commandName ?? "vc",
    ...(partial.guildId ? { guildId: partial.guildId } : {}),
    ...(partial.channelId ? { channelId: partial.channelId } : {}),
    ...(partial.messageId ? { messageId: partial.messageId } : {}),
    ...(partial.customId ? { customId: partial.customId } : {}),
    ...(partial.options ? { options: partial.options } : {}),
  };
}

async function setup(locked = true) {
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
  if (locked) {
    await channels.setLocked(channelId, true);
  }

  const { discord, controls } = createFakeDiscord();
  controls.channels.set(channelId, {
    id: channelId,
    name: "owner-room",
    guildId,
    userLimit: 0,
    permissionOverwrites: [
      {
        id: guildId,
        type: 0,
        allow: "0",
        deny: locked ? BitwisePermissionFlags.CONNECT.toString() : "0",
      },
    ],
  });
  controls.voiceByUser.set(`${guildId}:${ownerId}`, channelId);
  controls.users.set(requesterId, { id: requesterId, bot: false });
  controls.users.set(ownerId, { id: ownerId, bot: false });

  const metrics = createVcMetrics();
  const cooldowns = createCooldownStore();
  const vc = createVcCommandService({
    channels,
    discord,
    logger,
    metrics,
    cooldowns,
    completedInteractions: new Set(),
  });
  const voicePanel = createVoicePanelInteractionHandler({
    channels,
    discord,
    logger,
    botUsername: "Pure",
  });

  return { vc, voicePanel, controls, metrics, channels, logger };
}

async function waitForMessageDelete(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("/vc request join flow", () => {
  beforeEach(() => {
    resetJoinRequestStoreForTests();
    setJoinRequestMessageDeleteAfterMsForTests(20);
  });
  afterEach(() => {
    resetJoinRequestStoreForTests();
  });

  test("posts a join request in a locked channel and keeps /vc permit available", async () => {
    const { vc, controls, metrics, channels } = await setup(true);

    await vc.execute(
      interaction({
        id: "req-1",
        guildId,
        userId: requesterId,
        options: [
          {
            name: "request",
            type: 1,
            options: [{ name: "target", type: 3, value: channelId }],
          },
        ],
      }),
    );

    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/Join request sent/i);
    expect(controls.channelMessages).toHaveLength(1);
    const posted = controls.channelMessages[0]!;
    expect(posted.embeds?.[0]?.title).toBe("Join request");
    expect(posted.embeds?.[0]?.description).toContain(requesterId);
    expect(posted.embeds?.[0]?.description).toMatch(/<t:\d+:R>/);
    const componentsJson = JSON.stringify(posted.components);
    expect(componentsJson).toContain(VC_JOIN_REQUEST_PREFIX);
    expect(componentsJson).toContain('"label":"Approve"');
    expect(componentsJson).toContain('"label":"Decline"');
    expect(componentsJson).toContain('"style":2');
    expect(metrics.snapshot().successes.request).toBe(1);

    // /vc permit remains owner-usable independently of request.
    controls.voiceByUser.set(`${guildId}:${ownerId}`, channelId);
    await vc.execute(
      interaction({
        id: "permit-1",
        guildId,
        userId: ownerId,
        options: [
          {
            name: "permit",
            type: 1,
            options: [{ name: "member", type: 6, value: requesterId }],
          },
        ],
      }),
    );
    expect(metrics.snapshot().successes.permit).toBe(1);
    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/can now view and join/i);
    expect(await channels.findByChannelId(channelId)).toBeDefined();
  });

  test("resolves by owner id and rejects unlocked channels", async () => {
    const unlocked = await setup(false);
    await unlocked.vc.execute(
      interaction({
        id: "req-unlocked",
        guildId,
        userId: requesterId,
        options: [
          {
            name: "request",
            type: 1,
            options: [{ name: "target", type: 3, value: ownerId }],
          },
        ],
      }),
    );
    expect(embedText(unlocked.controls.editedInteractions.at(-1))).toMatch(/not locked/i);

    const locked = await setup(true);
    await locked.vc.execute(
      interaction({
        id: "req-owner",
        guildId,
        userId: requesterId,
        options: [
          {
            name: "request",
            type: 1,
            options: [{ name: "target", type: 3, value: ownerId }],
          },
        ],
      }),
    );
    expect(locked.metrics.snapshot().successes.request).toBe(1);
    expect(locked.controls.channelMessages[0]?.channelId).toBe(channelId);
  });

  test("owner approve permits the requester and disables buttons", async () => {
    const { vc, voicePanel, controls, metrics } = await setup(true);
    await vc.execute(
      interaction({
        id: "req-approve",
        guildId,
        userId: requesterId,
        options: [
          {
            name: "request",
            type: 1,
            options: [{ name: "target", type: 3, value: channelId }],
          },
        ],
      }),
    );
    const messageId = controls.channelMessages[0]!.id;
    const expiresAt = Date.now() + 60_000;
    const customId = buildJoinRequestCustomId("approve", channelId, requesterId, expiresAt);

    await voicePanel.execute(
      interaction({
        id: "btn-approve",
        guildId,
        channelId,
        messageId,
        userId: ownerId,
        customId,
      }),
    );

    expect(controls.overwriteCalls.some((call) => call.overwriteId === requesterId)).toBe(true);
    const edited = controls.editedChannelMessages.at(-1);
    expect(edited?.embeds?.[0]?.title).toMatch(/approved/i);
    expect(JSON.stringify(edited?.components)).toContain('"disabled":true');
    expect(JSON.stringify(edited?.components)).toContain('"label":"Approve"');
    expect(metrics.snapshot().successes.request).toBe(1);

    await waitForMessageDelete();
    expect(controls.deletedChannelMessages.some((entry) => entry.messageId === messageId)).toBe(
      true,
    );
  });

  test("owner decline disables buttons without permitting", async () => {
    const { vc, voicePanel, controls } = await setup(true);
    await vc.execute(
      interaction({
        id: "req-decline",
        guildId,
        userId: requesterId,
        options: [
          {
            name: "request",
            type: 1,
            options: [{ name: "target", type: 3, value: channelId }],
          },
        ],
      }),
    );
    const messageId = controls.channelMessages[0]!.id;
    const customId = buildJoinRequestCustomId(
      "decline",
      channelId,
      requesterId,
      Date.now() + 60_000,
    );
    const overwritesBefore = controls.overwriteCalls.length;

    await voicePanel.execute(
      interaction({
        id: "btn-decline",
        guildId,
        channelId,
        messageId,
        userId: ownerId,
        customId,
      }),
    );

    expect(controls.overwriteCalls.length).toBe(overwritesBefore);
    expect(controls.editedChannelMessages.at(-1)?.embeds?.[0]?.title).toMatch(/declined/i);

    await waitForMessageDelete();
    expect(controls.deletedChannelMessages.some((entry) => entry.messageId === messageId)).toBe(
      true,
    );
  });

  test("non-owner cannot approve", async () => {
    const { vc, voicePanel, controls } = await setup(true);
    await vc.execute(
      interaction({
        id: "req-deny",
        guildId,
        userId: requesterId,
        options: [
          {
            name: "request",
            type: 1,
            options: [{ name: "target", type: 3, value: channelId }],
          },
        ],
      }),
    );
    const messageId = controls.channelMessages[0]!.id;
    const customId = buildJoinRequestCustomId(
      "approve",
      channelId,
      requesterId,
      Date.now() + 60_000,
    );

    await voicePanel.execute(
      interaction({
        id: "btn-stranger",
        guildId,
        channelId,
        messageId,
        userId: requesterId,
        customId,
      }),
    );

    expect(embedText(controls.responses.at(-1))).toMatch(/Only the channel owner/i);
  });

  test("expired request disables buttons", async () => {
    const { voicePanel, controls, channels } = await setup(true);
    const messageId = "800000000000000001";
    controls.channelMessages.push({ channelId, id: messageId });
    const customId = buildJoinRequestCustomId(
      "approve",
      channelId,
      requesterId,
      Date.now() - 1_000,
    );

    expect(await channels.findByChannelId(channelId)).toBeDefined();
    await voicePanel.execute(
      interaction({
        id: "btn-expired",
        guildId,
        channelId,
        messageId,
        userId: ownerId,
        customId,
      }),
    );

    expect(controls.editedChannelMessages.at(-1)?.embeds?.[0]?.title).toMatch(/expired/i);
    expect(JSON.stringify(controls.editedChannelMessages.at(-1)?.components)).toContain(
      '"disabled":true',
    );

    await waitForMessageDelete();
    expect(controls.deletedChannelMessages.some((entry) => entry.messageId === messageId)).toBe(
      true,
    );
  });

  test("cancelPendingJoinRequestsForChannel clears store and disables buttons", async () => {
    const { discord, controls } = createFakeDiscord();
    const messageId = "800000000000000010";
    const expiresAt = Date.now() + VC_JOIN_REQUEST_TTL_MS;
    registerPendingJoinRequest(
      {
        requestKey: buildJoinRequestKey("cancel-unit"),
        guildId,
        channelId,
        ownerId,
        requesterId,
        messageId,
        expiresAt,
      },
      async () => undefined,
    );
    expect(hasPendingJoinRequest(channelId, requesterId)).toBe(true);

    await cancelPendingJoinRequestsForChannel({
      discord,
      channelId,
      requestId: "test-cancel",
    });

    expect(hasPendingJoinRequest(channelId, requesterId)).toBe(false);
    const edited = controls.editedChannelMessages.at(-1);
    expect(edited?.messageId).toBe(messageId);
    expect(edited?.embeds?.[0]?.title).toBe("Join request cancelled");
    expect(edited?.embeds?.[0]?.description).toContain(requesterId);
    expect(JSON.stringify(edited?.components)).toContain('"disabled":true');

    await waitForMessageDelete();
    expect(controls.deletedChannelMessages).toHaveLength(0);
  });

  test("cancel treats missing message edits as success", async () => {
    const { discord, controls } = createFakeDiscord();
    controls.failNextEditMessage = { kind: "missing" };
    registerPendingJoinRequest(
      {
        requestKey: buildJoinRequestKey("cancel-missing"),
        guildId,
        channelId,
        ownerId,
        requesterId,
        messageId: "800000000000000011",
        expiresAt: Date.now() + VC_JOIN_REQUEST_TTL_MS,
      },
      async () => undefined,
    );

    await cancelPendingJoinRequestsForChannel({
      discord,
      channelId,
      requestId: "test-cancel-missing",
    });

    expect(hasPendingJoinRequest(channelId, requesterId)).toBe(false);
    expect(controls.editedChannelMessages).toHaveLength(1);
  });

  test("/vc delete cancels pending join requests", async () => {
    const { vc, controls, channels } = await setup(true);
    await vc.execute(
      interaction({
        id: "req-before-delete",
        guildId,
        userId: requesterId,
        options: [
          {
            name: "request",
            type: 1,
            options: [{ name: "target", type: 3, value: channelId }],
          },
        ],
      }),
    );
    expect(hasPendingJoinRequest(channelId, requesterId)).toBe(true);
    const messageId = controls.channelMessages[0]!.id;

    await vc.execute(
      interaction({
        id: "delete-with-pending",
        guildId,
        userId: ownerId,
        options: [{ name: "delete", type: 1 }],
      }),
    );

    expect(await channels.findByChannelId(channelId)).toBeUndefined();
    expect(hasPendingJoinRequest(channelId, requesterId)).toBe(false);
    const cancelled = controls.editedChannelMessages.find((entry) => entry.messageId === messageId);
    expect(cancelled?.embeds?.[0]?.title).toMatch(/cancelled/i);
    expect(JSON.stringify(cancelled?.components)).toContain('"disabled":true');
  });

  test("empty-channel deletion cancels pending join requests", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    await channels.create({
      guildId,
      channelId,
      ownerId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-empty",
      creationRequestId: "req-empty",
      occupantIds: [],
    });
    const { discord, controls } = createFakeDiscord();
    controls.channels.set(channelId, {
      id: channelId,
      name: "empty-room",
      guildId,
      userLimit: 0,
      permissionOverwrites: [],
    });
    const messageId = "800000000000000012";
    registerPendingJoinRequest(
      {
        requestKey: buildJoinRequestKey("empty-delete"),
        guildId,
        channelId,
        ownerId,
        requesterId,
        messageId,
        expiresAt: Date.now() + VC_JOIN_REQUEST_TTL_MS,
      },
      async () => undefined,
    );

    const occupancy = createVoiceOccupancyTracker();
    occupancy.seedGuildVoiceStates(guildId, []);
    occupancy.markReady();
    const timers = createManualTimerScheduler();
    const deletion = createDeletionLifecycle({
      channels,
      discord,
      metrics: createJ2cMetrics(),
      logger: createLogger({
        service: "purev2",
        role: "test",
        level: "error",
        write: () => undefined,
      }),
      occupancy,
      clock: { now: () => new Date(timers.nowMs()) },
      timers,
    });

    await deletion.onOccupantsChanged(channelId, []);
    await timers.advance(EMPTY_CHANNEL_DELAY_MS);

    expect(await channels.findByChannelId(channelId)).toBeUndefined();
    expect(hasPendingJoinRequest(channelId, requesterId)).toBe(false);
    expect(controls.editedChannelMessages.at(-1)?.embeds?.[0]?.title).toMatch(/cancelled/i);
  });

  test("finalizeJoinRequestMessage cancelled copy stays professional", async () => {
    const { discord, controls } = createFakeDiscord();
    await finalizeJoinRequestMessage({
      discord,
      channelId,
      messageId: "800000000000000013",
      requesterId,
      ownerId,
      expiresAt: Date.now() + VC_JOIN_REQUEST_TTL_MS,
      outcome: "cancelled",
      requestId: "finalize-cancelled",
    });
    expect(controls.editedChannelMessages.at(-1)?.embeds?.[0]?.title).toMatch(/Join request cancelled/i);
    expect(controls.editedChannelMessages.at(-1)?.embeds?.[0]?.description).toMatch(/channel was deleted/i);
  });
});
