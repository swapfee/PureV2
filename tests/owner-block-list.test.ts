import { describe, expect, test } from "bun:test";
import { ChannelTypes } from "discordeno";

import { createCooldownStore } from "../src/handlers/cooldowns.ts";
import {
  BLOCK_LIST_BUTTON_PREFIX,
  blockUser,
  formatBlockListPage,
  unblockUser,
} from "../src/lib/j2c/block-list-actions.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import {
  createMemoryOwnerBlockListRepository,
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { OWNER_BLOCK_LIST_MAX } from "../src/models/owner-block-list.ts";
import { createVcCommandService } from "../src/lib/j2c/vc-command-service.ts";
import { createVcMetrics } from "../src/lib/j2c/vc-metrics.ts";
import { createVoicePanelInteractionHandler } from "../src/lib/j2c/voice-panel-interactions.ts";
import { VOICE_PANEL_PREFIX, VOICE_SELECT_PREFIX } from "../src/lib/j2c/voice-panel.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { InteractionCreatePayload } from "../src/lib/runtime-types.ts";
import { isConnectDenied, isViewDenied } from "../src/lib/j2c/voice-controls.ts";

const guildId = "123456789012345678";
const ownerId = "999999999999999999";
const targetId = "888888888888888888";
const otherId = "777777777777777777";
const newOwnerBlockTarget = "666666666666666666";
const channelId = "444444444444444444";
const lobbyId = "222222222222222222";
const botId = "555555555555555555";

function embedText(
  entry: { content?: string; embeds?: readonly { description: string }[] } | undefined,
): string {
  return entry?.embeds?.[0]?.description ?? entry?.content ?? "";
}

function testLogger() {
  return createLogger({
    service: "purev2",
    role: "test",
    level: "error",
    write: () => undefined,
  });
}

function vcInteraction(
  partial: {
    readonly id?: string;
    readonly userId?: string;
    readonly options?: InteractionCreatePayload["options"];
    readonly targetUserId?: string;
  },
): InteractionCreatePayload {
  return {
    id: partial.id ?? "100000000000000001",
    token: "interaction-token",
    type: 2,
    applicationId: botId,
    userId: partial.userId ?? ownerId,
    guildId,
    channelId,
    commandName: "vc",
    ...(partial.options ? { options: partial.options } : {}),
    ...(partial.targetUserId ? { targetUserId: partial.targetUserId } : {}),
  };
}

function panelInteraction(
  partial: Partial<InteractionCreatePayload> & Pick<InteractionCreatePayload, "customId">,
): InteractionCreatePayload {
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

async function setupOwnedChannel(options?: {
  readonly occupantIds?: readonly string[];
}) {
  const channels = createMemoryTemporaryChannelRepository();
  const blocks = createMemoryOwnerBlockListRepository();
  await channels.create({
    guildId,
    channelId,
    ownerId,
    lobbyChannelId: lobbyId,
    status: "active",
    reservationId: "res-1",
    creationRequestId: "req-1",
    occupantIds: options?.occupantIds ?? [ownerId],
  });
  const { discord, controls } = createFakeDiscord();
  controls.channels.set(channelId, {
    id: channelId,
    name: "owner-room",
    type: ChannelTypes.GuildVoice,
    guildId,
    userLimit: 0,
    permissionOverwrites: [{ id: guildId, type: 0, allow: "0", deny: "0" }],
  });
  controls.voiceByUser.set(`${guildId}:${ownerId}`, channelId);
  controls.users.set(targetId, { id: targetId, bot: false });
  controls.users.set(otherId, { id: otherId, bot: false });
  controls.users.set(ownerId, { id: ownerId, bot: false });
  controls.users.set(newOwnerBlockTarget, { id: newOwnerBlockTarget, bot: false });
  return { channels, blocks, discord, controls };
}

describe("owner block list", () => {
  test("block adds Connect+ViewChannel deny and persists on the channel record", async () => {
    const { channels, blocks, discord, controls } = await setupOwnedChannel({
      occupantIds: [ownerId, targetId],
    });
    controls.voiceByUser.set(`${guildId}:${targetId}`, channelId);

    const outcome = await blockUser({
      blocks,
      channels,
      discord,
      logger: testLogger(),
      guildId,
      ownerId,
      targetUserId: targetId,
      requestId: "block-1",
    });
    expect(outcome.kind).toBe("ok");

    const ids = await blocks.getBlockedUserIds(guildId, ownerId);
    expect(ids).toEqual([targetId]);

    const record = await channels.findByChannelId(channelId);
    expect(record?.appliedBlockUserIds).toEqual([targetId]);

    const overwrite = controls.channels
      .get(channelId)
      ?.permissionOverwrites.find((entry) => entry.id === targetId);
    expect(overwrite).toBeTruthy();
    expect(isConnectDenied([overwrite!], targetId)).toBe(true);
    expect(isViewDenied([overwrite!], targetId)).toBe(true);
    expect(controls.moveCalls.some((call) => call.userId === targetId && call.channelId === null)).toBe(
      true,
    );
  });

  test("unblock clears persistent denials while keeping channel reject Connect deny", async () => {
    const { channels, blocks, discord, controls } = await setupOwnedChannel();
    await blockUser({
      blocks,
      channels,
      discord,
      logger: testLogger(),
      guildId,
      ownerId,
      targetUserId: targetId,
      requestId: "block-2",
    });
    await channels.addRejectedUser(channelId, targetId);

    const outcome = await unblockUser({
      blocks,
      channels,
      discord,
      logger: testLogger(),
      guildId,
      ownerId,
      targetUserId: targetId,
      requestId: "unblock-1",
    });
    expect(outcome.kind).toBe("ok");
    expect(await blocks.getBlockedUserIds(guildId, ownerId)).toEqual([]);

    const overwrite = controls.channels
      .get(channelId)
      ?.permissionOverwrites.find((entry) => entry.id === targetId);
    expect(overwrite).toBeTruthy();
    expect(isViewDenied([overwrite!], targetId)).toBe(false);
    expect(isConnectDenied([overwrite!], targetId)).toBe(true);
  });

  test("block list enforces max of 50 entries", async () => {
    const { channels, blocks, discord } = await setupOwnedChannel();
    for (let i = 0; i < OWNER_BLOCK_LIST_MAX; i += 1) {
      const id = String(2_000_000_000_000_000_000n + BigInt(i));
      const added = await blocks.addBlockedUser(guildId, ownerId, id);
      expect(added.outcome).toBe("added");
    }
    const limit = await blocks.addBlockedUser(guildId, ownerId, targetId);
    expect(limit.outcome).toBe("limit");

    const outcome = await blockUser({
      blocks,
      channels,
      discord,
      logger: testLogger(),
      guildId,
      ownerId,
      targetUserId: targetId,
      requestId: "block-limit",
    });
    expect(outcome.kind).toBe("limit_reached");
  });

  test("/vc permit refuses blocked members", async () => {
    const { channels, blocks, discord, controls } = await setupOwnedChannel();
    await blocks.addBlockedUser(guildId, ownerId, targetId);
    const vc = createVcCommandService({
      channels,
      blocks,
      discord,
      logger: testLogger(),
      metrics: createVcMetrics(),
      cooldowns: createCooldownStore(),
    });

    await vc.execute(
      vcInteraction({
        options: [
          {
            name: "permit",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions[0])).toMatch(/unblock/i);
  });

  test("/vc invite refuses blocked members", async () => {
    const { channels, blocks, discord, controls } = await setupOwnedChannel();
    await blocks.addBlockedUser(guildId, ownerId, targetId);
    const vc = createVcCommandService({
      channels,
      blocks,
      discord,
      logger: testLogger(),
      metrics: createVcMetrics(),
      cooldowns: createCooldownStore(),
    });

    await vc.execute(
      vcInteraction({
        options: [
          {
            name: "invite",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions[0])).toMatch(/blocked/i);
  });

  test("/vc block and unblock via slash + targetUserId fallback", async () => {
    const { channels, blocks, discord, controls } = await setupOwnedChannel();
    const vc = createVcCommandService({
      channels,
      blocks,
      discord,
      logger: testLogger(),
      metrics: createVcMetrics(),
      cooldowns: createCooldownStore(),
    });

    await vc.execute(
      vcInteraction({
        id: "100000000000000011",
        targetUserId: targetId,
        options: [{ name: "block", type: 1 }],
      }),
    );
    expect(embedText(controls.editedInteractions[0])).toMatch(/blocked/i);
    expect(await blocks.getBlockedUserIds(guildId, ownerId)).toEqual([targetId]);

    await vc.execute(
      vcInteraction({
        id: "100000000000000012",
        options: [
          {
            name: "unblock",
            type: 1,
            options: [{ name: "member", type: 6, value: targetId }],
          },
        ],
      }),
    );
    expect(embedText(controls.editedInteractions[1])).toMatch(/unblocked/i);
    expect(await blocks.getBlockedUserIds(guildId, ownerId)).toEqual([]);
  });

  test("claim refuses when claimer is on the owner's block list", async () => {
    const { channels, blocks, discord, controls } = await setupOwnedChannel({
      occupantIds: [targetId],
    });
    await blocks.addBlockedUser(guildId, ownerId, targetId);
    controls.voiceByUser.delete(`${guildId}:${ownerId}`);
    controls.voiceByUser.set(`${guildId}:${targetId}`, channelId);

    const handler = createVoicePanelInteractionHandler({
      channels,
      blocks,
      discord,
      logger: testLogger(),
      botUsername: "Pure",
    });

    await handler.execute(
      panelInteraction({
        userId: targetId,
        customId: `${VOICE_PANEL_PREFIX}:claim:${channelId}:${ownerId}`,
      }),
    );

    expect(embedText(controls.editedInteractions.at(-1))).toMatch(/blocked/i);
    const record = await channels.findByChannelId(channelId);
    expect(record?.ownerId).toBe(ownerId);
  });

  test("ownership transfer syncs the new owner's block list onto the channel", async () => {
    const { channels, blocks, discord, controls } = await setupOwnedChannel({
      occupantIds: [ownerId, targetId],
    });
    controls.voiceByUser.set(`${guildId}:${targetId}`, channelId);

    await blockUser({
      blocks,
      channels,
      discord,
      logger: testLogger(),
      guildId,
      ownerId,
      targetUserId: otherId,
      requestId: "seed-owner-block",
    });
    await blocks.addBlockedUser(guildId, targetId, newOwnerBlockTarget);

    const handler = createVoicePanelInteractionHandler({
      channels,
      blocks,
      discord,
      logger: testLogger(),
      botUsername: "Pure",
    });

    await handler.execute(
      panelInteraction({
        customId: `${VOICE_SELECT_PREFIX}:transfer:${channelId}`,
        selectedUserIds: [targetId],
      }),
    );

    const record = await channels.findByChannelId(channelId);
    expect(record?.ownerId).toBe(targetId);
    expect(record?.appliedBlockUserIds).toEqual([newOwnerBlockTarget]);

    const overwrites = controls.channels.get(channelId)?.permissionOverwrites ?? [];
    expect(isConnectDenied(overwrites, newOwnerBlockTarget)).toBe(true);
    expect(isViewDenied(overwrites, newOwnerBlockTarget)).toBe(true);
    expect(isViewDenied(overwrites, otherId)).toBe(false);
  });

  test("block-list page buttons refresh the ephemeral list", async () => {
    const { channels, blocks, discord, controls } = await setupOwnedChannel();
    const many = Array.from({ length: 12 }, (_, index) =>
      String(3_000_000_000_000_000_000n + BigInt(index)),
    );
    for (const id of many) {
      await blocks.addBlockedUser(guildId, ownerId, id);
    }
    const page = formatBlockListPage({
      blockedUserIds: await blocks.getBlockedUserIds(guildId, ownerId),
      page: 1,
    });
    expect(page.hasNext).toBe(true);

    const handler = createVoicePanelInteractionHandler({
      channels,
      blocks,
      discord,
      logger: testLogger(),
      botUsername: "Pure",
    });
    await handler.execute(
      panelInteraction({
        customId: `${BLOCK_LIST_BUTTON_PREFIX}:${ownerId}:2`,
      }),
    );
    const text = embedText(controls.editedInteractions.at(-1));
    expect(text).toMatch(/Page 2\/2/);
    expect(text).toContain(many[10]!);
  });

  test("block list survives without a temporary channel", async () => {
    const blocks = createMemoryOwnerBlockListRepository();
    await blocks.addBlockedUser(guildId, ownerId, targetId);
    expect(await blocks.getBlockedUserIds(guildId, ownerId)).toEqual([targetId]);
  });
});

describe("block list formatting", () => {
  test("formats empty and multi-page lists", () => {
    expect(formatBlockListPage({ blockedUserIds: [], page: 1 }).description).toMatch(/empty/i);
    const ids = Array.from({ length: 11 }, (_, i) => String(1000 + i));
    const page2 = formatBlockListPage({ blockedUserIds: ids, page: 2 });
    expect(page2.page).toBe(2);
    expect(page2.hasPrev).toBe(true);
    expect(page2.hasNext).toBe(false);
  });
});
