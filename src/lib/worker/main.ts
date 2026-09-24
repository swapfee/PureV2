import { join } from "node:path";

import { createCooldownStore } from "../../handlers/cooldowns.ts";
import { loadCommandModules, loadEventModules } from "../../handlers/loaders.ts";
import type { EventContext } from "../../handlers/types.ts";
import { parseWorkerConfig } from "../config.ts";
import { toDatabaseConfig } from "../database-config.ts";
import { createMongoDatabase } from "../database.ts";
import { createJ2cMetrics } from "../j2c/metrics.ts";
import {
  createMongooseCreationReservationRepository,
  createMongooseGuildConfigRepository,
  createMongooseOwnerBlockListRepository,
  createMongooseTemporaryChannelRepository,
} from "../j2c/mongoose-repositories.ts";
import {
  createMemoryCreationReservationRepository,
  createMemoryGuildConfigRepository,
  createMemoryOwnerBlockListRepository,
  createMemoryTemporaryChannelRepository,
} from "../j2c/memory-repositories.ts";
import { createJ2cRuntime } from "../j2c/runtime.ts";
import { createVcCommandService } from "../j2c/vc-command-service.ts";
import { createSetupCommandService } from "../j2c/setup-command-service.ts";
import { createVoicePanelInteractionHandler } from "../j2c/voice-panel-interactions.ts";
import { createVcMetrics } from "../j2c/vc-metrics.ts";
import type { GatewayEventMessage, IpcMessage, VoiceStateSnapshotMessage } from "../ipc/messages.ts";
import { parseIpcMessage } from "../ipc/messages.ts";
import { createLogger } from "../logger.ts";
import { createRedisVoiceStatsCache, createMemoryVoiceStatsCache } from "../stats/cache.ts";
import { createVoiceStatsCardRenderer } from "../stats/card-renderer.ts";
import { createStatsCommandService } from "../stats/command-service.ts";
import { createMemoryVoiceStatsRepository } from "../stats/memory-repository.ts";
import { createVoiceStatsMetrics } from "../stats/metrics.ts";
import { createMongooseVoiceStatsRepository } from "../stats/mongoose-repository.ts";
import { createVoiceStatsService } from "../stats/service.ts";
import { systemClock } from "../j2c/time.ts";
import { createWorkerBot } from "./bot.ts";
import { createInteractionDispatcher, wireBotEvents } from "./dispatch.ts";
import { createEventDedupe } from "./event-dedupe.ts";
import { dispatchWorkerGatewayEvent, isDiscordGatewayPayload } from "./gateway-dispatch.ts";

function send(message: IpcMessage): void {
  if (typeof process.send !== "function") {
    throw new Error("Worker was started without an IPC channel");
  }
  process.send(message);
}

export async function runWorkerMain(): Promise<void> {
  const config = parseWorkerConfig();
  const logger = createLogger({
    service: "purev2",
    role: "worker",
    level: config.LOG_LEVEL,
    context: { workerId: config.BOT_WORKER_ID },
    sensitiveValues: [config.REST_PROXY_AUTHORIZATION, config.MONGODB_URI, config.REDIS_URL],
  });

  const database = createMongoDatabase(toDatabaseConfig(config), logger);
  await database.connect();

  const commandsDirectory = join(import.meta.dir, "../../commands");
  const eventsDirectory = join(import.meta.dir, "../../events");
  const commands = await loadCommandModules(commandsDirectory);
  const events = await loadEventModules(eventsDirectory);

  const { bot, discord } = createWorkerBot(config, logger);
  const cooldowns = createCooldownStore();

  const j2cMetrics = createJ2cMetrics();
  const channelsRepo =
    config.NODE_ENV === "test"
      ? createMemoryTemporaryChannelRepository()
      : createMongooseTemporaryChannelRepository();
  const configsRepo =
    config.NODE_ENV === "test"
      ? createMemoryGuildConfigRepository()
      : createMongooseGuildConfigRepository();
  const reservationsRepo =
    config.NODE_ENV === "test"
      ? createMemoryCreationReservationRepository()
      : createMongooseCreationReservationRepository();
  const blocksRepo =
    config.NODE_ENV === "test"
      ? createMemoryOwnerBlockListRepository()
      : createMongooseOwnerBlockListRepository();

  const statsRepository = config.NODE_ENV === "test"
    ? createMemoryVoiceStatsRepository()
    : createMongooseVoiceStatsRepository();
  const statsCache = config.NODE_ENV === "test"
    ? createMemoryVoiceStatsCache()
    : createRedisVoiceStatsCache(config.REDIS_URL);
  const statsMetrics = createVoiceStatsMetrics();
  try {
    await statsCache.connect();
  } catch (error) {
    statsMetrics.increment("redisFailures");
    logger.error("Voice statistics Redis unavailable; statistics remain disabled", {
      component: "voice-stats",
      error,
    });
  }
  const stats = createVoiceStatsService({
    repository: statsRepository,
    channels: channelsRepo,
    cache: statsCache,
    metrics: statsMetrics,
    logger: logger.child({ component: "voice-stats" }),
    clock: systemClock(),
  });

  const j2c = createJ2cRuntime({
    configs: configsRepo,
    channels: channelsRepo,
    reservations: reservationsRepo,
    blocks: blocksRepo,
    discord,
    logger: logger.child({ component: "j2c" }),
    metrics: j2cMetrics,
  });
  j2c.markModelsInitialized();
  j2c.markIndexesVerified(true);

  const botUser = await discord.getCurrentUser();
  const botUsername = botUser.kind === "found" ? botUser.value.username : "Bot";

  const vc = createVcCommandService({
    channels: channelsRepo,
    configs: configsRepo,
    blocks: blocksRepo,
    discord,
    logger: logger.child({ component: "vc" }),
    metrics: createVcMetrics(),
    cooldowns: createCooldownStore({ maxEntries: 5_000 }),
    botUsername,
  });

  const setup = createSetupCommandService({
    configs: configsRepo,
    channels: channelsRepo,
    reservations: reservationsRepo,
    occupancy: j2c.occupancy,
    discord,
    logger: logger.child({ component: "setup" }),
  });

  const statsCommand = createStatsCommandService({
    stats,
    discord,
    renderer: createVoiceStatsCardRenderer(),
    cooldowns: createCooldownStore({ maxEntries: 2_000 }),
    metrics: statsMetrics,
    logger: logger.child({ component: "stat-command" }),
  });

  const voicePanel = createVoicePanelInteractionHandler({
    channels: channelsRepo,
    configs: configsRepo,
    blocks: blocksRepo,
    discord,
    logger: logger.child({ component: "voice-panel" }),
    botUsername,
  });

  const dispatcher = createInteractionDispatcher(
    commands,
    cooldowns,
    config.BOT_WORKER_ID,
    logger,
    discord,
    { vc, setup, stats: statsCommand, voicePanel },
  );

  const statsGuilds = new Set<string>();

  const context: EventContext = {
    workerId: config.BOT_WORKER_ID,
    logger,
    commands: dispatcher,
    discord,
    j2c: {
      voice: j2c.voice,
      occupancy: {
        seedGuildVoiceStates: (guildId, states) => j2c.occupancy.seedGuildVoiceStates(guildId, states),
        markReady: () => j2c.markOccupancyReady(true),
        isReady: () => j2c.occupancy.isReady(),
      },
      scheduleEmptyChannelDeletions: (guildId) => j2c.scheduleEmptyChannelDeletions(guildId),
      scheduleEmptyChannelDeletionResweep: (guildId) => j2c.scheduleEmptyChannelDeletionResweep(guildId),
    },
    stats: {
      handle: (payload, eventId) => stats.handle(payload, eventId),
      expectGuilds: (guildIds) => stats.expectGuilds(guildIds),
      async reconcileGuild(guildId, states) {
        await stats.reconcileGuild(guildId, states);
        statsGuilds.add(guildId);
      },
    },
  };
  wireBotEvents(bot, events, context);

  const recentEvents = createEventDedupe(config.WORKER_EVENT_DEDUP_LIMIT, config.WORKER_EVENT_DEDUP_TTL_MS);

  let heartbeatSequence = 0;
  let inFlightCount = 0;
  let shuttingDown = false;

  send({
    type: "workerHello",
    workerId: config.BOT_WORKER_ID,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  send({
    type: "workerReady",
    workerId: config.BOT_WORKER_ID,
    mongoReady: database.isReady(),
    modulesReady: true,
    statsReady: stats.isReady(),
    statsMetrics: statsMetrics.snapshot(),
    at: new Date().toISOString(),
  });

  const heartbeatTimer = setInterval(() => {
    if (shuttingDown) return;
    heartbeatSequence += 1;
    send({
      type: "heartbeat",
      workerId: config.BOT_WORKER_ID,
      sequence: heartbeatSequence,
      at: new Date().toISOString(),
      inFlightCount,
      mongoReady: database.isReady(),
      statsReady: stats.isReady(),
      statsMetrics: statsMetrics.snapshot(),
    });
  }, config.WORKER_HEARTBEAT_INTERVAL_MS);

  const redisHealthTimer = setInterval(() => {
    void statsCache.refresh().catch((error: unknown) => {
      logger.warn("Voice statistics Redis health check failed", { error });
    });
  }, config.WORKER_HEARTBEAT_INTERVAL_MS);

  const checkpointTimer = setInterval(() => {
    for (const guildId of statsGuilds) {
      void stats.checkpointGuild(guildId).catch((error: unknown) => {
        logger.error("Voice statistics checkpoint failed", { guildId, error });
      });
    }
  }, config.VOICE_STATS_CHECKPOINT_INTERVAL_MS);

  const handleGatewayEvent = async (message: GatewayEventMessage): Promise<void> => {
    const begin = recentEvents.begin(message.eventId);
    if (begin === "completed") {
      send({
        type: "eventAck",
        workerId: config.BOT_WORKER_ID,
        eventId: message.eventId,
        at: new Date().toISOString(),
      });
      return;
    }
    if (begin === "in_flight") {
      return;
    }

    inFlightCount += 1;
    context.currentEventId = message.eventId;
    if (typeof message.payload.s === "number") context.currentGatewaySequence = message.payload.s;
    try {
      if (!isDiscordGatewayPayload(message.payload)) {
        throw new Error("Gateway event payload failed DiscordGatewayPayload validation");
      }
      await dispatchWorkerGatewayEvent(bot, message.payload, message.shardId);
      recentEvents.markCompleted(message.eventId);
      send({
        type: "eventAck",
        workerId: config.BOT_WORKER_ID,
        eventId: message.eventId,
        at: new Date().toISOString(),
      });
    } catch (error) {
      recentEvents.release(message.eventId);
      logger.error("Failed to process gateway event", {
        eventId: message.eventId,
        shardId: message.shardId,
        attempt: message.attempt,
        error,
      });
      send({
        type: "eventNack",
        workerId: config.BOT_WORKER_ID,
        eventId: message.eventId,
        at: new Date().toISOString(),
        reason: error instanceof Error ? error.message : "unknown_error",
        retryable: true,
      });
    } finally {
      delete context.currentEventId;
      delete context.currentGatewaySequence;
      inFlightCount = Math.max(0, inFlightCount - 1);
    }
  };

  let snapshotBarrier = Promise.resolve();
  const handleVoiceStateSnapshot = async (message: VoiceStateSnapshotMessage): Promise<void> => {
    if (message.workerId !== config.BOT_WORKER_ID) {
      throw new Error(`Voice snapshot addressed to worker ${message.workerId}`);
    }
    const guildIds = message.guilds.map((guild) => guild.guildId);
    stats.expectGuilds(guildIds);
    for (const guild of message.guilds) {
      j2c.occupancy.seedGuildVoiceStates(guild.guildId, guild.states);
      await stats.reconcileGuild(
        guild.guildId,
        guild.states.map((state) => ({ guildId: guild.guildId, ...state })),
      );
      statsGuilds.add(guild.guildId);
    }
    j2c.occupancy.markReady();
    for (const guild of message.guilds) {
      await j2c.scheduleEmptyChannelDeletions(guild.guildId);
      j2c.scheduleEmptyChannelDeletionResweep(guild.guildId);
    }
  };

  process.on("message", (raw) => {
    const parsed = parseIpcMessage(raw);
    if (!parsed.ok) {
      logger.warn("Invalid IPC message received by worker", { error: parsed.error });
      return;
    }

    const message = parsed.message;
    switch (message.type) {
      case "gatewayEvent":
        void snapshotBarrier.then(() => handleGatewayEvent(message));
        break;
      case "voiceStateSnapshot":
        snapshotBarrier = snapshotBarrier.then(async () => {
          try {
            await handleVoiceStateSnapshot(message);
            send({
              type: "voiceStateSnapshotAck",
              snapshotId: message.snapshotId,
              workerId: config.BOT_WORKER_ID,
              ok: true,
              statsReady: stats.isReady(),
              at: new Date().toISOString(),
            });
          } catch (error) {
            logger.error("Failed to restore coordinator voice-state snapshot", {
              snapshotId: message.snapshotId,
              error,
            });
            send({
              type: "voiceStateSnapshotAck",
              snapshotId: message.snapshotId,
              workerId: config.BOT_WORKER_ID,
              ok: false,
              statsReady: false,
              at: new Date().toISOString(),
              error: error instanceof Error ? error.message : "unknown_error",
            });
          }
        });
        break;
      case "shutdown":
        shuttingDown = true;
        clearInterval(heartbeatTimer);
        clearInterval(redisHealthTimer);
        clearInterval(checkpointTimer);
        void (async () => {
          statsCache.close();
          await database.close();
          logger.info("Worker shutting down", { reason: message.reason });
          process.exit(0);
        })();
        break;
      default:
        logger.debug("Ignoring coordinator IPC message", { type: message.type });
        break;
    }
  });

  logger.info("Worker ready", {
    workerId: config.BOT_WORKER_ID,
    commandCount: commands.size,
    eventCount: events.size,
  });
}

if (import.meta.main) {
  void runWorkerMain().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown_error";
    if (typeof process.send === "function") {
      process.send({
        type: "workerFatal",
        workerId: Number(Bun.env.BOT_WORKER_ID ?? 0),
        at: new Date().toISOString(),
        message,
      });
    }
    console.error(error);
    process.exit(1);
  });
}
