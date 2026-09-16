import { describe, expect, test } from "bun:test";

import { createJ2cMetrics } from "../src/lib/j2c/metrics.ts";
import {
  createMemoryCreationReservationRepository,
  createMemoryGuildConfigRepository,
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { createJ2cRuntime } from "../src/lib/j2c/runtime.ts";
import { createLogger } from "../src/lib/logger.ts";
import { verifyRequiredIndexSpecs } from "../src/lib/j2c/index-requirements.ts";

describe("j2c readiness transitions", () => {
  test("becomes ready only after models, indexes, REST reconcile, and occupancy warm-up", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "purev2",
      role: "test",
      level: "info",
      sensitiveValues: ["secret-token", "mongodb://prod"],
      write: (line) => lines.push(line),
    });
    const { discord } = createFakeDiscord();
    const runtime = createJ2cRuntime({
      configs: createMemoryGuildConfigRepository(),
      channels: createMemoryTemporaryChannelRepository(),
      reservations: createMemoryCreationReservationRepository(),
      discord,
      logger,
      metrics: createJ2cMetrics(),
    });

    expect(runtime.readiness().ready).toBe(false);
    runtime.markModelsInitialized();
    expect(runtime.readiness().ready).toBe(false);
    runtime.markIndexesVerified(true);
    expect(runtime.readiness().ready).toBe(false);
    await runtime.reconcileDatabaseRest();
    expect(runtime.readiness().ready).toBe(false);
    runtime.markOccupancyReady(true);
    expect(runtime.readiness().ready).toBe(false);
    await runtime.reconcileOccupancy();
    expect(runtime.readiness().ready).toBe(true);

    logger.info("j2c ready", {
      token: "secret-token",
      mongo: "mongodb://prod",
      guildId: "123456789012345678",
    });
    expect(lines.some((line) => line.includes("secret-token"))).toBe(false);
    expect(lines.some((line) => line.includes("mongodb://prod"))).toBe(false);
    expect(lines.some((line) => line.includes("[REDACTED]"))).toBe(true);
  });

  test("detects structurally incorrect indexes", () => {
    const check = verifyRequiredIndexSpecs([
      {
        modelName: "GuildConfig",
        indexes: [{ name: "guild_configs_guildId_unique", key: { guildId: 1 } }],
      },
    ]);
    expect(check.ok).toBe(false);
    expect(check.issues.length).toBeGreaterThan(0);
  });
});
