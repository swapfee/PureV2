import type { Logger } from "../logger.ts";
import type { DiscordApiPort, VoiceStateUpdatePayload } from "../runtime-types.ts";
import type { CreationLifecycle } from "./creation-lifecycle.ts";
import type { DeletionLifecycle } from "./deletion-lifecycle.ts";
import type { GuildConfigRepository, TemporaryChannelRepository } from "./repositories.ts";
import type { VoiceOccupancyTracker } from "./voice-occupancy.ts";
import {
  installVoiceControlPanel,
  refreshVoiceControlPanel,
  voicePanelNeedsRepair,
} from "./voice-panel-service.ts";

export interface VoiceStateHandler {
  handle(payload: VoiceStateUpdatePayload, eventId: string, sequence?: number): Promise<void>;
}

/** Minimum delay between panel repair attempts for the same channel. */
export const PANEL_REPAIR_COOLDOWN_MS = 60_000;

async function syncOwnerAbsence(
  channels: TemporaryChannelRepository,
  channelId: string,
  ownerId: string,
  occupantIds: readonly string[],
  ownerAbsentSince: Date | undefined,
): Promise<void> {
  const ownerPresent = occupantIds.includes(ownerId);
  if (ownerPresent) {
    if (ownerAbsentSince) {
      await channels.setOwnerAbsentSince(channelId, null);
    }
    return;
  }
  if (!ownerAbsentSince) {
    await channels.setOwnerAbsentSince(channelId, new Date());
  }
}

/**
 * Applies voice-state observations to the occupancy tracker, then routes lobby joins
 * and temporary-channel occupancy changes. Ownership does not transfer when the owner leaves;
 * claim becomes available after the grace period via the voice panel.
 */
export function createVoiceStateHandler(options: {
  readonly configs: GuildConfigRepository;
  readonly channels: TemporaryChannelRepository;
  readonly creation: CreationLifecycle;
  readonly deletion: DeletionLifecycle;
  readonly occupancy: VoiceOccupancyTracker;
  readonly logger: Logger;
  readonly discord?: DiscordApiPort;
  readonly nextSequence?: () => number;
  readonly now?: () => number;
  readonly panelRepairCooldownMs?: number;
}): VoiceStateHandler {
  let localSeq = 0;
  const nextSeq = options.nextSequence ?? (() => {
    localSeq += 1;
    return localSeq;
  });
  const now = options.now ?? (() => Date.now());
  const repairCooldownMs = options.panelRepairCooldownMs ?? PANEL_REPAIR_COOLDOWN_MS;
  const repairInFlight = new Set<string>();
  const repairNextAllowedAt = new Map<string, number>();
  let cachedBot:
    | { readonly id: string; readonly username: string }
    | undefined;

  const resolveBot = async (): Promise<{ id: string; username: string } | undefined> => {
    if (cachedBot) return cachedBot;
    if (!options.discord) return undefined;
    const me = await options.discord.getCurrentUser();
    if (me.kind !== "found") return undefined;
    cachedBot = me.value;
    return cachedBot;
  };

  const maybeRepairPanel = async (
    record: {
      readonly guildId: string;
      readonly channelId: string;
      readonly ownerId: string;
      readonly panelMessageId?: string;
      readonly panelVersion?: number;
      readonly panelOwnerId?: string;
    },
    eventId: string,
  ): Promise<void> => {
    if (!options.discord || !voicePanelNeedsRepair(record)) return;

    if (repairInFlight.has(record.channelId)) return;
    const allowedAt = repairNextAllowedAt.get(record.channelId) ?? 0;
    if (now() < allowedAt) return;

    const bot = await resolveBot();
    if (!bot) return;

    repairInFlight.add(record.channelId);
    repairNextAllowedAt.set(record.channelId, now() + repairCooldownMs);
    try {
      if (!record.panelMessageId) {
        await installVoiceControlPanel({
          discord: options.discord,
          channels: options.channels,
          logger: options.logger,
          guildId: record.guildId,
          channelId: record.channelId,
          ownerId: record.ownerId,
          botUserId: bot.id,
          botUsername: bot.username,
          requestId: `panel-repair:${record.channelId}:${eventId}`,
        });
      } else {
        await refreshVoiceControlPanel({
          discord: options.discord,
          channels: options.channels,
          logger: options.logger,
          channelId: record.channelId,
          ownerId: record.ownerId,
          botUsername: bot.username,
          panelMessageId: record.panelMessageId,
          requestId: `panel-repair:${record.channelId}:${eventId}`,
        });
      }
    } finally {
      repairInFlight.delete(record.channelId);
    }
  };

  return {
    async handle(payload, eventId, sequence) {
      if (payload.isBot) return;

      const seq = sequence ?? nextSeq();
      options.occupancy.apply({
        guildId: payload.guildId,
        userId: payload.userId,
        channelId: payload.channelId,
        sequence: seq,
        ...(payload.isBot ? { isBot: true } : {}),
      });

      const config = await options.configs.findByGuildId(payload.guildId);

      const active = await options.channels.listActiveByGuild(payload.guildId);
      const creating = (await options.channels.listByStatus(["creating"])).filter(
        (record) => record.guildId === payload.guildId,
      );
      const tracked = [...active, ...creating];

      for (const record of tracked) {
        const occupancy = options.occupancy.isReady()
          ? options.occupancy.getOccupants(record.guildId, record.channelId)
          : { kind: "unknown" as const };

        let occupantIds = record.occupantIds;
        if (occupancy.kind === "known") {
          occupantIds = occupancy.userIds;
          await options.deletion.onOccupantsChanged(record.channelId, occupancy.userIds);
        } else if (payload.channelId === record.channelId) {
          // Fallback while warming: maintain best-effort Mongo occupants from the event stream.
          if (!record.occupantIds.includes(payload.userId)) {
            occupantIds = [...record.occupantIds, payload.userId];
            await options.deletion.onOccupantsChanged(record.channelId, occupantIds);
          }
        } else if (record.occupantIds.includes(payload.userId)) {
          occupantIds = record.occupantIds.filter((id) => id !== payload.userId);
          await options.deletion.onOccupantsChanged(record.channelId, occupantIds);
        }

        if (record.status === "active") {
          await syncOwnerAbsence(
            options.channels,
            record.channelId,
            record.ownerId,
            occupantIds,
            record.ownerAbsentSince,
          );
          await maybeRepairPanel(record, eventId);
        }
      }

      if (config?.enabled && payload.channelId === config.lobbyChannelId) {
        const outcome = await options.creation.handleVoiceJoin({
          eventId,
          guildId: payload.guildId,
          memberId: payload.userId,
          joinedChannelId: payload.channelId,
          ...(payload.displayName === undefined ? {} : { username: payload.displayName }),
        });
        if (outcome.kind === "failed" || outcome.kind === "cancelled") {
          options.logger.debug("Join-to-create creation outcome", {
            guildId: payload.guildId,
            userId: payload.userId,
            eventId,
            outcome: outcome.kind,
            reason: outcome.reason,
          });
        }
      }
    },
  };
}
