import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import type {
  GuildConfigRepository,
  OwnerBlockListRepository,
  TemporaryChannelRepository,
} from "./repositories.ts";
import { postGuildErrorLog } from "./guild-error-log.ts";
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
  readonly configs?: GuildConfigRepository;
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
    if (options.configs) {
      await postGuildErrorLog({
        discord: options.discord,
        configs: options.configs,
        logger: options.logger,
        guildId: options.guildId,
        requestId: `${options.requestId}:error-log`,
        entry: {
          area: "block_list",
          summary: "Block list sync failed after ownership transfer.",
          detail: `Failed user ids: ${sync.failedUserIds.join(", ") || "unknown"}.`,
          solution:
            "Ensure the bot can Manage Permissions on the channel, then have the new owner re-apply blocks or run another ownership transfer to retry sync.",
          userId: options.newOwnerId,
          channelId: options.channelId,
        },
      });
    }
  }
}
