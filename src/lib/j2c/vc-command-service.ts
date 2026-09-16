import { BitwisePermissionFlags } from "discordeno";

import type { Logger } from "../logger.ts";
import type { DiscordApiPort, InteractionCreatePayload, PermissionOverwrite } from "../runtime-types.ts";
import type { CooldownStore } from "../../handlers/cooldowns.ts";
import { failureResponse, successResponse, type ActionMessage } from "./action-response.ts";
import { authorizeVcOwner, vcAuthUserMessage } from "./vc-auth.ts";
import type { OwnershipService } from "./ownership.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";
import type { VcMetrics, VcSubcommand } from "./vc-metrics.ts";

export const VC_COOLDOWNS_MS = {
  invite: 3_000,
  rename: 15_000,
  limit: 3_000,
  lock: 3_000,
  unlock: 3_000,
} as const;

const VIEW_CHANNEL = BitwisePermissionFlags.VIEW_CHANNEL;
const CONNECT = BitwisePermissionFlags.CONNECT;

function parseBits(value: string | undefined): bigint {
  if (!value || value.length === 0) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function bitsToString(value: bigint): string {
  return value.toString();
}

function findOverwrite(
  overwrites: readonly PermissionOverwrite[] | undefined,
  id: string,
): PermissionOverwrite | undefined {
  return overwrites?.find((overwrite) => overwrite.id === id);
}

function normalizeChannelName(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 100) return undefined;
  return trimmed;
}

function getSubcommand(interaction: InteractionCreatePayload): {
  readonly name: VcSubcommand | undefined;
  readonly options: readonly { name: string; value?: string | number | boolean }[];
} {
  const root = interaction.options?.[0];
  if (!root || typeof root.value === "boolean") {
    return { name: undefined, options: [] };
  }
  const name = root.name;
  if (name !== "invite" && name !== "rename" && name !== "limit" && name !== "lock" && name !== "unlock") {
    return { name: undefined, options: [] };
  }
  return {
    name,
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
  readonly ownership: OwnershipService;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly metrics: VcMetrics;
  readonly cooldowns: CooldownStore;
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

      const auth = await authorizeVcOwner({
        guildId: interaction.guildId,
        userId: interaction.userId,
        ownership: options.ownership,
        channels: options.channels,
        discord: options.discord,
        logger: options.logger,
      });
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

      const succeed = async (headline: string, details?: string): Promise<void> => {
        options.cooldowns.touch(cooldownKey, VC_COOLDOWNS_MS[subcommand]);
        options.metrics.success(subcommand);
        options.logger.info(`VC ${subcommand} succeeded`, { ...baseLog, outcome: "ok" });
        await reply(interaction, deferred, successResponse(headline, details));
      };

      try {
        if (subcommand === "invite") {
          const targetUserId = optionValue(sub.options, "user");
          if (typeof targetUserId !== "string") {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Invite Failed", "Provide a user to invite."),
            );
            return;
          }
          if (targetUserId === interaction.userId) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Invite Failed", "You cannot invite yourself."),
            );
            return;
          }
          const target = await options.discord.getUser({ userId: targetUserId });
          if (target.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Invite Failed", "Could not look up that user."),
            );
            return;
          }
          if (target.value.bot) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Invite Failed", "You cannot invite bots."),
            );
            return;
          }

          const channel = await options.discord.getChannel({ channelId: auth.channel.channelId });
          if (channel.kind !== "found") {
            options.metrics.restFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Invite Failed", "Could not load channel permissions."),
            );
            return;
          }
          const existing = findOverwrite(channel.value.permissionOverwrites, targetUserId);
          const allow = parseBits(existing?.allow) | VIEW_CHANNEL | CONNECT;
          const deny = parseBits(existing?.deny) & ~(VIEW_CHANNEL | CONNECT);
          const result = await options.discord.editChannelPermissionOverwrite({
            channelId: auth.channel.channelId,
            overwriteId: targetUserId,
            type: 1,
            allow: bitsToString(allow),
            deny: bitsToString(deny),
            requestId,
            reason: "vc invite",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC invite failed", { ...baseLog, targetUserId, outcome: result.kind });
            await reply(
              interaction,
              deferred,
              failureResponse("Invite Failed", "Could not update permissions."),
            );
            return;
          }
          options.logger.info("VC invite target", { ...baseLog, targetUserId });
          await succeed("Invite Complete", "Invite permissions updated.");
          return;
        }

        if (subcommand === "rename") {
          const rawName = optionValue(sub.options, "name");
          if (typeof rawName !== "string") {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse("Rename Failed", "Provide a new channel name."),
            );
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
          const result = await options.discord.editChannel({
            channelId: auth.channel.channelId,
            requestId,
            name,
            reason: "vc rename",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn("VC rename failed", { ...baseLog, outcome: result.kind });
            await reply(
              interaction,
              deferred,
              failureResponse("Rename Failed", "Could not rename the channel."),
            );
            return;
          }
          await succeed("Rename Complete", `Channel renamed to \`${name}\`.`);
          return;
        }

        if (subcommand === "limit") {
          const amount = optionValue(sub.options, "amount");
          if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > 99) {
            options.metrics.validationFailure();
            await reply(
              interaction,
              deferred,
              failureResponse(
                "Limit Failed",
                "Limit must be an integer from 0 to 99 (0 = unlimited).",
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
          const everyoneId = auth.channel.guildId;
          const existing = findOverwrite(channel.value.permissionOverwrites, everyoneId);
          let allow = parseBits(existing?.allow);
          let deny = parseBits(existing?.deny);
          if (subcommand === "lock") {
            allow &= ~CONNECT;
            deny |= CONNECT;
          } else {
            deny &= ~CONNECT;
          }
          const result = await options.discord.editChannelPermissionOverwrite({
            channelId: auth.channel.channelId,
            overwriteId: everyoneId,
            type: 0,
            allow: bitsToString(allow),
            deny: bitsToString(deny),
            requestId,
            reason: subcommand === "lock" ? "vc lock" : "vc unlock",
          });
          if (result.kind !== "ok") {
            options.metrics.restFailure();
            options.logger.warn(`VC ${subcommand} failed`, { ...baseLog, outcome: result.kind });
            await reply(
              interaction,
              deferred,
              failureResponse(
                subcommand === "lock" ? "Lock Failed" : "Unlock Failed",
                `Could not ${subcommand} the channel.`,
              ),
            );
            return;
          }
          await succeed(
            subcommand === "lock" ? "Lock Complete" : "Unlock Complete",
            subcommand === "lock" ? "Channel locked." : "Channel unlocked.",
          );
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
