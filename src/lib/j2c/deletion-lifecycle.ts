import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import type { J2cMetrics } from "./metrics.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";
import { deletionRequestId } from "./request-ids.ts";
import type { Clock, ScheduledTask, TimerScheduler } from "./time.ts";
import { systemClock, systemTimerScheduler } from "./time.ts";
import { cancelPendingJoinRequestsForChannel } from "./vc-join-request.ts";
import type { VoiceOccupancyTracker } from "./voice-occupancy.ts";

export const EMPTY_CHANNEL_DELAY_MS = 3_000;

export interface DeletionLifecycle {
  onOccupantsChanged(channelId: string, occupantIds: readonly string[]): Promise<void>;
  cancelPending(channelId: string): void;
}

export function createDeletionLifecycle(options: {
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly metrics: J2cMetrics;
  readonly logger: Logger;
  readonly occupancy: VoiceOccupancyTracker;
  readonly clock?: Clock;
  readonly timers?: TimerScheduler;
  readonly emptyDelayMs?: number;
}): DeletionLifecycle {
  const clock = options.clock ?? systemClock();
  const timers = options.timers ?? systemTimerScheduler();
  const delayMs = options.emptyDelayMs ?? EMPTY_CHANNEL_DELAY_MS;
  const pending = new Map<string, ScheduledTask>();

  const cancelPending = (channelId: string): void => {
    const task = pending.get(channelId);
    if (task) {
      task.cancel();
      pending.delete(channelId);
    }
  };

  const refreshActiveGauge = async (): Promise<void> => {
    const count = await options.channels.countByStatus("active");
    options.metrics.setActiveTemporaryChannels(count);
  };

  const executeDeletion = async (channelId: string, emptySinceMs: number): Promise<void> => {
    pending.delete(channelId);
    options.metrics.increment("emptyDeletionAttempts");

    const record = await options.channels.findByChannelId(channelId);
    if (!record || record.status !== "active") {
      return;
    }

    if (!options.occupancy.isReady()) {
      options.metrics.increment("poisonedLifecycleOperations");
      await options.channels.markStale(channelId, "occupancy_not_ready");
      options.logger.warn("Deferred deletion; occupancy cache not ready", {
        guildId: record.guildId,
        channelId,
      });
      return;
    }

    const occupancy = options.occupancy.getOccupants(record.guildId, channelId);
    if (occupancy.kind === "unknown") {
      options.metrics.increment("poisonedLifecycleOperations");
      await options.channels.markStale(channelId, "occupancy_unknown");
      options.logger.warn("Deferred deletion; occupancy unknown", {
        guildId: record.guildId,
        channelId,
      });
      return;
    }

    if (occupancy.userIds.length > 0) {
      await options.channels.setOccupants(channelId, occupancy.userIds, null);
      options.logger.info("Skipping deletion; occupancy cache shows members present", {
        guildId: record.guildId,
        channelId,
        occupantCount: occupancy.userIds.length,
      });
      return;
    }

    // Fresh Discord channel existence check (REST cannot list voice members).
    const channel = await options.discord.getChannel({ channelId });
    if (channel.kind === "missing") {
      await cancelPendingJoinRequestsForChannel({
        discord: options.discord,
        channelId,
        requestId: `j2c-delete-missing:${channelId}`,
      });
      await options.channels.remove(channelId);
      options.metrics.increment("deletionSuccesses");
      await refreshActiveGauge();
      options.logger.info("Temporary channel already missing; cleaned up", {
        guildId: record.guildId,
        channelId,
      });
      return;
    }
    if (channel.kind !== "found") {
      options.metrics.increment("poisonedLifecycleOperations");
      await options.channels.markStale(channelId, `predelete_check:${channel.kind}`);
      options.logger.error("Pre-deletion channel check failed", {
        guildId: record.guildId,
        channelId,
        result: channel.kind,
      });
      return;
    }

    // Re-check occupancy after the network round-trip.
    const latestOccupancy = options.occupancy.getOccupants(record.guildId, channelId);
    if (latestOccupancy.kind !== "known" || latestOccupancy.userIds.length > 0) {
      if (latestOccupancy.kind === "known") {
        await options.channels.setOccupants(channelId, latestOccupancy.userIds, null);
      }
      return;
    }

    const requestId = deletionRequestId(channelId, emptySinceMs);
    const claimed = await options.channels.beginDeleting(channelId, requestId, clock.now());
    if (!claimed) {
      return;
    }

    // Cancel join requests while the channel (and request messages) may still exist.
    await cancelPendingJoinRequestsForChannel({
      discord: options.discord,
      channelId,
      requestId,
    });

    const deleted = await options.discord.deleteChannel({
      channelId,
      requestId,
      reason: "join-to-create empty channel",
    });

    if (deleted.kind === "ok" || deleted.kind === "missing") {
      await options.channels.remove(channelId);
      options.metrics.increment("deletionSuccesses");
      await refreshActiveGauge();
      options.logger.info("Temporary channel deleted", {
        guildId: claimed.guildId,
        channelId,
        requestId,
      });
      return;
    }

    options.metrics.increment("poisonedLifecycleOperations");
    await options.channels.markStale(channelId, `delete_failed:${deleted.kind}`);
    options.logger.error("Temporary channel deletion failed", {
      guildId: claimed.guildId,
      channelId,
      requestId,
      result: deleted.kind,
    });
  };

  return {
    cancelPending,

    async onOccupantsChanged(channelId, occupantIds) {
      const existing = await options.channels.findByChannelId(channelId);
      if (!existing || (existing.status !== "active" && existing.status !== "creating")) {
        return;
      }

      if (occupantIds.length > 0) {
        cancelPending(channelId);
        await options.channels.setOccupants(channelId, occupantIds, null);
        return;
      }

      const emptySince = clock.now();
      await options.channels.setOccupants(channelId, [], emptySince);
      cancelPending(channelId);
      const emptySinceMs = emptySince.getTime();
      const task = timers.schedule(delayMs, () => executeDeletion(channelId, emptySinceMs));
      pending.set(channelId, task);
    },
  };
}
