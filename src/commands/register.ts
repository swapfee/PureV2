/**
 * Thin entrypoint kept for package script compatibility.
 * Prefer: bun run src/cli/register-commands.ts
 */
import { runRegisterCli } from "../cli/register-commands.ts";

if (import.meta.main) {
  void runRegisterCli().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
