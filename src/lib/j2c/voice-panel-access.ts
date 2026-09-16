import { BitwisePermissionFlags } from "discordeno";

import type { DiscordApiPort } from "../runtime-types.ts";
import { bitsToString, findOverwrite, parsePermissionBits } from "./voice-controls.ts";

const VIEW_CHANNEL = BitwisePermissionFlags.VIEW_CHANNEL;
const SEND_MESSAGES = BitwisePermissionFlags.SEND_MESSAGES;
const EMBED_LINKS = BitwisePermissionFlags.EMBED_LINKS;
const READ_MESSAGE_HISTORY = BitwisePermissionFlags.READ_MESSAGE_HISTORY;

/**
 * Allow the bot to post the control panel in the voice channel's text chat,
 * while denying @everyone Send Messages (read-only for members).
 */
export async function grantBotPanelTextAccess(options: {
  readonly discord: DiscordApiPort;
  readonly channelId: string;
  readonly guildId: string;
  readonly botUserId: string;
  readonly requestId: string;
}): Promise<void> {
  const channel = await options.discord.getChannel({ channelId: options.channelId });
  if (channel.kind !== "found") return;

  const everyone = findOverwrite(channel.value.permissionOverwrites, options.guildId);
  const everyoneAllow = parsePermissionBits(everyone?.allow) & ~SEND_MESSAGES;
  const everyoneDeny = parsePermissionBits(everyone?.deny) | SEND_MESSAGES;
  await options.discord.editChannelPermissionOverwrite({
    channelId: options.channelId,
    overwriteId: options.guildId,
    type: 0,
    allow: bitsToString(everyoneAllow),
    deny: bitsToString(everyoneDeny),
    requestId: `${options.requestId}:everyone-text`,
    reason: "voice panel read-only text",
  });

  const botExisting = findOverwrite(channel.value.permissionOverwrites, options.botUserId);
  const botAllow =
    parsePermissionBits(botExisting?.allow) |
    VIEW_CHANNEL |
    SEND_MESSAGES |
    EMBED_LINKS |
    READ_MESSAGE_HISTORY;
  const botDeny =
    parsePermissionBits(botExisting?.deny) &
    ~(VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | READ_MESSAGE_HISTORY);
  await options.discord.editChannelPermissionOverwrite({
    channelId: options.channelId,
    overwriteId: options.botUserId,
    type: 1,
    allow: bitsToString(botAllow),
    deny: bitsToString(botDeny),
    requestId: `${options.requestId}:bot-text`,
    reason: "voice panel bot text access",
  });
}
