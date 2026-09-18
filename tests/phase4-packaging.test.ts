import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseCoordinatorConfig,
  parseIndexMaintenanceConfig,
  parseRegistrationConfig,
} from "../src/lib/config.ts";
import {
  assertIndexApplyAllowed,
  parseIndexCliArgs,
  planJ2cIndexes,
} from "../src/lib/j2c/index-plan.ts";
import { REQUIRED_J2C_INDEX_SPECS } from "../src/lib/j2c/index-requirements.ts";
import {
  assertRegisterApplyAllowed,
  parseRegisterCliArgs,
  resolveRegisterScope,
  runRegisterCli,
  validateCommandBodies,
  type RegisterRestPort,
} from "../src/cli/register-commands.ts";
import { registerGracefulShutdown } from "../index.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { CommandModule } from "../src/handlers/types.ts";

const root = join(import.meta.dir, "..");

function stubCommand(name: string, description: string): CommandModule {
  return {
    data: {
      name,
      description,
      type: 1,
    },
    async execute() {
      return;
    },
  };
}

const unusedRest: RegisterRestPort = {
  upsertGlobalApplicationCommands: async () => {
    throw new Error("should not call Discord");
  },
  upsertGuildApplicationCommands: async () => {
    throw new Error("should not call Discord");
  },
};

const baseCoordinator = {
  DISCORD_TOKEN: "test-token-value-not-real",
  DISCORD_APPLICATION_ID: "123456789012345678",
  MONGODB_URI: "mongodb+srv://user:pass@cluster.example/purev2",
  REST_PROXY_AUTHORIZATION: "0123456789abcdef0123456789abcdef",
  NODE_ENV: "production",
} as const;

describe("production health vs REST proxy binding", () => {
  test("allows HEALTH_HOST=0.0.0.0 for Docker while rejecting REST non-loopback", () => {
    const config = parseCoordinatorConfig({
      ...baseCoordinator,
      HEALTH_HOST: "0.0.0.0",
      REST_PROXY_HOST: "127.0.0.1",
    });
    expect(config.HEALTH_HOST).toBe("0.0.0.0");
    expect(config.REST_PROXY_HOST).toBe("127.0.0.1");

    expect(() =>
      parseCoordinatorConfig({
        ...baseCoordinator,
        HEALTH_HOST: "0.0.0.0",
        REST_PROXY_HOST: "0.0.0.0",
      }),
    ).toThrow(/REST_PROXY_HOST/);

    expect(() =>
      parseCoordinatorConfig({
        ...baseCoordinator,
        HEALTH_HOST: "10.0.0.5",
      }),
    ).toThrow(/HEALTH_HOST/);
  });

  test("rejects non-loopback REST proxy even when health is loopback", () => {
    expect(() =>
      parseCoordinatorConfig({
        ...baseCoordinator,
        HEALTH_HOST: "127.0.0.1",
        REST_PROXY_HOST: "172.17.0.1",
      }),
    ).toThrow(/REST_PROXY_HOST/);
  });
});

describe("production configuration validation", () => {
  test("parses a production-shaped coordinator config", () => {
    const config = parseCoordinatorConfig({
      ...baseCoordinator,
      BOT_WORKER_COUNT: "1",
      HEALTH_HOST: "0.0.0.0",
      HEALTH_PORT: "3000",
      REST_PROXY_HOST: "127.0.0.1",
      REST_PROXY_PORT: "8081",
    });
    expect(config.NODE_ENV).toBe("production");
    expect(config.BOT_WORKER_COUNT).toBe(1);
    expect(config.HEALTH_HOST).toBe("0.0.0.0");
    expect(config.REST_PROXY_HOST).toBe("127.0.0.1");
  });

  test("index maintenance config does not require Discord token", () => {
    const config = parseIndexMaintenanceConfig({
      NODE_ENV: "production",
      MONGODB_URI: "mongodb+srv://user:pass@cluster.example/purev2",
    });
    expect(config.MONGODB_URI.startsWith("mongodb+srv://")).toBe(true);
    expect("DISCORD_TOKEN" in config).toBe(false);
  });

  test("registration config requires only Discord credentials", () => {
    const config = parseRegistrationConfig({
      DISCORD_TOKEN: "token",
      DISCORD_APPLICATION_ID: "123456789012345678",
    });
    expect(config.DISCORD_TOKEN).toBe("token");
    expect("MONGODB_URI" in config).toBe(false);
  });
});

describe("Docker packaging artifacts", () => {
  test("Dockerfile pins Bun 1.4.2, non-root, healthcheck, no REST EXPOSE", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("oven/bun:1.4.2");
    expect(dockerfile).not.toContain(":latest");
    expect(dockerfile).toContain("--frozen-lockfile");
    expect(dockerfile).toContain("bun run typecheck");
    expect(dockerfile).toContain("bun run lint");
    expect(dockerfile).toContain("USER purev2");
    expect(dockerfile).toContain("EXPOSE 3000");
    expect(dockerfile).not.toMatch(/EXPOSE\s+8081/);
    expect(dockerfile).toContain("/healthz");
    expect(dockerfile).not.toMatch(/^\s*COPY\s+\.env/m);
  });

  test("compose publishes health to loopback only and never publishes REST proxy", () => {
    const compose = readFileSync(join(root, "compose.yaml"), "utf8");
    expect(compose).toContain("init: true");
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).toContain("no-new-privileges");
    expect(compose).toContain("cap_drop");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("env_file");
    const portsBlock = compose.match(/ports:\s*\n((?:\s+-[^\n]+\n?)+)/)?.[1] ?? "";
    expect(portsBlock).toContain("127.0.0.1:3000:3000");
    expect(portsBlock).not.toContain("8081");
    expect(compose).not.toContain("privileged: true");
    expect(compose).not.toContain("/var/run/docker.sock");
    expect(compose).not.toMatch(/^\s*mongo:/im);
    expect(compose).not.toMatch(/^\s*redis:/im);
  });

  test(".dockerignore excludes secrets, git, and tests from production context patterns", () => {
    const ignore = readFileSync(join(root, ".dockerignore"), "utf8");
    expect(ignore).toContain(".env");
    expect(ignore).toContain(".git");
  });
});

describe("index maintenance CLI gates", () => {
  test("default parse is dry-run", () => {
    const args = parseIndexCliArgs([]);
    expect(args.apply).toBe(false);
    expect(args.verify).toBe(false);
    expect(args.confirmProduction).toBe(false);
  });

  test("plans creates for empty database and refuses apply with conflicts", () => {
    const emptyPlan = planJ2cIndexes([
      { modelName: "GuildConfig", indexes: [{ name: "_id_", key: { _id: 1 } }] },
      { modelName: "TemporaryChannel", indexes: [{ name: "_id_", key: { _id: 1 } }] },
      { modelName: "CreationReservation", indexes: [{ name: "_id_", key: { _id: 1 } }] },
    ]);
    expect(emptyPlan.creates.length).toBeGreaterThan(0);
    expect(emptyPlan.okToApply).toBe(true);

    const guildSpec = REQUIRED_J2C_INDEX_SPECS.GuildConfig![0]!;
    const conflictPlan = planJ2cIndexes([
      {
        modelName: "GuildConfig",
        indexes: [
          { name: "_id_", key: { _id: 1 } },
          { name: guildSpec.name, key: { guildId: -1 }, unique: true },
        ],
      },
      { modelName: "TemporaryChannel", indexes: [{ name: "_id_", key: { _id: 1 } }] },
      { modelName: "CreationReservation", indexes: [{ name: "_id_", key: { _id: 1 } }] },
    ]);
    expect(conflictPlan.conflicts.length).toBeGreaterThan(0);
    expect(conflictPlan.okToApply).toBe(false);

    expect(() =>
      assertIndexApplyAllowed({
        args: { apply: true, confirmProduction: true, verify: false, help: false },
        nodeEnv: "production",
        plan: conflictPlan,
      }),
    ).toThrow(/conflict/i);
  });

  test("plans retirement only for the exact legacy owner uniqueness index", () => {
    const plan = planJ2cIndexes([
      { modelName: "GuildConfig", indexes: [{ name: "_id_", key: { _id: 1 } }] },
      {
        modelName: "TemporaryChannel",
        indexes: [
          { name: "_id_", key: { _id: 1 } },
          {
            name: "temporary_channels_one_active_owner",
            key: { guildId: 1, ownerId: 1 },
            unique: true,
            partialFilterExpression: { status: { $in: ["creating", "active", "deleting"] } },
          },
        ],
      },
      { modelName: "CreationReservation", indexes: [{ name: "_id_", key: { _id: 1 } }] },
    ]);

    expect(plan.retirements).toHaveLength(1);
    expect(plan.retirements[0]?.indexName).toBe("temporary_channels_one_active_owner");
    expect(plan.okToApply).toBe(true);
  });

  test("requires --apply and production confirmation", () => {
    const plan = planJ2cIndexes([
      { modelName: "GuildConfig", indexes: [{ name: "_id_", key: { _id: 1 } }] },
      { modelName: "TemporaryChannel", indexes: [{ name: "_id_", key: { _id: 1 } }] },
      { modelName: "CreationReservation", indexes: [{ name: "_id_", key: { _id: 1 } }] },
    ]);

    expect(() =>
      assertIndexApplyAllowed({
        args: { apply: false, confirmProduction: false, verify: false, help: false },
        nodeEnv: "production",
        plan,
      }),
    ).toThrow(/--apply/);

    expect(() =>
      assertIndexApplyAllowed({
        args: { apply: true, confirmProduction: false, verify: false, help: false },
        nodeEnv: "production",
        plan,
      }),
    ).toThrow(/--confirm-production/);

    assertIndexApplyAllowed({
      args: { apply: true, confirmProduction: true, verify: false, help: false },
      nodeEnv: "production",
      plan,
    });
  });
});

describe("command registration CLI gates", () => {
  test("dry-run is default and never calls Discord REST", async () => {
    let restCalls = 0;
    const code = await runRegisterCli({
      argv: ["--guild", "123456789012345678"],
      environment: {
        DISCORD_TOKEN: "must-not-print-or-use",
        DISCORD_APPLICATION_ID: "123456789012345678",
        NODE_ENV: "test",
      },
      rest: {
        upsertGlobalApplicationCommands: async () => {
          restCalls += 1;
          return [];
        },
        upsertGuildApplicationCommands: async () => {
          restCalls += 1;
          return [];
        },
      },
      loadCommands: async () => new Map([["ping", stubCommand("ping", "Ping")]]),
    });
    expect(code).toBe(0);
    expect(restCalls).toBe(0);
  });

  test("guild apply requires --apply and uses injected REST only", async () => {
    expect(() =>
      assertRegisterApplyAllowed({
        args: parseRegisterCliArgs(["--guild", "123456789012345678"]),
        scope: resolveRegisterScope(parseRegisterCliArgs(["--guild", "123456789012345678"])),
      }),
    ).toThrow(/--apply/);

    let guildCalls = 0;
    let globalCalls = 0;
    const code = await runRegisterCli({
      argv: ["--guild", "123456789012345678", "--apply"],
      environment: {
        DISCORD_TOKEN: "injected-token",
        DISCORD_APPLICATION_ID: "123456789012345678",
        NODE_ENV: "test",
        ALLOW_COMMAND_REGISTER: "1",
      },
      rest: {
        upsertGlobalApplicationCommands: async () => {
          globalCalls += 1;
          return [];
        },
        upsertGuildApplicationCommands: async (guildId, body) => {
          guildCalls += 1;
          expect(guildId).toBe("123456789012345678");
          expect(body.map((command) => command.name)).toContain("ping");
          return body.map((command) => ({ name: command.name }));
        },
      },
      loadCommands: async () => new Map([["ping", stubCommand("ping", "Ping")]]),
    });
    expect(code).toBe(0);
    expect(guildCalls).toBe(1);
    expect(globalCalls).toBe(0);
  });

  test("global apply requires --confirm-global and rejects guild+global", () => {
    expect(() => resolveRegisterScope(parseRegisterCliArgs(["--guild", "1", "--global"]))).toThrow(
      /Conflicting/,
    );

    const args = parseRegisterCliArgs(["--global", "--apply"]);
    const scope = resolveRegisterScope(args);
    expect(() => assertRegisterApplyAllowed({ args, scope })).toThrow(/--confirm-global/);

    assertRegisterApplyAllowed({
      args: parseRegisterCliArgs(["--global", "--confirm-global", "--apply"]),
      scope: { kind: "global" },
    });
  });

  test("validateCommandBodies rejects empty or mismatched modules", () => {
    expect(() => validateCommandBodies(new Map())).toThrow(/No command/);
    expect(() =>
      validateCommandBodies(new Map([["ping", stubCommand("pong", "x")]])),
    ).toThrow(/mismatch/);
  });

  test("registration does not require MongoDB env and does not start Gateway", async () => {
    const code = await runRegisterCli({
      argv: ["--guild", "123456789012345678"],
      environment: {
        DISCORD_TOKEN: "token",
        DISCORD_APPLICATION_ID: "123456789012345678",
      },
      loadCommands: async () => new Map([["vc", stubCommand("vc", "Voice channel controls")]]),
      rest: unusedRest,
    });
    expect(code).toBe(0);
  });
});

describe("graceful SIGTERM boundary", () => {
  test("registerGracefulShutdown invokes runtime.stop on SIGTERM once", async () => {
    const stops: string[] = [];
    let exitCode: number | undefined;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    const fakeProcess = {
      on(event: string, handler: (...args: unknown[]) => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
        return fakeProcess;
      },
      off(event: string, handler: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(handler);
        return fakeProcess;
      },
      emit(event: string) {
        for (const handler of listeners.get(event) ?? []) handler();
      },
    };

    const registration = registerGracefulShutdown(
      {
        stop: async (reason?: string) => {
          stops.push(reason ?? "none");
        },
      },
      {
        processRef: fakeProcess,
        onAfterStop: (code) => {
          exitCode = code;
        },
      },
    );

    fakeProcess.emit("SIGTERM");
    fakeProcess.emit("SIGTERM");
    await Bun.sleep(10);
    expect(stops).toEqual(["SIGTERM"]);
    expect(exitCode).toBe(0);
    registration.dispose();
  });
});

describe("logger redaction of production environment values", () => {
  test("redacts Discord token, REST authorization, and Mongo URI", () => {
    const lines: string[] = [];
    const token = "prod-discord-token-abc";
    const auth = "prod-rest-auth-0123456789abcdef";
    const mongo = "mongodb+srv://user:secretpass@cluster.example/purev2";
    const logger = createLogger({
      service: "purev2",
      role: "coordinator",
      level: "info",
      sensitiveValues: [token, auth, mongo],
      write: (line) => lines.push(line),
    });

    logger.info("boot", {
      DISCORD_TOKEN: token,
      REST_PROXY_AUTHORIZATION: auth,
      MONGODB_URI: mongo,
      HEALTH_HOST: "0.0.0.0",
    });

    const line = lines[0] ?? "";
    expect(line.includes(token)).toBe(false);
    expect(line.includes(auth)).toBe(false);
    expect(line.includes("secretpass")).toBe(false);
    expect(line.includes("[REDACTED]")).toBe(true);
    expect(line.includes("0.0.0.0")).toBe(true);
  });
});
