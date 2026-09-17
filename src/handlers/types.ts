import type { CreateApplicationCommand } from "discordeno";

import type { Logger } from "../lib/logger.ts";
import type {
  DiscordApiPort,
  InteractionCreatePayload,
  RuntimeEventMap,
  RuntimeEventName,
} from "../lib/runtime-types.ts";

export interface CommandContext {
  readonly workerId: number;
  readonly logger: Logger;
  readonly discord: DiscordApiPort;
  readonly vc?: {
    execute(interaction: InteractionCreatePayload): Promise<void>;
  };
  readonly setup?: {
    execute(interaction: InteractionCreatePayload): Promise<void>;
    autocomplete?(interaction: InteractionCreatePayload): Promise<void>;
  };
}

export interface CommandModule {
  readonly data: CreateApplicationCommand;
  readonly cooldownMs?: number;
  execute(context: CommandContext, interaction: InteractionCreatePayload): Promise<void>;
}

export interface InteractionDispatcher {
  dispatch(interaction: InteractionCreatePayload): Promise<void>;
}

export interface J2cEventServices {
  readonly voice: {
    handle(payload: RuntimeEventMap["voiceStateUpdate"], eventId: string): Promise<void>;
  };
  readonly occupancy: {
    seedGuildVoiceStates(
      guildId: string,
      states: readonly { readonly userId: string; readonly channelId: string | null }[],
    ): void;
    markReady(): void;
    isReady(): boolean;
  };
  /**
   * After GUILD_CREATE seeds voice states, schedule empty-temp-channel deletion
   * without waiting for a subsequent leave event.
   */
  scheduleEmptyChannelDeletions(guildId: string): Promise<void>;
  /** Delayed second sweep for leaves during the restart seed window. */
  scheduleEmptyChannelDeletionResweep(guildId: string): void;
}

export interface EventContext {
  readonly workerId: number;
  readonly logger: Logger;
  readonly commands: InteractionDispatcher;
  readonly discord: DiscordApiPort;
  readonly j2c?: J2cEventServices;
  /** Set by the worker for the gateway event currently being processed. */
  currentEventId?: string;
}

export interface EventModule<Name extends RuntimeEventName = RuntimeEventName> {
  readonly name: Name;
  execute(context: EventContext, payload: RuntimeEventMap[Name]): Promise<void>;
}

export type CommandRegistry = ReadonlyMap<string, CommandModule>;
export type EventRegistry = ReadonlyMap<RuntimeEventName, EventModule>;
