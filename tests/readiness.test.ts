import { describe, expect, test } from "bun:test";

import { timingSafeEqualString } from "../src/lib/security.ts";
import { allComponentsHealthy, type ComponentStatus, type ReadinessComponent } from "../src/lib/coordinator/health.ts";

describe("timingSafeEqualString", () => {
  test("accepts equal secrets and rejects mismatches", () => {
    expect(timingSafeEqualString("0123456789abcdef", "0123456789abcdef")).toBe(true);
    expect(timingSafeEqualString("0123456789abcdef", "0123456789abcdee")).toBe(false);
    expect(timingSafeEqualString("short", "longer-secret")).toBe(false);
  });
});

describe("allComponentsHealthy", () => {
  test("requires every readiness component to be healthy", () => {
    const healthy: Record<ReadinessComponent, ComponentStatus> = {
      coordinatorMongo: { ok: true },
      moduleLoaders: { ok: true },
      restProxy: { ok: true },
      workerStartup: { ok: true },
      workerMongo: { ok: true },
      workerHeartbeats: { ok: true },
      gatewayManager: { ok: true },
      gatewayShards: { ok: true },
      queueOverflow: { ok: true },
      poisonEvents: { ok: true },
      shutdown: { ok: true },
    j2c: { ok: true },
    stats: { ok: true },
    };
    expect(allComponentsHealthy(healthy)).toBe(true);
    expect(allComponentsHealthy({ ...healthy, poisonEvents: { ok: false, detail: "poison=1" } })).toBe(false);
    expect(allComponentsHealthy({ ...healthy, j2c: { ok: false, detail: "pending" } })).toBe(false);
  });
});
