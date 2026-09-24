import { describe, expect, test } from "bun:test";

import {
  buildWorkerProcessEnv,
  buildWorkerSpawnEnv,
  parseCoordinatorConfig,
  parseRegistrationConfig,
  parseWorkerConfig,
  restProxyBaseUrl,
} from "../src/lib/config.ts";

const baseCoordinator = {
  DISCORD_TOKEN: "test-token",
  DISCORD_APPLICATION_ID: "123456789012345678",
  MONGODB_URI: "mongodb://127.0.0.1:27017/purev2-test",
  REST_PROXY_AUTHORIZATION: "0123456789abcdef",
} as const;

const baseWorker = {
  DISCORD_APPLICATION_ID: "123456789012345678",
  MONGODB_URI: "mongodb://127.0.0.1:27017/purev2-test",
  REST_PROXY_AUTHORIZATION: "0123456789abcdef",
  BOT_WORKER_ID: "0",
  BOT_WORKER_COUNT: "1",
} as const;

describe("parseCoordinatorConfig", () => {
  test("applies defaults including one worker and loopback health host", () => {
    const config = parseCoordinatorConfig(baseCoordinator);
    expect(config.BOT_WORKER_COUNT).toBe(1);
    expect(config.HEALTH_HOST).toBe("127.0.0.1");
    expect(config.HEALTH_PORT).toBe(3000);
    expect(config.REST_PROXY_PORT).toBe(8081);
    expect(config.MONGODB_MAX_POOL_SIZE).toBe(3);
    expect(config.WORKER_EVENT_MAX_ATTEMPTS).toBe(3);
    expect(config.REDIS_URL).toBe("redis://127.0.0.1:6379");
    expect(restProxyBaseUrl(config)).toBe("http://127.0.0.1:8081");
  });

  test("accepts two workers", () => {
    const config = parseCoordinatorConfig({ ...baseCoordinator, BOT_WORKER_COUNT: "2" });
    expect(config.BOT_WORKER_COUNT).toBe(2);
  });

  test("rejects more than two workers", () => {
    expect(() => parseCoordinatorConfig({ ...baseCoordinator, BOT_WORKER_COUNT: "3" })).toThrow(
      /BOT_WORKER_COUNT/,
    );
  });

  test("rejects non-loopback REST proxy hosts; allows Docker health binding", () => {
    expect(() =>
      parseCoordinatorConfig({ ...baseCoordinator, REST_PROXY_HOST: "0.0.0.0" }),
    ).toThrow(/REST_PROXY_HOST/);
    const dockerHealth = parseCoordinatorConfig({
      ...baseCoordinator,
      HEALTH_HOST: "0.0.0.0",
    });
    expect(dockerHealth.HEALTH_HOST).toBe("0.0.0.0");
    expect(() =>
      parseCoordinatorConfig({ ...baseCoordinator, HEALTH_HOST: "192.168.1.10" }),
    ).toThrow(/HEALTH_HOST/);
  });

  test("rejects invalid ports", () => {
    expect(() => parseCoordinatorConfig({ ...baseCoordinator, HEALTH_PORT: "0" })).toThrow(/HEALTH_PORT/);
    expect(() => parseCoordinatorConfig({ ...baseCoordinator, REST_PROXY_PORT: "70000" })).toThrow(
      /REST_PROXY_PORT/,
    );
  });

  test("rejects invalid Redis URLs", () => {
    expect(() => parseCoordinatorConfig({ ...baseCoordinator, REDIS_URL: "https://redis.example" })).toThrow(/REDIS_URL/);
  });

  test("rejects invalid heartbeat relationship", () => {
    expect(() =>
      parseCoordinatorConfig({
        ...baseCoordinator,
        WORKER_HEARTBEAT_INTERVAL_MS: "5000",
        WORKER_HEARTBEAT_TIMEOUT_MS: "1000",
      }),
    ).toThrow(/WORKER_HEARTBEAT_TIMEOUT_MS/);
  });
});

describe("parseWorkerConfig", () => {
  test("rejects DISCORD_TOKEN in worker environment", () => {
    expect(() =>
      parseWorkerConfig({
        ...baseWorker,
        DISCORD_TOKEN: "must-not-be-here",
      }),
    ).toThrow(/DISCORD_TOKEN/);
  });

  test("requires worker id within worker count", () => {
    expect(() =>
      parseWorkerConfig({
        ...baseWorker,
        BOT_WORKER_ID: "1",
        BOT_WORKER_COUNT: "1",
      }),
    ).toThrow(/BOT_WORKER_ID/);
  });

  test("parses a valid worker without a Discord token", () => {
    const config = parseWorkerConfig({
      ...baseWorker,
      BOT_WORKER_ID: "0",
      BOT_WORKER_COUNT: "2",
    });
    expect(config.BOT_WORKER_ID).toBe(0);
    expect(config.BOT_WORKER_COUNT).toBe(2);
    expect("DISCORD_TOKEN" in config).toBe(false);
  });
});

describe("buildWorkerProcessEnv", () => {
  test("never includes DISCORD_TOKEN and only allowlisted keys", () => {
    const config = parseCoordinatorConfig(baseCoordinator);
    const env = buildWorkerProcessEnv(config, 0, "http://127.0.0.1:8081");
    expect(env.DISCORD_TOKEN).toBeUndefined();
    expect(Object.keys(env).includes("DISCORD_TOKEN")).toBe(false);
    expect(env.DISCORD_APPLICATION_ID).toBe(config.DISCORD_APPLICATION_ID);
    expect(env.PUREV2_REST_PROXY_BASE_URL).toBe("http://127.0.0.1:8081");
    expect(env.REST_PROXY_AUTHORIZATION).toBe(config.REST_PROXY_AUTHORIZATION);
    expect(env.REDIS_URL).toBe(config.REDIS_URL);
  });
});

describe("buildWorkerSpawnEnv", () => {
  test("preserves PATH while stripping DISCORD_TOKEN from the parent environment", () => {
    const config = parseCoordinatorConfig(baseCoordinator);
    const env = buildWorkerSpawnEnv(config, 0, "http://127.0.0.1:8081", {
      PATH: "/usr/bin",
      DISCORD_TOKEN: "leaked-token",
      SOME_SECRET: "nope",
      HOME: "/home/bot",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/bot");
    expect(env.DISCORD_TOKEN).toBeUndefined();
    expect(env.SOME_SECRET).toBeUndefined();
    expect(env.REST_PROXY_AUTHORIZATION).toBe(config.REST_PROXY_AUTHORIZATION);
  });
});

describe("parseRegistrationConfig", () => {
  test("requires token and application id", () => {
    expect(() => parseRegistrationConfig({})).toThrow(/DISCORD_TOKEN/);
    const config = parseRegistrationConfig({
      DISCORD_TOKEN: "token",
      DISCORD_APPLICATION_ID: "123456789012345678",
    });
    expect(config.DISCORD_APPLICATION_ID).toBe("123456789012345678");
  });
});
