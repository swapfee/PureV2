import type { TemporaryChannelRecord } from "../../models/temporary-channel.ts";
import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import type { OwnershipService } from "./ownership.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";

export type VcAuthFailure =
  | "dm_not_allowed"
  | "no_active_channel"
  | "not_owner"
  | "channel_missing"
  | "owner_not_connected"
  | "voice_lookup_failed";

export type VcAuthResult =
  | { readonly ok: true; readonly channel: TemporaryChannelRecord }
  | { readonly ok: false; readonly reason: VcAuthFailure };

/**
 * Owner-only authorization for /vc commands.
 * Does not trust channel names, client-supplied channel IDs, or permission overwrites.
 */
export async function authorizeVcOwner(input: {
  readonly guildId: string | undefined;
  readonly userId: string;
  readonly ownership: OwnershipService;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): Promise<VcAuthResult> {
  if (!input.guildId) {
    return { ok: false, reason: "dm_not_allowed" };
  }

  const owned = await input.ownership.findOwnedChannel(input.guildId, input.userId);
  if (!owned || owned.status !== "active") {
    return { ok: false, reason: "no_active_channel" };
  }
  if (owned.ownerId !== input.userId) {
    return { ok: false, reason: "not_owner" };
  }

  const discordChannel = await input.discord.getChannel({ channelId: owned.channelId });
  if (discordChannel.kind === "missing") {
    return { ok: false, reason: "channel_missing" };
  }
  if (discordChannel.kind !== "found") {
    input.logger.warn("VC auth channel lookup failed", {
      guildId: input.guildId,
      channelId: owned.channelId,
      ownerId: input.userId,
      result: discordChannel.kind,
    });
    return { ok: false, reason: "voice_lookup_failed" };
  }

  const voice = await input.discord.getUserVoiceChannel({
    guildId: input.guildId,
    userId: input.userId,
  });
  if (voice.kind !== "found") {
    return { ok: false, reason: "voice_lookup_failed" };
  }
  if (voice.value.channelId !== owned.channelId) {
    return { ok: false, reason: "owner_not_connected" };
  }

  return { ok: true, channel: owned };
}

export function vcAuthUserMessage(reason: VcAuthFailure): string {
  const messages: Record<VcAuthFailure, string> = {
    dm_not_allowed: "This command can only be used in a server.",
    no_active_channel: "You do not own an active temporary voice channel.",
    not_owner: "Only the channel owner can use this command.",
    channel_missing: "Your temporary channel no longer exists.",
    owner_not_connected: "You must be connected to your temporary voice channel.",
    voice_lookup_failed: "Could not verify your voice state. Try again shortly.",
  };
  return messages[reason];
}
