import { ChannelTypes } from "discordeno";

import type { Logger } from "../logger.ts";
import type { DiscordApiPort, InteractionCreatePayload } from "../runtime-types.ts";
import { ACTION_EMOJIS, failureResponse, successResponse } from "./action-response.ts";
import { applyOwnerHandoffPresentation } from "./owner-handoff.ts";
import type { GuildConfigRepository, OwnerBlockListRepository, TemporaryChannelRepository } from "./repositories.ts";
import {
  buildDeleteConfirmation,
  buildLimitModal,
  buildRenameModal,
  buildTransferSelect,
  parseColonId,
  VOICE_DELETE_PREFIX,
  VOICE_MODAL_PREFIX,
  VOICE_PANEL_PREFIX,
  VOICE_SELECT_PREFIX,
  isVoicePanelAction,
  type VoicePanelAction,
} from "./voice-panel.ts";
import {
  isConnectDenied,
  isViewDenied,
  setEveryoneConnectDenied,
  setEveryoneViewDenied,
  temporaryChannelLockMatches,
  temporaryChannelVisibilityMatches,
} from "./voice-controls.ts";
import { syncBlocksAfterOwnershipChange } from "./owner-block-sync.ts";
import {
  BLOCK_LIST_BUTTON_PREFIX,
  buildBlockListComponents,
  formatBlockListPage,
} from "./block-list-actions.ts";
import {
  approveJoinRequest,
  buildJoinRequestComponents,
  cancelPendingJoinRequestsForChannel,
  consumePendingJoinRequest,
  finalizeJoinRequestMessage,
  formatJoinRequestResolvedEmbed,
  parseJoinRequestCustomId,
  VC_JOIN_REQUEST_PREFIX,
} from "./vc-join-request.ts";

const OWNER_ACTIONS = new Set<VoicePanelAction>([
  "lock",
  "unlock",
  "hide",
  "unhide",
  "rename",
  "limit",
  "transfer",
  "delete",
]);

interface InteractionReplyState {
  deferred: boolean;
  answered: boolean;
}

function normalizeChannelName(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 100) return undefined;
  return trimmed;
}

async function replyEphemeral(
  discord: DiscordApiPort,
  interaction: InteractionCreatePayload,
  replyState: InteractionReplyState,
  message: ReturnType<typeof successResponse>,
): Promise<void> {
  if (replyState.deferred) {
    await discord.editInteractionResponse({
      applicationId: interaction.applicationId,
      interactionToken: interaction.token,
      embeds: message.embeds,
    });
    replyState.answered = true;
    return;
  }
  await discord.respondToInteraction({
    interactionId: interaction.id,
    interactionToken: interaction.token,
    embeds: message.embeds,
    ephemeral: true,
  });
  replyState.answered = true;
}

async function deferEphemeral(
  discord: DiscordApiPort,
  interaction: InteractionCreatePayload,
  replyState: InteractionReplyState,
): Promise<void> {
  await discord.deferInteraction({
    interactionId: interaction.id,
    interactionToken: interaction.token,
    ephemeral: true,
  });
  replyState.deferred = true;
}

async function deferUpdate(
  discord: DiscordApiPort,
  interaction: InteractionCreatePayload,
  replyState: InteractionReplyState,
): Promise<void> {
  await discord.deferUpdateInteraction({
    interactionId: interaction.id,
    interactionToken: interaction.token,
  });
  replyState.deferred = true;
}

async function requireManagedConnected(options: {
  readonly interaction: InteractionCreatePayload;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly channelId: string;
}): Promise<
  | { readonly ok: true; readonly record: NonNullable<Awaited<ReturnType<TemporaryChannelRepository["findByChannelId"]>>> }
  | { readonly ok: false; readonly reason: string }
> {
  const { interaction, channelId } = options;
  if (!interaction.guildId) {
    return { ok: false, reason: "This command can only be used in a server." };
  }
  if (interaction.channelId !== channelId) {
    return { ok: false, reason: "Use this control inside the managed voice channel." };
  }

  const channel = await options.discord.getChannel({ channelId });
  if (channel.kind !== "found" || channel.value.type !== ChannelTypes.GuildVoice) {
    return { ok: false, reason: "You must be connected to a managed voice channel." };
  }

  const voice = await options.discord.getUserVoiceChannel({
    guildId: interaction.guildId,
    userId: interaction.userId,
  });
  if (voice.kind !== "found" || voice.value.channelId !== channelId) {
    return { ok: false, reason: "You must be connected to a managed voice channel." };
  }

  const record = await options.channels.findByChannelId(channelId);
  if (!record || record.status !== "active" || record.guildId !== interaction.guildId) {
    return { ok: false, reason: "You must be connected to a managed voice channel." };
  }
  return { ok: true, record };
}

export function createVoicePanelInteractionHandler(options: {
  readonly channels: TemporaryChannelRepository;
  readonly configs?: GuildConfigRepository;
  readonly blocks?: OwnerBlockListRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly botUsername: string;
}): {
  handles(interaction: InteractionCreatePayload): boolean;
  execute(interaction: InteractionCreatePayload): Promise<void>;
} {
  const { channels, discord, logger, botUsername } = options;
  const configs = options.configs;
  const blocks = options.blocks;

  return {
    handles(interaction) {
      const customId = interaction.customId;
      if (!customId) return false;
      return (
        customId.startsWith(`${VOICE_PANEL_PREFIX}:`) ||
        customId.startsWith(`${VOICE_MODAL_PREFIX}:`) ||
        customId.startsWith(`${VOICE_SELECT_PREFIX}:`) ||
        customId.startsWith(`${VOICE_DELETE_PREFIX}:`) ||
        customId.startsWith(`${BLOCK_LIST_BUTTON_PREFIX}:`) ||
        customId.startsWith(`${VC_JOIN_REQUEST_PREFIX}:`)
      );
    },

    async execute(interaction) {
      const customId = interaction.customId;
      if (!customId) return;
      const parts = parseColonId(customId);
      const replyState: InteractionReplyState = { deferred: false, answered: false };

      try {
        if (parts[0] === VC_JOIN_REQUEST_PREFIX) {
          await handleJoinRequestButton({
            interaction,
            customId,
            channels,
            ...(blocks ? { blocks } : {}),
            discord,
            logger,
            replyState,
          });
          return;
        }
        if (parts[0] === BLOCK_LIST_BUTTON_PREFIX) {
          await handleBlockListPage({
            interaction,
            parts,
            ...(blocks ? { blocks } : {}),
            discord,
            replyState,
          });
          return;
        }
        if (parts[0] === VOICE_PANEL_PREFIX) {
          await handlePanelButton({
            interaction,
            parts,
            channels,
            ...(configs ? { configs } : {}),
            ...(blocks ? { blocks } : {}),
            discord,
            logger,
            botUsername,
            replyState,
          });
          return;
        }
        if (parts[0] === VOICE_MODAL_PREFIX) {
          await handleModalSubmit({ interaction, parts, channels, discord, logger, replyState });
          return;
        }
        if (parts[0] === VOICE_SELECT_PREFIX) {
          await handleTransferSelect({
            interaction,
            parts,
            channels,
            ...(configs ? { configs } : {}),
            ...(blocks ? { blocks } : {}),
            discord,
            logger,
            botUsername,
            replyState,
          });
          return;
        }
        if (parts[0] === VOICE_DELETE_PREFIX) {
          await handleDeleteConfirm({ interaction, parts, channels, discord, logger, replyState });
        }
      } catch (error) {
        logger.error("Voice panel interaction failed", {
          customId,
          userId: interaction.userId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (replyState.answered) return;
        try {
          await replyEphemeral(
            discord,
            interaction,
            replyState,
            failureResponse("An unexpected error occurred. Please try again."),
          );
        } catch {
          // ignore secondary failure
        }
      }
    },
  };
}

async function handlePanelButton(input: {
  readonly interaction: InteractionCreatePayload;
  readonly parts: readonly string[];
  readonly channels: TemporaryChannelRepository;
  readonly configs?: GuildConfigRepository;
  readonly blocks?: OwnerBlockListRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly botUsername: string;
  readonly replyState: InteractionReplyState;
}): Promise<void> {
  const [, actionRaw, channelId, embeddedOwnerId, extra] = input.parts;
  if (!actionRaw || !channelId || !embeddedOwnerId || extra || !isVoicePanelAction(actionRaw)) {
    return;
  }
  const action = actionRaw;

  if (action === "rename" || action === "limit") {
    const access = await requireManagedConnected({
      interaction: input.interaction,
      channels: input.channels,
      discord: input.discord,
      channelId,
    });
    if (!access.ok) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse(access.reason),
      );
      return;
    }
    if (access.record.ownerId !== input.interaction.userId) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("You must own this voice channel to use its controls."),
      );
      return;
    }
    const modal = action === "rename" ? buildRenameModal(channelId) : buildLimitModal(channelId);
    await input.discord.showModal({
      interactionId: input.interaction.id,
      interactionToken: input.interaction.token,
      title: modal.title,
      customId: modal.customId,
      components: modal.components,
    });
    input.replyState.answered = true;
    return;
  }

  await deferEphemeral(input.discord, input.interaction, input.replyState);

  const access = await requireManagedConnected({
    interaction: input.interaction,
    channels: input.channels,
    discord: input.discord,
    channelId,
  });
  if (!access.ok) {
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      failureResponse(access.reason),
    );
    return;
  }

  if (OWNER_ACTIONS.has(action) && access.record.ownerId !== input.interaction.userId) {
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      failureResponse("You must own this voice channel to use its controls."),
    );
    return;
  }

  if (action === "info") {
    const channel = await input.discord.getChannel({ channelId });
    if (channel.kind !== "found") {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("Unable to load channel details."),
      );
      return;
    }
    const hidden = isViewDenied(channel.value.permissionOverwrites, access.record.guildId);
    const lockedDiscord = isConnectDenied(channel.value.permissionOverwrites, access.record.guildId);
    const limit =
      channel.value.userLimit === undefined || channel.value.userLimit === 0
        ? "Unlimited"
        : String(channel.value.userLimit);
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      successResponse(
        `Owner <@${access.record.ownerId}> · \`${channel.value.name ?? "unknown"}\` · limit ${limit} · locked ${access.record.locked || lockedDiscord ? "Yes" : "No"} · hidden ${hidden ? "Yes" : "No"}`,
      ),
    );
    return;
  }

  if (action === "lock" || action === "unlock") {
    const channel = await input.discord.getChannel({ channelId });
    if (channel.kind !== "found") {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("Unable to load channel permissions."),
      );
      return;
    }
    const wantLocked = action === "lock";
    if (
      temporaryChannelLockMatches(
        access.record,
        channel.value.permissionOverwrites,
        access.record.guildId,
        wantLocked,
      )
    ) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        input.replyState,
        failureResponse(wantLocked ? "The channel is already locked." : "The channel is already unlocked."),
      );
      return;
    }
    const result = await setEveryoneConnectDenied({
      discord: input.discord,
      channel: channel.value,
      everyoneId: access.record.guildId,
      denied: wantLocked,
      requestId: `panel:${action}:${input.interaction.id}`,
      reason: `panel ${action}`,
    });
    if (result.kind !== "ok") {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse(`Unable to ${action} the channel.`),
      );
      return;
    }
    await input.channels.setLocked(channelId, wantLocked);
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      successResponse(wantLocked ? "Channel locked." : "Channel unlocked."),
    );
    return;
  }

  if (action === "hide" || action === "unhide") {
    const channel = await input.discord.getChannel({ channelId });
    if (channel.kind !== "found") {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("Unable to load channel permissions."),
      );
      return;
    }
    const wantHidden = action === "hide";
    if (
      temporaryChannelVisibilityMatches(
        channel.value.permissionOverwrites,
        access.record.guildId,
        wantHidden,
      )
    ) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        input.replyState,
        failureResponse(wantHidden ? "The channel is already hidden." : "The channel is already visible."),
      );
      return;
    }
    const result = await setEveryoneViewDenied({
      discord: input.discord,
      channel: channel.value,
      everyoneId: access.record.guildId,
      denied: wantHidden,
      requestId: `panel:${action}:${input.interaction.id}`,
      reason: `panel ${action}`,
    });
    if (result.kind !== "ok") {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse(`Unable to ${action} the channel.`),
      );
      return;
    }
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      successResponse(wantHidden ? "Channel hidden." : "Channel visible again."),
    );
    return;
  }

  if (action === "transfer") {
    const connectedOthers = access.record.occupantIds.filter(
      (id) => id !== access.record.ownerId,
    );
    if (connectedOthers.length === 0) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("No other members are connected to transfer to."),
      );
      return;
    }
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      content: "Select the member who should become the new owner.",
      components: [...buildTransferSelect(channelId)],
    });
    input.replyState.answered = true;
    return;
  }

  if (action === "claim") {
    if (access.record.ownerId === input.interaction.userId) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("You already own this channel."),
      );
      return;
    }
    if (input.blocks) {
      const ownerBlocks = await input.blocks.getBlockedUserIds(
        access.record.guildId,
        access.record.ownerId,
      );
      if (ownerBlocks.includes(input.interaction.userId)) {
        await replyEphemeral(
          input.discord,
          input.interaction,
          input.replyState,
          failureResponse("You are blocked from this channel by its owner."),
        );
        return;
      }
    }
    const ownerVoice = await input.discord.getUserVoiceChannel({
      guildId: access.record.guildId,
      userId: access.record.ownerId,
    });
    if (ownerVoice.kind === "found" && ownerVoice.value.channelId === channelId) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("The owner is still connected to this channel."),
      );
      return;
    }
    const transferred = await input.channels.transferOwner(channelId, input.interaction.userId);
    if (!transferred) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("Unable to claim ownership."),
      );
      return;
    }
    await applyOwnerHandoffPresentation({
      discord: input.discord,
      channels: input.channels,
      ...(input.configs ? { configs: input.configs } : {}),
      logger: input.logger,
      guildId: access.record.guildId,
      channelId,
      newOwnerId: input.interaction.userId,
      botUsername: input.botUsername,
      requestId: `panel:claim:${input.interaction.id}`,
      ...(transferred.panelMessageId ? { panelMessageId: transferred.panelMessageId } : {}),
    });
    if (input.blocks) {
      await syncBlocksAfterOwnershipChange({
        blocks: input.blocks,
        channels: input.channels,
        discord: input.discord,
        logger: input.logger,
        guildId: access.record.guildId,
        channelId,
        newOwnerId: input.interaction.userId,
        requestId: `panel:claim:${input.interaction.id}:blocks`,
      });
    }
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      successResponse("You are now the channel owner."),
    );
    return;
  }

  if (action === "delete") {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: [
        {
          description: `${ACTION_EMOJIS.error} Are you sure you want to delete this voice channel?`,
        },
      ],
      components: [...buildDeleteConfirmation(channelId)],
    });
    input.replyState.answered = true;
  }
}

async function handleModalSubmit(input: {
  readonly interaction: InteractionCreatePayload;
  readonly parts: readonly string[];
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly replyState: InteractionReplyState;
}): Promise<void> {
  const [, action, channelId, extra] = input.parts;
  if (!action || !channelId || extra) return;

  await deferEphemeral(input.discord, input.interaction, input.replyState);

  const access = await requireManagedConnected({
    interaction: input.interaction,
    channels: input.channels,
    discord: input.discord,
    channelId,
  });
  if (!access.ok) {
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      failureResponse(access.reason),
    );
    return;
  }
  if (access.record.ownerId !== input.interaction.userId) {
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      failureResponse("You must own this voice channel to use its controls."),
    );
    return;
  }

  const raw = input.interaction.componentValues?.value ?? "";
  if (action === "rename") {
    const name = normalizeChannelName(raw);
    if (!name) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("Channel name must be 1–100 characters."),
      );
      return;
    }
    const channel = await input.discord.getChannel({ channelId });
    if (channel.kind === "found" && channel.value.name === name) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse(`The channel is already named \`${name}\`.`),
      );
      return;
    }
    const result = await input.discord.editChannel({
      channelId,
      requestId: `panel:rename:${input.interaction.id}`,
      name,
      reason: "panel rename",
    });
    if (result.kind !== "ok") {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("Unable to rename the channel."),
      );
      return;
    }
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      successResponse(`Channel renamed to \`${name}\`.`),
    );
    return;
  }

  if (action === "limit") {
    if (!/^\d{1,2}$/.test(raw.trim())) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("User limit must be an integer from 0 to 99."),
      );
      return;
    }
    const amount = Number(raw.trim());
    if (!Number.isInteger(amount) || amount < 0 || amount > 99) {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("User limit must be an integer from 0 to 99."),
      );
      return;
    }
    const channel = await input.discord.getChannel({ channelId });
    if (channel.kind === "found") {
      const current = channel.value.userLimit ?? 0;
      if (current === amount) {
        await replyEphemeral(
          input.discord,
          input.interaction,
          input.replyState,
          failureResponse(amount === 0
              ? "The channel limit is already unlimited."
              : `The channel limit is already ${amount}.`),
        );
        return;
      }
    }
    const result = await input.discord.editChannel({
      channelId,
      requestId: `panel:limit:${input.interaction.id}`,
      userLimit: amount,
      reason: "panel limit",
    });
    if (result.kind !== "ok") {
      await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
        failureResponse("Unable to update the user limit."),
      );
      return;
    }
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      successResponse(amount === 0 ? "User limit removed." : `User limit set to ${amount}.`),
    );
  }
}

async function handleTransferSelect(input: {
  readonly interaction: InteractionCreatePayload;
  readonly parts: readonly string[];
  readonly channels: TemporaryChannelRepository;
  readonly configs?: GuildConfigRepository;
  readonly blocks?: OwnerBlockListRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly botUsername: string;
  readonly replyState: InteractionReplyState;
}): Promise<void> {
  const [, action, channelId, extra] = input.parts;
  if (action !== "transfer" || !channelId || extra) return;

  await deferUpdate(input.discord, input.interaction, input.replyState);

  const access = await requireManagedConnected({
    interaction: input.interaction,
    channels: input.channels,
    discord: input.discord,
    channelId,
  });
  if (!access.ok || access.record.ownerId !== input.interaction.userId) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse(access.ok ? "You must own this voice channel to use its controls." : access.reason).embeds,
      components: [],
    });
    return;
  }

  const targetUserId = input.interaction.selectedUserIds?.[0];
  if (!targetUserId) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Select a member to transfer ownership to.").embeds,
      components: [],
    });
    return;
  }
  if (targetUserId === input.interaction.userId) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("You already own this channel.").embeds,
      components: [],
    });
    return;
  }

  const target = await input.discord.getUser({ userId: targetUserId });
  if (target.kind !== "found" || target.value.bot) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Select a non-bot member.").embeds,
      components: [],
    });
    return;
  }

  const targetVoice = await input.discord.getUserVoiceChannel({
    guildId: access.record.guildId,
    userId: targetUserId,
  });
  if (targetVoice.kind !== "found" || targetVoice.value.channelId !== channelId) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("That member must be connected to this channel.").embeds,
      components: [],
    });
    return;
  }

  const transferred = await input.channels.transferOwner(channelId, targetUserId);
  if (!transferred) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Unable to transfer ownership. The member may already own another channel.").embeds,
      components: [],
    });
    return;
  }

  await applyOwnerHandoffPresentation({
    discord: input.discord,
    channels: input.channels,
    ...(input.configs ? { configs: input.configs } : {}),
    logger: input.logger,
    guildId: access.record.guildId,
    channelId,
    newOwnerId: targetUserId,
    botUsername: input.botUsername,
    requestId: `panel:transfer:${input.interaction.id}`,
    ...(transferred.panelMessageId ? { panelMessageId: transferred.panelMessageId } : {}),
  });

  if (input.blocks) {
    await syncBlocksAfterOwnershipChange({
      blocks: input.blocks,
      channels: input.channels,
      discord: input.discord,
      logger: input.logger,
      guildId: access.record.guildId,
      channelId,
      newOwnerId: targetUserId,
      requestId: `panel:transfer:${input.interaction.id}:blocks`,
    });
  }

  await input.discord.editInteractionResponse({
    applicationId: input.interaction.applicationId,
    interactionToken: input.interaction.token,
    embeds: successResponse(`Ownership transferred to <@${targetUserId}>.`)
      .embeds,
    components: [],
  });
}

async function handleBlockListPage(input: {
  readonly interaction: InteractionCreatePayload;
  readonly parts: readonly string[];
  readonly blocks?: OwnerBlockListRepository;
  readonly discord: DiscordApiPort;
  readonly replyState: InteractionReplyState;
}): Promise<void> {
  const [, ownerId, pageRaw, extra] = input.parts;
  if (!ownerId || !pageRaw || extra) return;

  await deferUpdate(input.discord, input.interaction, input.replyState);

  if (!input.interaction.guildId) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("This command can only be used in a server.").embeds,
      components: [],
    });
    input.replyState.answered = true;
    return;
  }

  if (input.interaction.userId !== ownerId) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Only the block list owner can page through it.").embeds,
      components: [],
    });
    input.replyState.answered = true;
    return;
  }

  if (!input.blocks) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("The block list is currently unavailable.").embeds,
      components: [],
    });
    input.replyState.answered = true;
    return;
  }

  const pageNumber = Number(pageRaw);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Invalid block list page.").embeds,
      components: [],
    });
    input.replyState.answered = true;
    return;
  }

  const blockedUserIds = await input.blocks.getBlockedUserIds(
    input.interaction.guildId,
    ownerId,
  );
  const page = formatBlockListPage({ blockedUserIds, page: pageNumber });
  await input.discord.editInteractionResponse({
    applicationId: input.interaction.applicationId,
    interactionToken: input.interaction.token,
    embeds: [{ description: page.description }],
    components: [
      ...buildBlockListComponents({
        ownerId,
        page: page.page,
        hasPrev: page.hasPrev,
        hasNext: page.hasNext,
      }),
    ],
  });
  input.replyState.answered = true;
}

async function handleJoinRequestButton(input: {
  readonly interaction: InteractionCreatePayload;
  readonly customId: string;
  readonly channels: TemporaryChannelRepository;
  readonly blocks?: OwnerBlockListRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly replyState: InteractionReplyState;
}): Promise<void> {
  const parsed = parseJoinRequestCustomId(input.customId);
  if (!parsed) return;

  if (!input.interaction.guildId) {
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      failureResponse("This command can only be used in a server."),
    );
    return;
  }

  const record = await input.channels.findByChannelId(parsed.channelId);
  if (!record || record.status !== "active" || record.guildId !== input.interaction.guildId) {
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      failureResponse("That temporary channel is no longer available."),
    );
    return;
  }

  if (record.ownerId !== input.interaction.userId) {
    await replyEphemeral(
      input.discord,
      input.interaction,
      input.replyState,
      failureResponse("Only the channel owner can respond to this request."),
    );
    return;
  }

  if (parsed.decision === "approve" && parsed.expiresAt > Date.now() && input.blocks) {
    const blocked = await input.blocks.getBlockedUserIds(record.guildId, record.ownerId);
    if (blocked.includes(parsed.requesterId)) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        input.replyState,
        failureResponse(
          "That member is on your block list. Use /vc unblock before approving.",
        ),
      );
      return;
    }
  }

  // Cancel expiry timer before acknowledging the click.
  const pending = consumePendingJoinRequest({
    channelId: parsed.channelId,
    requesterId: parsed.requesterId,
  });
  const messageId = input.interaction.messageId ?? pending?.messageId;
  const requestId = `vc-req:${parsed.decision}:${input.interaction.id}`;

  await deferUpdate(input.discord, input.interaction, input.replyState);

  const publishResolved = async (outcome: "approved" | "declined" | "expired"): Promise<void> => {
    const embeds = [
      formatJoinRequestResolvedEmbed({
        requesterId: parsed.requesterId,
        ownerId: record.ownerId,
        outcome,
      }),
    ];
    const components = [
      ...buildJoinRequestComponents({
        channelId: parsed.channelId,
        requesterId: parsed.requesterId,
        expiresAt: parsed.expiresAt,
        disabled: true,
      }),
    ];

    if (messageId) {
      await finalizeJoinRequestMessage({
        discord: input.discord,
        channelId: parsed.channelId,
        messageId,
        requesterId: parsed.requesterId,
        ownerId: record.ownerId,
        expiresAt: parsed.expiresAt,
        outcome,
        requestId: `${requestId}:message`,
      });
    }

    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      content: "",
      embeds,
      components,
    });
    input.replyState.answered = true;
  };

  if (parsed.expiresAt <= Date.now()) {
    await publishResolved("expired");
    return;
  }

  if (parsed.decision === "decline") {
    await publishResolved("declined");
    return;
  }

  const channel = await input.discord.getChannel({ channelId: parsed.channelId });
  if (channel.kind !== "found") {
    input.logger.warn("Join request approve failed to load channel", {
      channelId: parsed.channelId,
      outcome: channel.kind,
      interactionId: input.interaction.id,
    });
    await publishResolved("declined");
    return;
  }

  const result = await approveJoinRequest({
    discord: input.discord,
    channels: input.channels,
    ...(input.blocks ? { blocks: input.blocks } : {}),
    logger: input.logger,
    record,
    channel: channel.value,
    requesterId: parsed.requesterId,
    requestId: `${requestId}:permit`,
  });

  if (result.kind === "blocked") {
    await publishResolved("declined");
    return;
  }

  if (result.kind === "already_permitted" || result.kind === "ok") {
    await publishResolved("approved");
    return;
  }

  input.logger.warn("Join request approve failed", {
    channelId: parsed.channelId,
    requesterId: parsed.requesterId,
    outcome: result.kind,
    interactionId: input.interaction.id,
  });
  await input.discord.editInteractionResponse({
    applicationId: input.interaction.applicationId,
    interactionToken: input.interaction.token,
    embeds: failureResponse("Unable to approve that join request.").embeds,
    components: [
      ...buildJoinRequestComponents({
        channelId: parsed.channelId,
        requesterId: parsed.requesterId,
        expiresAt: parsed.expiresAt,
        disabled: true,
      }),
    ],
  });
  input.replyState.answered = true;
}

async function handleDeleteConfirm(input: {
  readonly interaction: InteractionCreatePayload;
  readonly parts: readonly string[];
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly replyState: InteractionReplyState;
}): Promise<void> {
  const [, choice, channelId, extra] = input.parts;
  if (!choice || !channelId || extra) return;

  await deferUpdate(input.discord, input.interaction, input.replyState);

  const access = await requireManagedConnected({
    interaction: input.interaction,
    channels: input.channels,
    discord: input.discord,
    channelId,
  });
  if (!access.ok || access.record.ownerId !== input.interaction.userId) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse(access.ok ? "You must own this voice channel to use its controls." : access.reason).embeds,
      components: [],
    });
    input.replyState.answered = true;
    return;
  }

  if (choice === "cancel") {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      content: "Deletion cancelled.",
      embeds: [],
      components: [],
    });
    input.replyState.answered = true;
    return;
  }

  const requestId = `panel:delete:${input.interaction.id}`;
  await cancelPendingJoinRequestsForChannel({
    discord: input.discord,
    channelId,
    requestId,
  });
  const deleted = await input.discord.deleteChannel({
    channelId,
    requestId,
    reason: "panel delete",
  });
  if (deleted.kind !== "ok" && deleted.kind !== "missing") {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Unable to delete the channel.").embeds,
      components: [],
    });
    input.replyState.answered = true;
    return;
  }
  await input.channels.remove(channelId);
  // Channel (and this confirmation message) are gone — do not edit the interaction.
  input.replyState.answered = true;
}
