import { BitwisePermissionFlags, ChannelTypes } from "discordeno";

import type { Logger } from "../logger.ts";
import type { DiscordApiPort, InteractionCreatePayload } from "../runtime-types.ts";
import { DEFAULT_CHANNEL_NAME_TEMPLATE } from "../../models/snowflake.ts";
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

      if (!interaction.guildId) {
        await reply("Use `/setup` in a server.");
        return;
      }

      if (!hasManageGuild(interaction.memberPermissions)) {
        await reply("You need the Manage Server permission to configure Join-to-Create.");
        return;
      }

      const lobbyRaw = optionValue(interaction.options, "lobby");
      const categoryRaw = optionValue(interaction.options, "category");
      if (typeof lobbyRaw !== "string" || typeof categoryRaw !== "string") {
        await reply("Lobby and category channels are required.");
        return;
      }

      const templateRaw = optionValue(interaction.options, "template");
      const limitRaw = optionValue(interaction.options, "limit");
      const enabledRaw = optionValue(interaction.options, "enabled");
      const moderatorRaw = optionValue(interaction.options, "moderator_role");

      const lobby = await discord.getChannel({ channelId: lobbyRaw });
      if (lobby.kind !== "found") {
        await reply("Could not load the lobby channel. Pick a voice channel in this server.");
        return;
      }
      if (lobby.value.type !== ChannelTypes.GuildVoice) {
        await reply("Lobby must be a voice channel.");
        return;
      }

      const category = await discord.getChannel({ channelId: categoryRaw });
      if (category.kind !== "found") {
        await reply("Could not load the category. Pick a category channel in this server.");
        return;
      }
      if (category.value.type !== ChannelTypes.GuildCategory) {
        await reply("Category must be a category channel.");
        return;
      }

      try {
        const input = validateUpsertGuildConfigInput({
          guildId: interaction.guildId,
          enabled: typeof enabledRaw === "boolean" ? enabledRaw : true,
          lobbyChannelId: lobbyRaw,
          categoryId: categoryRaw,
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
        logger.info("Guild Join-to-Create config upserted", {
          guildId: record.guildId,
          lobbyChannelId: record.lobbyChannelId,
          categoryId: record.categoryId,
          enabled: record.enabled,
          userId: interaction.userId,
        });

        await reply(
          [
            "Join-to-Create configured.",
            `Enabled: ${record.enabled ? "yes" : "no"}`,
            `Lobby: <#${record.lobbyChannelId}>`,
            `Category: <#${record.categoryId}>`,
            `Template: \`${record.channelNameTemplate}\``,
            record.defaultUserLimit === undefined
              ? "Default limit: unlimited"
              : `Default limit: ${record.defaultUserLimit}`,
          ].join("\n"),
        );
      } catch (error: unknown) {
        if (error instanceof GuildConfigValidationError) {
          await reply(error.message);
          return;
        }
        logger.error("Setup command failed", {
          guildId: interaction.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
        await reply("Could not save Join-to-Create settings. Try again later.");
      }
    },
  };
}
