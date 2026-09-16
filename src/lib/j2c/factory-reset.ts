import type { TemporaryChannelRecord } from "../../models/temporary-channel.ts";
import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import { DEFAULT_SETUP_CATEGORY_NAME } from "./setup-channel-names.ts";
import type {
  CreationReservationRepository,
  GuildConfigRepository,
  TemporaryChannelRepository,
} from "./repositories.ts";
import type { VoiceOccupancyTracker } from "./voice-occupancy.ts";

export interface FactoryResetResult {
  readonly deletedTemporaryChannels: number;
  readonly keptTemporaryChannels: number;
  readonly deletedLobby: boolean;
  readonly deletedCategory: boolean;
  readonly keptCategory: boolean;
  readonly renamedCategory: boolean;
  readonly removedConfig: boolean;
  readonly failedReservations: number;
}

export function isTemporaryChannelOccupied(input: {
  readonly record: TemporaryChannelRecord;
  readonly occupancy: VoiceOccupancyTracker;
}): boolean {
  if (input.occupancy.isReady()) {
    const occupants = input.occupancy.getOccupants(input.record.guildId, input.record.channelId);
    if (occupants.kind === "known") {
      return occupants.userIds.length > 0;
    }
  }
  return input.record.occupantIds.length > 0;
}

/**
 * Removes Join-to-Create for a guild:
 * - deletes empty temporary channels
 * - keeps non-empty temporary channels (still tracked for later empty deletion)
 * - deletes the lobby
 * - keeps the category when occupied temp channels remain (renames it); otherwise deletes it
 * - deletes guild config and fails in-flight reservations
 */
export async function runFactoryReset(options: {
  readonly guildId: string;
  readonly interactionId: string;
  readonly configs: GuildConfigRepository;
  readonly channels: TemporaryChannelRepository;
  readonly reservations: CreationReservationRepository;
  readonly occupancy: VoiceOccupancyTracker;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): Promise<FactoryResetResult | { readonly kind: "not_configured" }> {
  const config = await options.configs.findByGuildId(options.guildId);
  if (!config) {
    return { kind: "not_configured" };
  }

  const reason = "PureV2 Join-to-Create factory reset";
  const tracked = await options.channels.listByGuild(options.guildId);
  let deletedTemporaryChannels = 0;
  let keptTemporaryChannels = 0;

  for (const record of tracked) {
    const occupied = isTemporaryChannelOccupied({
      record,
      occupancy: options.occupancy,
    });

    if (occupied) {
      keptTemporaryChannels += 1;
      continue;
    }

    const deleted = await options.discord.deleteChannel({
      channelId: record.channelId,
      requestId: `setup-reset:${options.interactionId}:temp:${record.channelId}`,
      reason,
    });
    if (deleted.kind === "ok" || deleted.kind === "missing") {
      await options.channels.remove(record.channelId);
      deletedTemporaryChannels += 1;
    } else {
      options.logger.warn("Factory reset failed to delete temporary channel", {
        guildId: options.guildId,
        channelId: record.channelId,
        outcome: deleted.kind,
      });
      // Treat as kept so we do not delete the category while Discord still has it.
      keptTemporaryChannels += 1;
    }
  }

  let deletedLobby = false;
  const lobbyDelete = await options.discord.deleteChannel({
    channelId: config.lobbyChannelId,
    requestId: `setup-reset:${options.interactionId}:lobby`,
    reason,
  });
  if (lobbyDelete.kind === "ok" || lobbyDelete.kind === "missing") {
    deletedLobby = true;
  } else {
    options.logger.warn("Factory reset failed to delete lobby", {
      guildId: options.guildId,
      channelId: config.lobbyChannelId,
      outcome: lobbyDelete.kind,
    });
  }

  let deletedCategory = false;
  let keptCategory = false;
  let renamedCategory = false;

  if (keptTemporaryChannels > 0) {
    keptCategory = true;
    const rename = await options.discord.editChannel({
      channelId: config.categoryId,
      requestId: `setup-reset:${options.interactionId}:rename-category`,
      name: DEFAULT_SETUP_CATEGORY_NAME,
      reason,
    });
    renamedCategory = rename.kind === "ok";
  } else {
    const categoryDelete = await options.discord.deleteChannel({
      channelId: config.categoryId,
      requestId: `setup-reset:${options.interactionId}:category`,
      reason,
    });
    if (categoryDelete.kind === "ok" || categoryDelete.kind === "missing") {
      deletedCategory = true;
    } else {
      options.logger.warn("Factory reset failed to delete category", {
        guildId: options.guildId,
        channelId: config.categoryId,
        outcome: categoryDelete.kind,
      });
      keptCategory = true;
    }
  }

  let failedReservations = 0;
  const reserved = await options.reservations.listByStatus("reserved");
  for (const reservation of reserved) {
    if (reservation.guildId !== options.guildId) continue;
    const failed = await options.reservations.fail(reservation.reservationId, "factory_reset");
    if (failed) failedReservations += 1;
  }

  const removedConfig = await options.configs.deleteByGuildId(options.guildId);

  options.logger.info("Join-to-Create factory reset completed", {
    guildId: options.guildId,
    deletedTemporaryChannels,
    keptTemporaryChannels,
    deletedLobby,
    deletedCategory,
    keptCategory,
    renamedCategory,
    removedConfig,
    failedReservations,
  });

  return {
    deletedTemporaryChannels,
    keptTemporaryChannels,
    deletedLobby,
    deletedCategory,
    keptCategory,
    renamedCategory,
    removedConfig,
    failedReservations,
  };
}
