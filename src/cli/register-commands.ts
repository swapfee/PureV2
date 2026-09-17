import { join } from "node:path";

import type { CreateApplicationCommand, RestManager } from "discordeno";
import { createRestManager } from "discordeno";

import { loadCommandModules } from "../handlers/loaders.ts";
import { parseRegistrationConfig } from "../lib/config.ts";
import { createDiscordenoLogger, createLogger } from "../lib/logger.ts";

export interface RegisterCliArgs {
  readonly apply: boolean;
  readonly global: boolean;
  readonly confirmGlobal: boolean;
  readonly guildId?: string;
  readonly help: boolean;
}

export type RegisterScope =
  | { readonly kind: "guild"; readonly guildId: string }
  | { readonly kind: "global" };

export function parseRegisterCliArgs(argv: readonly string[]): RegisterCliArgs {
  let guildId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--guild") {
      guildId = argv[i + 1];
    }
  }
  return {
    apply: argv.includes("--apply"),
    global: argv.includes("--global"),
    confirmGlobal: argv.includes("--confirm-global"),
    ...(guildId === undefined ? {} : { guildId }),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

export function registerCliUsage(): string {
  return [
    "PureV2 command registration (dry-run by default)",
    "",
    "Development guild (recommended first):",
    "  bun run commands:register:guild -- --guild <guild-id> --apply",
    "",
    "Global (requires explicit confirmation):",
    "  bun run commands:register:global -- --global --confirm-global --apply",
    "",
    "Flags:",
    "  --guild <id>       Target a single guild (fast iteration)",
    "  --global           Target global application commands",
    "  --confirm-global   Required with --global --apply",
    "  --apply            Perform Discord mutation (omit for dry-run)",
    "  --help             Show this help",
    "",
    "Does not start Gateway, MongoDB, or workers.",
  ].join("\n");
}

export function resolveRegisterScope(args: RegisterCliArgs): RegisterScope {
  const hasGuild = typeof args.guildId === "string" && args.guildId.length > 0;
  if (hasGuild && args.global) {
    throw new Error("Conflicting flags: use either --guild or --global, not both");
  }
  if (!hasGuild && !args.global) {
    throw new Error("Specify --guild <id> or --global (default mode is dry-run)");
  }
  if (hasGuild) {
    const guildId = args.guildId;
    if (guildId === undefined || !/^\d{17,20}$/.test(guildId)) {
      throw new Error("guild id must be a Discord snowflake");
    }
    return { kind: "guild", guildId };
  }
  return { kind: "global" };
}

export function assertRegisterApplyAllowed(input: {
  readonly args: RegisterCliArgs;
  readonly scope: RegisterScope;
}): void {
  if (!input.args.apply) {
    throw new Error("Refusing Discord mutation without --apply (dry-run only)");
  }
  if (input.scope.kind === "global" && !input.args.confirmGlobal) {
    throw new Error("Refusing global registration without --confirm-global");
  }
}

export function validateCommandBodies(
  commands: ReadonlyMap<string, { readonly data: CreateApplicationCommand }>,
): readonly CreateApplicationCommand[] {
  if (commands.size === 0) throw new Error("No command modules found to register");
  const bodies: CreateApplicationCommand[] = [];
  for (const [name, module] of commands) {
    if (!module.data.name || module.data.name !== name) {
      throw new Error(`Command module key/name mismatch for ${name}`);
    }
    const commandType =
      "type" in module.data && typeof module.data.type === "number" ? module.data.type : 1;
    const description =
      "description" in module.data && typeof module.data.description === "string"
        ? module.data.description
        : undefined;
    // Chat input requires a description; USER/MESSAGE context menus do not.
    if (commandType === 1 && (!description || description.trim().length === 0)) {
      throw new Error(`Command ${name} is missing a description`);
    }
    bodies.push(module.data);
  }
  return bodies;
}

export interface RegisterRestPort {
  upsertGlobalApplicationCommands(
    body: readonly CreateApplicationCommand[],
  ): Promise<readonly { readonly name: string }[]>;
  upsertGuildApplicationCommands(
    guildId: string,
    body: readonly CreateApplicationCommand[],
  ): Promise<readonly { readonly name: string }[]>;
}

export function createDiscordenoRegisterRest(rest: RestManager): RegisterRestPort {
  return {
    upsertGlobalApplicationCommands: (body) => rest.upsertGlobalApplicationCommands([...body]),
    upsertGuildApplicationCommands: (guildId, body) =>
      rest.upsertGuildApplicationCommands(guildId, [...body]),
  };
}

export async function runRegisterCli(options: {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly commandsDirectory?: string;
  readonly rest?: RegisterRestPort;
  readonly loadCommands?: typeof loadCommandModules;
} = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const args = parseRegisterCliArgs(argv);
  if (args.help) {
    console.log(registerCliUsage());
    return 0;
  }

  const environment = options.environment ?? Bun.env;
  if (environment.NODE_ENV === "test" && environment.ALLOW_COMMAND_REGISTER !== "1" && args.apply) {
    throw new Error("Refusing to register commands while NODE_ENV=test without ALLOW_COMMAND_REGISTER=1");
  }

  const config = parseRegistrationConfig(environment);
  const logger = createLogger({
    service: "purev2",
    role: "command-registration",
    level: config.LOG_LEVEL,
    sensitiveValues: [config.DISCORD_TOKEN],
  });

  const scope = resolveRegisterScope(args);
  const load = options.loadCommands ?? loadCommandModules;
  const commandsDirectory = options.commandsDirectory ?? join(import.meta.dir, "../commands");
  const commands = await load(commandsDirectory);
  const bodies = validateCommandBodies(commands);

  logger.info("Command registration plan", {
    mode: args.apply ? "apply" : "dry-run",
    scope: scope.kind,
    ...(scope.kind === "guild" ? { guildId: scope.guildId } : {}),
    commandNames: bodies.map((command) => command.name),
    count: bodies.length,
  });

  if (!args.apply) {
    logger.info("Dry-run complete; no Discord mutation performed");
    return 0;
  }

  assertRegisterApplyAllowed({ args, scope });

  const rest =
    options.rest ??
    createDiscordenoRegisterRest(
      createRestManager({
        token: config.DISCORD_TOKEN,
        applicationId: BigInt(config.DISCORD_APPLICATION_ID),
        logger: createDiscordenoLogger(logger),
      }),
    );

  const result =
    scope.kind === "guild"
      ? await rest.upsertGuildApplicationCommands(scope.guildId, bodies)
      : await rest.upsertGlobalApplicationCommands(bodies);

  logger.info("Registered application commands", {
    scope: scope.kind,
    ...(scope.kind === "guild" ? { guildId: scope.guildId } : {}),
    count: result.length,
    names: result.map((command) => command.name),
  });
  return 0;
}

if (import.meta.main) {
  void runRegisterCli().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
