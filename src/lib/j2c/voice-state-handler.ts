import type { Logger } from "../logger.ts";
import type { VoiceStateUpdatePayload } from "../runtime-types.ts";
import type { CreationLifecycle } from "./creation-lifecycle.ts";
import type { DeletionLifecycle } from "./deletion-lifecycle.ts";
import type { GuildConfigRepository, TemporaryChannelRepository } from "./repositories.ts";
import type { VoiceOccupancyTracker } from "./voice-occupancy.ts";

export interface VoiceStateHandler {
  handle(payload: VoiceStateUpdatePayload, eventId: string, sequence?: number): Promise<void>;
}

/**
 * Applies voice-state observations to the occupancy tracker, then routes lobby joins
 * and temporary-channel occupancy changes. Ownership does not transfer when the owner leaves.
 */
export function createVoiceStateHandler(options: {
  readonly configs: GuildConfigRepository;
  readonly channels: TemporaryChannelRepository;
  readonly creation: CreationLifecycle;
  readonly deletion: DeletionLifecycle;
  readonly occupancy: VoiceOccupancyTracker;
  readonly logger: Logger;
  readonly nextSequence?: () => number;
}): VoiceStateHandler {
  let localSeq = 0;
  const nextSeq = options.nextSequence ?? (() => {
    localSeq += 1;
    return localSeq;
  });

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

        if (occupancy.kind === "known") {
          await options.deletion.onOccupantsChanged(record.channelId, occupancy.userIds);
          continue;
        }

        // Fallback while warming: maintain best-effort Mongo occupants from the event stream.
        if (payload.channelId === record.channelId) {
          if (!record.occupantIds.includes(payload.userId)) {
            await options.deletion.onOccupantsChanged(record.channelId, [
              ...record.occupantIds,
              payload.userId,
            ]);
          }
        } else if (record.occupantIds.includes(payload.userId)) {
          await options.deletion.onOccupantsChanged(
            record.channelId,
            record.occupantIds.filter((id) => id !== payload.userId),
          );
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
