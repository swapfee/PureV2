import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import type { OwnerBlockListRepository, TemporaryChannelRepository } from "./repositories.ts";
import { synchronizeTemporaryChannelAccess } from "./voice-controls.ts";

/** After ownership changes, replace previous-owner blocks with the new owner's list. */
export async function syncBlocksAfterOwnershipChange(options: {
  readonly blocks: OwnerBlockListRepository;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly guildId: string;
  readonly channelId: string;
  readonly newOwnerId: string;
  readonly requestId: string;
}): Promise<void> {
  const record = await options.channels.findByChannelId(options.channelId);
  if (!record || record.status !== "active") return;
  const blockedUserIds = await options.blocks.getBlockedUserIds(options.guildId, options.newOwnerId);
  const sync = await synchronizeTemporaryChannelAccess({
    discord: options.discord,
    channels: options.channels,
    record,
    blockedUserIds,
    requestId: options.requestId,
    reason: "ownership change block list sync",
  });
  if (!sync.ok) {
    options.logger.warn("Failed to fully sync block list after ownership change", {
      guildId: options.guildId,
      channelId: options.channelId,
      newOwnerId: options.newOwnerId,
      failedUserIds: sync.failedUserIds,
    });
  }
}
