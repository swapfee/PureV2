import { BitwisePermissionFlags } from "discordeno";

import type { DiscordApiPort, PermissionOverwrite } from "../runtime-types.ts";
import { bitsToString, findOverwrite, parsePermissionBits } from "./voice-controls.ts";

const MANAGE_CHANNELS = BitwisePermissionFlags.MANAGE_CHANNELS;
const VIEW_CHANNEL = BitwisePermissionFlags.VIEW_CHANNEL;
const CONNECT = BitwisePermissionFlags.CONNECT;
const SPEAK = BitwisePermissionFlags.SPEAK;

/**
 * Grant the temporary-channel owner Discord Manage Channel (and basic voice access)
 * so they can edit the channel in the Discord UI when setup has editable enabled.
 */
export async function grantOwnerChannelEditAccess(options: {
  readonly discord: DiscordApiPort;
  readonly channelId: string;
  readonly ownerId: string;
  readonly requestId: string;
}): Promise<void> {
  const channel = await options.discord.getChannel({ channelId: options.channelId });
  if (channel.kind !== "found") return;

  const existing = findOverwrite(channel.value.permissionOverwrites, options.ownerId);
  const allow =
    parsePermissionBits(existing?.allow) | MANAGE_CHANNELS | VIEW_CHANNEL | CONNECT | SPEAK;
  const deny =
    parsePermissionBits(existing?.deny) & ~(MANAGE_CHANNELS | VIEW_CHANNEL | CONNECT | SPEAK);

  await options.discord.editChannelPermissionOverwrite({
    channelId: options.channelId,
    overwriteId: options.ownerId,
    type: 1,
    allow: bitsToString(allow),
    deny: bitsToString(deny),
    requestId: `${options.requestId}:owner-edit`,
    reason: "temporary channel owner edit access",
  });
}

/** Copy permission overwrites from a source channel onto a newly created temp channel. */
export async function copyChannelPermissionOverwrites(options: {
  readonly discord: DiscordApiPort;
  readonly sourceChannelId: string;
  readonly targetChannelId: string;
  readonly requestId: string;
}): Promise<void> {
  const source = await options.discord.getChannel({ channelId: options.sourceChannelId });
  if (source.kind !== "found") return;
  const overwrites: readonly PermissionOverwrite[] = source.value.permissionOverwrites ?? [];
  let index = 0;
  for (const overwrite of overwrites) {
    await options.discord.editChannelPermissionOverwrite({
      channelId: options.targetChannelId,
      overwriteId: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow,
      deny: overwrite.deny,
      requestId: `${options.requestId}:copy-perm:${index}`,
      reason: "copy join-to-create permissions",
    });
    index += 1;
  }
}
