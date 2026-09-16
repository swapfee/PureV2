import type { CoordinatorConfig } from "../config.ts";
import { buildWorkerSpawnEnv } from "../config.ts";
import type { GatewayEventMessage, IpcMessage } from "../ipc/messages.ts";
import { assertIpcMessage, parseIpcMessage } from "../ipc/messages.ts";
import type { Logger } from "../logger.ts";
import { assignWorker } from "../sharding.ts";
import { createEventTracker, type EventTrackerSnapshot } from "./event-tracker.ts";
import type { CoordinatorMetrics } from "./metrics.ts";
import { createRestartBackoff } from "./restart-backoff.ts";

/**
 * Event queues survive worker restarts only.
 * They do NOT survive coordinator process restarts or VPS reboots.
 */
export interface WorkerSupervisor {
  start(): Promise<void>;
  waitUntilWorkersReady(timeoutMs?: number): Promise<void>;
  stop(reason?: string): Promise<void>;
  forwardGatewayEvent(message: GatewayEventMessage): void;
  aliveWorkerCount(): number;
  expectedWorkerCount(): number;
  readyWorkerCount(): number;
  allWorkersMongoReady(): boolean;
  allHeartbeatsFresh(now?: number): boolean;
  eventSnapshot(): EventTrackerSnapshot;
  hasPoisonEvents(): boolean;
  lastWorkerEnv(workerId: number): Readonly<Record<string, string>> | undefined;
}

interface ManagedWorker {
  workerId: number;
  process: SupervisedProcess;
  alive: boolean;
  modulesReady: boolean;
  mongoReady: boolean;
  lastHeartbeatAt: number;
  backoff: ReturnType<typeof createRestartBackoff>;
  restartTimer?: ReturnType<typeof setTimeout>;
}

export interface SupervisedProcess {
  send(message: unknown): void;
  kill(code?: number | string): void;
  readonly exited: Promise<number>;
}

export interface WorkerSupervisorOptions {
  readonly config: CoordinatorConfig;
  readonly logger: Logger;
  readonly metrics: CoordinatorMetrics;
  readonly workerEntryPath: string;
  readonly restProxyBaseUrl: string;
  readonly now?: () => number;
  readonly spawnWorker?: (
    workerId: number,
    env: Record<string, string>,
    onMessage: (message: unknown) => void,
  ) => SupervisedProcess;
}

function defaultSpawn(env: Record<string, string>, entryPath: string, onMessage: (message: unknown) => void): SupervisedProcess {
  return Bun.spawn({
    cmd: ["bun", "run", entryPath],
    cwd: process.cwd(),
    env,
    stdout: "inherit",
    stderr: "inherit",
    ipc: (message) => {
      onMessage(message);
    },
    serialization: "json",
  });
}

function sendToWorker(worker: ManagedWorker, message: IpcMessage): void {
  if (!worker.alive) return;
  worker.process.send(message);
}

export function createWorkerSupervisor(options: WorkerSupervisorOptions): WorkerSupervisor {
  const workers = new Map<number, ManagedWorker>();
  const lastEnvs = new Map<number, Record<string, string>>();
  const tracker = createEventTracker(options.config.WORKER_EVENT_BUFFER_LIMIT);
  const now = options.now ?? Date.now;
  let stopping = false;
  let monitorTimer: ReturnType<typeof setInterval> | undefined;

  const dispatchToWorker = (workerId: number, message: GatewayEventMessage): void => {
    const worker = workers.get(workerId);
    const tracked = tracker.track(workerId, message);
    if (tracked.overflowed) {
      options.logger.error("Event buffer overflow", {
        workerId,
        eventId: message.eventId,
        limit: options.config.WORKER_EVENT_BUFFER_LIMIT,
      });
    }
    if (!worker || !worker.alive) {
      options.logger.warn("No alive worker for shard event; retained until worker returns", {
        workerId,
        shardId: message.shardId,
        eventId: message.eventId,
      });
      return;
    }
    sendToWorker(worker, message);
    options.metrics.increment("eventsForwarded");
  };

  const handleRetryOrPoison = (
    action: "retry" | "poison",
    workerId: number,
    message: GatewayEventMessage,
  ): void => {
    if (action === "poison") {
      options.logger.error("Poison event: retries exhausted", {
        eventId: message.eventId,
        workerId,
        attempt: message.attempt,
      });
      options.metrics.increment("eventsNacked");
      return;
    }
    dispatchToWorker(workerId, message);
  };

  const handleWorkerMessage = (workerId: number, raw: unknown): void => {
    const parsed = parseIpcMessage(raw);
    if (!parsed.ok) {
      options.logger.warn("Ignoring invalid worker IPC message", { workerId, error: parsed.error });
      return;
    }

    const message = parsed.message;
    const worker = workers.get(workerId);
    if (!worker) return;

    switch (message.type) {
      case "workerHello":
        worker.alive = true;
        worker.lastHeartbeatAt = now();
        worker.backoff = worker.backoff.success();
        options.logger.info("Worker said hello", { workerId, pid: message.pid });
        break;
      case "workerReady":
        worker.alive = true;
        worker.mongoReady = message.mongoReady;
        worker.modulesReady = message.modulesReady;
        worker.lastHeartbeatAt = now();
        options.logger.info("Worker ready", {
          workerId,
          mongoReady: message.mongoReady,
          modulesReady: message.modulesReady,
        });
        for (const pending of tracker.pendingForWorker(workerId)) {
          sendToWorker(worker, pending);
        }
        break;
      case "heartbeat":
        worker.lastHeartbeatAt = now();
        worker.mongoReady = message.mongoReady;
        break;
      case "eventAck":
        tracker.acknowledge(message.eventId);
        options.metrics.increment("eventsAcked");
        break;
      case "eventNack": {
        options.metrics.increment("eventsNacked");
        options.logger.warn("Worker nacked event", {
          workerId,
          eventId: message.eventId,
          reason: message.reason,
          retryable: message.retryable,
        });
        if (!message.retryable) {
          const decision = tracker.scheduleRetry(message.eventId, options.config.WORKER_EVENT_MAX_ATTEMPTS);
          if (decision.action === "poison") {
            handleRetryOrPoison("poison", workerId, decision.tracked.message);
          }
          break;
        }
        const decision = tracker.scheduleRetry(message.eventId, options.config.WORKER_EVENT_MAX_ATTEMPTS);
        if (decision.action === "retry") {
          handleRetryOrPoison("retry", decision.workerId, decision.message);
        } else if (decision.action === "poison") {
          handleRetryOrPoison("poison", workerId, decision.tracked.message);
        }
        break;
      }
      case "workerFatal":
        options.logger.error("Worker reported fatal error", {
          workerId,
          message: message.message,
        });
        break;
      default:
        options.logger.debug("Unhandled worker IPC message type", { workerId, type: message.type });
        break;
    }
  };

  const spawn = (workerId: number): void => {
    const existing = workers.get(workerId);
    if (existing?.restartTimer) clearTimeout(existing.restartTimer);

    const env = buildWorkerSpawnEnv(options.config, workerId, options.restProxyBaseUrl);
    lastEnvs.set(workerId, env);

    const processHandle = options.spawnWorker
      ? options.spawnWorker(workerId, env, (message) => {
          handleWorkerMessage(workerId, message);
        })
      : defaultSpawn(env, options.workerEntryPath, (message) => {
          handleWorkerMessage(workerId, message);
        });

    const managed: ManagedWorker = {
      workerId,
      process: processHandle,
      alive: true,
      modulesReady: false,
      mongoReady: false,
      lastHeartbeatAt: now(),
      backoff:
        existing?.backoff ??
        createRestartBackoff(
          options.config.WORKER_RESTART_BASE_DELAY_MS,
          options.config.WORKER_RESTART_MAX_DELAY_MS,
        ),
    };

    workers.set(workerId, managed);

    void processHandle.exited.then((code) => {
      managed.alive = false;
      managed.modulesReady = false;
      managed.mongoReady = false;
      if (stopping) return;
      options.metrics.increment("workerRestarts");
      managed.backoff = managed.backoff.failure();
      const delay = managed.backoff.nextDelayMs();
      options.logger.warn("Worker exited; scheduling restart", { workerId, code, delay });
      managed.restartTimer = setTimeout(() => {
        if (stopping) return;
        spawn(workerId);
      }, delay);
    });
  };

  const monitor = (): void => {
    const current = now();
    for (const worker of workers.values()) {
      if (!worker.alive) continue;
      if (current - worker.lastHeartbeatAt > options.config.WORKER_HEARTBEAT_TIMEOUT_MS) {
        options.logger.warn("Worker heartbeat timeout; killing process", { workerId: worker.workerId });
        worker.process.kill();
      }
    }

    for (const timedOut of tracker.takeTimedOut(
      current,
      options.config.WORKER_EVENT_ACK_TIMEOUT_MS,
      options.config.WORKER_EVENT_MAX_ATTEMPTS,
    )) {
      options.logger.warn("Event ack timed out", {
        eventId: timedOut.message.eventId,
        workerId: timedOut.tracked.workerId,
        action: timedOut.action,
        attempt: timedOut.message.attempt,
      });
      if (timedOut.action === "retry") {
        handleRetryOrPoison("retry", timedOut.tracked.workerId, timedOut.message);
      } else {
        handleRetryOrPoison("poison", timedOut.tracked.workerId, timedOut.message);
      }
    }
  };

  return {
    expectedWorkerCount(): number {
      return options.config.BOT_WORKER_COUNT;
    },

    aliveWorkerCount(): number {
      let count = 0;
      for (const worker of workers.values()) {
        if (worker.alive) count += 1;
      }
      return count;
    },

    readyWorkerCount(): number {
      let count = 0;
      for (const worker of workers.values()) {
        if (worker.alive && worker.modulesReady && worker.mongoReady) count += 1;
      }
      return count;
    },

    allWorkersMongoReady(): boolean {
      if (workers.size < options.config.BOT_WORKER_COUNT) return false;
      for (const worker of workers.values()) {
        if (!worker.mongoReady) return false;
      }
      return true;
    },

    allHeartbeatsFresh(current = now()): boolean {
      if (workers.size < options.config.BOT_WORKER_COUNT) return false;
      for (const worker of workers.values()) {
        if (!worker.alive) return false;
        if (current - worker.lastHeartbeatAt > options.config.WORKER_HEARTBEAT_TIMEOUT_MS) return false;
      }
      return true;
    },

    eventSnapshot(): EventTrackerSnapshot {
      return tracker.snapshot();
    },

    hasPoisonEvents(): boolean {
      return tracker.hasPoisonEvents();
    },

    lastWorkerEnv(workerId): Readonly<Record<string, string>> | undefined {
      return lastEnvs.get(workerId);
    },

    async start(): Promise<void> {
      for (let workerId = 0; workerId < options.config.BOT_WORKER_COUNT; workerId += 1) {
        spawn(workerId);
      }
      monitorTimer = setInterval(monitor, Math.min(1_000, options.config.WORKER_HEARTBEAT_INTERVAL_MS));
    },

    async waitUntilWorkersReady(timeoutMs = 30_000): Promise<void> {
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        if (this.readyWorkerCount() >= options.config.BOT_WORKER_COUNT) return;
        await Bun.sleep(50);
      }
      throw new Error(
        `Timed out waiting for ${options.config.BOT_WORKER_COUNT} workers to become ready (ready=${this.readyWorkerCount()})`,
      );
    },

    forwardGatewayEvent(message): void {
      const workerId = assignWorker(message.shardId, options.config.BOT_WORKER_COUNT);
      dispatchToWorker(workerId, message);
    },

    async stop(reason = "coordinator_shutdown"): Promise<void> {
      stopping = true;
      if (monitorTimer) clearInterval(monitorTimer);

      const deadlineAt = new Date(now() + options.config.SHUTDOWN_TIMEOUT_MS).toISOString();
      const shutdownMessage = assertIpcMessage({
        type: "shutdown",
        reason,
        deadlineAt,
      });

      for (const worker of workers.values()) {
        if (worker.restartTimer) clearTimeout(worker.restartTimer);
        if (worker.alive) sendToWorker(worker, shutdownMessage);
      }

      const exits = [...workers.values()].map(async (worker) => {
        const timeout = setTimeout(() => worker.process.kill(), options.config.SHUTDOWN_TIMEOUT_MS);
        try {
          await worker.process.exited;
        } finally {
          clearTimeout(timeout);
        }
      });
      await Promise.all(exits);
      workers.clear();
    },
  };
}
