import { createCoordinatorRuntime, type CoordinatorRuntime } from "./src/lib/coordinator/app.ts";
import { createLogger } from "./src/lib/logger.ts";
import { parseCoordinatorConfig } from "./src/lib/config.ts";

export const applicationName = "purev2";

export interface ShutdownRegistration {
  readonly dispose: () => void;
}

export interface ShutdownSignalTarget {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/**
 * Register graceful SIGINT/SIGTERM handlers. Docker Compose sends SIGTERM on stop.
 * Exported for integration-boundary tests without starting the Gateway.
 */
export function registerGracefulShutdown(
  runtime: Pick<CoordinatorRuntime, "stop">,
  options: {
    readonly onAfterStop?: (code: number) => void;
    readonly processRef?: ShutdownSignalTarget;
  } = {},
): ShutdownRegistration {
  const processRef = options.processRef ?? process;
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    void runtime.stop(signal).finally(() => {
      options.onAfterStop?.(0);
    });
  };

  const onSigint = (): void => shutdown("SIGINT");
  const onSigterm = (): void => shutdown("SIGTERM");
  processRef.on("SIGINT", onSigint);
  processRef.on("SIGTERM", onSigterm);

  return {
    dispose: () => {
      processRef.off("SIGINT", onSigint);
      processRef.off("SIGTERM", onSigterm);
    },
  };
}

async function main(): Promise<void> {
  const config = parseCoordinatorConfig();
  const logger = createLogger({
    service: applicationName,
    role: "coordinator",
    level: config.LOG_LEVEL,
    sensitiveValues: [config.DISCORD_TOKEN, config.REST_PROXY_AUTHORIZATION, config.MONGODB_URI],
  });

  const runtime = createCoordinatorRuntime(config, logger);
  registerGracefulShutdown(runtime, {
    onAfterStop: (code) => process.exit(code),
  });

  try {
    await runtime.start();
  } catch (error: unknown) {
    logger.error("Coordinator startup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await runtime.stop("startup_failed");
    process.exit(1);
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
