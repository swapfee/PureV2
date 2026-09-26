import type { Logger } from "../logger.ts";
import type { DiscordApiPort, InteractionCreatePayload } from "../runtime-types.ts";
import type { CooldownStore } from "../../handlers/cooldowns.ts";
import { cooldownFailureMessage } from "../discord-timestamp.ts";
import { failureResponse, successResponse, type ActionMessage } from "./action-response.ts";
import { beginEphemeralProgress } from "./interaction-progress.ts";
import { postGuildErrorLog, solutionForDiscordOutcome } from "./guild-error-log.ts";
import {
  authorizeVcConnectedMember,
  authorizeVcOwner,
  vcAuthUserMessage,
} from "./vc-auth.ts";
import type { TemporaryChannelRepository, GuildConfigRepository, OwnerBlockListRepository } from "./repositories.ts";
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
import { applyOwnerHandoffPresentation } from "./owner-handoff.ts";
import {
  blockUser,
  buildBlockListComponents,
  formatBlockListPage,
  unblockUser,
} from "./block-list-actions.ts";
import { syncBlocksAfterOwnershipChange } from "./owner-block-sync.ts";
import {
  bitsToKbps,
  formatVoiceRegion,
  isVoiceRegionValue,
  kbpsToBits,
  maxVoiceBitrateKbps,
  normalizeVoiceStatus,
  VOICE_BITRATE_MIN_KBPS,
  VOICE_REGION_AUTOMATIC,
  VOICE_STATUS_MAX_LENGTH,
} from "./voice-channel-settings.ts";
import {
  buildJoinRequestComponents,
  buildJoinRequestKey,
  channelIsLockedForJoinRequests,
  cancelPendingJoinRequestsForChannel,
  finalizeJoinRequestMessage,
  formatJoinRequestEmbed,
  hasPendingJoinRequest,
  registerPendingJoinRequest,
  resolveManagedChannelTarget,
  VC_JOIN_REQUEST_TTL_MS,
} from "./vc-join-request.ts";
import { isSnowflake } from "../../models/snowflake.ts";

export const VC_COOLDOWNS_MS = {
  invite: 3_000,
  request: 10_000,
  rename: 15_000,
  limit: 3_000,
  bitrate: 3_000,
  status: 3_000,
  nsfw: 3_000,
  region: 5_000,
  lock: 3_000,
  unlock: 3_000,
  hide: 3_000,
  unhide: 3_000,
  permit: 3_000,
  reject: 3_000,
  mute: 3_000,
  unmute: 3_000,
  transfer: 5_000,
  info: 3_000,
  delete: 10_000,
  block: 3_000,
  unblock: 3_000,
  "block-list": 3_000,
} as const;

const OWNER_SUBCOMMANDS = new Set<VcSubcommand>([
  "rename",
  "limit",
  "bitrate",
  "status",
  "nsfw",
  "region",
  "lock",
  "unlock",
  "hide",
  "unhide",
  "permit",
  "reject",
  "mute",
  "unmute",
  "transfer",
  "delete",
]);

const MEMBER_SUBCOMMANDS = new Set<VcSubcommand>(["invite", "info"]);

/** Guild-scoped personal list commands — no temporary channel required. */
const PERSONAL_SUBCOMMANDS = new Set<VcSubcommand>(["block", "unblock", "block-list"]);

/** Guild-scoped join requests — target a locked managed channel by id/owner. */
const REQUEST_SUBCOMMANDS = new Set<VcSubcommand>(["request"]);

const VC_PROGRESS_MESSAGES: Readonly<Record<VcSubcommand, string>> = {
  invite: "Creating voice channel invitation...",
  request: "Sending join request...",
  rename: "Renaming voice channel...",
  limit: "Updating voice channel limit...",
  bitrate: "Updating voice channel bitrate...",
  status: "Updating voice channel status...",
  nsfw: "Updating voice channel age restriction...",
  region: "Updating voice channel region...",
  lock: "Locking voice channel...",
  unlock: "Unlocking voice channel...",
  hide: "Hiding voice channel...",
  unhide: "Making voice channel visible...",
  permit: "Updating member access...",
  reject: "Updating member access...",
  mute: "Muting member...",
  unmute: "Unmuting member...",
  transfer: "Transferring voice channel ownership...",
  info: "Loading voice channel information...",
  delete: "Deleting voice channel...",
  block: "Updating block list...",
  unblock: "Updating block list...",
  "block-list": "Loading block list...",
};

function normalizeChannelName(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 100) return undefined;
  return trimmed;
}

function isVcSubcommand(value: string): value is VcSubcommand {
  switch (value) {
    case "invite":
    case "request":
    case "rename":
    case "limit":
    case "bitrate":
    case "status":
    case "nsfw":
    case "region":
    case "lock":
    case "unlock":
    case "hide":
    case "unhide":
    case "permit":
    case "reject":
    case "mute":
    case "unmute":
    case "transfer":
    case "info":
    case "delete":
    case "block":
    case "unblock":
    case "block-list":
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
  readonly configs?: GuildConfigRepository;
  readonly blocks?: OwnerBlockListRepository;
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
    initialResponseSent: boolean,
    message: ActionMessage,
  ): Promise<void> => {
    if (initialResponseSent) {
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
          embeds: failureResponse("Unknown subcommand.").embeds,
          ephemeral: true,
        });
        return;
      }

      options.metrics.attempt(sub.name);
      const subcommand = sub.name;
      await beginEphemeralProgress({
        discord: options.discord,
        interaction,
        message: VC_PROGRESS_MESSAGES[subcommand],
      });
      const initialResponseSent = true;

      if (PERSONAL_SUBCOMMANDS.has(subcommand)) {
        if (!interaction.guildId) {
          options.metrics.authorizationFailure();
          await reply(interaction, initialResponseSent, failureResponse("This command can only be used in a server."));
          return;
        }
        const guildId = interaction.guildId;
        const cooldownKey = `vc:${subcommand}:${guildId}:${interaction.userId}`;
        const remainingMs = options.cooldowns.remaining(cooldownKey);
        if (remainingMs > 0) {
          options.metrics.cooldownRejection();
          await reply(
            interaction,
            initialResponseSent,
            failureResponse(cooldownFailureMessage(remainingMs)),
          );
          return;
        }
        if (!options.blocks) {
          await reply(interaction, initialResponseSent, failureResponse("The block list is currently unavailable."));
          return;
        }
        const requestId = `vc:${subcommand}:${interaction.id}`;
        try {
          if (subcommand === "block" || subcommand === "unblock") {
            const targetFromOption = optionValue(sub.options, "member");
            const targetUserId =
              typeof targetFromOption === "string"
                ? targetFromOption
                : interaction.targetUserId;
            if (typeof targetUserId !== "string") {
              options.metrics.validationFailure();
              await reply(
                interaction,
                initialResponseSent,
                failureResponse(`Specify a member to ${subcommand}.`),
              );
              return;
            }
            if (subcommand === "block") {
              const outcome = await blockUser({
                blocks: options.blocks,
                channels: options.channels,
                discord: options.discord,
                logger: options.logger,
                guildId,
                ownerId: interaction.userId,
                targetUserId,
                requestId,
              });
              options.cooldowns.touch(cooldownKey, VC_COOLDOWNS_MS.block);
              if (outcome.kind === "ok") {
                options.metrics.success("block");
                await reply(
                  interaction,
                  initialResponseSent,
                  successResponse(
                    outcome.partialSync
                      ? `<@${targetUserId}> has been blocked. Some channels could not be updated.`
                      : `<@${targetUserId}> has been blocked.`,
                  ),
                );
                return;
              }
              options.metrics.validationFailure();
              const message =
                outcome.kind === "cannot_block_self"
                  ? "You cannot block yourself."
                  : outcome.kind === "cannot_block_bot"
                    ? "You cannot block bots."
                    : outcome.kind === "already_blocked"
                      ? "That member is already on your block list."
                      : outcome.kind === "limit_reached"
                        ? "Your block list is full (maximum 50 members)."
                        : "Unable to resolve that user.";
              await reply(interaction, initialResponseSent, failureResponse(message));
              return;
            }

            const outcome = await unblockUser({
              blocks: options.blocks,
              channels: options.channels,
              discord: options.discord,
              logger: options.logger,
              guildId,
              ownerId: interaction.userId,
              targetUserId,
              requestId,
            });
            options.cooldowns.touch(cooldownKey, VC_COOLDOWNS_MS.unblock);
            if (outcome.kind === "ok") {
              options.metrics.success("unblock");
              await reply(
                interaction,
                initialResponseSent,
                successResponse(
                  outcome.partialSync
                    ? `<@${targetUserId}> has been unblocked. Some channels could not be updated.`
                    : `<@${targetUserId}> has been unblocked.`,
                ),
              );
              return;
            }
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("That member is not on your block list."));
            return;
          }

          if (subcommand === "block-list") {
            const blockedUserIds = await options.blocks.getBlockedUserIds(guildId, interaction.userId);
            const page = formatBlockListPage({ blockedUserIds, page: 1 });
            options.cooldowns.touch(cooldownKey, VC_COOLDOWNS_MS["block-list"]);
            options.metrics.success("block-list");
            await options.discord.editInteractionResponse({
              applicationId: interaction.applicationId,
              interactionToken: interaction.token,
              embeds: [{ description: page.description }],
              components: [
                ...buildBlockListComponents({
                  ownerId: interaction.userId,
                  page: page.page,
                  hasPrev: page.hasPrev,
                  hasNext: page.hasNext,
                }),
              ],
            });
            return;
          }
        } catch (error: unknown) {
          options.logger.error("VC personal command failed", {
            guildId,
            userId: interaction.userId,
            subcommand,
            error: error instanceof Error ? error.message : String(error),
          });
          if (options.configs) {
            await postGuildErrorLog({
              discord: options.discord,
              configs: options.configs,
              logger: options.logger,
              guildId,
              requestId: `vc:${subcommand}:${interaction.id}:error-log`,
              entry: {
                area: "voice_management",
                summary: `Unexpected failure while running \`/vc ${subcommand}\`.`,
                detail: error instanceof Error ? error.message : String(error),
                solution:
                  "Retry the command. Confirm the bot still has access to the channel, then try again.",
                userId: interaction.userId,
              },
            });
          }
          await reply(
            interaction,
            initialResponseSent,
            failureResponse("An unexpected error occurred. Please try again."),
          );
        }
        return;
      }

      if (!interaction.guildId) {
        options.metrics.authorizationFailure();
        await reply(
          interaction,
          initialResponseSent,
          failureResponse("This command can only be used in a server."),
        );
        return;
      }

      if (options.configs) {
        const config = await options.configs.findByGuildId(interaction.guildId);
        if (!config || !config.enabled) {
          options.metrics.authorizationFailure();
          await reply(
            interaction,
            initialResponseSent,
            failureResponse("Join to Create System is not configured in this server."),
          );
          return;
        }
      }

      if (REQUEST_SUBCOMMANDS.has(subcommand)) {
        const guildId = interaction.guildId;
        const cooldownKey = `vc:${subcommand}:${guildId}:${interaction.userId}`;
        const remainingMs = options.cooldowns.remaining(cooldownKey);
        if (remainingMs > 0) {
          options.metrics.cooldownRejection();
          await reply(
            interaction,
            initialResponseSent,
            failureResponse(cooldownFailureMessage(remainingMs)),
          );
          return;
        }

        const requestId = `vc:${subcommand}:${interaction.id}`;
        const baseLog = {
          guildId,
          userId: interaction.userId,
          interactionId: interaction.id,
          requestId,
          operation: subcommand,
        };

        try {
          const rawTarget = optionValue(sub.options, "target");
          if (typeof rawTarget !== "string" || !isSnowflake(rawTarget.trim())) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Specify a valid voice channel ID or channel owner ID."),
            );
            return;
          }
          const target = rawTarget.trim();
          const record = await resolveManagedChannelTarget({
            guildId,
            target,
            channels: options.channels,
          });
          if (!record) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("No managed temporary voice channel matched that target."),
            );
            return;
          }
          if (record.ownerId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("You already own that channel."),
            );
            return;
          }
          if (record.rejectedUserIds.includes(interaction.userId)) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("You are rejected from that channel."),
            );
            return;
          }
          if (options.blocks) {
            const blocked = await options.blocks.getBlockedUserIds(guildId, record.ownerId);
            if (blocked.includes(interaction.userId)) {
              options.metrics.validationFailure();
              await reply(
                interaction,
                initialResponseSent,
                failureResponse("You are blocked from this channel by its owner."),
              );
              return;
            }
          }

          const channel = await options.discord.getChannel({ channelId: record.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to load the channel."));
            return;
          }
          if (!channelIsLockedForJoinRequests(record, channel.value)) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("That channel is not locked."),
            );
            return;
          }
          if (
            memberAlreadyPermitted(
              channel.value.permissionOverwrites,
              interaction.userId,
              record.rejectedUserIds,
            )
          ) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("You already have access to that channel."),
            );
            return;
          }

          const voice = await options.discord.getUserVoiceChannel({
            guildId,
            userId: interaction.userId,
          });
          if (voice.kind === "found" && voice.value.channelId === record.channelId) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("You are already connected to that channel."),
            );
            return;
          }

          if (hasPendingJoinRequest(record.channelId, interaction.userId)) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("You already have a pending join request for that channel."),
            );
            return;
          }

          const expiresAt = Date.now() + VC_JOIN_REQUEST_TTL_MS;
          const sent = await options.discord.sendChannelMessage({
            channelId: record.channelId,
            requestId: `${requestId}:message`,
            embeds: [
              formatJoinRequestEmbed({
                requesterId: interaction.userId,
                ownerId: record.ownerId,
                expiresAt,
              }),
            ],
            components: [
              ...buildJoinRequestComponents({
                channelId: record.channelId,
                requesterId: interaction.userId,
                expiresAt,
              }),
            ],
          });
          if (sent.kind !== "found") {
            options.metrics.restFailure();
            options.logger.warn("VC join request message failed", {
              ...baseLog,
              channelId: record.channelId,
              outcome: sent.kind,
            });
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to post the join request in that channel."),
            );
            return;
          }

          const requestKey = buildJoinRequestKey(interaction.id);
          registerPendingJoinRequest(
            {
              requestKey,
              guildId,
              channelId: record.channelId,
              ownerId: record.ownerId,
              requesterId: interaction.userId,
              messageId: sent.value.id,
              expiresAt,
            },
            async (pending) => {
              await finalizeJoinRequestMessage({
                discord: options.discord,
                channelId: pending.channelId,
                messageId: pending.messageId,
                requesterId: pending.requesterId,
                ownerId: pending.ownerId,
                expiresAt: pending.expiresAt,
                outcome: "expired",
                requestId: `${pending.requestKey}:expire`,
              });
            },
          );

          options.cooldowns.touch(cooldownKey, VC_COOLDOWNS_MS.request);
          options.metrics.success("request");
          options.logger.info("VC request succeeded", {
            ...baseLog,
            channelId: record.channelId,
            ownerId: record.ownerId,
            outcome: "ok",
          });
          await reply(
            interaction,
            initialResponseSent,
            successResponse(
              `Join request sent to <#${record.channelId}>. The owner has 60 seconds to respond.`,
            ),
          );
        } catch (error: unknown) {
          options.metrics.restFailure();
          options.logger.error("VC request command failed", {
            ...baseLog,
            error: error instanceof Error ? error.message : String(error),
          });
          await reply(
            interaction,
            initialResponseSent,
            failureResponse("An unexpected error occurred. Please try again."),
          );
        }
        return;
      }

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
        await reply(interaction, initialResponseSent, failureResponse(vcAuthUserMessage(auth.reason)));
        return;
      }

      const cooldownKey = `vc:${subcommand}:${auth.channel.channelId}:${interaction.userId}`;
      const remainingMs = options.cooldowns.remaining(cooldownKey);
      if (remainingMs > 0) {
        options.metrics.cooldownRejection();
        await reply(
          interaction,
          initialResponseSent,
          failureResponse(cooldownFailureMessage(remainingMs)),
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

      const succeed = async (message: string): Promise<void> => {
        options.cooldowns.touch(cooldownKey, VC_COOLDOWNS_MS[subcommand]);
        options.metrics.success(subcommand);
        options.logger.info(`VC ${subcommand} succeeded`, { ...baseLog, outcome: "ok" });
        await reply(interaction, initialResponseSent, successResponse(message));
      };

      try {
        if (subcommand === "info") {
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to load channel details."),
            );
            return;
          }
          const everyoneId = auth.channel.guildId;
          const hidden = isViewDenied(channel.value.permissionOverwrites, everyoneId);
          const lockedDiscord = isConnectDenied(channel.value.permissionOverwrites, everyoneId);
          const limit =
            channel.value.userLimit === undefined || channel.value.userLimit === 0
              ? "unlimited"
              : String(channel.value.userLimit);
          const bitrate =
            channel.value.bitrate === undefined
              ? "unknown"
              : `${bitsToKbps(channel.value.bitrate)} kbps`;
          const region = formatVoiceRegion(channel.value.rtcRegion);
          const ageRestricted = channel.value.nsfw === true ? "yes" : "no";
          const statusText =
            channel.value.status && channel.value.status.length > 0
              ? channel.value.status
              : "none";
          await succeed(
            `Owner <@${auth.channel.ownerId}> · \`${channel.value.name ?? "unknown"}\` · limit ${limit} · bitrate ${bitrate} · region ${region} · age-restricted ${ageRestricted} · status ${statusText} · locked ${auth.channel.locked || lockedDiscord ? "yes" : "no"} · hidden ${hidden ? "yes" : "no"}`,
          );
          return;
        }

        if (subcommand === "invite") {
          const targetUserId = optionValue(sub.options, "member");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("Specify a member to invite."));
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("You cannot invite yourself."));
            return;
          }
          if (auth.channel.rejectedUserIds.includes(targetUserId)) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("That member is rejected from this channel."),
            );
            return;
          }
          if (options.blocks) {
            const blocked = await options.blocks.getBlockedUserIds(
              auth.channel.guildId,
              auth.channel.ownerId,
            );
            if (blocked.includes(targetUserId)) {
              options.metrics.validationFailure();
              await reply(
                interaction,
                initialResponseSent,
                failureResponse("That member is blocked from this channel."),
              );
              return;
            }
          }
          const target = await options.discord.getUser({ userId: targetUserId });
          if (target.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to resolve that user."));
            return;
          }
          if (target.value.bot) {
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("You cannot invite bots."));
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
              initialResponseSent,
              failureResponse("That member is already connected to this channel."),
            );
            return;
          }
          const dm = await options.discord.sendDirectMessage({
            userId: targetUserId,
            content: `You have been invited to a temporary voice channel:\n${channelInviteLink(auth.channel.guildId, auth.channel.channelId)}`,
            requestId,
          });
          if (dm.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC invite DM failed", { ...baseLog, targetUserId, outcome: dm.kind });
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to send a direct message to that member."),
            );
            return;
          }
          await succeed("Invitation sent.");
          return;
        }

        if (subcommand === "rename") {
          const rawName = optionValue(sub.options, "name");
          if (typeof rawName !== "string") {
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("Specify a new channel name."));
            return;
          }
          const name = normalizeChannelName(rawName);
          if (!name) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Channel name must be 1–100 characters."),
            );
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to load the channel."));
            return;
          }
          if (channel.value.name === name) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(`The channel is already named \`${name}\`.`),
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
            await reply(interaction, initialResponseSent, failureResponse("Unable to rename the channel."));
            return;
          }
          await succeed(`Channel renamed to \`${name}\`.`);
          return;
        }

        if (subcommand === "limit") {
          const amount = optionValue(sub.options, "limit");
          if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > 99) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("User limit must be an integer from 0 to 99 (0 = unlimited)."),
            );
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to load the channel."));
            return;
          }
          const current = channel.value.userLimit ?? 0;
          if (current === amount) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(amount === 0
                  ? "The user limit is already unlimited."
                  : `The user limit is already ${amount}.`),
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
              initialResponseSent,
              failureResponse("Unable to update the user limit."),
            );
            return;
          }
          await succeed(amount === 0 ? "User limit removed." : `User limit set to ${amount}.`);
          return;
        }

        if (subcommand === "bitrate") {
          const kbps = optionValue(sub.options, "kbps");
          if (
            typeof kbps !== "number" ||
            !Number.isInteger(kbps) ||
            kbps < VOICE_BITRATE_MIN_KBPS ||
            kbps > 384
          ) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(
                `Bitrate must be an integer from ${VOICE_BITRATE_MIN_KBPS} to 384 kbps.`,
              ),
            );
            return;
          }
          const guild = await options.discord.getGuild({ guildId: auth.channel.guildId });
          if (guild.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to load server boost information."),
            );
            return;
          }
          const maxKbps = maxVoiceBitrateKbps(guild.value.premiumTier, guild.value.features);
          if (kbps > maxKbps) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(
                `Maximum bitrate for this server is ${maxKbps} kbps (boost level ${guild.value.premiumTier}).`,
              ),
            );
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to load the channel."));
            return;
          }
          const currentKbps =
            channel.value.bitrate === undefined ? undefined : bitsToKbps(channel.value.bitrate);
          if (currentKbps === kbps) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(`The channel bitrate is already ${kbps} kbps.`),
            );
            return;
          }
          const result = await options.discord.editChannel({
            channelId: auth.channel.channelId,
            requestId,
            bitrate: kbpsToBits(kbps),
            reason: "vc bitrate",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC bitrate failed", { ...baseLog, outcome: result.kind });
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to update the channel bitrate."),
            );
            return;
          }
          await succeed(`Bitrate set to ${kbps} kbps.`);
          return;
        }

        if (subcommand === "status") {
          const rawText = optionValue(sub.options, "text");
          if (rawText !== undefined && typeof rawText !== "string") {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Status text must be a string."),
            );
            return;
          }
          const nextStatus = normalizeVoiceStatus(
            typeof rawText === "string" ? rawText : undefined,
          );
          if (nextStatus === undefined) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(`Status text must be at most ${VOICE_STATUS_MAX_LENGTH} characters.`),
            );
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to load the channel."));
            return;
          }
          const current = channel.value.status ?? null;
          const currentNormalized = current && current.length > 0 ? current : null;
          if (currentNormalized === nextStatus) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(
                nextStatus === null
                  ? "The channel status is already cleared."
                  : "The channel status is already set to that text.",
              ),
            );
            return;
          }
          const result = await options.discord.setChannelVoiceStatus({
            channelId: auth.channel.channelId,
            requestId,
            status: nextStatus,
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC status failed", { ...baseLog, outcome: result.kind });
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to update the channel status."),
            );
            return;
          }
          await succeed(
            nextStatus === null
              ? "Channel status cleared."
              : `Channel status set to \`${nextStatus}\`.`,
          );
          return;
        }

        if (subcommand === "nsfw") {
          const enabled = optionValue(sub.options, "enabled");
          if (typeof enabled !== "boolean") {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Specify whether age restriction should be enabled."),
            );
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to load the channel."));
            return;
          }
          if ((channel.value.nsfw === true) === enabled) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(
                enabled
                  ? "Age restriction is already enabled."
                  : "Age restriction is already disabled.",
              ),
            );
            return;
          }
          const result = await options.discord.editChannel({
            channelId: auth.channel.channelId,
            requestId,
            nsfw: enabled,
            reason: "vc nsfw",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC nsfw failed", { ...baseLog, outcome: result.kind });
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to update age restriction."),
            );
            return;
          }
          await succeed(enabled ? "Age restriction enabled." : "Age restriction disabled.");
          return;
        }

        if (subcommand === "region") {
          const region = optionValue(sub.options, "region");
          if (typeof region !== "string" || !isVoiceRegionValue(region)) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Select a valid voice region."),
            );
            return;
          }
          const nextRegion = region === VOICE_REGION_AUTOMATIC ? null : region;
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to load the channel."));
            return;
          }
          const current = channel.value.rtcRegion ?? null;
          if (current === nextRegion) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(
                `The channel region is already ${formatVoiceRegion(nextRegion)}.`,
              ),
            );
            return;
          }
          const result = await options.discord.editChannel({
            channelId: auth.channel.channelId,
            requestId,
            rtcRegion: nextRegion,
            reason: "vc region",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC region failed", { ...baseLog, outcome: result.kind });
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to update the channel region."),
            );
            return;
          }
          await succeed(`Region set to ${formatVoiceRegion(nextRegion)}.`);
          return;
        }

        if (subcommand === "lock" || subcommand === "unlock") {
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to load channel permissions."),
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
              initialResponseSent,
              failureResponse(wantLocked
                  ? "The channel is already locked."
                  : "The channel is already unlocked."),
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
              initialResponseSent,
              failureResponse(`Unable to ${subcommand} the channel.`),
            );
            return;
          }
          await options.channels.setLocked(auth.channel.channelId, wantLocked);
          await succeed(wantLocked ? "Channel locked." : "Channel unlocked.");
          return;
        }

        if (subcommand === "hide" || subcommand === "unhide") {
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to load channel permissions."),
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
              initialResponseSent,
              failureResponse(wantHidden
                  ? "The channel is already hidden."
                  : "The channel is already visible."),
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
              initialResponseSent,
              failureResponse(`Unable to ${subcommand} the channel.`),
            );
            return;
          }
          await succeed(wantHidden ? "Channel hidden." : "Channel visible again.");
          return;
        }

        if (subcommand === "permit") {
          const targetUserId = optionValue(sub.options, "member");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("Specify a member to permit."));
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("You cannot permit yourself."));
            return;
          }
          const target = await options.discord.getUser({ userId: targetUserId });
          if (target.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to resolve that user."));
            return;
          }
          if (target.value.bot) {
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("You cannot permit bots."));
            return;
          }
          if (options.blocks) {
            const blocked = await options.blocks.getBlockedUserIds(
              auth.channel.guildId,
              auth.channel.ownerId,
            );
            if (blocked.includes(targetUserId)) {
              options.metrics.validationFailure();
              await reply(
                interaction,
                initialResponseSent,
                failureResponse(
                  "That member is on your block list. Use /vc unblock before permitting them.",
                ),
              );
              return;
            }
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to load channel permissions."),
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
              initialResponseSent,
              failureResponse("The member is already permitted."),
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
            await reply(interaction, initialResponseSent, failureResponse("Unable to update channel permissions."));
            return;
          }
          await succeed("Member can now view and join this channel.");
          return;
        }

        if (subcommand === "reject") {
          const targetUserId = optionValue(sub.options, "member");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("Specify a member to reject."));
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(interaction, initialResponseSent, failureResponse("You cannot reject yourself."));
            return;
          }
          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to load channel permissions."),
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
              initialResponseSent,
              failureResponse("The member is already rejected."),
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
            await reply(interaction, initialResponseSent, failureResponse("Unable to reject that member."));
            return;
          }
          await succeed("Member denied and disconnected if present.");
          return;
        }

        if (subcommand === "mute" || subcommand === "unmute") {
          const wantMuted = subcommand === "mute";
          const targetUserId = optionValue(sub.options, "member");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(`Specify a member to ${subcommand}.`),
            );
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(`You cannot ${subcommand} yourself.`),
            );
            return;
          }
          const target = await options.discord.getUser({ userId: targetUserId });
          if (target.kind !== "found") {
            options.metrics.restFailure();
            await reply(interaction, initialResponseSent, failureResponse("Unable to resolve that user."));
            return;
          }
          if (target.value.bot) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(`You cannot ${subcommand} bots.`),
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
              initialResponseSent,
              failureResponse("That member must be connected to this channel."),
            );
            return;
          }
          if (
            targetVoice.value.serverMuted !== undefined &&
            targetVoice.value.serverMuted === wantMuted
          ) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(wantMuted ? "The member is already muted." : "The member is already unmuted."),
            );
            return;
          }
          const result = await options.discord.setMemberServerMute({
            guildId: auth.channel.guildId,
            userId: targetUserId,
            mute: wantMuted,
            requestId,
            reason: wantMuted ? "vc mute" : "vc unmute",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn(`VC ${subcommand} failed`, {
              ...baseLog,
              targetUserId,
              outcome: result.kind,
            });
            await reply(
              interaction,
              initialResponseSent,
              failureResponse(`Unable to ${subcommand} that member.`),
            );
            return;
          }
          await succeed(wantMuted ? "Member server muted." : "Member server unmuted.");
          return;
        }

        if (subcommand === "transfer") {
          const targetUserId = optionValue(sub.options, "member");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Specify a member to transfer ownership to."),
            );
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("You already own this channel."),
            );
            return;
          }
          const target = await options.discord.getUser({ userId: targetUserId });
          if (target.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to resolve that user."),
            );
            return;
          }
          if (target.value.bot) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("You cannot transfer ownership to a bot."),
            );
            return;
          }
          if (auth.channel.rejectedUserIds.includes(targetUserId)) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("That member is rejected from this channel."),
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
              initialResponseSent,
              failureResponse("That member must be connected to this channel."),
            );
            return;
          }
          const transferred = await options.channels.transferOwner(auth.channel.channelId, targetUserId);
          if (!transferred) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              initialResponseSent,
              failureResponse("Unable to transfer ownership right now."),
            );
            return;
          }
          try {
            await applyOwnerHandoffPresentation({
              discord: options.discord,
              channels: options.channels,
              ...(options.configs ? { configs: options.configs } : {}),
              logger: options.logger,
              guildId: auth.channel.guildId,
              channelId: auth.channel.channelId,
              newOwnerId: targetUserId,
              ...(options.botUsername ? { botUsername: options.botUsername } : {}),
              ...(transferred.panelMessageId ? { panelMessageId: transferred.panelMessageId } : {}),
              requestId,
            });
            if (options.blocks) {
              await syncBlocksAfterOwnershipChange({
                blocks: options.blocks,
                channels: options.channels,
                discord: options.discord,
                logger: options.logger,
                guildId: auth.channel.guildId,
                channelId: auth.channel.channelId,
                newOwnerId: targetUserId,
                requestId: `${requestId}:blocks`,
                ...(options.configs ? { configs: options.configs } : {}),
              });
            }
          } catch (error) {
            options.logger.warn("VC transfer owner presentation update failed", {
              ...baseLog,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          await succeed(`Ownership transferred to <@${targetUserId}>.`);
          return;
        }

        if (subcommand === "delete") {
          await cancelPendingJoinRequestsForChannel({
            discord: options.discord,
            channelId: auth.channel.channelId,
            requestId,
          });
          const deleted = await options.discord.deleteChannel({
            channelId: auth.channel.channelId,
            requestId,
            reason: "vc delete",
          });
          if (deleted.kind !== "ok" && deleted.kind !== "missing") {
            options.metrics.restFailure();
            options.logger.warn("VC delete failed", { ...baseLog, outcome: deleted.kind });
            if (options.configs) {
              await postGuildErrorLog({
                discord: options.discord,
                configs: options.configs,
                logger: options.logger,
                guildId: auth.channel.guildId,
                requestId: `${requestId}:error-log`,
                entry: {
                  area: deleted.kind === "forbidden" ? "permissions" : "voice_management",
                  summary: "Failed to delete a temporary voice channel via `/vc delete`.",
                  detail: `Discord outcome: \`${deleted.kind}\`.`,
                  solution: solutionForDiscordOutcome(deleted.kind),
                  userId: interaction.userId,
                  channelId: auth.channel.channelId,
                },
              });
            }
            await reply(interaction, initialResponseSent, failureResponse("Unable to delete the channel."));
            return;
          }
          await options.channels.remove(auth.channel.channelId);
          await succeed("Temporary channel deleted.");
        }
      } catch (error) {
        options.metrics.restFailure();
        options.logger.error("VC command failed", {
          ...baseLog,
          error: error instanceof Error ? error.message : "unknown",
        });
        if (options.configs) {
          await postGuildErrorLog({
            discord: options.discord,
            configs: options.configs,
            logger: options.logger,
            guildId: auth.channel.guildId,
            requestId: `${requestId}:error-log`,
            entry: {
              area: "voice_management",
              summary: `Unexpected failure while running \`/vc ${subcommand}\`.`,
              detail: error instanceof Error ? error.message : String(error),
              solution:
                "Retry the command. Confirm the bot has Manage Channels / Connect permissions in this category.",
              userId: interaction.userId,
              channelId: auth.channel.channelId,
            },
          });
        }
        await reply(
          interaction,
          initialResponseSent,
          failureResponse("An unexpected error occurred. Please try again."),
        );
      }
    },
  };
}
