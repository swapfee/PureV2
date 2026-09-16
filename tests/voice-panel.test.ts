import { describe, expect, test } from "bun:test";

import { ChannelTypes } from "discordeno";

import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { createMemoryTemporaryChannelRepository } from "../src/lib/j2c/memory-repositories.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { InteractionCreatePayload } from "../src/lib/runtime-types.ts";
import {
  buildVoiceControlPanelComponents,
  IS_COMPONENTS_V2,
  OWNER_TRANSFER_GRACE_MS,
  PANEL_EMOJIS,
  VOICE_PANEL_PREFIX,
  VOICE_PANEL_VERSION,
} from "../src/lib/j2c/voice-panel.ts";
import { createVoicePanelInteractionHandler } from "../src/lib/j2c/voice-panel-interactions.ts";
import { installVoiceControlPanel, refreshVoiceControlPanel, resetVoicePanelLocksForTests } from "../src/lib/j2c/voice-panel-service.ts";
import { createVoiceStateHandler } from "../src/lib/j2c/voice-state-handler.ts";
import { createCreationLifecycle } from "../src/lib/j2c/creation-lifecycle.ts";
import { createDeletionLifecycle } from "../src/lib/j2c/deletion-lifecycle.ts";
import { createJ2cMetrics } from "../src/lib/j2c/metrics.ts";
import {
  createMemoryCreationReservationRepository,
  createMemoryGuildConfigRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { createReservationService } from "../src/lib/j2c/reservation-service.ts";
import { createVoiceOccupancyTracker } from "../src/lib/j2c/voice-occupancy.ts";

const guildId = "123456789012345678";
const ownerId = "999999999999999999";
const memberId = "888888888888888888";
const channelId = "777777777777777777";
const lobbyId = "222222222222222222";
const categoryId = "333333333333333333";
const botId = "111111111111111111";

function testLogger() {
  return createLogger({ service: "purev2", role: "test", level: "error", write: () => undefined });
}

function interaction(partial: Partial<InteractionCreatePayload> & Pick<InteractionCreatePayload, "customId">): InteractionCreatePayload {
  return {
    id: "500000000000000001",
    token: "token",
    type: 3,
    applicationId: botId,
    guildId,
    channelId,
    userId: ownerId,
    ...partial,
  };
}

function panelRowButtons(row: unknown): readonly unknown[] {
  const buttons = Reflect.get(row ?? {}, "components");
  return Array.isArray(buttons) ? buttons : [];
}

describe("voice panel builder", () => {
  test("builds Components V2 container with emoji-only secondary buttons", () => {
    const components = buildVoiceControlPanelComponents({
      botUsername: "Pure",
      channelId,
      ownerId,
    });
    expect(components).toHaveLength(1);
    const container = components[0];
    expect(container).toBeTruthy();
    expect(Reflect.get(container ?? {}, "type")).toBe(17);
    const nested = Reflect.get(container ?? {}, "components");
    expect(Array.isArray(nested)).toBe(true);
    const parts = Array.isArray(nested) ? nested : [];
    const heading = parts.find((entry) => {
      return Reflect.get(entry, "type") === 10
        && typeof Reflect.get(entry, "content") === "string"
        && String(Reflect.get(entry, "content")).includes("Pure's Interface");
    });
    expect(String(Reflect.get(heading ?? {}, "content"))).toContain(`<@${ownerId}>`);
    const commandList = parts.find((entry) => {
      return Reflect.get(entry, "type") === 10
        && typeof Reflect.get(entry, "content") === "string"
        && String(Reflect.get(entry, "content")).includes(PANEL_EMOJIS.lock.id);
    });
    const commandText = String(Reflect.get(commandList ?? {}, "content"));
    expect(commandText).toContain("**Lock**");
    expect(commandText).toContain(PANEL_EMOJIS.delete.id);

    const rows = parts.filter((entry) => Reflect.get(entry, "type") === 1);
    expect(rows).toHaveLength(2);
    expect(panelRowButtons(rows[0])).toHaveLength(5);
    expect(panelRowButtons(rows[1])).toHaveLength(5);
    for (const button of [...panelRowButtons(rows[0]), ...panelRowButtons(rows[1])]) {
      if (typeof button !== "object" || button === null) {
        throw new Error("expected button object");
      }
      expect(Reflect.get(button, "style")).toBe(2);
      const customId = String(Reflect.get(button, "custom_id") ?? "");
      expect(customId.startsWith(`${VOICE_PANEL_PREFIX}:`)).toBe(true);
      expect(customId.endsWith(`:${channelId}:${ownerId}`)).toBe(true);
      const emoji = Reflect.get(button, "emoji");
      expect(typeof Reflect.get(emoji && typeof emoji === "object" ? emoji : {}, "id")).toBe(
        "string",
      );
    }
  });
});

describe("voice panel install", () => {
  test("stores panelMessageId after successful send", async () => {
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
    const { discord, controls } = createFakeDiscord({
      currentUser: { id: botId, username: "Pure" },
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "test",
            type: ChannelTypes.GuildVoice,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
    });

    await installVoiceControlPanel({
      discord,
      channels,
      logger: testLogger(),
      guildId,
      channelId,
      ownerId,
      botUserId: botId,
      botUsername: "Pure",
      requestId: "create-1",
    });

    const record = await channels.findByChannelId(channelId);
    expect(record?.panelMessageId).toBeTruthy();
    expect(record?.panelVersion).toBe(VOICE_PANEL_VERSION);
    expect(record?.panelOwnerId).toBe(ownerId);
    expect(controls.channelMessages).toHaveLength(1);
    expect(controls.channelMessages[0]?.flags).toBe(IS_COMPONENTS_V2);
    expect(controls.overwriteCalls.some((call) => call.overwriteId === botId)).toBe(true);
    expect(controls.overwriteCalls.some((call) => call.overwriteId === guildId)).toBe(true);
  });

  test("panel send failure does not remove the channel record", async () => {
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
    const { discord } = createFakeDiscord({
      currentUser: { id: botId, username: "Pure" },
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "test",
            type: ChannelTypes.GuildVoice,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
      failNextSendMessage: { kind: "transient", message: "fail" },
    });

    await installVoiceControlPanel({
      discord,
      channels,
      logger: testLogger(),
      guildId,
      channelId,
      ownerId,
      botUserId: botId,
      botUsername: "Pure",
      requestId: "create-1",
    });

    const record = await channels.findByChannelId(channelId);
    expect(record?.status).toBe("active");
    expect(record?.panelMessageId).toBeUndefined();
  });
});

describe("voice panel interactions", () => {
  test("rejects owner-only actions for non-owners", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    await channels.create({
      guildId,
      channelId,
      ownerId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-1",
      creationRequestId: "req-1",
      occupantIds: [ownerId, memberId],
    });
    const { discord, controls } = createFakeDiscord({
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "room",
            type: ChannelTypes.GuildVoice,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
    });
    controls.voiceByUser.set(`${guildId}:${memberId}`, channelId);

    const handler = createVoicePanelInteractionHandler({
      channels,
      discord,
      logger: testLogger(),
      botUsername: "Pure",
    });

    await handler.execute(
      interaction({
        userId: memberId,
        customId: `${VOICE_PANEL_PREFIX}:lock:${channelId}:${ownerId}`,
      }),
    );

    expect(controls.deferredInteractions).toContain("500000000000000001");
    const reply = controls.editedInteractions.at(-1);
    expect(reply?.embeds?.[0]?.description).toContain("You must own this voice channel");
  });

  test("locks channel for the owner", async () => {
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
    const { discord, controls } = createFakeDiscord({
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "room",
            type: ChannelTypes.GuildVoice,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
    });
    controls.voiceByUser.set(`${guildId}:${ownerId}`, channelId);

    const handler = createVoicePanelInteractionHandler({
      channels,
      discord,
      logger: testLogger(),
      botUsername: "Pure",
    });

    await handler.execute(
      interaction({
        customId: `${VOICE_PANEL_PREFIX}:lock:${channelId}:${ownerId}`,
      }),
    );

    const record = await channels.findByChannelId(channelId);
    expect(record?.locked).toBe(true);
    expect(controls.overwriteCalls.some((call) => call.overwriteId === guildId)).toBe(true);
    expect(controls.editedInteractions.at(-1)?.embeds?.[0]?.description).toContain("Channel locked");
  });

  test("opens rename modal for owner", async () => {
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
    const { discord, controls } = createFakeDiscord({
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "room",
            type: ChannelTypes.GuildVoice,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
    });
    controls.voiceByUser.set(`${guildId}:${ownerId}`, channelId);

    const handler = createVoicePanelInteractionHandler({
      channels,
      discord,
      logger: testLogger(),
      botUsername: "Pure",
    });

    await handler.execute(
      interaction({
        customId: `${VOICE_PANEL_PREFIX}:rename:${channelId}:${ownerId}`,
      }),
    );

    expect(controls.modals).toHaveLength(1);
    expect(controls.modals[0]?.customId).toBe(`voice-modal:rename:${channelId}`);
    expect(controls.modals[0]?.title).toBe("Rename Voice Channel");
  });

  test("claim waits for grace period then succeeds", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    await channels.create({
      guildId,
      channelId,
      ownerId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-1",
      creationRequestId: "req-1",
      occupantIds: [memberId],
    });
    await channels.setOwnerAbsentSince(channelId, new Date(Date.now() - 60_000));

    const { discord, controls } = createFakeDiscord({
      currentUser: { id: botId, username: "Pure" },
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "room",
            type: ChannelTypes.GuildVoice,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
      users: new Map([
        [memberId, { id: memberId, bot: false, username: "claimer" }],
        [ownerId, { id: ownerId, bot: false, username: "owner" }],
      ]),
    });
    controls.voiceByUser.set(`${guildId}:${memberId}`, channelId);
    controls.voiceByUser.set(`${guildId}:${ownerId}`, null);

    const handler = createVoicePanelInteractionHandler({
      channels,
      discord,
      logger: testLogger(),
      botUsername: "Pure",
    });

    await handler.execute(
      interaction({
        userId: memberId,
        customId: `${VOICE_PANEL_PREFIX}:claim:${channelId}:${ownerId}`,
      }),
    );
    expect(controls.editedInteractions.at(-1)?.embeds?.[0]?.description).toContain(
      "You can claim ownership",
    );

    await channels.setOwnerAbsentSince(
      channelId,
      new Date(Date.now() - OWNER_TRANSFER_GRACE_MS - 1_000),
    );
    await handler.execute(
      interaction({
        id: "500000000000000002",
        userId: memberId,
        customId: `${VOICE_PANEL_PREFIX}:claim:${channelId}:${ownerId}`,
      }),
    );

    const record = await channels.findByChannelId(channelId);
    expect(record?.ownerId).toBe(memberId);
    expect(controls.editedInteractions.at(-1)?.embeds?.[0]?.description).toContain(
      "You are now the channel owner",
    );
  });
});

describe("owner absence tracking", () => {
  test("sets and clears ownerAbsentSince based on occupancy", async () => {
    const configs = createMemoryGuildConfigRepository();
    await configs.upsert({
      guildId,
      enabled: true,
      lobbyChannelId: lobbyId,
      categoryId,
      channelNameTemplate: "{username}'s channel",
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
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord } = createFakeDiscord({ currentUser: { id: botId, username: "Pure" } });
    const occupancy = createVoiceOccupancyTracker();
    occupancy.seedGuildVoiceStates(guildId, [{ userId: ownerId, channelId }]);
    occupancy.markReady();
    const deletion = createDeletionLifecycle({
      channels,
      discord,
      metrics,
      logger: testLogger(),
      occupancy,
    });
    const reservationService = createReservationService({
      reservations,
      channels,
      metrics,
    });
    const creation = createCreationLifecycle({
      configs,
      channels,
      reservations,
      reservationService,
      discord,
      metrics,
      logger: testLogger(),
    });
    const voice = createVoiceStateHandler({
      configs,
      channels,
      creation,
      deletion,
      occupancy,
      logger: testLogger(),
      discord,
    });

    occupancy.apply({
      guildId,
      userId: ownerId,
      channelId: null,
      sequence: 1,
    });
    occupancy.apply({
      guildId,
      userId: memberId,
      channelId,
      sequence: 2,
    });

    await voice.handle(
      { guildId, userId: ownerId, channelId: null },
      "evt-leave",
      3,
    );
    let record = await channels.findByChannelId(channelId);
    expect(record?.ownerAbsentSince).toBeInstanceOf(Date);

    occupancy.apply({
      guildId,
      userId: ownerId,
      channelId,
      sequence: 4,
    });
    await voice.handle(
      { guildId, userId: ownerId, channelId },
      "evt-rejoin",
      5,
    );
    record = await channels.findByChannelId(channelId);
    expect(record?.ownerAbsentSince).toBeUndefined();
  });
});

describe("creation installs panel", () => {
  test("sends control panel after successful channel create", async () => {
    const configs = createMemoryGuildConfigRepository();
    await configs.upsert({
      guildId,
      enabled: true,
      lobbyChannelId: lobbyId,
      categoryId,
      channelNameTemplate: "{username}'s channel",
    });
    const channels = createMemoryTemporaryChannelRepository();
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord({
      currentUser: { id: botId, username: "Pure" },
      users: new Map([[ownerId, { id: ownerId, bot: false, username: "Owner" }]]),
    });
    controls.voiceByUser.set(`${guildId}:${ownerId}`, lobbyId);

    const reservationService = createReservationService({
      reservations,
      channels,
      metrics,
    });
    const creation = createCreationLifecycle({
      configs,
      channels,
      reservations,
      reservationService,
      discord,
      metrics,
      logger: testLogger(),
    });

    const outcome = await creation.handleVoiceJoin({
      eventId: "evt-create-panel",
      guildId,
      memberId: ownerId,
      joinedChannelId: lobbyId,
      username: "Owner",
    });

    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    const record = await channels.findByChannelId(outcome.channelId);
    expect(record?.panelMessageId).toBeTruthy();
    expect(record?.panelVersion).toBe(VOICE_PANEL_VERSION);
    expect(controls.channelMessages.length).toBeGreaterThan(0);
  });
});

describe("voice panel refresh duplication", () => {
  test("concurrent installs only send one panel message", async () => {
    resetVoicePanelLocksForTests();
    const channels = createMemoryTemporaryChannelRepository();
    await channels.create({
      guildId,
      channelId,
      ownerId,
      lobbyChannelId: lobbyId,
      status: "creating",
      reservationId: "res-1",
      creationRequestId: "req-1",
      occupantIds: [],
    });
    const { discord, controls } = createFakeDiscord({
      currentUser: { id: botId, username: "Pure" },
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "room",
            type: ChannelTypes.GuildVoice,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
    });

    await Promise.all([
      installVoiceControlPanel({
        discord,
        channels,
        logger: testLogger(),
        guildId,
        channelId,
        ownerId,
        botUserId: botId,
        botUsername: "Pure",
        requestId: "create-1",
      }),
      installVoiceControlPanel({
        discord,
        channels,
        logger: testLogger(),
        guildId,
        channelId,
        ownerId,
        botUserId: botId,
        botUsername: "Pure",
        requestId: "repair-1",
      }),
    ]);

    expect(controls.channelMessages).toHaveLength(1);
    const record = await channels.findByChannelId(channelId);
    expect(record?.panelMessageId).toBe(controls.channelMessages[0]?.id);
    expect(record?.panelOwnerId).toBe(ownerId);
  });

  test("transient edit failure does not send a second panel", async () => {
    resetVoicePanelLocksForTests();
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
    await channels.setPanelMessage(channelId, "800000000000000001", VOICE_PANEL_VERSION, ownerId);

    const { discord, controls } = createFakeDiscord({
      failNextEditMessage: { kind: "transient", message: "rate_limited" },
    });

    await refreshVoiceControlPanel({
      discord,
      channels,
      logger: testLogger(),
      channelId,
      ownerId,
      botUsername: "Pure",
      panelMessageId: "800000000000000001",
      requestId: "refresh-1",
    });

    expect(controls.editedChannelMessages).toHaveLength(1);
    expect(controls.channelMessages).toHaveLength(0);
    const record = await channels.findByChannelId(channelId);
    expect(record?.panelMessageId).toBe("800000000000000001");
  });

  test("missing panel message is replaced once", async () => {
    resetVoicePanelLocksForTests();
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
    await channels.setPanelMessage(channelId, "800000000000000001", VOICE_PANEL_VERSION, ownerId);

    const { discord, controls } = createFakeDiscord({
      failNextEditMessage: { kind: "missing" },
    });

    await refreshVoiceControlPanel({
      discord,
      channels,
      logger: testLogger(),
      channelId,
      ownerId,
      botUsername: "Pure",
      panelMessageId: "800000000000000001",
      requestId: "refresh-2",
    });

    expect(controls.editedChannelMessages).toHaveLength(1);
    expect(controls.channelMessages).toHaveLength(1);
    const record = await channels.findByChannelId(channelId);
    expect(record?.panelMessageId).toBe(controls.channelMessages[0]?.id);
    expect(record?.panelOwnerId).toBe(ownerId);
  });
});

describe("voice panel repair throttle", () => {
  test("does not retry install within the cooldown window", async () => {
    const configs = createMemoryGuildConfigRepository();
    await configs.upsert({
      guildId,
      enabled: true,
      lobbyChannelId: lobbyId,
      categoryId,
      channelNameTemplate: "{username}'s channel",
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
    const reservations = createMemoryCreationReservationRepository();
    const metrics = createJ2cMetrics();
    const { discord, controls } = createFakeDiscord({
      currentUser: { id: botId, username: "Pure" },
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "room",
            type: ChannelTypes.GuildVoice,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
      failNextSendMessage: { kind: "transient", message: "fail" },
    });
    const occupancy = createVoiceOccupancyTracker();
    occupancy.seedGuildVoiceStates(guildId, [{ userId: ownerId, channelId }]);
    occupancy.markReady();
    occupancy.apply({ guildId, userId: ownerId, channelId, sequence: 1 });

    let nowMs = 1_000;
    const deletion = createDeletionLifecycle({
      channels,
      discord,
      metrics,
      logger: testLogger(),
      occupancy,
    });
    const reservationService = createReservationService({ reservations, channels, metrics });
    const creation = createCreationLifecycle({
      configs,
      channels,
      reservations,
      reservationService,
      discord,
      metrics,
      logger: testLogger(),
    });
    const voice = createVoiceStateHandler({
      configs,
      channels,
      creation,
      deletion,
      occupancy,
      logger: testLogger(),
      discord,
      now: () => nowMs,
      panelRepairCooldownMs: 60_000,
    });

    await voice.handle({ guildId, userId: ownerId, channelId }, "evt-1", 2);
    // First repair attempt consumes the forced send failure.
    expect(controls.failNextSendMessage).toBeUndefined();
    expect(controls.channelMessages).toHaveLength(0);

    controls.failNextSendMessage = { kind: "transient", message: "fail-again" };
    nowMs = 30_000;
    await voice.handle({ guildId, userId: ownerId, channelId }, "evt-2", 3);
    // Still within cooldown: repair skipped, failure token unused.
    expect(controls.channelMessages).toHaveLength(0);
    expect(controls.failNextSendMessage).toEqual({ kind: "transient", message: "fail-again" });

    nowMs = 70_000;
    await voice.handle({ guildId, userId: ownerId, channelId }, "evt-3", 4);
    expect(controls.failNextSendMessage).toBeUndefined();
  });
});

describe("voice panel access gates", () => {
  test("rejects controls when Discord channel is not a guild voice channel", async () => {
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
    const { discord, controls } = createFakeDiscord({
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "text",
            type: ChannelTypes.GuildText,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
    });
    controls.voiceByUser.set(`${guildId}:${ownerId}`, channelId);

    const handler = createVoicePanelInteractionHandler({
      channels,
      discord,
      logger: testLogger(),
      botUsername: "Pure",
    });

    await handler.execute(
      interaction({
        customId: `${VOICE_PANEL_PREFIX}:lock:${channelId}:${ownerId}`,
      }),
    );

    expect(controls.editedInteractions.at(-1)?.embeds?.[0]?.description).toContain(
      "managed voice channel",
    );
    const record = await channels.findByChannelId(channelId);
    expect(record?.locked).toBe(false);
  });

  test("delete cancel revalidates ownership", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    await channels.create({
      guildId,
      channelId,
      ownerId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-1",
      creationRequestId: "req-1",
      occupantIds: [ownerId, memberId],
    });
    const { discord, controls } = createFakeDiscord({
      channels: new Map([
        [
          channelId,
          {
            id: channelId,
            name: "room",
            type: ChannelTypes.GuildVoice,
            guildId,
            permissionOverwrites: [],
          },
        ],
      ]),
    });
    controls.voiceByUser.set(`${guildId}:${memberId}`, channelId);

    const handler = createVoicePanelInteractionHandler({
      channels,
      discord,
      logger: testLogger(),
      botUsername: "Pure",
    });

    await handler.execute(
      interaction({
        userId: memberId,
        customId: `voice-delete:cancel:${channelId}`,
      }),
    );

    expect(controls.deferredUpdates).toContain("500000000000000001");
    expect(controls.editedInteractions.at(-1)?.embeds?.[0]?.description).toContain(
      "You must own this voice channel",
    );
  });
});
