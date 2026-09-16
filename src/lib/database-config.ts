import type { DatabaseConfig } from "./database.ts";

export function toDatabaseConfig(config: {
  readonly MONGODB_URI: string;
  readonly MONGODB_MAX_POOL_SIZE: number;
  readonly MONGODB_SERVER_SELECTION_TIMEOUT_MS: number;
  readonly MONGODB_WAIT_QUEUE_TIMEOUT_MS: number;
}): DatabaseConfig {
  return {
    uri: config.MONGODB_URI,
    maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
    serverSelectionTimeoutMs: config.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    waitQueueTimeoutMs: config.MONGODB_WAIT_QUEUE_TIMEOUT_MS,
  };
}
