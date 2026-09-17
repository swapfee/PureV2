import { DEFAULT_CHANNEL_NAME_TEMPLATE } from "../../models/snowflake.ts";
import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import { renderChannelName } from "./channel-name.ts";
import { pickDisplayName } from "./display-name.ts";
import type { GuildConfigRepository, TemporaryChannelRepository } from "./repositories.ts";
import { refreshVoiceControlPanel } from "./voice-panel-service.ts";

export async function resolveChannelUsername(options: {
  readonly discord: DiscordApiPort;
  readonly guildId: string;
  readonly memberId: string;
  readonly username?: string;
}): Promise<string> {
  const provided = options.username?.trim();
  if (provided && provided.length > 0) return provided.slice(0, 80);

  const member = await options.discord.getGuildMember({
    guildId: options.guildId,
    userId: options.memberId,
  });
  if (member.kind === "found") {
    const fromMember = pickDisplayName({
      nick: member.value.nick,
      globalName: member.value.globalName,
      username: member.value.username,
    });
    if (fromMember) return fromMember;
  }

  const user = await options.discord.getUser({ userId: options.memberId });
  if (user.kind === "found") {
    const fromUser = pickDisplayName({
      globalName: user.value.globalName,
      username: user.value.username,
    });
    if (fromUser) return fromUser;
  }

  return "user";
}

/**
 * After claim/transfer: rename the temp channel for the new owner and refresh
 * the control panel so owner mention + button custom ids match.
 */
export async function applyOwnerHandoffPresentation(options: {
  readonly discord: DiscordApiPort;
  readonly channels: TemporaryChannelRepository;
  readonly configs?: GuildConfigRepository;
  readonly logger: Logger;
  readonly guildId: string;
  readonly channelId: string;
  readonly newOwnerId: string;
  readonly botUsername?: string;
  readonly requestId: string;
  readonly panelMessageId?: string;
  readonly preferredUsername?: string;
}): Promise<void> {
  const config = options.configs
    ? await options.configs.findByGuildId(options.guildId)
    : undefined;
  const template = config?.channelNameTemplate ?? DEFAULT_CHANNEL_NAME_TEMPLATE;
  const username = await resolveChannelUsername({
    discord: options.discord,
    guildId: options.guildId,
    memberId: options.newOwnerId,
    ...(options.preferredUsername === undefined
      ? {}
      : { username: options.preferredUsername }),
  });
  const channelName = renderChannelName(template, username);

  const renamed = await options.discord.editChannel({
    channelId: options.channelId,
    requestId: `${options.requestId}:rename`,
    name: channelName,
    reason: "temporary channel ownership change",
  });
  if (renamed.kind !== "ok") {
    options.logger.warn("Failed to rename channel after ownership change", {
      guildId: options.guildId,
      channelId: options.channelId,
      newOwnerId: options.newOwnerId,
      outcome: renamed.kind,
    });
  }

  if (!options.botUsername) return;

  await refreshVoiceControlPanel({
    discord: options.discord,
    channels: options.channels,
    logger: options.logger,
    channelId: options.channelId,
    ownerId: options.newOwnerId,
    botUsername: options.botUsername,
    ...(options.panelMessageId ? { panelMessageId: options.panelMessageId } : {}),
    requestId: `${options.requestId}:panel`,
  });
}
