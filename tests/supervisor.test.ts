import { describe, expect, test } from "bun:test";

import { parseCoordinatorConfig } from "../src/lib/config.ts";
import { createCoordinatorMetrics } from "../src/lib/coordinator/metrics.ts";
import { createWorkerSupervisor, type SupervisedProcess } from "../src/lib/coordinator/supervisor.ts";
import { createLogger } from "../src/lib/logger.ts";
import { assignWorker } from "../src/lib/sharding.ts";
import type { IpcMessage } from "../src/lib/ipc/messages.ts";
import { parseIpcMessage } from "../src/lib/ipc/messages.ts";

class FakeSubprocess implements SupervisedProcess {
  readonly messages: IpcMessage[] = [];
  readonly exited: Promise<number>;
  readonly #onMessage: (message: unknown) => void;
  #resolveExit!: (code: number) => void;
  killed = false;

  constructor(onMessage: (message: unknown) => void) {
    this.#onMessage = onMessage;
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  send(message: unknown): void {
    const parsed = parseIpcMessage(message);
    if (!parsed.ok) throw new Error(parsed.error);
    this.messages.push(parsed.message);
    if (parsed.message.type === "shutdown") {
      queueMicrotask(() => this.complete(0));
    }
  }

  emitFromWorker(message: IpcMessage): void {
    this.#onMessage(message);
  }

  kill(): void {
    this.killed = true;
    this.#resolveExit(1);
  }

  complete(code = 0): void {
    this.#resolveExit(code);
  }
}

describe("worker supervisor foundations", () => {
  test("sends a coordinator voice snapshot on readiness and refresh", async () => {
    const config = parseCoordinatorConfig({
      DISCORD_TOKEN: "token",
      DISCORD_APPLICATION_ID: "123456789012345678",
      MONGODB_URI: "mongodb://127.0.0.1:27017/purev2-test",
      REST_PROXY_AUTHORIZATION: "0123456789abcdef",
      BOT_WORKER_COUNT: "1",
      SHUTDOWN_TIMEOUT_MS: "1000",
    });
    let fake: FakeSubprocess | undefined;
    let snapshotSequence = 0;
    const supervisor = createWorkerSupervisor({
      config,
      logger: createLogger({ service: "purev2-test", role: "test", level: "error", write: () => undefined }),
      metrics: createCoordinatorMetrics(),
      workerEntryPath: "unused",
      restProxyBaseUrl: "http://127.0.0.1:8081",
      voiceSnapshotForWorker: (workerId) => ({
        type: "voiceStateSnapshot",
        snapshotId: `00000000-0000-4000-8000-${String(++snapshotSequence).padStart(12, "0")}`,
        workerId,
        guilds: [{ guildId: "123456789012345678", states: [] }],
        at: "2026-01-01T00:00:00.000Z",
      }),
      spawnWorker: (workerId, _env, onMessage) => {
        fake = new FakeSubprocess(onMessage);
        queueMicrotask(() => fake?.emitFromWorker({
          type: "workerReady",
          workerId,
          mongoReady: true,
          modulesReady: true,
          statsReady: false,
          statsMetrics: { sessionOpens: 0, sessionCloses: 0, deduplicatedEvents: 0, reconciliationFindings: 0, redisFailures: 0, renders: 0, renderFailures: 0 },
          at: new Date().toISOString(),
        }));
        return fake;
      },
    });

    await supervisor.start();
    await supervisor.waitUntilWorkersReady(2_000);
    expect(fake?.messages.filter((message) => message.type === "voiceStateSnapshot")).toHaveLength(1);
    supervisor.refreshVoiceSnapshots();
    expect(fake?.messages.filter((message) => message.type === "voiceStateSnapshot")).toHaveLength(2);

    const lastSnapshot = fake?.messages.findLast((message) => message.type === "voiceStateSnapshot");
    if (!lastSnapshot || lastSnapshot.type !== "voiceStateSnapshot") throw new Error("missing snapshot");
    fake?.emitFromWorker({
      type: "voiceStateSnapshotAck",
      snapshotId: lastSnapshot.snapshotId,
      workerId: 0,
      ok: true,
      statsReady: true,
      at: new Date().toISOString(),
    });
    expect(supervisor.allWorkersStatsReady()).toBe(true);
    await supervisor.stop("test_done");
  });

  test("never passes DISCORD_TOKEN and routes shards exclusively", async () => {
    for (const workerCount of [1, 2] as const) {
      const config = parseCoordinatorConfig({
        DISCORD_TOKEN: "secret-discord-token",
        DISCORD_APPLICATION_ID: "123456789012345678",
        MONGODB_URI: "mongodb://127.0.0.1:27017/purev2-test",
        REST_PROXY_AUTHORIZATION: "0123456789abcdef",
        BOT_WORKER_COUNT: String(workerCount),
        WORKER_HEARTBEAT_INTERVAL_MS: "10000",
        WORKER_HEARTBEAT_TIMEOUT_MS: "30000",
        WORKER_EVENT_ACK_TIMEOUT_MS: "500",
        SHUTDOWN_TIMEOUT_MS: "1000",
      });

      const fakeWorkers = new Map<number, FakeSubprocess>();
      const logger = createLogger({
        service: "purev2-test",
        role: "test",
        level: "error",
        write: () => undefined,
      });

      const supervisor = createWorkerSupervisor({
        config,
        logger,
        metrics: createCoordinatorMetrics(),
        workerEntryPath: "unused",
        restProxyBaseUrl: "http://127.0.0.1:8081",
        spawnWorker: (workerId, env, onMessage) => {
          expect(Object.hasOwn(env, "DISCORD_TOKEN")).toBe(false);
          expect(JSON.stringify(env).includes("secret-discord-token")).toBe(false);
          const fake = new FakeSubprocess(onMessage);
          fakeWorkers.set(workerId, fake);
          queueMicrotask(() => {
            fake.emitFromWorker({
              type: "workerReady",
              workerId,
              mongoReady: true,
              modulesReady: true,
              statsReady: workerId === 0,
              statsMetrics: { sessionOpens: 0, sessionCloses: 0, deduplicatedEvents: 0, reconciliationFindings: 0, redisFailures: 0, renders: 0, renderFailures: 0 },
              at: new Date().toISOString(),
            });
          });
          return fake;
        },
      });

      await supervisor.start();
      await supervisor.waitUntilWorkersReady(2_000);

      expect(supervisor.readyWorkerCount()).toBe(workerCount);
      expect(supervisor.allWorkersStatsReady(1)).toBe(true);
      if (workerCount === 2) expect(supervisor.allWorkersStatsReady(2)).toBe(false);
      expect(supervisor.lastWorkerEnv(0)?.DISCORD_TOKEN).toBeUndefined();

      const shards = workerCount === 2 ? [0] : [0, 1, 2, 3];
      for (const shardId of shards) {
        const eventId = `00000000-0000-4000-8000-00000000000${shardId}`;
        supervisor.forwardGatewayEvent({
          type: "gatewayEvent",
          eventId,
          shardId,
          payload: { op: 0, t: "READY", s: 1, d: {} },
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          attempt: 1,
        });

        const owner = assignWorker(shardId, workerCount);
        expect(
          fakeWorkers
            .get(owner)
            ?.messages.some((message) => message.type === "gatewayEvent" && message.eventId === eventId),
        ).toBe(true);

        for (const [workerId, fake] of fakeWorkers) {
          if (workerId === owner) continue;
          expect(
            fake.messages.some((message) => message.type === "gatewayEvent" && message.eventId === eventId),
          ).toBe(false);
        }
      }

      if (workerCount === 2) {
        expect(fakeWorkers.get(1)?.messages.some((message) => message.type === "gatewayEvent")).toBe(false);
      }

      await supervisor.stop("test_done");
    }
  });

  test("replays retain the same event UUID and poison after max attempts", async () => {
    const config = parseCoordinatorConfig({
      DISCORD_TOKEN: "token",
      DISCORD_APPLICATION_ID: "123456789012345678",
      MONGODB_URI: "mongodb://127.0.0.1:27017/purev2-test",
      REST_PROXY_AUTHORIZATION: "0123456789abcdef",
      BOT_WORKER_COUNT: "1",
      WORKER_EVENT_MAX_ATTEMPTS: "2",
      WORKER_EVENT_ACK_TIMEOUT_MS: "500",
      SHUTDOWN_TIMEOUT_MS: "1000",
    });

    let fake: FakeSubprocess | undefined;
    const supervisor = createWorkerSupervisor({
      config,
      logger: createLogger({
        service: "purev2-test",
        role: "test",
        level: "error",
        write: () => undefined,
      }),
      metrics: createCoordinatorMetrics(),
      workerEntryPath: "unused",
      restProxyBaseUrl: "http://127.0.0.1:8081",
      spawnWorker: (_workerId, _env, onMessage) => {
        fake = new FakeSubprocess(onMessage);
        queueMicrotask(() => {
          fake?.emitFromWorker({
            type: "workerReady",
            workerId: 0,
            mongoReady: true,
            modulesReady: true,
            statsReady: true,
            statsMetrics: { sessionOpens: 0, sessionCloses: 0, deduplicatedEvents: 0, reconciliationFindings: 0, redisFailures: 0, renders: 0, renderFailures: 0 },
            at: new Date().toISOString(),
          });
        });
        return fake;
      },
    });

    await supervisor.start();
    await supervisor.waitUntilWorkersReady(2_000);

    const eventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    supervisor.forwardGatewayEvent({
      type: "gatewayEvent",
      eventId,
      shardId: 0,
      payload: { op: 0, t: "READY", s: 1, d: {} },
      enqueuedAt: "2026-01-01T00:00:00.000Z",
      attempt: 1,
    });

    fake?.emitFromWorker({
      type: "eventNack",
      workerId: 0,
      eventId,
      at: new Date().toISOString(),
      reason: "boom",
      retryable: true,
    });

    const replay = fake?.messages.filter((message) => message.type === "gatewayEvent") ?? [];
    expect(replay.length).toBeGreaterThanOrEqual(2);
    expect(replay.every((message) => message.type === "gatewayEvent" && message.eventId === eventId)).toBe(true);

    fake?.emitFromWorker({
      type: "eventNack",
      workerId: 0,
      eventId,
      at: new Date().toISOString(),
      reason: "boom-again",
      retryable: true,
    });

    expect(supervisor.hasPoisonEvents()).toBe(true);
    await supervisor.stop("test_done");
  });

  test("kills workers with stale heartbeats and reports freshness", async () => {
    const config = parseCoordinatorConfig({
      DISCORD_TOKEN: "token",
      DISCORD_APPLICATION_ID: "123456789012345678",
      MONGODB_URI: "mongodb://127.0.0.1:27017/purev2-test",
      REST_PROXY_AUTHORIZATION: "0123456789abcdef",
      BOT_WORKER_COUNT: "1",
      WORKER_HEARTBEAT_INTERVAL_MS: "250",
      WORKER_HEARTBEAT_TIMEOUT_MS: "500",
      WORKER_RESTART_BASE_DELAY_MS: "60000",
      WORKER_RESTART_MAX_DELAY_MS: "60000",
      SHUTDOWN_TIMEOUT_MS: "1000",
    });

    let fake: FakeSubprocess | undefined;
    const supervisor = createWorkerSupervisor({
      config,
      logger: createLogger({
        service: "purev2-test",
        role: "test",
        level: "error",
        write: () => undefined,
      }),
      metrics: createCoordinatorMetrics(),
      workerEntryPath: "unused",
      restProxyBaseUrl: "http://127.0.0.1:8081",
      spawnWorker: (_workerId, _env, onMessage) => {
        fake = new FakeSubprocess(onMessage);
        queueMicrotask(() => {
          fake?.emitFromWorker({
            type: "workerReady",
            workerId: 0,
            mongoReady: true,
            modulesReady: true,
            statsReady: true,
            statsMetrics: { sessionOpens: 0, sessionCloses: 0, deduplicatedEvents: 0, reconciliationFindings: 0, redisFailures: 0, renders: 0, renderFailures: 0 },
            at: new Date().toISOString(),
          });
        });
        return fake;
      },
    });

    await supervisor.start();
    await supervisor.waitUntilWorkersReady(2_000);
    expect(supervisor.allHeartbeatsFresh()).toBe(true);

    await Bun.sleep(1_200);
    expect(fake?.killed).toBe(true);
    expect(supervisor.allHeartbeatsFresh()).toBe(false);

    await supervisor.stop("stale_heartbeat_test");
  });

  test("graceful shutdown sends shutdown and clears workers", async () => {
    const config = parseCoordinatorConfig({
      DISCORD_TOKEN: "token",
      DISCORD_APPLICATION_ID: "123456789012345678",
      MONGODB_URI: "mongodb://127.0.0.1:27017/purev2-test",
      REST_PROXY_AUTHORIZATION: "0123456789abcdef",
      BOT_WORKER_COUNT: "2",
      SHUTDOWN_TIMEOUT_MS: "1000",
    });

    const fakeWorkers = new Map<number, FakeSubprocess>();
    const supervisor = createWorkerSupervisor({
      config,
      logger: createLogger({
        service: "purev2-test",
        role: "test",
        level: "error",
        write: () => undefined,
      }),
      metrics: createCoordinatorMetrics(),
      workerEntryPath: "unused",
      restProxyBaseUrl: "http://127.0.0.1:8081",
      spawnWorker: (workerId, _env, onMessage) => {
        const fake = new FakeSubprocess(onMessage);
        fakeWorkers.set(workerId, fake);
        queueMicrotask(() => {
          fake.emitFromWorker({
            type: "workerReady",
            workerId,
            mongoReady: true,
            modulesReady: true,
            statsReady: true,
            statsMetrics: { sessionOpens: 0, sessionCloses: 0, deduplicatedEvents: 0, reconciliationFindings: 0, redisFailures: 0, renders: 0, renderFailures: 0 },
            at: new Date().toISOString(),
          });
        });
        return fake;
      },
    });

    await supervisor.start();
    await supervisor.waitUntilWorkersReady(2_000);
    expect(supervisor.readyWorkerCount()).toBe(2);

    await supervisor.stop("graceful");
    for (const fake of fakeWorkers.values()) {
      expect(fake.messages.some((message) => message.type === "shutdown")).toBe(true);
    }
    expect(supervisor.aliveWorkerCount()).toBe(0);
  });
});
