import { join } from "node:path";

import type { DiscordGatewayPayload } from "discordeno";

import { loadCommandModules, loadEventModules } from "../../handlers/loaders.ts";
import { listJ2cIndexes } from "../../models/index-sync.ts";
import type { CoordinatorConfig } from "../config.ts";
import { parseCoordinatorConfig, restProxyBaseUrl } from "../config.ts";
import { toDatabaseConfig } from "../database-config.ts";
import { createMongoDatabase, type DatabaseConnection } from "../database.ts";
import { verifyRequiredIndexSpecs } from "../j2c/index-requirements.ts";
import { createJ2cMetrics, type J2cMetrics } from "../j2c/metrics.ts";
import {
  createMongooseCreationReservationRepository,
  createMongooseGuildConfigRepository,
  createMongooseOwnerBlockListRepository,
  createMongooseTemporaryChannelRepository,
} from "../j2c/mongoose-repositories.ts";
import { createRestManagerDiscordPort } from "../j2c/rest-discord-port.ts";
import type { GuildConfigRepository, TemporaryChannelRepository } from "../j2c/repositories.ts";
import { createJ2cRuntime, type J2cRuntime } from "../j2c/runtime.ts";
import { createLogger, type Logger } from "../logger.ts";
import { assignWorker } from "../sharding.ts";
import { createMongooseVoiceStatsRepository } from "../stats/mongoose-repository.ts";
import type { VoiceStatsRepository } from "../stats/repositories.ts";
import { createDashboardControlApi, type DashboardControlApi } from "./dashboard-api.ts";
import { createCoordinatorGateway } from "./gateway.ts";
import {
  allComponentsHealthy,
  createHealthServer,
  type ComponentStatus,
  type ReadinessComponent,
  type ReadinessReport,
} from "./health.ts";
import { createCoordinatorMetrics } from "./metrics.ts";
import { createCoordinatorRest } from "./rest.ts";
import { createWorkerSupervisor } from "./supervisor.ts";

export interface CoordinatorRuntime {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  readiness(): ReadinessReport;
}

function extractGuildId(payload: DiscordGatewayPayload): string | undefined {
  if (typeof payload.d !== "object" || payload.d === null) return undefined;
  if (!("guild_id" in payload.d)) return undefined;
  const guildId = payload.d.guild_id;
  return typeof guildId === "string" ? guildId : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    record[key] = nested;
  }
  return record;
}

function readSnowflakeField(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function observeGatewayVoiceState(
  runtime: J2cRuntime,
  payload: DiscordGatewayPayload,
  sequence: number,
): void {
  if (payload.t === "VOICE_STATE_UPDATE") {
    const data = asRecord(payload.d);
    if (!data) return;
    const guildId = typeof data.guild_id === "string" ? data.guild_id : undefined;
    const userId = typeof data.user_id === "string" ? data.user_id : undefined;
    if (!guildId || !userId) return;
    const channelId = readSnowflakeField(data.channel_id);
    if (channelId === undefined) return;
    const member = asRecord(data.member);
    const memberUser = member ? asRecord(member.user) : undefined;
    const isBot = memberUser?.bot === true;
    runtime.occupancy.apply({
      guildId,
      userId,
      channelId,
      sequence,
      ...(isBot ? { isBot: true } : {}),
    });
    // Coordinator occupancy is separate from the worker voice-state-handler path;
    // schedule empty-temp deletion when a leave/move may have emptied a tracked channel.
    if (runtime.occupancy.isReady()) {
      void runtime.scheduleEmptyChannelDeletions(guildId);
    }
    return;
  }

  if (payload.t === "GUILD_CREATE") {
    const data = asRecord(payload.d);
    if (!data) return;
    const guildId = typeof data.id === "string" ? data.id : undefined;
    if (!guildId) return;
    const voiceStates = Array.isArray(data.voice_states) ? data.voice_states : [];
    const seeded: { userId: string; channelId: string | null }[] = [];
    for (const state of voiceStates) {
      const record = asRecord(state);
      if (!record) continue;
      const userId = typeof record.user_id === "string" ? record.user_id : undefined;
      if (!userId) continue;
      const channelId = readSnowflakeField(record.channel_id);
      if (channelId === undefined) continue;
      const member = asRecord(record.member);
      const user = member ? asRecord(member.user) : undefined;
      if (user?.bot === true) continue;
      seeded.push({ userId, channelId });
    }
    runtime.occupancy.seedGuildVoiceStates(guildId, seeded);
    // Late GUILD_CREATE after initial occupancy reconcile still needs empty-channel sweep.
    if (runtime.occupancy.isReady()) {
      void runtime.scheduleEmptyChannelDeletions(guildId);
      runtime.scheduleEmptyChannelDeletionResweep(guildId);
    }
  }
}

export function createCoordinatorRuntime(
  config: CoordinatorConfig = parseCoordinatorConfig(),
  logger: Logger = createLogger({
    service: "purev2",
    role: "coordinator",
    level: config.LOG_LEVEL,
    sensitiveValues: [
      config.DISCORD_TOKEN,
      config.REST_PROXY_AUTHORIZATION,
      config.MONGODB_URI,
      config.DASHBOARD_API_AUTHORIZATION ?? "",
      config.REDIS_URL,
    ],
  }),
): CoordinatorRuntime {
  const metrics = createCoordinatorMetrics();
  const j2cMetrics: J2cMetrics = createJ2cMetrics();
  let database: DatabaseConnection | undefined;
  let modulesLoaded = false;
  let shuttingDown = false;
  let serviceReady = false;
  let j2cRuntime: J2cRuntime | undefined;
  let dashboardApi: DashboardControlApi | undefined;
  let voiceSequence = 0;
  let workerSnapshotsEnabled = false;
  const guildShardIds = new Map<string, number>();

  const voiceSnapshotForWorker = (workerId: number) => {
    if (!workerSnapshotsEnabled || !j2cRuntime?.occupancy.isReady()) return undefined;
    const guilds = j2cRuntime.occupancy.snapshotGuilds().flatMap((guild) => {
      const shardId = guildShardIds.get(guild.guildId);
      if (shardId === undefined || assignWorker(shardId, config.BOT_WORKER_COUNT) !== workerId) return [];
      return [{
        guildId: guild.guildId,
        states: guild.states.map((state) => ({
          userId: state.userId,
          channelId: state.channelId,
        })),
      }];
    });
    return {
      type: "voiceStateSnapshot" as const,
      snapshotId: crypto.randomUUID(),
      workerId,
      guilds,
      at: new Date().toISOString(),
    };
  };

  const rest = createCoordinatorRest({
    token: config.DISCORD_TOKEN,
    applicationId: config.DISCORD_APPLICATION_ID,
    host: config.REST_PROXY_HOST,
    port: config.REST_PROXY_PORT,
    authorization: config.REST_PROXY_AUTHORIZATION,
    bodyLimitBytes: config.REST_PROXY_BODY_LIMIT_BYTES,
    requestCacheLimit: config.REST_REQUEST_CACHE_LIMIT,
    requestCacheTtlMs: config.REST_REQUEST_CACHE_TTL_MS,
    logger,
    metrics,
  });

  let supervisor = createWorkerSupervisor({
    config,
    logger,
    metrics,
    workerEntryPath: join(import.meta.dir, "../worker/main.ts"),
    restProxyBaseUrl: restProxyBaseUrl(config),
    voiceSnapshotForWorker,
  });

  let gateway = createCoordinatorGateway({
    token: config.DISCORD_TOKEN,
    rest: rest.rest,
    logger,
    totalWorkers: config.BOT_WORKER_COUNT,
    forwardEvent: async () => undefined,
    connect: config.NODE_ENV !== "test",
  });

  const buildReadiness = (): ReadinessReport => {
    const eventSnapshot = supervisor.eventSnapshot();
    const j2cState = j2cRuntime?.readiness();
    const requiredStatsWorkers = Math.min(config.BOT_WORKER_COUNT, Math.max(1, gateway.recommendedShardCount()));
    const statsReady = supervisor.allWorkersStatsReady(requiredStatsWorkers);
    const components: Record<ReadinessComponent, ComponentStatus> = {
      coordinatorMongo: {
        ok: database?.isReady() ?? false,
        detail: database?.isReady() ? "connected" : "not_connected",
      },
      moduleLoaders: {
        ok: modulesLoaded,
        detail: modulesLoaded ? "loaded" : "pending",
      },
      restProxy: {
        ok: rest.isListening(),
        detail: rest.isListening() ? "listening" : "stopped",
      },
      workerStartup: {
        ok: supervisor.readyWorkerCount() >= supervisor.expectedWorkerCount(),
        detail: `${supervisor.readyWorkerCount()}/${supervisor.expectedWorkerCount()} ready`,
      },
      workerMongo: {
        ok: supervisor.allWorkersMongoReady(),
        detail: supervisor.allWorkersMongoReady() ? "all_ready" : "waiting",
      },
      workerHeartbeats: {
        ok: supervisor.allHeartbeatsFresh(),
        detail: supervisor.allHeartbeatsFresh() ? "fresh" : "stale_or_missing",
      },
      gatewayManager: {
        ok: gateway.isStarted(),
        detail: gateway.isStarted() ? "started" : "not_started",
      },
      gatewayShards: {
        ok: gateway.areRequiredShardsHealthy(),
        detail: `${gateway.healthyShardCount()}/${gateway.recommendedShardCount()} healthy`,
      },
      queueOverflow: {
        ok: !eventSnapshot.overflowed,
        detail: eventSnapshot.overflowed ? "overflowed" : "ok",
      },
      poisonEvents: {
        ok: !supervisor.hasPoisonEvents(),
        detail: supervisor.hasPoisonEvents()
          ? `poison=${eventSnapshot.poisonEventIds.length}`
          : "none",
      },
      shutdown: {
        ok: !shuttingDown,
        detail: shuttingDown ? "shutting_down" : "running",
      },
      j2c: {
        ok: j2cState?.ready ?? false,
        detail: j2cState?.ready
          ? "ready"
          : (j2cState?.detail ?? "pending_models_indexes_occupancy_or_reconciliation"),
      },
      stats: {
        ok: statsReady,
        detail: statsReady ? "ready" : "warming_or_redis_unavailable",
      },
    };

    const j2cReady = j2cState?.ready ?? false;
    return {
      ok: serviceReady && allComponentsHealthy(components),
      phase: j2cReady ? "j2c" : "foundation",
      j2cReady,
      statsReady,
      components,
      metrics: {
        ...metrics.snapshot(),
        j2c: j2cMetrics.snapshot(),
        stats: supervisor.statsMetrics(),
      },
    };
  };

  const health = createHealthServer({
    host: config.HEALTH_HOST,
    port: config.HEALTH_PORT,
    status: {
      isLive: () => !shuttingDown,
      report: buildReadiness,
    },
  });

  return {
    readiness: buildReadiness,

    async start(): Promise<void> {
      logger.info("Starting coordinator", {
        workerCount: config.BOT_WORKER_COUNT,
        nodeEnv: config.NODE_ENV,
      });

      // Liveness only — readiness stays false until the full startup sequence completes.
      await health.start();

      database = createMongoDatabase(toDatabaseConfig(config), logger);
      await database.connect();

      if (config.NODE_ENV !== "test") {
        const earlyListings = await listJ2cIndexes();
        const earlyIndexCheck = verifyRequiredIndexSpecs(earlyListings);
        if (!earlyIndexCheck.ok) {
          throw new Error(
            `Join-to-Create index verification failed: ${JSON.stringify(earlyIndexCheck.issues)}`,
          );
        }
        logger.info("Required database indexes verified structurally");
      }

      const commands = await loadCommandModules(join(import.meta.dir, "../../commands"));
      const events = await loadEventModules(join(import.meta.dir, "../../events"));
      modulesLoaded = true;
      logger.info("Loaded modules", { commandCount: commands.size, eventCount: events.size });

      await rest.start();

      supervisor = createWorkerSupervisor({
        config,
        logger,
        metrics,
        workerEntryPath: join(import.meta.dir, "../worker/main.ts"),
        restProxyBaseUrl: rest.baseUrl,
        voiceSnapshotForWorker,
      });
      await supervisor.start();

      if (config.NODE_ENV !== "test") {
        await supervisor.waitUntilWorkersReady(config.SHUTDOWN_TIMEOUT_MS);
      }

      let configs: GuildConfigRepository;
      let channels: TemporaryChannelRepository;
      let stats: VoiceStatsRepository;
      const discord = createRestManagerDiscordPort(rest.rest);

      if (config.NODE_ENV === "test") {
        const {
          createMemoryCreationReservationRepository,
          createMemoryGuildConfigRepository,
          createMemoryOwnerBlockListRepository,
          createMemoryTemporaryChannelRepository,
        } = await import("../j2c/memory-repositories.ts");
        const { createMemoryVoiceStatsRepository } = await import("../stats/memory-repository.ts");
        configs = createMemoryGuildConfigRepository();
        channels = createMemoryTemporaryChannelRepository();
        stats = createMemoryVoiceStatsRepository();
        j2cRuntime = createJ2cRuntime({
          configs,
          channels,
          reservations: createMemoryCreationReservationRepository(),
          blocks: createMemoryOwnerBlockListRepository(),
          discord,
          logger: logger.child({ component: "j2c" }),
          metrics: j2cMetrics,
          reconcileConcurrency: 4,
        });
        j2cRuntime.markModelsInitialized();
        j2cRuntime.markIndexesVerified(true);
        await j2cRuntime.reconcileDatabaseRest();
      } else {
        configs = createMongooseGuildConfigRepository();
        channels = createMongooseTemporaryChannelRepository();
        stats = createMongooseVoiceStatsRepository();
        j2cRuntime = createJ2cRuntime({
          configs,
          channels,
          reservations: createMongooseCreationReservationRepository(),
          blocks: createMongooseOwnerBlockListRepository(),
          discord,
          logger: logger.child({ component: "j2c" }),
          metrics: j2cMetrics,
          reconcileConcurrency: 4,
        });
        j2cRuntime.markModelsInitialized();
        j2cRuntime.markIndexesVerified(true);
        await j2cRuntime.reconcileDatabaseRest();
      }

      if (config.DASHBOARD_API_AUTHORIZATION !== undefined) {
        dashboardApi = createDashboardControlApi({
          host: config.DASHBOARD_API_HOST,
          port: config.DASHBOARD_API_PORT,
          authorization: config.DASHBOARD_API_AUTHORIZATION,
          bodyLimitBytes: config.DASHBOARD_API_BODY_LIMIT_BYTES,
          configs,
          channels,
          stats,
          discord,
          logger: logger.child({ component: "dashboardApi" }),
          isReady: () => serviceReady,
        });
        await dashboardApi.start();
      } else {
        logger.info("Dashboard control API disabled");
      }

      logger.info("Join-to-Create database/REST reconciliation finished", {
        j2cReady: j2cRuntime.readiness().ready,
      });

      const connection =
        config.NODE_ENV === "test"
          ? {
              url: "wss://gateway.discord.gg",
              shards: 1,
              sessionStartLimit: {
                total: 1000,
                remaining: 1000,
                resetAfter: 0,
                maxConcurrency: 1,
              },
            }
          : await rest.rest.getSessionInfo();

      const runtimeForVoice = j2cRuntime;
      gateway = createCoordinatorGateway({
        token: config.DISCORD_TOKEN,
        rest: rest.rest,
        logger,
        totalWorkers: config.BOT_WORKER_COUNT,
        connect: config.NODE_ENV !== "test",
        connection,
        forwardEvent: (shardId, payload) => {
          voiceSequence += 1;
          const guildId = extractGuildId(payload);
          if (guildId !== undefined) guildShardIds.set(guildId, shardId);
          observeGatewayVoiceState(runtimeForVoice, payload, voiceSequence);

          const base = {
            type: "gatewayEvent" as const,
            eventId: crypto.randomUUID(),
            shardId,
            payload: {
              op: payload.op,
              t: payload.t,
              s: payload.s,
              d: payload.d,
            },
            enqueuedAt: new Date().toISOString(),
            attempt: 1,
          };
          if (guildId !== undefined) {
            supervisor.forwardGatewayEvent({ ...base, guildId });
            return;
          }
          supervisor.forwardGatewayEvent(base);
        },
      });

      await gateway.start();

      if (config.NODE_ENV !== "test") {
        const deadline = Date.now() + config.SHUTDOWN_TIMEOUT_MS;
        while (Date.now() < deadline && !gateway.areRequiredShardsHealthy()) {
          await Bun.sleep(100);
        }
        if (!gateway.areRequiredShardsHealthy()) {
          throw new Error(
            `Gateway shards not healthy: ${gateway.healthyShardCount()}/${gateway.recommendedShardCount()}`,
          );
        }
      }

      j2cRuntime.markOccupancyReady(true);
      await j2cRuntime.reconcileOccupancy();
      await j2cRuntime.scheduleRestartEmptyChannelResweeps();
      workerSnapshotsEnabled = true;
      supervisor.refreshVoiceSnapshots();

      serviceReady = true;

      logger.info("Coordinator started", {
        healthUrl: health.url,
        restProxyUrl: rest.baseUrl,
        dashboardApiEnabled: dashboardApi?.isListening() ?? false,
        recommendedShards: gateway.recommendedShardCount(),
        j2cReady: j2cRuntime.readiness().ready,
      });
    },

    async stop(reason = "shutdown"): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      serviceReady = false;
      logger.info("Coordinator stopping", { reason });

      await health.stop();
      await dashboardApi?.stop();
      await gateway.stop(1_000, reason);
      await supervisor.stop(reason);
      await rest.stop();
      await database?.close();

      logger.info("Coordinator stopped");
    },
  };
}
