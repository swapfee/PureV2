import {
  ActivityTypes,
  createGatewayManager,
  GatewayIntents,
  type BotStatusUpdate,
  type GatewayManager,
  type DiscordGatewayPayload,
  type RestManager,
  type Camelize,
  type DiscordGetGatewayBot,
} from "discordeno";

import type { Logger } from "../logger.ts";
import { createDiscordenoLogger } from "../logger.ts";

/** Shown as the bot's Discord custom status while connected. */
export const BOT_CUSTOM_STATUS = "PureV2 · early beta";

function botPresence(): BotStatusUpdate {
  return {
    since: null,
    status: "online",
    activities: [
      {
        // Type 4 custom status: `name` stays "Custom Status"; `state` is the visible text.
        name: "Custom Status",
        type: ActivityTypes.Custom,
        state: BOT_CUSTOM_STATUS,
      } as BotStatusUpdate["activities"][number] & { state: string },
    ],
  };
}

export type GatewayEventForwarder = (
  shardId: number,
  payload: DiscordGatewayPayload,
) => Promise<void> | void;

export interface CoordinatorGatewayOptions {
  readonly token: string;
  readonly rest: RestManager;
  readonly logger: Logger;
  readonly totalWorkers: number;
  readonly forwardEvent: GatewayEventForwarder;
  /**
   * When false, create the manager but do not call spawnShards().
   * Useful for tests and dry startup wiring.
   */
  readonly connect?: boolean;
  readonly connection?: Camelize<DiscordGetGatewayBot>;
}

export interface CoordinatorGateway {
  readonly gateway: GatewayManager;
  start(): Promise<void>;
  stop(code?: number, reason?: string): Promise<void>;
  isStarted(): boolean;
  recommendedShardCount(): number;
  healthyShardCount(): number;
  areRequiredShardsHealthy(): boolean;
}

/** Intents required by the future Join-to-Create voice lifecycle. */
export const COORDINATOR_INTENTS = GatewayIntents.Guilds | GatewayIntents.GuildVoiceStates;

function isDiscordGatewayPayload(value: unknown): value is DiscordGatewayPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("op" in value) || typeof value.op !== "number") return false;
  return true;
}

export function createCoordinatorGateway(options: CoordinatorGatewayOptions): CoordinatorGateway {
  let started = false;
  let gateway: GatewayManager | undefined;
  let recommendedShards = 0;
  const healthyShards = new Set<number>();
  const connect = options.connect !== false;

  return {
    get gateway(): GatewayManager {
      if (!gateway) throw new Error("Gateway manager has not been created yet");
      return gateway;
    },

    isStarted(): boolean {
      return started;
    },

    recommendedShardCount(): number {
      return recommendedShards;
    },

    healthyShardCount(): number {
      return healthyShards.size;
    },

    areRequiredShardsHealthy(): boolean {
      if (!connect) return started;
      return started && recommendedShards > 0 && healthyShards.size >= recommendedShards;
    },

    async start(): Promise<void> {
      if (gateway) return;

      const connection = options.connection ?? (await options.rest.getSessionInfo());
      recommendedShards = connection.shards;
      const logger = createDiscordenoLogger(options.logger.child({ component: "gateway" }));

      gateway = createGatewayManager({
        token: options.token,
        intents: COORDINATOR_INTENTS,
        connection,
        // Same trick as discord.js: only `browser` controls the mobile indicator.
        properties: {
          os: process.platform,
          browser: "Discord iOS",
          device: "Discordeno",
        },
        makePresence: async () => botPresence(),
        // Keep shards in this process; workers only process events.
        totalWorkers: 1,
        shardsPerWorker: connection.shards,
        // Pass snake_case Discord payloads to bot.handlers on workers.
        preferSnakeCase: true,
        logger,
        events: {
          identified: (shard) => {
            healthyShards.add(shard.id);
            options.logger.info("Gateway shard identified", { shardId: shard.id });
          },
          disconnected: (shard) => {
            healthyShards.delete(shard.id);
            options.logger.warn("Gateway shard disconnected", { shardId: shard.id });
          },
          message: (shard, payload) => {
            if (!isDiscordGatewayPayload(payload)) {
              options.logger.warn("Ignoring non-gateway payload from shard", { shardId: shard.id });
              return;
            }
            void Promise.resolve(options.forwardEvent(shard.id, payload)).catch((error: unknown) => {
              options.logger.error("Failed to forward gateway event", {
                shardId: shard.id,
                eventName: payload.t,
                error,
              });
            });
          },
        },
        resharding: {
          enabled: false,
          shardsFullPercentage: 80,
          checkInterval: 28_800_000,
          getSessionInfo: async () => options.rest.getSessionInfo(),
        },
      });

      if (!connect) {
        started = true;
        options.logger.info("Gateway manager created without connecting shards", {
          recommendedShards,
          workerCount: options.totalWorkers,
        });
        return;
      }

      await gateway.spawnShards();
      started = true;
      options.logger.info("Gateway shards spawning requested", {
        totalShards: connection.shards,
        recommendedShards: connection.shards,
        workerCount: options.totalWorkers,
      });
    },

    async stop(code = 1_000, reason = "coordinator_shutdown"): Promise<void> {
      if (!gateway) return;
      await gateway.shutdown(code, reason, true);
      started = false;
      healthyShards.clear();
      gateway = undefined;
      options.logger.info("Gateway manager shut down");
    },
  };
}
