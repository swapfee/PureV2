import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import type { J2cMetrics } from "./metrics.ts";
import type { CreationReservationRepository, TemporaryChannelRepository } from "./repositories.ts";
import type { Clock } from "./time.ts";
import { systemClock } from "./time.ts";
import type { VoiceOccupancyTracker } from "./voice-occupancy.ts";

export interface ReconciliationFinding {
  readonly kind:
    | "missing_discord_channel"
    | "stuck_creating"
    | "stuck_deleting"
    | "expired_reservation"
    | "stale_orphan_preserved"
    | "recovered_active"
    | "occupancy_empty_candidate"
    | "occupancy_not_ready";
  readonly channelId?: string;
  readonly reservationId?: string;
  readonly guildId?: string;
}

export interface ReconciliationResult {
  readonly findings: readonly ReconciliationFinding[];
  readonly discordRequests: number;
}

export interface Reconciler {
  /** Database + REST only — safe before Gateway voice state is warm. */
  runDatabaseRest(): Promise<ReconciliationResult>;
  /** Requires a ready occupancy tracker — run after Gateway warm-up. */
  runOccupancyDependent(): Promise<ReconciliationResult>;
  /** @deprecated Prefer runDatabaseRest then runOccupancyDependent */
  run(): Promise<ReconciliationResult>;
}

async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, concurrency);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      if (current !== undefined) await worker(current);
    }
  });
  await Promise.all(runners);
}

export function createReconciler(options: {
  readonly channels: TemporaryChannelRepository;
  readonly reservations: CreationReservationRepository;
  readonly discord: DiscordApiPort;
  readonly metrics: J2cMetrics;
  readonly logger: Logger;
  readonly occupancy?: VoiceOccupancyTracker;
  readonly clock?: Clock;
  readonly concurrency?: number;
  readonly stuckAfterMs?: number;
}): Reconciler {
  const clock = options.clock ?? systemClock();
  const concurrency = options.concurrency ?? 4;
  const stuckAfterMs = options.stuckAfterMs ?? 60_000;

  const runDatabaseRest = async (): Promise<ReconciliationResult> => {
    const findings: ReconciliationFinding[] = [];
    let discordRequests = 0;
    const now = clock.now();

    const expired = await options.reservations.expireDue(now);
    if (expired > 0) {
      options.metrics.increment("reconciliationFindings", expired);
      for (let i = 0; i < expired; i += 1) {
        findings.push({ kind: "expired_reservation" });
      }
    }

    const stuckCreating = await options.channels.listByStatus(["creating"]);
    const stuckDeleting = await options.channels.listByStatus(["deleting"]);
    const stale = await options.channels.listByStatus(["stale"]);
    const active = await options.channels.listByStatus(["active"]);

    const inspect = async (
      channelId: string,
      guildId: string,
      status: "creating" | "deleting" | "active" | "stale",
    ): Promise<void> => {
      discordRequests += 1;
      const result = await options.discord.getChannel({ channelId });
      if (result.kind === "missing") {
        await options.channels.remove(channelId);
        findings.push({ kind: "missing_discord_channel", channelId, guildId });
        options.metrics.increment("reconciliationFindings");
        options.logger.info("Reconciliation removed missing Discord channel record", {
          guildId,
          channelId,
          status,
        });
        return;
      }
      if (result.kind !== "found") {
        options.metrics.increment("poisonedLifecycleOperations");
        options.logger.warn("Reconciliation channel lookup failed", {
          guildId,
          channelId,
          status,
          result: result.kind,
        });
        return;
      }

      if (status === "creating") {
        const record = await options.channels.findByChannelId(channelId);
        if (record && now.getTime() - record.updatedAt.getTime() >= stuckAfterMs) {
          findings.push({ kind: "stuck_creating", channelId, guildId });
          options.metrics.increment("reconciliationFindings");
          await options.channels.markActive(
            channelId,
            record.occupantIds.length > 0 ? record.occupantIds : [],
          );
          findings.push({ kind: "recovered_active", channelId, guildId });
          options.metrics.increment("reconciliationFindings");
        }
      }

      if (status === "deleting") {
        const record = await options.channels.findByChannelId(channelId);
        if (record && now.getTime() - record.updatedAt.getTime() >= stuckAfterMs) {
          findings.push({ kind: "stuck_deleting", channelId, guildId });
          options.metrics.increment("reconciliationFindings");
          discordRequests += 1;
          const deleted = await options.discord.deleteChannel({
            channelId,
            requestId: `j2c-reconcile-delete:${channelId}`,
            reason: "j2c reconciliation",
          });
          if (deleted.kind === "ok" || deleted.kind === "missing") {
            await options.channels.remove(channelId);
            options.metrics.increment("deletionSuccesses");
          } else {
            await options.channels.markStale(channelId, `reconcile_delete:${deleted.kind}`);
            options.metrics.increment("poisonedLifecycleOperations");
          }
        }
      }

      if (status === "stale") {
        findings.push({ kind: "stale_orphan_preserved", channelId, guildId });
        options.metrics.increment("reconciliationFindings");
      }
    };

    await mapPool(stuckCreating, concurrency, async (record) => {
      await inspect(record.channelId, record.guildId, "creating");
    });
    await mapPool(stuckDeleting, concurrency, async (record) => {
      await inspect(record.channelId, record.guildId, "deleting");
    });
    await mapPool(active, concurrency, async (record) => {
      await inspect(record.channelId, record.guildId, "active");
    });
    await mapPool(stale, concurrency, async (record) => {
      await inspect(record.channelId, record.guildId, "stale");
    });

    const activeCount = await options.channels.countByStatus("active");
    options.metrics.setActiveTemporaryChannels(activeCount);

    options.logger.info("Join-to-Create database/REST reconciliation completed", {
      findingCount: findings.length,
      discordRequests,
      concurrency,
    });

    return { findings, discordRequests };
  };

  const runOccupancyDependent = async (): Promise<ReconciliationResult> => {
    const findings: ReconciliationFinding[] = [];
    const occupancy = options.occupancy;
    if (!occupancy || !occupancy.isReady()) {
      findings.push({ kind: "occupancy_not_ready" });
      options.metrics.increment("reconciliationFindings");
      options.logger.warn("Occupancy-dependent reconciliation skipped; tracker not ready");
      return { findings, discordRequests: 0 };
    }

    const active = await options.channels.listByStatus(["active"]);
    for (const record of active) {
      const occupants = occupancy.getOccupants(record.guildId, record.channelId);
      if (occupants.kind !== "known") {
        findings.push({
          kind: "occupancy_not_ready",
          channelId: record.channelId,
          guildId: record.guildId,
        });
        options.metrics.increment("reconciliationFindings");
        continue;
      }
      await options.channels.setOccupants(
        record.channelId,
        occupants.userIds,
        occupants.userIds.length === 0 ? clock.now() : null,
      );
      if (occupants.userIds.length === 0) {
        findings.push({
          kind: "occupancy_empty_candidate",
          channelId: record.channelId,
          guildId: record.guildId,
        });
        options.metrics.increment("reconciliationFindings");
      }
    }

    options.logger.info("Join-to-Create occupancy reconciliation completed", {
      findingCount: findings.length,
    });
    return { findings, discordRequests: 0 };
  };

  return {
    runDatabaseRest,
    runOccupancyDependent,
    async run() {
      const first = await runDatabaseRest();
      const second = await runOccupancyDependent();
      return {
        findings: [...first.findings, ...second.findings],
        discordRequests: first.discordRequests + second.discordRequests,
      };
    },
  };
}
