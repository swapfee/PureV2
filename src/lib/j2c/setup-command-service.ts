import { BitwisePermissionFlags, ChannelTypes } from "discordeno";

import type { Logger } from "../logger.ts";
import type { DiscordApiPort, InteractionCreatePayload } from "../runtime-types.ts";
import { DEFAULT_CHANNEL_NAME_TEMPLATE } from "../../models/snowflake.ts";
import {
  DEFAULT_SETUP_CATEGORY_NAME,
  DEFAULT_SETUP_LOBBY_NAME,
  normalizeSetupChannelName,
} from "./setup-channel-names.ts";
import { GuildConfigValidationError, validateUpsertGuildConfigInput } from "./validation.ts";
import type { GuildConfigRepository } from "./repositories.ts";

const MANAGE_GUILD = BitwisePermissionFlags.MANAGE_GUILD;
const ADMINISTRATOR = BitwisePermissionFlags.ADMINISTRATOR;

function optionValue(
  options: readonly { name: string; value?: string | number | boolean }[] | undefined,
  name: string,
): string | number | boolean | undefined {
  return options?.find((option) => option.name === name)?.value;
}

function hasManageGuild(permissions: string | undefined): boolean {
  if (!permissions) return false;
  try {
    const bits = BigInt(permissions);
    return (bits & ADMINISTRATOR) === ADMINISTRATOR || (bits & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}

function createFailureMessage(
  result: { readonly kind: "missing" | "forbidden" | "transient"; readonly message?: string },
  action: string,
): string {
  if (result.kind === "forbidden") {
    return `Missing permission to ${action}. Ensure the bot has **Manage Channels**.`;
  }
  if (result.kind === "transient") {
    return `Discord failed to ${action}${result.message ? `: ${result.message}` : ""}. Try again.`;
  }
  return `Could not ${action}.`;
}

export interface SetupCommandService {
  execute(interaction: InteractionCreatePayload): Promise<void>;
}

export function createSetupCommandService(options: {
  readonly configs: GuildConfigRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): SetupCommandService {
  const { configs, discord, logger } = options;

  return {
    async execute(interaction): Promise<void> {
      const reply = async (content: string): Promise<void> => {
        await discord.respondToInteraction({
          interactionId: interaction.id,
          interactionToken: interaction.token,
          content,
          ephemeral: true,
        });
      };

      const finish = async (content: string): Promise<void> => {
        await discord.editInteractionResponse({
          applicationId: interaction.applicationId,
          interactionToken: interaction.token,
          content,
        });
      };

      if (!interaction.guildId) {
        await reply("Use `/setup` in a server.");
        return;
      }

      if (!hasManageGuild(interaction.memberPermissions)) {
        await reply("You need the Manage Server permission to configure Join-to-Create.");
        return;
      }

      await discord.deferInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        ephemeral: true,
      });

      const guildId = interaction.guildId;
      const categoryName = normalizeSetupChannelName(
        typeof optionValue(interaction.options, "category_name") === "string"
          ? String(optionValue(interaction.options, "category_name"))
          : undefined,
        DEFAULT_SETUP_CATEGORY_NAME,
      );
      const lobbyName = normalizeSetupChannelName(
        typeof optionValue(interaction.options, "lobby_name") === "string"
          ? String(optionValue(interaction.options, "lobby_name"))
          : undefined,
        DEFAULT_SETUP_LOBBY_NAME,
      );

      const templateRaw = optionValue(interaction.options, "template");
      const limitRaw = optionValue(interaction.options, "limit");
      const enabledRaw = optionValue(interaction.options, "enabled");
      const moderatorRaw = optionValue(interaction.options, "moderator_role");

      const setupReason = "PureV2 Join-to-Create setup";
      const categoryRequestId = `setup:${interaction.id}:category`;

      const categoryCreated = await discord.createGuildChannel({
        guildId,
        name: categoryName,
        type: ChannelTypes.GuildCategory,
        requestId: categoryRequestId,
        reason: setupReason,
      });

      if (categoryCreated.kind !== "found") {
        await finish(createFailureMessage(categoryCreated, "create the category"));
        return;
      }

      const categoryId = categoryCreated.value.id;
      const lobbyRequestId = `setup:${interaction.id}:lobby`;

      const lobbyCreated = await discord.createGuildChannel({
        guildId,
        name: lobbyName,
        type: ChannelTypes.GuildVoice,
        parentId: categoryId,
        requestId: lobbyRequestId,
        reason: setupReason,
      });

      if (lobbyCreated.kind !== "found") {
        await discord.deleteChannel({
          channelId: categoryId,
          requestId: `setup:${interaction.id}:compensate-category`,
          reason: setupReason,
        });
        await finish(createFailureMessage(lobbyCreated, "create the join-to-create voice channel"));
        return;
      }

      const lobbyChannelId = lobbyCreated.value.id;

      try {
        const input = validateUpsertGuildConfigInput({
          guildId,
          enabled: typeof enabledRaw === "boolean" ? enabledRaw : true,
          lobbyChannelId,
          categoryId,
          channelNameTemplate:
            typeof templateRaw === "string" && templateRaw.trim().length > 0
              ? templateRaw
              : DEFAULT_CHANNEL_NAME_TEMPLATE,
          ...(typeof limitRaw === "number" ? { defaultUserLimit: limitRaw } : {}),
          ...(typeof moderatorRaw === "string"
            ? { moderatorRoleIds: [moderatorRaw] }
            : { moderatorRoleIds: [] }),
        });

        const record = await configs.upsert(input);
        logger.info("Guild Join-to-Create setup completed", {
          guildId: record.guildId,
          lobbyChannelId: record.lobbyChannelId,
          categoryId: record.categoryId,
          enabled: record.enabled,
          userId: interaction.userId,
        });

        await finish(
          [
            "Join-to-Create is ready.",
            `Category: <#${record.categoryId}> (\`${categoryName}\`)`,
            `Lobby: <#${record.lobbyChannelId}> (\`${lobbyName}\`)`,
            `Enabled: ${record.enabled ? "yes" : "no"}`,
            `Template: \`${record.channelNameTemplate}\``,
            record.defaultUserLimit === undefined
              ? "Default limit: unlimited"
              : `Default limit: ${record.defaultUserLimit}`,
            "",
            "Members join the lobby voice channel to get a temporary channel.",
          ].join("\n"),
        );
      } catch (error: unknown) {
        await discord.deleteChannel({
          channelId: lobbyChannelId,
          requestId: `setup:${interaction.id}:compensate-lobby`,
          reason: setupReason,
        });
        await discord.deleteChannel({
          channelId: categoryId,
          requestId: `setup:${interaction.id}:compensate-category`,
          reason: setupReason,
        });

        if (error instanceof GuildConfigValidationError) {
          await finish(error.message);
          return;
        }
        logger.error("Setup command failed saving config", {
          guildId,
          error: error instanceof Error ? error.message : String(error),
        });
        await finish("Created Discord channels but could not save settings. Try `/setup` again.");
      }
    },
  };
}
