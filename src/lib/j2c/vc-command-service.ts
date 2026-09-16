import type { Logger } from "../logger.ts";
import type { DiscordApiPort, InteractionCreatePayload } from "../runtime-types.ts";
import type { CooldownStore } from "../../handlers/cooldowns.ts";
import { failureResponse, successResponse, type ActionMessage } from "./action-response.ts";
import {
  authorizeVcConnectedMember,
  authorizeVcOwner,
  vcAuthUserMessage,
} from "./vc-auth.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";
import type { VcMetrics, VcSubcommand } from "./vc-metrics.ts";
import {
  channelInviteLink,
  isConnectDenied,
  isViewDenied,
  memberAlreadyPermitted,
  memberAlreadyRejected,
  permitMember,
  rejectMember,
  setEveryoneConnectDenied,
  setEveryoneViewDenied,
  temporaryChannelLockMatches,
  temporaryChannelVisibilityMatches,
} from "./voice-controls.ts";
import { refreshVoiceControlPanel } from "./voice-panel-service.ts";

export const VC_COOLDOWNS_MS = {
  invite: 3_000,
  rename: 15_000,
  limit: 3_000,
  lock: 3_000,
  unlock: 3_000,
  hide: 3_000,
  unhide: 3_000,
  permit: 3_000,
  reject: 3_000,
  transfer: 5_000,
  info: 3_000,
  delete: 10_000,
} as const;

const OWNER_SUBCOMMANDS = new Set<VcSubcommand>([
  "rename",
  "limit",
  "lock",
  "unlock",
  "hide",
  "unhide",
  "permit",
  "reject",
  "transfer",
  "delete",
]);

const MEMBER_SUBCOMMANDS = new Set<VcSubcommand>(["invite", "info"]);

function normalizeChannelName(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 100) return undefined;
  return trimmed;
}

function isVcSubcommand(value: string): value is VcSubcommand {
  switch (value) {
    case "invite":
    case "rename":
    case "limit":
    case "lock":
    case "unlock":
    case "hide":
    case "unhide":
    case "permit":
    case "reject":
    case "transfer":
    case "info":
    case "delete":
      return true;
    default:
      return false;
  }
}

function getSubcommand(interaction: InteractionCreatePayload): {
  readonly name: VcSubcommand | undefined;
  readonly options: readonly { name: string; value?: string | number | boolean }[];
} {
  const root = interaction.options?.[0];
  if (!root || typeof root.value === "boolean") {
    return { name: undefined, options: [] };
  }
  if (!isVcSubcommand(root.name)) {
    return { name: undefined, options: [] };
  }
  return {
    name: root.name,
    options: (root.options ?? []).map((option) => ({
      name: option.name,
      ...(option.value === undefined ? {} : { value: option.value }),
    })),
  };
}

function optionValue(
  options: readonly { name: string; value?: string | number | boolean }[],
  name: string,
): string | number | boolean | undefined {
  return options.find((option) => option.name === name)?.value;
}

export interface VcCommandService {
  execute(interaction: InteractionCreatePayload): Promise<void>;
}

export function createVcCommandService(options: {
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly metrics: VcMetrics;
  readonly cooldowns: CooldownStore;
  readonly botUsername?: string;
  readonly completedInteractions?: Set<string>;
}): VcCommandService {
  const completed = options.completedInteractions ?? new Set<string>();

  const reply = async (
    interaction: InteractionCreatePayload,
    deferred: boolean,
    message: ActionMessage,
  ): Promise<void> => {
    if (deferred) {
      await options.discord.editInteractionResponse({
        applicationId: interaction.applicationId,
        interactionToken: interaction.token,
        embeds: message.embeds,
      });
      return;
    }
    await options.discord.respondToInteraction({
      interactionId: interaction.id,
      interactionToken: interaction.token,
      embeds: message.embeds,
      ephemeral: true,
    });
  };

  return {
    async execute(interaction) {
      if (completed.has(interaction.id)) {
        options.metrics.replayDedup();
        return;
      }
      completed.add(interaction.id);

      const sub = getSubcommand(interaction);
      if (!sub.name) {
        await options.discord.respondToInteraction({
          interactionId: interaction.id,
          interactionToken: interaction.token,
          embeds: failureResponse("Action Failed", "Unknown subcommand.").embeds,
          ephemeral: true,
        });
        return;
      }

      options.metrics.attempt(sub.name);
      const subcommand = sub.name;
      await options.discord.deferInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        ephemeral: true,
      });
      const deferred = true;

      const auth =
        OWNER_SUBCOMMANDS.has(subcommand)
          ? await authorizeVcOwner({
              guildId: interaction.guildId,
              userId: interaction.userId,
              channels: options.channels,
              discord: options.discord,
              logger: options.logger,
            })
          : MEMBER_SUBCOMMANDS.has(subcommand)
            ? await authorizeVcConnectedMember({
                guildId: interaction.guildId,
                userId: interaction.userId,
                channels: options.channels,
                discord: options.discord,
                logger: options.logger,
              })
            : ({ ok: false, reason: "dm_not_allowed" } as const);

      if (!auth.ok) {
        options.metrics.authorizationFailure();
        await reply(interaction, deferred, failureResponse("Action Failed", vcAuthUserMessage(auth.reason)));
        return;
      }

      const cooldownKey = `vc:${subcommand}:${auth.channel.channelId}:${interaction.userId}`;
      const remainingMs = options.cooldowns.remaining(cooldownKey);
      if (remainingMs > 0) {
        options.metrics.cooldownRejection();
        await reply(
          interaction,
          deferred,
          failureResponse(
            "Action Failed",
            `Please wait ${Math.ceil(remainingMs / 1000)}s before using this again.`,
          ),
        );
        return;
      }

      const requestId = `vc:${subcommand}:${interaction.id}`;
      const baseLog = {
        guildId: auth.channel.guildId,
        channelId: auth.channel.channelId,
        ownerId: auth.channel.ownerId,
        interactionId: interaction.id,
        requestId,
        operation: subcommand,
      };

      const succeed = async (headline: string, details?: string | readonly string[]): Promise<void> => {
        options.cooldowns.touch(cooldownKey, VC_COOLDOWNS_MS[subcommand]);
        options.metrics.success(subcommand);
        options.logger.info(`VC ${subcommand} succeeded`, { ...baseLog, outcome: "ok" });
        await reply(interaction, deferred, successResponse(headline, details));
      };

      try {
        if (subcommand === "info") {
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Info Failed", "Could not load channel details."),
            );
            return;
          }
          const everyoneId = auth.channel.guildId;
          const hidden = isViewDenied(channel.value.permissionOverwrites, everyoneId);
          const lockedDiscord = isConnectDenied(channel.value.permissionOverwrites, everyoneId);
          await succeed("Channel Info", [
            `Owner: <@${auth.channel.ownerId}>`,
            `Name: \`${channel.value.name ?? "unknown"}\``,
            `Limit: ${channel.value.userLimit === undefined || channel.value.userLimit === 0 ? "unlimited" : String(channel.value.userLimit)}`,
            `Locked: ${auth.channel.locked || lockedDiscord ? "yes" : "no"}`,
            `Hidden: ${hidden ? "yes" : "no"}`,
          ]);
          return;
        }

        if (subcommand === "invite") {
          const targetUserId = optionValue(sub.options, "member");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(interaction, deferred, failureResponse("Invite Failed", "Provide a member to invite."));
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(interaction, deferred, failureResponse("Invite Failed", "You cannot invite yourself."));
            return;
          }
          if (auth.channel.rejectedUserIds.includes(targetUserId)) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Invite Failed", "That member is rejected from this channel."),
            );
            return;
          }
          const target = await options.discord.getUser({ userId: targetUserId });
          if (target.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, deferred, failureResponse("Invite Failed", "Could not look up that user."));
            return;
          }
          if (target.value.bot) {
            options.metrics.validationFailure();
            await reply(interaction, deferred, failureResponse("Invite Failed", "You cannot invite bots."));
            return;
          }
          const targetVoice = await options.discord.getUserVoiceChannel({
            guildId: auth.channel.guildId,
            userId: targetUserId,
          });
          if (targetVoice.kind === "found" && targetVoice.value.channelId === auth.channel.channelId) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Invite Failed", "That member is already connected."),
            );
            return;
          }
          const dm = await options.discord.sendDirectMessage({
            userId: targetUserId,
            content: `You are invited to join a voice channel: ${channelInviteLink(auth.channel.guildId, auth.channel.channelId)}`,
            requestId,
          });
          if (dm.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC invite DM failed", { ...baseLog, targetUserId, outcome: dm.kind });
            await reply(
              interaction,
              deferred,
              failureResponse("Invite Failed", "Could not send a direct message to that member."),
            );
            return;
          }
          await succeed("Invite Complete", "Invitation sent.");
          return;
        }

        if (subcommand === "rename") {
          const rawName = optionValue(sub.options, "name");
          if (typeof rawName !== "string") {
            options.metrics.validationFailure();
            await reply(interaction, deferred, failureResponse("Rename Failed", "Provide a new channel name."));
            return;
          }
          const name = normalizeChannelName(rawName);
          if (!name) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Rename Failed", "Name must be 1–100 characters."),
            );
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, deferred, failureResponse("Rename Failed", "Could not load the channel."));
            return;
          }
          if (channel.value.name === name) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Rename Failed", `The channel is already named \`${name}\`.`),
            );
            return;
          }
          const result = await options.discord.editChannel({
            channelId: auth.channel.channelId,
            requestId,
            name,
            reason: "vc rename",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC rename failed", { ...baseLog, outcome: result.kind });
            await reply(interaction, deferred, failureResponse("Rename Failed", "Could not rename the channel."));
            return;
          }
          await succeed("Rename Complete", `Channel renamed to \`${name}\`.`);
          return;
        }

        if (subcommand === "limit") {
          const amount = optionValue(sub.options, "limit");
          if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > 99) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Limit Failed", "Limit must be an integer from 0 to 99 (0 = unlimited)."),
            );
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, deferred, failureResponse("Limit Failed", "Could not load the channel."));
            return;
          }
          const current = channel.value.userLimit ?? 0;
          if (current === amount) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse(
                "Limit Failed",
                amount === 0
                  ? "The channel limit is already unlimited."
                  : `The channel limit is already ${amount}.`,
              ),
            );
            return;
          }
          const result = await options.discord.editChannel({
            channelId: auth.channel.channelId,
            requestId,
            userLimit: amount,
            reason: "vc limit",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC limit failed", { ...baseLog, outcome: result.kind });
            await reply(
              interaction,
              deferred,
              failureResponse("Limit Failed", "Could not update the user limit."),
            );
            return;
          }
          await succeed(
            "Limit Complete",
            amount === 0 ? "User limit removed." : `User limit set to ${amount}.`,
          );
          return;
        }

        if (subcommand === "lock" || subcommand === "unlock") {
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              deferred,
              failureResponse(
                subcommand === "lock" ? "Lock Failed" : "Unlock Failed",
                "Could not load channel permissions.",
              ),
            );
            return;
          }
          const wantLocked = subcommand === "lock";
          if (
            temporaryChannelLockMatches(
              auth.channel,
              channel.value.permissionOverwrites,
              auth.channel.guildId,
              wantLocked,
            )
          ) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse(
                wantLocked ? "Lock Failed" : "Unlock Failed",
                wantLocked
                  ? "The channel is already locked."
                  : "The channel is already unlocked.",
              ),
            );
            return;
          }
          const result = await setEveryoneConnectDenied({
            discord: options.discord,
            channel: channel.value,
            everyoneId: auth.channel.guildId,
            denied: wantLocked,
            requestId,
            reason: wantLocked ? "vc lock" : "vc unlock",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn(`VC ${subcommand} failed`, { ...baseLog, outcome: result.kind });
            await reply(
              interaction,
              deferred,
              failureResponse(
                wantLocked ? "Lock Failed" : "Unlock Failed",
                `Could not ${subcommand} the channel.`,
              ),
            );
            return;
          }
          await options.channels.setLocked(auth.channel.channelId, wantLocked);
          await succeed(
            wantLocked ? "Lock Complete" : "Unlock Complete",
            wantLocked ? "Channel locked." : "Channel unlocked.",
          );
          return;
        }

        if (subcommand === "hide" || subcommand === "unhide") {
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              deferred,
              failureResponse(
                subcommand === "hide" ? "Hide Failed" : "Unhide Failed",
                "Could not load channel permissions.",
              ),
            );
            return;
          }
          const wantHidden = subcommand === "hide";
          if (
            temporaryChannelVisibilityMatches(
              channel.value.permissionOverwrites,
              auth.channel.guildId,
              wantHidden,
            )
          ) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse(
                wantHidden ? "Hide Failed" : "Unhide Failed",
                wantHidden
                  ? "The channel is already hidden."
                  : "The channel is already visible.",
              ),
            );
            return;
          }
          const result = await setEveryoneViewDenied({
            discord: options.discord,
            channel: channel.value,
            everyoneId: auth.channel.guildId,
            denied: wantHidden,
            requestId,
            reason: wantHidden ? "vc hide" : "vc unhide",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn(`VC ${subcommand} failed`, { ...baseLog, outcome: result.kind });
            await reply(
              interaction,
              deferred,
              failureResponse(
                wantHidden ? "Hide Failed" : "Unhide Failed",
                `Could not ${subcommand} the channel.`,
              ),
            );
            return;
          }
          await succeed(
            wantHidden ? "Hide Complete" : "Unhide Complete",
            wantHidden ? "Channel hidden." : "Channel visible again.",
          );
          return;
        }

        if (subcommand === "permit") {
          const targetUserId = optionValue(sub.options, "member");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(interaction, deferred, failureResponse("Permit Failed", "Provide a member to permit."));
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(interaction, deferred, failureResponse("Permit Failed", "You cannot permit yourself."));
            return;
          }
          const target = await options.discord.getUser({ userId: targetUserId });
          if (target.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, deferred, failureResponse("Permit Failed", "Could not look up that user."));
            return;
          }
          if (target.value.bot) {
            options.metrics.validationFailure();
            await reply(interaction, deferred, failureResponse("Permit Failed", "You cannot permit bots."));
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Permit Failed", "Could not load channel permissions."),
            );
            return;
          }
          if (
            memberAlreadyPermitted(
              channel.value.permissionOverwrites,
              targetUserId,
              auth.channel.rejectedUserIds,
            )
          ) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Permit Failed", "The member is already permitted."),
            );
            return;
          }
          const result = await permitMember({
            discord: options.discord,
            channels: options.channels,
            channel: channel.value,
            record: auth.channel,
            userId: targetUserId,
            requestId,
            reason: "vc permit",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC permit failed", { ...baseLog, targetUserId, outcome: result.kind });
            await reply(interaction, deferred, failureResponse("Permit Failed", "Could not update permissions."));
            return;
          }
          await succeed("Permit Complete", "Member can now view and join this channel.");
          return;
        }

        if (subcommand === "reject") {
          const targetUserId = optionValue(sub.options, "member");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(interaction, deferred, failureResponse("Reject Failed", "Provide a member to reject."));
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(interaction, deferred, failureResponse("Reject Failed", "You cannot reject yourself."));
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Reject Failed", "Could not load channel permissions."),
            );
            return;
          }
          const targetVoice = await options.discord.getUserVoiceChannel({
            guildId: auth.channel.guildId,
            userId: targetUserId,
          });
          const connectedToChannel =
            targetVoice.kind === "found" && targetVoice.value.channelId === auth.channel.channelId;
          if (
            memberAlreadyRejected(
              channel.value.permissionOverwrites,
              targetUserId,
              auth.channel.rejectedUserIds,
              connectedToChannel,
            )
          ) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Reject Failed", "The member is already rejected."),
            );
            return;
          }
          const result = await rejectMember({
            discord: options.discord,
            channels: options.channels,
            channel: channel.value,
            record: auth.channel,
            userId: targetUserId,
            requestId,
            reason: "vc reject",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC reject failed", { ...baseLog, targetUserId, outcome: result.kind });
            await reply(interaction, deferred, failureResponse("Reject Failed", "Could not reject that member."));
            return;
          }
          await succeed("Reject Complete", "Member denied and disconnected if present.");
          return;
        }

        if (subcommand === "transfer") {
          const targetUserId = optionValue(sub.options, "member");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Transfer Failed", "Provide a member to transfer ownership to."),
            );
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Transfer Failed", "You already own this channel."),
            );
            return;
          }
          const target = await options.discord.getUser({ userId: targetUserId });
          if (target.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Transfer Failed", "Could not look up that user."),
            );
            return;
          }
          if (target.value.bot) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Transfer Failed", "You cannot transfer ownership to a bot."),
            );
            return;
          }
          if (auth.channel.rejectedUserIds.includes(targetUserId)) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Transfer Failed", "That member is rejected from this channel."),
            );
            return;
          }
          const targetVoice = await options.discord.getUserVoiceChannel({
            guildId: auth.channel.guildId,
            userId: targetUserId,
          });
          if (targetVoice.kind !== "found" || targetVoice.value.channelId !== auth.channel.channelId) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Transfer Failed", "That member must be connected to this channel."),
            );
            return;
          }
          const transferred = await options.channels.transferOwner(auth.channel.channelId, targetUserId);
          if (!transferred) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse(
                "Transfer Failed",
                "Could not transfer ownership. The member may already own another channel.",
              ),
            );
            return;
          }
          if (options.botUsername) {
            try {
              await refreshVoiceControlPanel({
                discord: options.discord,
                channels: options.channels,
                logger: options.logger,
                channelId: auth.channel.channelId,
                ownerId: targetUserId,
                botUsername: options.botUsername,
                ...(transferred.panelMessageId ? { panelMessageId: transferred.panelMessageId } : {}),
                requestId: `${requestId}:panel`,
              });
            } catch (error) {
              options.logger.warn("VC transfer panel refresh failed", {
                ...baseLog,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          await succeed("Transfer Complete", `Ownership transferred to <@${targetUserId}>.`);
          return;
        }

        if (subcommand === "delete") {
          const deleted = await options.discord.deleteChannel({
            channelId: auth.channel.channelId,
            requestId,
            reason: "vc delete",
          });
          if (deleted.kind !== "ok" && deleted.kind !== "missing") {
            options.metrics.restFailure();
            options.logger.warn("VC delete failed", { ...baseLog, outcome: deleted.kind });
            await reply(interaction, deferred, failureResponse("Delete Failed", "Could not delete the channel."));
            return;
          }
          await options.channels.remove(auth.channel.channelId);
          await succeed("Delete Complete", "Temporary channel deleted.");
        }
      } catch (error) {
        options.metrics.restFailure();
        options.logger.error("VC command failed", {
          ...baseLog,
          error: error instanceof Error ? error.message : "unknown",
        });
        await reply(
          interaction,
          deferred,
          failureResponse("Action Failed", "Something went wrong. Try again shortly."),
        );
      }
    },
  };
}
