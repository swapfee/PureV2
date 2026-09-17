import { BitwisePermissionFlags, ChannelTypes } from "discordeno";

import type { GuildNamingMode, GuildPermissionSource } from "../../models/guild-config.ts";
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

type SetupSubcommand = "automatic" | "default" | "sequence" | "config" | "create" | "reset";

function optionValue(
  options: readonly InteractionOption[] | undefined,
  name: string,
): string | number | boolean | undefined {
  return options?.find((option) => option.name === name)?.value;
}

function resolveSubcommand(options: readonly InteractionOption[] | undefined): {
  readonly name: SetupSubcommand | undefined;
  readonly options: readonly InteractionOption[];
} {
  const root = options?.[0];
  if (!root) return { name: undefined, options: [] };
  if (
    root.name === "automatic" ||
    root.name === "default" ||
    root.name === "sequence" ||
    root.name === "config" ||
    root.name === "create" ||
    root.name === "reset"
  ) {
    return { name: root.name, options: root.options ?? [] };
  }
  // Backward-compatible flat options (treat as automatic).
  return { name: "automatic", options: options ?? [] };
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

      const sub = resolveSubcommand(interaction.options);
      // `/reset` command is routed here as a synthetic reset subcommand.
      const isReset = interaction.commandName === "reset" || sub.name === "reset";
      if (
        !isReset &&
        sub.name !== "automatic" &&
        sub.name !== "default" &&
        sub.name !== "sequence" &&
        sub.name !== "config" &&
        sub.name !== "create"
      ) {
        await reply(
          failureResponse("Use `/setup automatic`, `/setup default`, `/setup sequence`, or `/setup config`."),
        );
        return;
      }

      await discord.deferInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        ephemeral: true,
      });

      if (isReset) {
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
        await finish(failureResponse("Join to Create System already exists."));
        return;
      }

      const mode: "automatic" | "default" | "sequence" =
        sub.name === "sequence" ? "sequence" : sub.name === "default" ? "default" : "automatic";

      await handleCreate({
        interaction,
        guildId,
        mode,
        subOptions: sub.options,
        finish,
      });
    },
  };

  async function handleCreate(input: {
    readonly interaction: InteractionCreatePayload;
    readonly guildId: string;
    readonly mode: "automatic" | "default" | "sequence";
    readonly subOptions: readonly InteractionOption[];
    readonly finish: (message: ActionMessage) => Promise<void>;
  }): Promise<void> {
    const { interaction, guildId, mode, subOptions, finish } = input;

    let ownerCanEdit = false;
    let permissionSource: GuildPermissionSource = "category";
    let namingMode: GuildNamingMode = "template";
    let channelNameTemplate = DEFAULT_CHANNEL_NAME_TEMPLATE;
    let defaultUserLimit: number | undefined;
    let sequenceNext = 1;

    if (mode === "default" || mode === "sequence") {
      const editableRaw = optionValue(subOptions, "editable");
      if (typeof editableRaw !== "boolean") {
        await finish(failureResponse("Specify whether channels should be editable."));
        return;
      }
      ownerCanEdit = editableRaw;
      permissionSource = parsePermissionSource(optionValue(subOptions, "permission"));
    }

    if (mode === "sequence") {
      const nameRaw = optionValue(subOptions, "name");
      const limitRaw = optionValue(subOptions, "limit");
      if (typeof nameRaw !== "string" || nameRaw.trim().length < 1) {
        await finish(failureResponse("Specify a base name for sequential channels."));
        return;
      }
      if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 0 || limitRaw > 99) {
        await finish(failureResponse("Specify a user limit between 0 and 99."));
        return;
      }
      namingMode = "sequence";
      channelNameTemplate = normalizeSetupChannelName(nameRaw, "Channel");
      defaultUserLimit = limitRaw;
    }

    const categoryOptionId = optionValue(subOptions, "category");
    const setupReason = "PureV2 Join-to-Create setup";

    let categoryId: string;
    let createdCategory = false;

    if (typeof categoryOptionId === "string") {
      const categoryChannel = await discord.getChannel({ channelId: categoryOptionId });
      if (categoryChannel.kind !== "found" || categoryChannel.value.type !== ChannelTypes.GuildCategory) {
        await finish(failureResponse("Specify a valid category channel."));
        return;
      }
      categoryId = categoryOptionId;
    } else {
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
      categoryId = categoryCreated.value.id;
      createdCategory = true;
    }

    const lobbyCreated = await discord.createGuildChannel({
      guildId,
      name: DEFAULT_SETUP_LOBBY_NAME,
      type: ChannelTypes.GuildVoice,
      parentId: categoryId,
      requestId: `setup:${interaction.id}:lobby`,
      reason: setupReason,
    });

    if (lobbyCreated.kind !== "found") {
      if (createdCategory) {
        await discord.deleteChannel({
          channelId: categoryId,
          requestId: `setup:${interaction.id}:compensate-category`,
          reason: setupReason,
        });
      }
      await finish(createFailureMessage(lobbyCreated, "create the join-to-create voice channel"));
      return;
    }

    const lobbyChannelId = lobbyCreated.value.id;

    try {
      const upsertInput = validateUpsertGuildConfigInput({
        guildId,
        enabled: true,
        lobbyChannelId,
        categoryId,
        channelNameTemplate,
        ...(defaultUserLimit === undefined ? {} : { defaultUserLimit }),
        ownerCanEdit,
        permissionSource,
        namingMode,
        sequenceNext,
        moderatorRoleIds: [],
      });

      const record = await configs.upsert(upsertInput);
      logger.info("Guild Join-to-Create setup completed", {
        guildId: record.guildId,
        lobbyChannelId: record.lobbyChannelId,
        categoryId: record.categoryId,
        mode,
        namingMode: record.namingMode,
        ownerCanEdit: record.ownerCanEdit,
        permissionSource: record.permissionSource,
        userId: interaction.userId,
      });

      await finish(successResponse(SETUP_SUCCESS_HEADLINE));
    } catch (error: unknown) {
      await discord.deleteChannel({
        channelId: lobbyChannelId,
        requestId: `setup:${interaction.id}:compensate-lobby`,
        reason: setupReason,
      });
      if (createdCategory) {
        await discord.deleteChannel({
          channelId: categoryId,
          requestId: `setup:${interaction.id}:compensate-category`,
          reason: setupReason,
        });
      }

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

    const channelRaw = optionValue(subOptions, "channel");
    if (typeof channelRaw !== "string") {
      await finish(failureResponse("Specify the Join to Create channel to configure."));
      return;
    }
    if (channelRaw !== existing.lobbyChannelId) {
      await finish(failureResponse("That channel is not the Join to Create channel for this server."));
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
      if (categoryRaw !== existing.categoryId) {
        const moved = await discord.editChannel({
          channelId: existing.lobbyChannelId,
          parentId: categoryRaw,
          requestId: `setup:${interaction.id}:move-lobby`,
          reason: "PureV2 Join-to-Create config update",
        });
        if (moved.kind !== "ok") {
          await finish(createFailureMessage(moved, "move the Join to Create channel"));
          return;
        }
        categoryId = categoryRaw;
      }
    }

    let namingMode = existing.namingMode;
    let channelNameTemplate = existing.channelNameTemplate;
    let sequenceNext = existing.sequenceNext;
    if (typeof nameRaw === "string" && nameRaw.trim().length > 0) {
      namingMode = "sequence";
      channelNameTemplate = normalizeSetupChannelName(nameRaw, existing.channelNameTemplate);
      // Keep the current counter so existing numbering continues.
      sequenceNext = existing.sequenceNext;
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
          sequenceNext,
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
