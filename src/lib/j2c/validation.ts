import {
  CHANNEL_NAME_TEMPLATE_MAX,
  DEFAULT_CHANNEL_NAME_TEMPLATE,
  isSnowflake,
  type UpsertGuildConfigInput,
} from "../../models/index.ts";
import {
  GUILD_NAMING_MODES,
  GUILD_PERMISSION_SOURCES,
  type GuildNamingMode,
  type GuildPermissionSource,
} from "../../models/guild-config.ts";

export class GuildConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuildConfigValidationError";
  }
}

function isPermissionSource(value: string): value is GuildPermissionSource {
  return (GUILD_PERMISSION_SOURCES as readonly string[]).includes(value);
}

function isNamingMode(value: string): value is GuildNamingMode {
  return (GUILD_NAMING_MODES as readonly string[]).includes(value);
}

export function validateUpsertGuildConfigInput(input: UpsertGuildConfigInput): UpsertGuildConfigInput {
  if (!isSnowflake(input.guildId)) throw new GuildConfigValidationError("guildId must be a snowflake");
  if (!isSnowflake(input.lobbyChannelId)) {
    throw new GuildConfigValidationError("lobbyChannelId must be a snowflake");
  }
  if (!isSnowflake(input.categoryId)) throw new GuildConfigValidationError("categoryId must be a snowflake");
  if (input.errorLogChannelId !== undefined && !isSnowflake(input.errorLogChannelId)) {
    throw new GuildConfigValidationError("errorLogChannelId must be a snowflake");
  }

  const channelNameTemplate = input.channelNameTemplate.trim();
  if (
    channelNameTemplate.length < 1 ||
    channelNameTemplate.length > CHANNEL_NAME_TEMPLATE_MAX
  ) {
    throw new GuildConfigValidationError(
      `channelNameTemplate must be 1-${CHANNEL_NAME_TEMPLATE_MAX} characters`,
    );
  }

  if (input.defaultUserLimit !== undefined) {
    if (!Number.isInteger(input.defaultUserLimit) || input.defaultUserLimit < 0 || input.defaultUserLimit > 99) {
      throw new GuildConfigValidationError("defaultUserLimit must be an integer between 0 and 99");
    }
  }

  const ownerCanEdit = input.ownerCanEdit === true;
  const permissionSource = input.permissionSource ?? "category";
  if (!isPermissionSource(permissionSource)) {
    throw new GuildConfigValidationError("permissionSource must be category or lobby");
  }

  const namingMode = input.namingMode ?? "template";
  if (!isNamingMode(namingMode)) {
    throw new GuildConfigValidationError("namingMode must be template or sequence");
  }

  const sequenceNext = input.sequenceNext ?? 1;
  if (!Number.isInteger(sequenceNext) || sequenceNext < 1) {
    throw new GuildConfigValidationError("sequenceNext must be an integer >= 1");
  }

  const moderatorRoleIds = (input.moderatorRoleIds ?? []).map((value) => value.trim());
  if (moderatorRoleIds.some((value) => !isSnowflake(value))) {
    throw new GuildConfigValidationError("moderatorRoleIds must contain snowflakes");
  }

  return {
    guildId: input.guildId,
    enabled: input.enabled,
    lobbyChannelId: input.lobbyChannelId,
    categoryId: input.categoryId,
    ...(input.errorLogChannelId === undefined ? {} : { errorLogChannelId: input.errorLogChannelId }),
    channelNameTemplate: channelNameTemplate.length > 0 ? channelNameTemplate : DEFAULT_CHANNEL_NAME_TEMPLATE,
    ...(input.defaultUserLimit === undefined ? {} : { defaultUserLimit: input.defaultUserLimit }),
    ownerCanEdit,
    permissionSource,
    namingMode,
    sequenceNext,
    moderatorRoleIds,
  };
}
