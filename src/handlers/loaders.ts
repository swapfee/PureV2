import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CreateApplicationCommand } from "discordeno";
import { z } from "zod";

import type {
  CommandModule,
  CommandRegistry,
  EventModule,
  EventRegistry,
} from "./types.ts";
import type { RuntimeEventName } from "../lib/runtime-types.ts";

const commandDataSchema = z
  .object({
    name: z.string().min(1).max(32),
    description: z.string().min(1).max(100).optional(),
    type: z.number().int().optional(),
    options: z.array(z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    const commandType = value.type ?? 1; // ChatInput default
    if (commandType === 1) {
      if (!value.description || value.description.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Chat input commands require a description",
          path: ["description"],
        });
      }
      if (!/^[-_a-z0-9]{1,32}$/.test(value.name)) {
        ctx.addIssue({
          code: "custom",
          message: "Chat input command names must be lowercase kebab/snake case",
          path: ["name"],
        });
      }
      return;
    }
    if (commandType === 2 || commandType === 3) {
      // USER / MESSAGE context menus: name may include spaces and mixed case.
      if (value.name.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Context menu command names cannot be empty",
          path: ["name"],
        });
      }
      return;
    }
    ctx.addIssue({
      code: "custom",
      message: `Unsupported application command type ${commandType}`,
      path: ["type"],
    });
  })
  .loose();

const commandModuleShapeSchema = z.object({
  data: z.unknown(),
  cooldownMs: z.number().int().nonnegative().optional(),
  execute: z.unknown(),
});

const runtimeEventNameSchema = z.enum(["interactionCreate", "ready", "voiceStateUpdate"]);

const eventModuleShapeSchema = z.object({
  name: runtimeEventNameSchema,
  execute: z.unknown(),
});

async function discoverModules(directory: string, suffix: string): Promise<string[]> {
  const discovered: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...(await discoverModules(fullPath, suffix)));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      discovered.push(fullPath);
    }
  }

  return discovered.toSorted((left, right) => left.localeCompare(right));
}

async function importDefault(filePath: string): Promise<unknown> {
  const namespace: unknown = await import(pathToFileURL(filePath).href);
  if (typeof namespace !== "object" || namespace === null || !("default" in namespace)) {
    throw new Error(`Module must have a default export: ${filePath}`);
  }
  return namespace.default;
}

function isCreateApplicationCommand(value: unknown): value is CreateApplicationCommand {
  return commandDataSchema.safeParse(value).success;
}

function isCommandExecute(value: unknown): value is CommandModule["execute"] {
  return typeof value === "function";
}

function isEventExecute(value: unknown): value is EventModule["execute"] {
  return typeof value === "function";
}

function toCommandModule(value: unknown, filePath: string): CommandModule {
  const shape = commandModuleShapeSchema.safeParse(value);
  if (!shape.success) {
    throw new Error(`Malformed command module ${filePath}: ${z.prettifyError(shape.error)}`);
  }
  if (!isCreateApplicationCommand(shape.data.data)) {
    throw new Error(`Malformed command module ${filePath}: invalid command data`);
  }
  if (!isCommandExecute(shape.data.execute)) {
    throw new Error(`Malformed command module ${filePath}: execute must be a function`);
  }

  const command: CommandModule = {
    data: shape.data.data,
    execute: shape.data.execute,
  };
  if (shape.data.cooldownMs !== undefined) {
    return { ...command, cooldownMs: shape.data.cooldownMs };
  }
  return command;
}

function toEventModule(value: unknown, filePath: string): EventModule {
  const shape = eventModuleShapeSchema.safeParse(value);
  if (!shape.success) {
    throw new Error(`Malformed event module ${filePath}: ${z.prettifyError(shape.error)}`);
  }
  if (!isEventExecute(shape.data.execute)) {
    throw new Error(`Malformed event module ${filePath}: execute must be a function`);
  }

  return {
    name: shape.data.name,
    execute: shape.data.execute,
  };
}

export async function loadCommandModules(directory: string): Promise<CommandRegistry> {
  const registry = new Map<string, CommandModule>();

  for (const filePath of await discoverModules(directory, ".command.ts")) {
    const command = toCommandModule(await importDefault(filePath), filePath);
    if (registry.has(command.data.name)) {
      throw new Error(`Duplicate command name "${command.data.name}" in ${filePath}`);
    }
    registry.set(command.data.name, command);
  }

  return registry;
}

export async function loadEventModules(directory: string): Promise<EventRegistry> {
  const registry = new Map<RuntimeEventName, EventModule>();

  for (const filePath of await discoverModules(directory, ".event.ts")) {
    const event = toEventModule(await importDefault(filePath), filePath);
    if (registry.has(event.name)) {
      throw new Error(`Duplicate event name "${event.name}" in ${filePath}`);
    }
    registry.set(event.name, event);
  }

  return registry;
}
