import { BitwisePermissionFlags } from "discordeno";

import type { TemporaryChannelRecord } from "../../models/temporary-channel.ts";
import type {
  DiscordApiPort,
  DiscordChannelDetails,
  DiscordOperationResult,
  PermissionOverwrite,
} from "../runtime-types.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";

const VIEW_CHANNEL = BitwisePermissionFlags.VIEW_CHANNEL;
const CONNECT = BitwisePermissionFlags.CONNECT;

export function parsePermissionBits(value: string | undefined): bigint {
  if (!value || value.length === 0) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export function bitsToString(value: bigint): string {
  return value.toString();
}

export function findOverwrite(
  overwrites: readonly PermissionOverwrite[] | undefined,
  id: string,
): PermissionOverwrite | undefined {
  return overwrites?.find((overwrite) => overwrite.id === id);
}

export function isConnectDenied(overwrites: readonly PermissionOverwrite[] | undefined, everyoneId: string): boolean {
  const everyone = findOverwrite(overwrites, everyoneId);
  return (parsePermissionBits(everyone?.deny) & CONNECT) === CONNECT;
}

export function isViewDenied(overwrites: readonly PermissionOverwrite[] | undefined, everyoneId: string): boolean {
  const everyone = findOverwrite(overwrites, everyoneId);
  return (parsePermissionBits(everyone?.deny) & VIEW_CHANNEL) === VIEW_CHANNEL;
}

export function channelInviteLink(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

async function editEveryoneOverwrite(options: {
  readonly discord: DiscordApiPort;
  readonly channel: DiscordChannelDetails;
  readonly everyoneId: string;
  readonly requestId: string;
  readonly reason: string;
  readonly mutate: (allow: bigint, deny: bigint) => { allow: bigint; deny: bigint };
}): Promise<DiscordOperationResult> {
  const existing = findOverwrite(options.channel.permissionOverwrites, options.everyoneId);
  const currentAllow = parsePermissionBits(existing?.allow);
  const currentDeny = parsePermissionBits(existing?.deny);
  const next = options.mutate(currentAllow, currentDeny);
  return options.discord.editChannelPermissionOverwrite({
    channelId: options.channel.id,
    overwriteId: options.everyoneId,
    type: 0,
    allow: bitsToString(next.allow),
    deny: bitsToString(next.deny),
    requestId: options.requestId,
    reason: options.reason,
  });
}

export async function setEveryoneConnectDenied(options: {
  readonly discord: DiscordApiPort;
  readonly channel: DiscordChannelDetails;
  readonly everyoneId: string;
  readonly denied: boolean;
  readonly requestId: string;
  readonly reason: string;
}): Promise<DiscordOperationResult> {
  return editEveryoneOverwrite({
    discord: options.discord,
    channel: options.channel,
    everyoneId: options.everyoneId,
    requestId: options.requestId,
    reason: options.reason,
    mutate: (allow, deny) => {
      if (options.denied) {
        return { allow: allow & ~CONNECT, deny: deny | CONNECT };
      }
      return { allow, deny: deny & ~CONNECT };
    },
  });
}

export async function setEveryoneViewDenied(options: {
  readonly discord: DiscordApiPort;
  readonly channel: DiscordChannelDetails;
  readonly everyoneId: string;
  readonly denied: boolean;
  readonly requestId: string;
  readonly reason: string;
}): Promise<DiscordOperationResult> {
  return editEveryoneOverwrite({
    discord: options.discord,
    channel: options.channel,
    everyoneId: options.everyoneId,
    requestId: options.requestId,
    reason: options.reason,
    mutate: (allow, deny) => {
      if (options.denied) {
        return { allow: allow & ~VIEW_CHANNEL, deny: deny | VIEW_CHANNEL };
      }
      return { allow, deny: deny & ~VIEW_CHANNEL };
    },
  });
}

export async function permitMember(options: {
  readonly discord: DiscordApiPort;
  readonly channels: TemporaryChannelRepository;
  readonly channel: DiscordChannelDetails;
  readonly record: TemporaryChannelRecord;
  readonly userId: string;
  readonly requestId: string;
  readonly reason: string;
}): Promise<DiscordOperationResult> {
  const existing = findOverwrite(options.channel.permissionOverwrites, options.userId);
  const allow = parsePermissionBits(existing?.allow) | VIEW_CHANNEL | CONNECT;
  const deny = parsePermissionBits(existing?.deny) & ~(VIEW_CHANNEL | CONNECT);
  const result = await options.discord.editChannelPermissionOverwrite({
    channelId: options.channel.id,
    overwriteId: options.userId,
    type: 1,
    allow: bitsToString(allow),
    deny: bitsToString(deny),
    requestId: options.requestId,
    reason: options.reason,
  });
  if (result.kind !== "ok") return result;
  await options.channels.removeRejectedUser(options.record.channelId, options.userId);
  return result;
}

export async function rejectMember(options: {
  readonly discord: DiscordApiPort;
  readonly channels: TemporaryChannelRepository;
  readonly channel: DiscordChannelDetails;
  readonly record: TemporaryChannelRecord;
  readonly userId: string;
  readonly requestId: string;
  readonly reason: string;
}): Promise<DiscordOperationResult> {
  const existing = findOverwrite(options.channel.permissionOverwrites, options.userId);
  const allow = parsePermissionBits(existing?.allow) & ~CONNECT;
  const deny = parsePermissionBits(existing?.deny) | CONNECT;
  const overwriteResult = await options.discord.editChannelPermissionOverwrite({
    channelId: options.channel.id,
    overwriteId: options.userId,
    type: 1,
    allow: bitsToString(allow),
    deny: bitsToString(deny),
    requestId: `${options.requestId}:overwrite`,
    reason: options.reason,
  });
  if (overwriteResult.kind !== "ok") return overwriteResult;

  await options.channels.addRejectedUser(options.record.channelId, options.userId);

  const voice = await options.discord.getUserVoiceChannel({
    guildId: options.record.guildId,
    userId: options.userId,
  });
  if (voice.kind === "found" && voice.value.channelId === options.record.channelId) {
    const disconnected = await options.discord.moveMemberToChannel({
      guildId: options.record.guildId,
      userId: options.userId,
      channelId: null,
      requestId: `${options.requestId}:disconnect`,
      reason: options.reason,
    });
    if (disconnected.kind !== "ok") return disconnected;
  }

  return { kind: "ok" };
}
