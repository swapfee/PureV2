import { describe, expect, test } from "bun:test";

import { createCoordinatorMetrics } from "../src/lib/coordinator/metrics.ts";
import { createHealthServer } from "../src/lib/coordinator/health.ts";

describe("createCoordinatorMetrics", () => {
  test("increments and snapshots counters", () => {
    const metrics = createCoordinatorMetrics();
    metrics.increment("eventsForwarded");
    metrics.increment("eventsAcked", 2);
    expect(metrics.snapshot()).toEqual({
      eventsForwarded: 1,
      eventsAcked: 2,
      eventsNacked: 0,
      workerRestarts: 0,
      restProxyRequests: 0,
      restProxyErrors: 0,
    });
  });
});

describe("createHealthServer", () => {
  test("serves health and readiness endpoints with foundation phase marker", async () => {
    let ready = false;
    const metrics = createCoordinatorMetrics();
    const server = createHealthServer({
      host: "127.0.0.1",
      port: 0,
      status: {
        isLive: () => true,
        report: () => ({
          ok: ready,
          phase: "foundation",
          j2cReady: false,
          statsReady: false,
          components: {
            coordinatorMongo: { ok: ready },
            moduleLoaders: { ok: ready },
            restProxy: { ok: ready },
            workerStartup: { ok: ready },
            workerMongo: { ok: ready },
            workerHeartbeats: { ok: ready },
            gatewayManager: { ok: ready },
            gatewayShards: { ok: ready },
            queueOverflow: { ok: true },
            poisonEvents: { ok: true },
            shutdown: { ok: true },
            j2c: { ok: false, detail: "pending" },
            stats: { ok: false, detail: "pending" },
          },
          metrics: metrics.snapshot(),
        }),
      },
    });

    await server.start();
    try {
      const live = await fetch(`${server.url}/healthz`);
      expect(live.status).toBe(200);

      const notReady = await fetch(`${server.url}/readyz`);
      expect(notReady.status).toBe(503);
      const notReadyBody: unknown = await notReady.json();
      expect(notReadyBody).toMatchObject({ phase: "foundation", j2cReady: false });

      ready = true;
      const readyResponse = await fetch(`${server.url}/readyz`);
      expect(readyResponse.status).toBe(200);
      const body: unknown = await readyResponse.json();
      expect(body).toMatchObject({ ok: true, phase: "foundation", j2cReady: false });
    } finally {
      await server.stop();
    }
  });
});
