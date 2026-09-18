import { BitwisePermissionFlags, ChannelTypes } from "discordeno";

import type { GuildPermissionSource } from "../../models/guild-config.ts";
import { DEFAULT_CHANNEL_NAME_TEMPLATE } from "../../models/snowflake.ts";
import type { Logger } from "../logger.ts";
import type {
  DiscordApiPort,
  InteractionCreatePayload,
  InteractionOption,
} from "../runtime-types.ts";
import {
  type ActionMessage,
  failureResponse,
  successResponse,
} from "./action-response.ts";
import { runFactoryReset } from "./factory-reset.ts";
import {
  DEFAULT_SETUP_CATEGORY_NAME,
  DEFAULT_SETUP_LOBBY_NAME,
  normalizeSetupChannelName,
} from "./setup-channel-names.ts";
import { GuildConfigValidationError, validateUpsertGuildConfigInput } from "./validation.ts";
import type {
  CreationReservationRepository,
  GuildConfigRepository,
  TemporaryChannelRepository,
} from "./repositories.ts";
import type { VoiceOccupancyTracker } from "./voice-occupancy.ts";

const MANAGE_GUILD = BitwisePermissionFlags.MANAGE_GUILD;
const ADMINISTRATOR = BitwisePermissionFlags.ADMINISTRATOR;

const SETUP_SUCCESS_HEADLINE = "Setup Complete";
const CONFIG_SUCCESS_HEADLINE = "Setup Updated";
const RESET_SUCCESS_HEADLINE = "Factory Reset Complete";
const ALREADY_CONFIGURED_MESSAGE =
  "This server already has a Join to Create system. Use `/setup config` to change settings, or `/reset` before creating a new one";

type SetupSubcommand = "create" | "config" | "reset";

function optionValue(
  options: readonly InteractionOption[] | undefined,
  name: string,
): string | number | boolean | undefined {
  return options?.find((option) => option.name === name)?.value;
}

function resolveSubcommand(
  commandName: string | undefined,
  options: readonly InteractionOption[] | undefined,
): {
  readonly name: SetupSubcommand | undefined;
  readonly options: readonly InteractionOption[];
} {
  if (commandName === "reset") {
    return { name: "reset", options: options ?? [] };
  }

  const root = options?.[0];
  if (!root) {
    // Bare `/setup` (no subcommand payload) → automatic create.
    return { name: "create", options: [] };
  }
  if (root.name === "config" || root.name === "create" || root.name === "reset") {
    return { name: root.name, options: root.options ?? [] };
  }
  // Legacy aliases from the removed automatic/default/sequence modes.
  if (root.name === "automatic" || root.name === "default" || root.name === "sequence") {
    return { name: "create", options: [] };
  }
  return { name: undefined, options: [] };
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
): ActionMessage {
  if (result.kind === "forbidden") {
    return failureResponse("Insufficient permissions to complete this action.");
  }
  if (result.kind === "transient") {
    return failureResponse(
      `Discord failed to ${action}${result.message ? `: ${result.message}` : ""}. Please try again.`,
    );
  }
  return failureResponse(`Unable to ${action}.`);
}

function parsePermissionSource(raw: string | number | boolean | undefined): GuildPermissionSource {
  return raw === "lobby" ? "lobby" : "category";
}

export interface SetupCommandService {
  execute(interaction: InteractionCreatePayload): Promise<void>;
}

export function createSetupCommandService(options: {
  readonly configs: GuildConfigRepository;
  readonly channels: TemporaryChannelRepository;
  readonly reservations: CreationReservationRepository;
  readonly occupancy: VoiceOccupancyTracker;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): SetupCommandService {
  const { configs, channels, reservations, occupancy, discord, logger } = options;

  return {
    async execute(interaction): Promise<void> {
      const reply = async (message: ActionMessage): Promise<void> => {
        await discord.respondToInteraction({
          interactionId: interaction.id,
          interactionToken: interaction.token,
          embeds: message.embeds,
          ephemeral: true,
        });
      };

      const finish = async (message: ActionMessage): Promise<void> => {
        await discord.editInteractionResponse({
          applicationId: interaction.applicationId,
          interactionToken: interaction.token,
          embeds: message.embeds,
        });
      };

      if (!interaction.guildId) {
        await reply(failureResponse("Use this command in a server."));
        return;
      }

      if (!hasManageGuild(interaction.memberPermissions)) {
        await reply(failureResponse("Insufficient permissions to complete this action."));
        return;
      }

      const sub = resolveSubcommand(interaction.commandName, interaction.options);
      const isReset = interaction.commandName === "reset" || sub.name === "reset";
      if (!isReset && sub.name !== "create" && sub.name !== "config") {
        await reply(failureResponse("Use `/setup` or `/setup config`."));
        return;
      }

      await discord.deferInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        ephemeral: true,
      });

      if (isReset) {
        const configured = await configs.findByGuildId(interaction.guildId);
        if (!configured) {
          await finish(
            failureResponse("Join to Create System is not configured in this server."),
          );
          return;
        }

        const result = await runFactoryReset({
          guildId: interaction.guildId,
          interactionId: interaction.id,
          configs,
          channels,
          reservations,
          occupancy,
          discord,
          logger,
        });

        if ("kind" in result) {
          await finish(
            failureResponse("Join to Create System is not configured in this server."),
          );
          return;
        }

        await finish(successResponse(RESET_SUCCESS_HEADLINE));
        return;
      }

      const guildId = interaction.guildId;
      const existing = await configs.findByGuildId(guildId);

      if (sub.name === "config") {
        await handleConfig({
          interaction,
          guildId,
          subOptions: sub.options,
          existing,
          finish,
        });
        return;
      }

      if (existing) {
        await finish(failureResponse(ALREADY_CONFIGURED_MESSAGE));
        return;
      }

      await handleCreate({
        interaction,
        guildId,
        finish,
      });
    },
  };

  async function handleCreate(input: {
    readonly interaction: InteractionCreatePayload;
    readonly guildId: string;
    readonly finish: (message: ActionMessage) => Promise<void>;
  }): Promise<void> {
    const { interaction, guildId, finish } = input;
    const setupReason = "PureV2 Join-to-Create setup";

    // Re-check immediately before Discord mutations (covers concurrent /setup).
    if (await configs.findByGuildId(guildId)) {
      await finish(failureResponse(ALREADY_CONFIGURED_MESSAGE));
      return;
    }

    const categoryCreated = await discord.createGuildChannel({
      guildId,
      name: DEFAULT_SETUP_CATEGORY_NAME,
      type: ChannelTypes.GuildCategory,
      requestId: `setup:${interaction.id}:category`,
      reason: setupReason,
    });
    if (categoryCreated.kind !== "found") {
      await finish(createFailureMessage(categoryCreated, "create the category"));
      return;
    }
    const categoryId = categoryCreated.value.id;

    const lobbyCreated = await discord.createGuildChannel({
      guildId,
      name: DEFAULT_SETUP_LOBBY_NAME,
      type: ChannelTypes.GuildVoice,
      parentId: categoryId,
      requestId: `setup:${interaction.id}:lobby`,
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

    const compensateCreatedChannels = async (): Promise<void> => {
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
    };

    try {
      const upsertInput = validateUpsertGuildConfigInput({
        guildId,
        enabled: true,
        lobbyChannelId,
        categoryId,
        channelNameTemplate: DEFAULT_CHANNEL_NAME_TEMPLATE,
        ownerCanEdit: false,
        permissionSource: "category",
        namingMode: "template",
        sequenceNext: 1,
        moderatorRoleIds: [],
      });

      const created = await configs.create(upsertInput);
      if (created.kind === "exists") {
        await compensateCreatedChannels();
        await finish(failureResponse(ALREADY_CONFIGURED_MESSAGE));
        return;
      }

      logger.info("Guild Join-to-Create setup completed", {
        guildId: created.record.guildId,
        lobbyChannelId: created.record.lobbyChannelId,
        categoryId: created.record.categoryId,
        namingMode: created.record.namingMode,
        userId: interaction.userId,
      });

      await finish(successResponse(SETUP_SUCCESS_HEADLINE));
    } catch (error: unknown) {
      await compensateCreatedChannels();

      if (error instanceof GuildConfigValidationError) {
        await finish(failureResponse(error.message));
        return;
      }
      logger.error("Setup command failed saving config", {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
      await finish(
        failureResponse(
          "Created Discord channels but could not save settings. Try `/setup` again.",
        ),
      );
    }
  }

  async function handleConfig(input: {
    readonly interaction: InteractionCreatePayload;
    readonly guildId: string;
    readonly subOptions: readonly InteractionOption[];
    readonly existing: Awaited<ReturnType<GuildConfigRepository["findByGuildId"]>>;
    readonly finish: (message: ActionMessage) => Promise<void>;
  }): Promise<void> {
    const { interaction, guildId, subOptions, existing, finish } = input;
    if (!existing) {
      await finish(failureResponse("Join to Create System is not configured in this server."));
      return;
    }

    const editableRaw = optionValue(subOptions, "editable");
    const nameRaw = optionValue(subOptions, "name");
    const limitRaw = optionValue(subOptions, "limit");
    const categoryRaw = optionValue(subOptions, "category");
    const permissionRaw = optionValue(subOptions, "permission");

    if (
      editableRaw === undefined &&
      nameRaw === undefined &&
      limitRaw === undefined &&
      categoryRaw === undefined &&
      permissionRaw === undefined
    ) {
      await finish(failureResponse("Specify at least one setting to update."));
      return;
    }

    let categoryId = existing.categoryId;
    if (typeof categoryRaw === "string") {
      const categoryChannel = await discord.getChannel({ channelId: categoryRaw });
      if (categoryChannel.kind !== "found" || categoryChannel.value.type !== ChannelTypes.GuildCategory) {
        await finish(failureResponse("Specify a valid category channel."));
        return;
      }
      // Category only controls where temporary VCs are created — do not move the lobby.
      categoryId = categoryRaw;
    }

    let namingMode = existing.namingMode;
    let channelNameTemplate = existing.channelNameTemplate;
    if (typeof nameRaw === "string" && nameRaw.trim().length > 0) {
      namingMode = "template";
      channelNameTemplate = normalizeSetupChannelName(nameRaw, existing.channelNameTemplate);
    }

    let defaultUserLimit = existing.defaultUserLimit;
    if (typeof limitRaw === "number") {
      if (!Number.isInteger(limitRaw) || limitRaw < 0 || limitRaw > 99) {
        await finish(failureResponse("User limit must be an integer between 0 and 99."));
        return;
      }
      defaultUserLimit = limitRaw;
    }

    const ownerCanEdit =
      typeof editableRaw === "boolean" ? editableRaw : existing.ownerCanEdit;
    const permissionSource =
      permissionRaw === undefined
        ? existing.permissionSource
        : parsePermissionSource(permissionRaw);

    try {
      const record = await configs.upsert(
        validateUpsertGuildConfigInput({
          guildId,
          enabled: existing.enabled,
          lobbyChannelId: existing.lobbyChannelId,
          categoryId,
          channelNameTemplate,
          ...(defaultUserLimit === undefined ? {} : { defaultUserLimit }),
          ownerCanEdit,
          permissionSource,
          namingMode,
          sequenceNext: existing.sequenceNext,
          moderatorRoleIds: [...existing.moderatorRoleIds],
        }),
      );
      logger.info("Guild Join-to-Create config updated", {
        guildId: record.guildId,
        lobbyChannelId: record.lobbyChannelId,
        categoryId: record.categoryId,
        namingMode: record.namingMode,
        ownerCanEdit: record.ownerCanEdit,
        permissionSource: record.permissionSource,
        userId: interaction.userId,
      });
      await finish(successResponse(CONFIG_SUCCESS_HEADLINE));
    } catch (error: unknown) {
      if (error instanceof GuildConfigValidationError) {
        await finish(failureResponse(error.message));
        return;
      }
      logger.error("Setup config failed", {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
      await finish(failureResponse("Unable to update setup settings. Please try again."));
    }
  }
}
