import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { loadCommandModules, loadEventModules } from "../src/handlers/loaders.ts";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "purev2-loaders-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("loadCommandModules", () => {
  test("loads valid command modules and rejects duplicates", async () => {
    await withTempDir(async (directory) => {
      await writeFile(
        join(directory, "ping.command.ts"),
        `export default {
          data: { name: "ping", description: "Ping the bot" },
          async execute() {}
        };`,
      );

      const registry = await loadCommandModules(directory);
      expect(registry.size).toBe(1);
      expect(registry.get("ping")?.data.name).toBe("ping");

      await writeFile(
        join(directory, "ping-dupe.command.ts"),
        `export default {
          data: { name: "ping", description: "Duplicate" },
          async execute() {}
        };`,
      );

      try {
        await loadCommandModules(directory);
        throw new Error("expected duplicate command failure");
      } catch (error) {
        expect(error instanceof Error ? error.message : "").toMatch(/Duplicate command name/);
      }
    });
  });

  test("rejects malformed command modules", async () => {
    await withTempDir(async (directory) => {
      await writeFile(join(directory, "bad.command.ts"), `export default { data: { name: "bad" } };`);
      try {
        await loadCommandModules(directory);
        throw new Error("expected malformed command failure");
      } catch (error) {
        expect(error instanceof Error ? error.message : "").toMatch(/Malformed command module/);
      }
    });
  });

  test("loads nested command folders", async () => {
    await withTempDir(async (directory) => {
      const nested = join(directory, "utility");
      await mkdir(nested);
      await writeFile(
        join(nested, "echo.command.ts"),
        `export default {
          data: { name: "echo", description: "Echo text" },
          async execute() {}
        };`,
      );
      const registry = await loadCommandModules(directory);
      expect(registry.has("echo")).toBe(true);
    });
  });

  test("loads user context menu commands without descriptions", async () => {
    await withTempDir(async (directory) => {
      await writeFile(
        join(directory, "block-from-vc.command.ts"),
        `export default {
          data: { name: "Block from VC", type: 2 },
          async execute() {}
        };`,
      );
      const registry = await loadCommandModules(directory);
      expect(registry.get("Block from VC")?.data.type).toBe(2);
    });
  });
});

describe("loadEventModules", () => {
  test("loads valid event modules and rejects duplicates", async () => {
    await withTempDir(async (directory) => {
      await writeFile(
        join(directory, "ready.event.ts"),
        `export default {
          name: "ready",
          async execute() {}
        };`,
      );
      const registry = await loadEventModules(directory);
      expect(registry.size).toBe(1);

      await writeFile(
        join(directory, "ready-dupe.event.ts"),
        `export default {
          name: "ready",
          async execute() {}
        };`,
      );
      try {
        await loadEventModules(directory);
        throw new Error("expected duplicate event failure");
      } catch (error) {
        expect(error instanceof Error ? error.message : "").toMatch(/Duplicate event name/);
      }
    });
  });
});

describe("project modules", () => {
  test("loads the repository command and event modules", async () => {
    const commands = await loadCommandModules(join(import.meta.dir, "../src/commands"));
    const events = await loadEventModules(join(import.meta.dir, "../src/events"));
    expect(commands.has("ping")).toBe(true);
    expect(events.has("ready")).toBe(true);
    expect(events.has("interactionCreate")).toBe(true);
  });
});
