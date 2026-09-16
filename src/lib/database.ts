import mongoose from "mongoose";

import type { Logger } from "./logger.ts";

export interface DatabaseConfig {
  readonly uri: string;
  readonly maxPoolSize: number;
  readonly serverSelectionTimeoutMs: number;
  readonly waitQueueTimeoutMs: number;
}

export interface DatabaseConnection {
  connect(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;
}

export function createMongoDatabase(config: DatabaseConfig, logger: Logger): DatabaseConnection {
  return {
    async connect(): Promise<void> {
      await mongoose.connect(config.uri, {
        autoIndex: false,
        maxPoolSize: config.maxPoolSize,
        serverSelectionTimeoutMS: config.serverSelectionTimeoutMs,
        waitQueueTimeoutMS: config.waitQueueTimeoutMs,
      });
      logger.info("MongoDB connection established");
    },

    async close(): Promise<void> {
      if (mongoose.connection.readyState === mongoose.ConnectionStates.disconnected) return;
      await mongoose.disconnect();
      logger.info("MongoDB connection closed");
    },

    isReady(): boolean {
      return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
    },
  };
}
