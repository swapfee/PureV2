import type { Logger } from "../logger.ts";
import type { DiscordApiPort, InteractionCreatePayload } from "../runtime-types.ts";
import { ACTION_EMOJIS, failureResponse, successResponse } from "./action-response.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";
import {
  buildDeleteConfirmation,
  buildLimitModal,
  buildRenameModal,
  buildTransferSelect,
  emojiMention,
  OWNER_TRANSFER_GRACE_MS,
  PANEL_EMOJIS,
  parseColonId,
  VOICE_DELETE_PREFIX,
  VOICE_MODAL_PREFIX,
  VOICE_PANEL_PREFIX,
  VOICE_SELECT_PREFIX,
  isVoicePanelAction,
  type VoicePanelAction,
} from "./voice-panel.ts";
import { refreshVoiceControlPanel } from "./voice-panel-service.ts";
import {
  isConnectDenied,
  isViewDenied,
  setEveryoneConnectDenied,
  setEveryoneViewDenied,
} from "./voice-controls.ts";

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

function normalizeChannelName(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 100) return undefined;
  return trimmed;
}

async function replyEphemeral(
  discord: DiscordApiPort,
  interaction: InteractionCreatePayload,
  deferred: boolean,
  message: ReturnType<typeof successResponse>,
): Promise<void> {
  if (deferred) {
    await discord.editInteractionResponse({
      applicationId: interaction.applicationId,
      interactionToken: interaction.token,
      embeds: message.embeds,
    });
    return;
  }
  await discord.respondToInteraction({
    interactionId: interaction.id,
    interactionToken: interaction.token,
    embeds: message.embeds,
    ephemeral: true,
  });
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
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly botUsername: string;
}): {
  handles(interaction: InteractionCreatePayload): boolean;
  execute(interaction: InteractionCreatePayload): Promise<void>;
} {
  const { channels, discord, logger, botUsername } = options;

  return {
    handles(interaction) {
      const customId = interaction.customId;
      if (!customId) return false;
      return (
        customId.startsWith(`${VOICE_PANEL_PREFIX}:`) ||
        customId.startsWith(`${VOICE_MODAL_PREFIX}:`) ||
        customId.startsWith(`${VOICE_SELECT_PREFIX}:`) ||
        customId.startsWith(`${VOICE_DELETE_PREFIX}:`)
      );
    },

    async execute(interaction) {
      const customId = interaction.customId;
      if (!customId) return;
      const parts = parseColonId(customId);

      try {
        if (parts[0] === VOICE_PANEL_PREFIX) {
          await handlePanelButton({ interaction, parts, channels, discord, logger, botUsername });
          return;
        }
        if (parts[0] === VOICE_MODAL_PREFIX) {
          await handleModalSubmit({ interaction, parts, channels, discord, logger });
          return;
        }
        if (parts[0] === VOICE_SELECT_PREFIX) {
          await handleTransferSelect({ interaction, parts, channels, discord, logger, botUsername });
          return;
        }
        if (parts[0] === VOICE_DELETE_PREFIX) {
          await handleDeleteConfirm({ interaction, parts, channels, discord, logger });
        }
      } catch (error) {
        logger.error("Voice panel interaction failed", {
          customId,
          userId: interaction.userId,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await replyEphemeral(
            discord,
            interaction,
            true,
            failureResponse("Action Failed", "Something went wrong. Try again shortly."),
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
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly botUsername: string;
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
        false,
        failureResponse("Action Failed", access.reason),
      );
      return;
    }
    if (access.record.ownerId !== input.interaction.userId) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        false,
        failureResponse("Action Failed", "You must own this voice channel to use its controls."),
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
    return;
  }

  await input.discord.deferInteraction({
    interactionId: input.interaction.id,
    interactionToken: input.interaction.token,
    ephemeral: true,
  });

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
      true,
      failureResponse("Action Failed", access.reason),
    );
    return;
  }

  if (OWNER_ACTIONS.has(action) && access.record.ownerId !== input.interaction.userId) {
    await replyEphemeral(
      input.discord,
      input.interaction,
      true,
      failureResponse("Action Failed", "You must own this voice channel to use its controls."),
    );
    return;
  }

  if (action === "info") {
    const channel = await input.discord.getChannel({ channelId });
    if (channel.kind !== "found") {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Info Failed", "Could not load channel details."),
      );
      return;
    }
    const hidden = isViewDenied(channel.value.permissionOverwrites, access.record.guildId);
    const lockedDiscord = isConnectDenied(channel.value.permissionOverwrites, access.record.guildId);
    await replyEphemeral(
      input.discord,
      input.interaction,
      true,
      {
        embeds: [
          {
            description: [
              `${emojiMention(PANEL_EMOJIS.info)} Channel Info.`,
              `Owner: <@${access.record.ownerId}>`,
              `Name: \`${channel.value.name ?? "unknown"}\``,
              `User limit: ${channel.value.userLimit === undefined || channel.value.userLimit === 0 ? "Unlimited" : String(channel.value.userLimit)}`,
              `Locked: ${access.record.locked || lockedDiscord ? "Yes" : "No"}`,
              `Hidden: ${hidden ? "Yes" : "No"}`,
            ].join("\n"),
          },
        ],
      },
    );
    return;
  }

  if (action === "lock" || action === "unlock") {
    const channel = await input.discord.getChannel({ channelId });
    if (channel.kind !== "found") {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Action Failed", "Could not load channel permissions."),
      );
      return;
    }
    const result = await setEveryoneConnectDenied({
      discord: input.discord,
      channel: channel.value,
      everyoneId: access.record.guildId,
      denied: action === "lock",
      requestId: `panel:${action}:${input.interaction.id}`,
      reason: `panel ${action}`,
    });
    if (result.kind !== "ok") {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Action Failed", `Could not ${action} the channel.`),
      );
      return;
    }
    await input.channels.setLocked(channelId, action === "lock");
    await replyEphemeral(
      input.discord,
      input.interaction,
      true,
      successResponse(action === "lock" ? "Channel locked." : "Channel unlocked."),
    );
    return;
  }

  if (action === "hide" || action === "unhide") {
    const channel = await input.discord.getChannel({ channelId });
    if (channel.kind !== "found") {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Action Failed", "Could not load channel permissions."),
      );
      return;
    }
    const result = await setEveryoneViewDenied({
      discord: input.discord,
      channel: channel.value,
      everyoneId: access.record.guildId,
      denied: action === "hide",
      requestId: `panel:${action}:${input.interaction.id}`,
      reason: `panel ${action}`,
    });
    if (result.kind !== "ok") {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Action Failed", `Could not ${action} the channel.`),
      );
      return;
    }
    await replyEphemeral(
      input.discord,
      input.interaction,
      true,
      successResponse(action === "hide" ? "Channel hidden." : "Channel visible again."),
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
        true,
        failureResponse("Transfer Failed", "No other members are connected to transfer to."),
      );
      return;
    }
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      content: "Select the member who should become the new owner.",
      components: [...buildTransferSelect(channelId)],
    });
    return;
  }

  if (action === "claim") {
    if (access.record.ownerId === input.interaction.userId) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Claim Failed", "You already own this channel."),
      );
      return;
    }
    const ownerVoice = await input.discord.getUserVoiceChannel({
      guildId: access.record.guildId,
      userId: access.record.ownerId,
    });
    if (ownerVoice.kind === "found" && ownerVoice.value.channelId === channelId) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Claim Failed", "The owner is still connected to this channel."),
      );
      return;
    }
    const absentSince = access.record.ownerAbsentSince?.getTime();
    if (absentSince === undefined) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Claim Failed", "Ownership is not available to claim yet."),
      );
      return;
    }
    const remaining = OWNER_TRANSFER_GRACE_MS - (Date.now() - absentSince);
    if (remaining > 0) {
      const minutes = Math.max(1, Math.ceil(remaining / 60_000));
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse(
          "Claim Failed",
          `You can claim ownership in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        ),
      );
      return;
    }
    const transferred = await input.channels.transferOwner(channelId, input.interaction.userId);
    if (!transferred) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Claim Failed", "Could not claim ownership."),
      );
      return;
    }
    await refreshVoiceControlPanel({
      discord: input.discord,
      channels: input.channels,
      logger: input.logger,
      channelId,
      ownerId: input.interaction.userId,
      botUsername: input.botUsername,
      ...(transferred.panelMessageId ? { panelMessageId: transferred.panelMessageId } : {}),
      requestId: `panel:claim:${input.interaction.id}`,
    });
    await replyEphemeral(
      input.discord,
      input.interaction,
      true,
      successResponse("Claim Complete", "You are now the channel owner."),
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
  }
}

async function handleModalSubmit(input: {
  readonly interaction: InteractionCreatePayload;
  readonly parts: readonly string[];
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): Promise<void> {
  const [, action, channelId, extra] = input.parts;
  if (!action || !channelId || extra) return;

  await input.discord.deferInteraction({
    interactionId: input.interaction.id,
    interactionToken: input.interaction.token,
    ephemeral: true,
  });

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
      true,
      failureResponse("Action Failed", access.reason),
    );
    return;
  }
  if (access.record.ownerId !== input.interaction.userId) {
    await replyEphemeral(
      input.discord,
      input.interaction,
      true,
      failureResponse("Action Failed", "You must own this voice channel to use its controls."),
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
        true,
        failureResponse("Rename Failed", "Name must be 1–100 characters."),
      );
      return;
    }
    const channel = await input.discord.getChannel({ channelId });
    if (channel.kind === "found" && channel.value.name === name) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Rename Failed", "That is already the channel name."),
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
        true,
        failureResponse("Rename Failed", "Could not rename the channel."),
      );
      return;
    }
    await replyEphemeral(
      input.discord,
      input.interaction,
      true,
      successResponse("Rename Complete", `Channel renamed to \`${name}\`.`),
    );
    return;
  }

  if (action === "limit") {
    if (!/^\d{1,2}$/.test(raw.trim())) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Limit Failed", "Limit must be an integer from 0 to 99."),
      );
      return;
    }
    const amount = Number(raw.trim());
    if (!Number.isInteger(amount) || amount < 0 || amount > 99) {
      await replyEphemeral(
        input.discord,
        input.interaction,
        true,
        failureResponse("Limit Failed", "Limit must be an integer from 0 to 99."),
      );
      return;
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
        true,
        failureResponse("Limit Failed", "Could not update the user limit."),
      );
      return;
    }
    await replyEphemeral(
      input.discord,
      input.interaction,
      true,
      successResponse(
        "Limit Complete",
        amount === 0 ? "User limit removed." : `User limit set to ${amount}.`,
      ),
    );
  }
}

async function handleTransferSelect(input: {
  readonly interaction: InteractionCreatePayload;
  readonly parts: readonly string[];
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly botUsername: string;
}): Promise<void> {
  const [, action, channelId, extra] = input.parts;
  if (action !== "transfer" || !channelId || extra) return;

  await input.discord.deferUpdateInteraction({
    interactionId: input.interaction.id,
    interactionToken: input.interaction.token,
  });

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
      embeds: failureResponse(
        "Transfer Failed",
        access.ok ? "You must own this voice channel to use its controls." : access.reason,
      ).embeds,
      components: [],
    });
    return;
  }

  const targetUserId = input.interaction.selectedUserIds?.[0];
  if (!targetUserId) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Transfer Failed", "Select a member to transfer ownership to.").embeds,
      components: [],
    });
    return;
  }
  if (targetUserId === input.interaction.userId) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Transfer Failed", "You already own this channel.").embeds,
      components: [],
    });
    return;
  }

  const target = await input.discord.getUser({ userId: targetUserId });
  if (target.kind !== "found" || target.value.bot) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Transfer Failed", "Select a non-bot member.").embeds,
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
      embeds: failureResponse(
        "Transfer Failed",
        "That member must be connected to this channel.",
      ).embeds,
      components: [],
    });
    return;
  }

  const transferred = await input.channels.transferOwner(channelId, targetUserId);
  if (!transferred) {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse(
        "Transfer Failed",
        "Could not transfer ownership. The member may already own another channel.",
      ).embeds,
      components: [],
    });
    return;
  }

  await refreshVoiceControlPanel({
    discord: input.discord,
    channels: input.channels,
    logger: input.logger,
    channelId,
    ownerId: targetUserId,
    botUsername: input.botUsername,
    ...(transferred.panelMessageId ? { panelMessageId: transferred.panelMessageId } : {}),
    requestId: `panel:transfer:${input.interaction.id}`,
  });

  await input.discord.editInteractionResponse({
    applicationId: input.interaction.applicationId,
    interactionToken: input.interaction.token,
    embeds: successResponse("Transfer Complete", `Ownership transferred to <@${targetUserId}>.`)
      .embeds,
    components: [],
  });
}

async function handleDeleteConfirm(input: {
  readonly interaction: InteractionCreatePayload;
  readonly parts: readonly string[];
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): Promise<void> {
  const [, choice, channelId, extra] = input.parts;
  if (!choice || !channelId || extra) return;

  await input.discord.deferUpdateInteraction({
    interactionId: input.interaction.id,
    interactionToken: input.interaction.token,
  });

  if (choice === "cancel") {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      content: "Deletion cancelled.",
      embeds: [],
      components: [],
    });
    return;
  }

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
      embeds: failureResponse(
        "Delete Failed",
        access.ok ? "You must own this voice channel to use its controls." : access.reason,
      ).embeds,
      components: [],
    });
    return;
  }

  const deleted = await input.discord.deleteChannel({
    channelId,
    requestId: `panel:delete:${input.interaction.id}`,
    reason: "panel delete",
  });
  if (deleted.kind !== "ok" && deleted.kind !== "missing") {
    await input.discord.editInteractionResponse({
      applicationId: input.interaction.applicationId,
      interactionToken: input.interaction.token,
      embeds: failureResponse("Delete Failed", "Could not delete the channel.").embeds,
      components: [],
    });
    return;
  }
  await input.channels.remove(channelId);
  await input.discord.editInteractionResponse({
    applicationId: input.interaction.applicationId,
    interactionToken: input.interaction.token,
    embeds: successResponse("Delete Complete", "Temporary channel deleted.").embeds,
    components: [],
  });
}
