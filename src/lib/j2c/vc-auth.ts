import type { TemporaryChannelRecord } from "../../models/temporary-channel.ts";
import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";

export type VcAuthFailure =
  | "dm_not_allowed"
  | "not_owner"
  | "channel_missing"
  | "not_in_managed_channel"
  | "voice_lookup_failed";

export type VcAuthResult =
  | { readonly ok: true; readonly channel: TemporaryChannelRecord }
  | { readonly ok: false; readonly reason: VcAuthFailure };

/**
 * Resolve the caller's current Discord voice channel to an active managed
 * temporary channel record. The Join to Create lobby is never managed — it
 * has no temporary_channels row — so lobby occupants are rejected here.
 */
async function resolveManagedTemporaryChannel(input: {
  readonly guildId: string;
  readonly userId: string;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): Promise<VcAuthResult> {
  const voice = await input.discord.getUserVoiceChannel({
    guildId: input.guildId,
    userId: input.userId,
  });
  if (voice.kind !== "found") {
    input.logger.warn("VC auth voice lookup failed", {
      guildId: input.guildId,
      userId: input.userId,
      result: voice.kind,
    });
    return { ok: false, reason: "voice_lookup_failed" };
  }
  if (!voice.value.channelId) {
    return { ok: false, reason: "not_in_managed_channel" };
  }

  const record = await input.channels.findByChannelId(voice.value.channelId);
  // Lobby / normal guild channels are not in temporary_channels.
  if (!record || record.status !== "active" || record.guildId !== input.guildId) {
    return { ok: false, reason: "not_in_managed_channel" };
  }

  const discordChannel = await input.discord.getChannel({ channelId: record.channelId });
  if (discordChannel.kind === "missing") {
    return { ok: false, reason: "channel_missing" };
  }
  if (discordChannel.kind !== "found") {
    input.logger.warn("VC auth channel lookup failed", {
      guildId: input.guildId,
      channelId: record.channelId,
      userId: input.userId,
      result: discordChannel.kind,
    });
    return { ok: false, reason: "voice_lookup_failed" };
  }

  return { ok: true, channel: record };
}

/**
 * Owner-only authorization for /vc commands.
 * Requires the caller to be connected to their own managed temporary channel
 * (database record). The Join to Create lobby cannot be managed.
 */
export async function authorizeVcOwner(input: {
  readonly guildId: string | undefined;
  readonly userId: string;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): Promise<VcAuthResult> {
  if (!input.guildId) {
    return { ok: false, reason: "dm_not_allowed" };
  }

  const resolved = await resolveManagedTemporaryChannel({
    guildId: input.guildId,
    userId: input.userId,
    channels: input.channels,
    discord: input.discord,
    logger: input.logger,
  });
  if (!resolved.ok) return resolved;
  if (resolved.channel.ownerId !== input.userId) {
    return { ok: false, reason: "not_owner" };
  }
  return resolved;
}

/**
 * Any member currently connected to a managed temporary channel.
 * Rejects the Join to Create lobby and any non-managed voice channel.
 */
export async function authorizeVcConnectedMember(input: {
  readonly guildId: string | undefined;
  readonly userId: string;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): Promise<VcAuthResult> {
  if (!input.guildId) {
    return { ok: false, reason: "dm_not_allowed" };
  }

  return resolveManagedTemporaryChannel({
    guildId: input.guildId,
    userId: input.userId,
    channels: input.channels,
    discord: input.discord,
    logger: input.logger,
  });
}

export function vcAuthUserMessage(reason: VcAuthFailure): string {
  const messages: Record<VcAuthFailure, string> = {
    dm_not_allowed: "This command can only be used in a server.",
    not_owner: "Only the channel owner can use this command.",
    channel_missing: "Your temporary channel no longer exists.",
    not_in_managed_channel: "You must be connected to a managed voice channel.",
    voice_lookup_failed: "Unable to verify your voice state. Please try again.",
  };
  return messages[reason];
}
