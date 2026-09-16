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
  createMongooseTemporaryChannelRepository,
} from "../j2c/mongoose-repositories.ts";
import {
  createMemoryCreationReservationRepository,
  createMemoryGuildConfigRepository,
  createMemoryTemporaryChannelRepository,
} from "../j2c/memory-repositories.ts";
import { createJ2cRuntime } from "../j2c/runtime.ts";
import { createVcCommandService } from "../j2c/vc-command-service.ts";
import { createSetupCommandService } from "../j2c/setup-command-service.ts";
import { createVoicePanelInteractionHandler } from "../j2c/voice-panel-interactions.ts";
import { createVcMetrics } from "../j2c/vc-metrics.ts";
import type { GatewayEventMessage, IpcMessage } from "../ipc/messages.ts";
import { parseIpcMessage } from "../ipc/messages.ts";
import { createLogger } from "../logger.ts";
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
    sensitiveValues: [config.REST_PROXY_AUTHORIZATION, config.MONGODB_URI],
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

  const j2c = createJ2cRuntime({
    configs: configsRepo,
    channels: channelsRepo,
    reservations: reservationsRepo,
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

  const voicePanel = createVoicePanelInteractionHandler({
    channels: channelsRepo,
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
    { vc, setup, voicePanel },
  );

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
    });
  }, config.WORKER_HEARTBEAT_INTERVAL_MS);

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
      inFlightCount = Math.max(0, inFlightCount - 1);
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
        void handleGatewayEvent(message);
        break;
      case "shutdown":
        shuttingDown = true;
        clearInterval(heartbeatTimer);
        void (async () => {
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
