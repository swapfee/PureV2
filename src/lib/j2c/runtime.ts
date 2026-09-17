import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import { createCreationLifecycle } from "./creation-lifecycle.ts";
import { createDeletionLifecycle } from "./deletion-lifecycle.ts";
import { createJ2cMetrics, type J2cMetrics, type J2cMetricsSnapshot } from "./metrics.ts";
import type {
  CreationReservationRepository,
  GuildConfigRepository,
  OwnerBlockListRepository,
  TemporaryChannelRepository,
} from "./repositories.ts";
import { createOwnershipService, type OwnershipService } from "./ownership.ts";
import { createReconciler, type ReconciliationResult } from "./reconciliation.ts";
import { createReservationService } from "./reservation-service.ts";
import type { Clock, TimerScheduler } from "./time.ts";
import { systemTimerScheduler } from "./time.ts";
import { createVoiceOccupancyTracker, type VoiceOccupancyTracker } from "./voice-occupancy.ts";
import { createVoiceStateHandler, type VoiceStateHandler } from "./voice-state-handler.ts";

/** Second sweep after seed/reconcile to catch leaves during the restart window. */
export const RESTART_EMPTY_CHANNEL_RESWEEP_MS = 5_000;

export interface J2cReadinessState {
  readonly modelsInitialized: boolean;
  readonly indexesVerified: boolean;
  readonly databaseRestReconciliationCompleted: boolean;
  readonly occupancyReady: boolean;
  readonly occupancyReconciliationCompleted: boolean;
  readonly fatal: boolean;
  readonly detail?: string;
}

export interface J2cRuntime {
  readonly metrics: J2cMetrics;
  readonly ownership: OwnershipService;
  readonly voice: VoiceStateHandler;
  readonly occupancy: VoiceOccupancyTracker;
  readonly readiness: () => J2cReadinessState & { readonly ready: boolean };
  markModelsInitialized(): void;
  markIndexesVerified(ok: boolean, detail?: string): void;
  markOccupancyReady(ready: boolean): void;
  markFatal(detail: string): void;
  reconcileDatabaseRest(): Promise<ReconciliationResult>;
  reconcileOccupancy(): Promise<ReconciliationResult>;
  /**
   * After a guild's voice states are seeded, schedule deletion for temp channels
   * that are empty in the occupancy cache (covers worker restart without a leave event).
   */
  scheduleEmptyChannelDeletions(guildId: string): Promise<void>;
  /**
   * Queue a delayed empty-channel sweep for leaves that arrive during the
   * seed/reconcile restart window after the immediate sweep already ran.
   */
  scheduleEmptyChannelDeletionResweep(guildId: string): void;
  /**
   * After occupancy reconcile, queue delayed empty sweeps for every guild that
   * still has active temporary channels (restart-window leave catch).
   */
  scheduleRestartEmptyChannelResweeps(): Promise<void>;
  /** Runs database/REST reconcile only; occupancy must be completed separately after warm-up. */
  reconcile(): Promise<ReconciliationResult>;
  snapshotMetrics(): J2cMetricsSnapshot;
}

export function createJ2cRuntime(options: {
  readonly configs: GuildConfigRepository;
  readonly channels: TemporaryChannelRepository;
  readonly reservations: CreationReservationRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly timers?: TimerScheduler;
  readonly reconcileConcurrency?: number;
  readonly metrics?: J2cMetrics;
  readonly occupancy?: VoiceOccupancyTracker;
  readonly blocks?: OwnerBlockListRepository;
}): J2cRuntime {
  const metrics = options.metrics ?? createJ2cMetrics();
  const occupancy = options.occupancy ?? createVoiceOccupancyTracker();
  const reservationService = createReservationService({
    reservations: options.reservations,
    channels: options.channels,
    metrics,
    ...(options.clock ? { now: () => options.clock!.now() } : {}),
  });
  const ownership = createOwnershipService(options.channels);
  const creation = createCreationLifecycle({
    configs: options.configs,
    channels: options.channels,
    reservations: options.reservations,
    reservationService,
    discord: options.discord,
    metrics,
    logger: options.logger,
    ...(options.blocks ? { blocks: options.blocks } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const deletion = createDeletionLifecycle({
    channels: options.channels,
    discord: options.discord,
    metrics,
    logger: options.logger,
    occupancy,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  });
  const voice = createVoiceStateHandler({
    configs: options.configs,
    channels: options.channels,
    creation,
    deletion,
    occupancy,
    logger: options.logger,
    discord: options.discord,
  });
  const reconciler = createReconciler({
    channels: options.channels,
    reservations: options.reservations,
    discord: options.discord,
    metrics,
    logger: options.logger,
    occupancy,
    deletion,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.reconcileConcurrency === undefined
      ? {}
      : { concurrency: options.reconcileConcurrency }),
  });

  const timers = options.timers ?? systemTimerScheduler();
  const restartResweepPending = new Set<string>();

  const scheduleEmptyChannelDeletions = async (guildId: string): Promise<void> => {
    if (!occupancy.isReady()) return;
    const active = await options.channels.listActiveByGuild(guildId);
    for (const record of active) {
      const occupants = occupancy.getOccupants(record.guildId, record.channelId);
      if (occupants.kind !== "known") continue;
      await deletion.onOccupantsChanged(record.channelId, occupants.userIds);
    }
  };

  const scheduleEmptyChannelDeletionResweep = (guildId: string): void => {
    if (restartResweepPending.has(guildId)) return;
    restartResweepPending.add(guildId);
    timers.schedule(RESTART_EMPTY_CHANNEL_RESWEEP_MS, () => {
      restartResweepPending.delete(guildId);
      return scheduleEmptyChannelDeletions(guildId).catch((error: unknown) => {
        options.logger.error("Failed delayed empty-channel resweep after restart", {
          guildId,
          error,
        });
      });
    });
  };

  const scheduleRestartEmptyChannelResweeps = async (): Promise<void> => {
    const active = await options.channels.listByStatus(["active"]);
    const guildIds = new Set(active.map((record) => record.guildId));
    for (const guildId of guildIds) {
      scheduleEmptyChannelDeletionResweep(guildId);
    }
  };

  let modelsInitialized = false;
  let indexesVerified = false;
  let databaseRestReconciliationCompleted = false;
  let occupancyReady = false;
  let occupancyReconciliationCompleted = false;
  let fatal = false;
  let detail: string | undefined;

  return {
    metrics,
    ownership,
    voice,
    occupancy,
    snapshotMetrics: () => metrics.snapshot(),
    markModelsInitialized() {
      modelsInitialized = true;
    },
    markIndexesVerified(ok, message) {
      indexesVerified = ok;
      if (!ok) {
        fatal = true;
        detail = message ?? "indexes_missing";
      }
    },
    markOccupancyReady(ready) {
      occupancyReady = ready;
      if (ready) occupancy.markReady();
      else occupancy.markWarming();
    },
    markFatal(message) {
      fatal = true;
      detail = message;
    },
    readiness() {
      const ready =
        modelsInitialized &&
        indexesVerified &&
        databaseRestReconciliationCompleted &&
        occupancyReady &&
        occupancyReconciliationCompleted &&
        !fatal;
      return {
        modelsInitialized,
        indexesVerified,
        databaseRestReconciliationCompleted,
        occupancyReady,
        occupancyReconciliationCompleted,
        fatal,
        ready,
        ...(detail === undefined ? {} : { detail }),
      };
    },
    async reconcileDatabaseRest() {
      try {
        const result = await reconciler.runDatabaseRest();
        databaseRestReconciliationCompleted = true;
        return result;
      } catch (error) {
        fatal = true;
        detail = error instanceof Error ? error.message : "reconciliation_failed";
        throw error;
      }
    },
    async reconcileOccupancy() {
      try {
        if (!occupancyReady) {
          throw new Error("occupancy_not_ready");
        }
        const result = await reconciler.runOccupancyDependent();
        occupancyReconciliationCompleted = true;
        return result;
      } catch (error) {
        fatal = true;
        detail = error instanceof Error ? error.message : "occupancy_reconciliation_failed";
        throw error;
      }
    },
    scheduleEmptyChannelDeletions,
    scheduleEmptyChannelDeletionResweep,
    scheduleRestartEmptyChannelResweeps,
    async reconcile() {
      return this.reconcileDatabaseRest();
    },
  };
}
