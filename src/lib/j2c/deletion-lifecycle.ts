import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import type { TemporaryChannelRecord } from "../../models/temporary-channel.ts";
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

const retainedCategoryCleanupLocks = new Map<string, Promise<void>>();

async function withRetainedCategoryCleanupLock<T>(
  categoryId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = retainedCategoryCleanupLocks.get(categoryId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  retainedCategoryCleanupLocks.set(categoryId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (retainedCategoryCleanupLocks.get(categoryId) === queued) {
      retainedCategoryCleanupLocks.delete(categoryId);
    }
  }
}

/** Removes a deleted temp-channel record and its reset-retained category when it is the last one. */
export async function finalizeDeletedTemporaryChannel(options: {
  readonly record: TemporaryChannelRecord;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
}): Promise<boolean> {
  const categoryId = options.record.cleanupCategoryId;
  if (!categoryId) {
    await options.channels.remove(options.record.channelId);
    return true;
  }

  return withRetainedCategoryCleanupLock(categoryId, async () => {
    const current = await options.channels.findByChannelId(options.record.channelId);
    if (!current) return true;

    const guildChannels = await options.channels.listByGuild(options.record.guildId);
    const hasRetainedSibling = guildChannels.some(
      (record) =>
        record.channelId !== options.record.channelId &&
        record.cleanupCategoryId === categoryId,
    );

    if (!hasRetainedSibling) {
      const deletedCategory = await options.discord.deleteChannel({
        channelId: categoryId,
        requestId: `j2c-delete-retained-category:${categoryId}`,
        reason: "join-to-create reset cleanup",
      });
      if (deletedCategory.kind !== "ok" && deletedCategory.kind !== "missing") {
        options.logger.error("Retained Join-to-Create category deletion failed", {
          guildId: options.record.guildId,
          channelId: options.record.channelId,
          categoryId,
          result: deletedCategory.kind,
        });
        return false;
      }
      options.logger.info("Retained Join-to-Create category deleted", {
        guildId: options.record.guildId,
        categoryId,
      });
    }

    await options.channels.remove(options.record.channelId);
    return true;
  });
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
  readonly onTemporaryChannelDeleted?: (record: TemporaryChannelRecord) => Promise<void>;
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

  const notifyTemporaryChannelDeleted = async (
    record: TemporaryChannelRecord,
  ): Promise<void> => {
    if (!options.onTemporaryChannelDeleted) return;
    try {
      await options.onTemporaryChannelDeleted(record);
    } catch (error: unknown) {
      options.metrics.increment("poisonedLifecycleOperations");
      options.logger.error("Post-deletion temporary channel callback failed", {
        guildId: record.guildId,
        channelId: record.channelId,
        ownerId: record.ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      const finalized = await finalizeDeletedTemporaryChannel({
        record,
        channels: options.channels,
        discord: options.discord,
        logger: options.logger,
      });
      if (!finalized) {
        options.metrics.increment("poisonedLifecycleOperations");
        return;
      }
      options.metrics.increment("deletionSuccesses");
      await refreshActiveGauge();
      await notifyTemporaryChannelDeleted(record);
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
      const finalized = await finalizeDeletedTemporaryChannel({
        record: claimed,
        channels: options.channels,
        discord: options.discord,
        logger: options.logger,
      });
      if (!finalized) {
        options.metrics.increment("poisonedLifecycleOperations");
        return;
      }
      options.metrics.increment("deletionSuccesses");
      await refreshActiveGauge();
      await notifyTemporaryChannelDeleted(claimed);
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
