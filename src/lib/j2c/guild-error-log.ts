import { BitwisePermissionFlags } from "discordeno";

import type { Logger } from "../logger.ts";
import type { DiscordApiPort, InteractionEmbed } from "../runtime-types.ts";
import type { GuildConfigRepository } from "./repositories.ts";

const VIEW_CHANNEL = BitwisePermissionFlags.VIEW_CHANNEL;
const SEND_MESSAGES = BitwisePermissionFlags.SEND_MESSAGES;
const EMBED_LINKS = BitwisePermissionFlags.EMBED_LINKS;
const READ_MESSAGE_HISTORY = BitwisePermissionFlags.READ_MESSAGE_HISTORY;

const ERROR_EMBED_COLOR = 0xed_42_45;

export const GUILD_ERROR_DEVELOPER_HINT =
  "If this keeps happening after the steps below, contact the bot developer and include your server ID and the approximate time of this error.";

export type GuildErrorArea =
  | "join_to_create"
  | "voice_management"
  | "block_list"
  | "permissions"
  | "system";

const AREA_LABELS: Record<GuildErrorArea, string> = {
  join_to_create: "Join to Create",
  voice_management: "Voice management",
  block_list: "Block list",
  permissions: "Permissions",
  system: "System",
};

export interface GuildErrorLogEntry {
  readonly area: GuildErrorArea;
  readonly summary: string;
  readonly detail?: string;
  readonly solution: string;
  readonly userId?: string;
  readonly channelId?: string;
}

export function formatGuildErrorLogEmbed(entry: GuildErrorLogEntry): InteractionEmbed {
  const lines = [
    `**What happened**`,
    entry.summary.trim(),
  ];
  if (entry.detail && entry.detail.trim().length > 0) {
    lines.push("", `**Details**`, entry.detail.trim());
  }
  if (entry.userId) {
    lines.push("", `**User**`, `<@${entry.userId}> (\`${entry.userId}\`)`);
  }
  if (entry.channelId) {
    lines.push("", `**Channel**`, `<#${entry.channelId}> (\`${entry.channelId}\`)`);
  }
  lines.push(
    "",
    `**Possible solution**`,
    entry.solution.trim(),
    "",
    `**If that fails**`,
    GUILD_ERROR_DEVELOPER_HINT,
  );

  return {
    title: `Error · ${AREA_LABELS[entry.area]}`,
    description: lines.join("\n").slice(0, 4096),
    color: ERROR_EMBED_COLOR,
  };
}

export function solutionForDiscordOutcome(outcome: string): string {
  switch (outcome) {
    case "forbidden":
      return "Grant the bot Manage Channels, Connect, Move Members, and Send Messages in the Join to Create category (and its channels), then try again.";
    case "missing":
      return "The target Discord channel no longer exists. Run `/reset` if Join to Create is broken, then `/setup create` to recreate it.";
    case "transient":
      return "Discord returned a temporary error. Wait a moment and retry the action.";
    default:
      return "Retry the action. If it continues, check the bot's channel permissions and Discord's status.";
  }
}

/**
 * Best-effort post to the guild error-log channel. Never throws to callers.
 */
export async function postGuildErrorLog(options: {
  readonly discord: DiscordApiPort;
  readonly configs: GuildConfigRepository;
  readonly logger: Logger;
  readonly guildId: string;
  readonly requestId: string;
  readonly entry: GuildErrorLogEntry;
}): Promise<void> {
  try {
    const config = await options.configs.findByGuildId(options.guildId);
    const channelId = config?.errorLogChannelId;
    if (!channelId) return;

    const sent = await options.discord.sendChannelMessage({
      channelId,
      requestId: options.requestId,
      embeds: [formatGuildErrorLogEmbed(options.entry)],
    });
    if (sent.kind !== "found") {
      options.logger.warn("Failed to post guild error log", {
        guildId: options.guildId,
        channelId,
        outcome: sent.kind,
      });
    }
  } catch (error: unknown) {
    options.logger.warn("Guild error log threw", {
      guildId: options.guildId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Restrict @everyone and allow the bot to post in the error-log channel. */
export async function hardenErrorLogChannelAccess(options: {
  readonly discord: DiscordApiPort;
  readonly guildId: string;
  readonly channelId: string;
  readonly botUserId: string;
  readonly requestId: string;
}): Promise<void> {
  await options.discord.editChannelPermissionOverwrite({
    channelId: options.channelId,
    overwriteId: options.guildId,
    type: 0,
    allow: "0",
    deny: String(VIEW_CHANNEL),
    requestId: `${options.requestId}:everyone-deny`,
    reason: "PureV2 error-log channel privacy",
  });
  const botAllow = VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | READ_MESSAGE_HISTORY;
  await options.discord.editChannelPermissionOverwrite({
    channelId: options.channelId,
    overwriteId: options.botUserId,
    type: 1,
    allow: String(botAllow),
    deny: "0",
    requestId: `${options.requestId}:bot-allow`,
    reason: "PureV2 error-log bot access",
  });
}
