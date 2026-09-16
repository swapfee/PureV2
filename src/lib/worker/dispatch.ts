import type { CommandRegistry, EventContext, EventRegistry, InteractionDispatcher } from "../../handlers/types.ts";
import type { CooldownStore } from "../../handlers/cooldowns.ts";
import type { Logger } from "../logger.ts";
import type {
  DiscordApiPort,
  InteractionCreatePayload,
  InteractionOption,
  ReadyPayload,
  VoiceStateUpdatePayload,
} from "../runtime-types.ts";
import type { WorkerBot } from "./bot.ts";

function bigintToSnowflake(value: bigint | undefined): string | undefined {
  return value === undefined ? undefined : value.toString();
}

function mapInteractionOption(option: {
  readonly name: string;
  readonly type: number;
  readonly value?: string | number | boolean;
  readonly options?: readonly {
    readonly name: string;
    readonly type: number;
    readonly value?: string | number | boolean;
    readonly options?: readonly {
      readonly name: string;
      readonly type: number;
      readonly value?: string | number | boolean;
    }[];
  }[];
}): InteractionOption {
  const mapped: InteractionOption = {
    name: option.name,
    type: option.type,
  };
  const withValue = option.value === undefined ? mapped : { ...mapped, value: option.value };
  if (!option.options) return withValue;
  return {
    ...withValue,
    options: option.options.map((nested) => mapInteractionOption(nested)),
  };
}

export function createInteractionDispatcher(
  commands: CommandRegistry,
  cooldowns: CooldownStore,
  workerId: number,
  logger: Logger,
  discord: DiscordApiPort,
  services?: {
    readonly vc?: { execute(interaction: InteractionCreatePayload): Promise<void> };
    readonly setup?: { execute(interaction: InteractionCreatePayload): Promise<void> };
  },
): InteractionDispatcher {
  return {
    async dispatch(interaction: InteractionCreatePayload): Promise<void> {
      if (!interaction.commandName) return;
      const command = commands.get(interaction.commandName);
      if (!command) {
        logger.warn("Unknown command", { commandName: interaction.commandName });
        return;
      }

      if (command.cooldownMs !== undefined) {
        const key = `${interaction.commandName}:${interaction.userId}`;
        const decision = cooldowns.check(key, command.cooldownMs);
        if (!decision.allowed) {
          await discord.respondToInteraction({
            interactionId: interaction.id,
            interactionToken: interaction.token,
            content: `Please wait ${Math.ceil(decision.remainingMs / 1000)}s before using this command again.`,
            ephemeral: true,
          });
          return;
        }
      }

      await command.execute(
        {
          workerId,
          logger,
          discord,
          ...(services?.vc ? { vc: services.vc } : {}),
          ...(services?.setup ? { setup: services.setup } : {}),
        },
        interaction,
      );
    },
  };
}

export function wireBotEvents(
  bot: WorkerBot,
  events: EventRegistry,
  context: EventContext,
): void {
  bot.events.ready = async (payload) => {
    const event = events.get("ready");
    if (!event) return;
    const readyPayload: ReadyPayload = {
      shardId: payload.shardId,
      applicationId: payload.applicationId.toString(),
      guildIds: payload.guilds.map((guildId) => guildId.toString()),
    };
    await event.execute(context, readyPayload);
  };

  bot.events.interactionCreate = async (interaction) => {
    const event = events.get("interactionCreate");
    if (!event) return;

    const userId = interaction.user?.id ?? interaction.member?.id;
    if (userId === undefined) {
      context.logger.warn("interactionCreate missing user id");
      return;
    }

    const options: InteractionOption[] | undefined = interaction.data?.options?.map((option) =>
      mapInteractionOption(option),
    );

    const memberPermissionsRaw = Reflect.get(interaction.member ?? {}, "permissions");
    const memberPermissions =
      typeof memberPermissionsRaw === "bigint" ||
      typeof memberPermissionsRaw === "number" ||
      typeof memberPermissionsRaw === "string"
        ? String(memberPermissionsRaw)
        : undefined;

    const payload: InteractionCreatePayload = {
      id: interaction.id.toString(),
      token: interaction.token,
      type: interaction.type,
      applicationId: interaction.applicationId.toString(),
      userId: userId.toString(),
      ...(interaction.guildId === undefined ? {} : { guildId: interaction.guildId.toString() }),
      ...(interaction.channelId === undefined ? {} : { channelId: interaction.channelId.toString() }),
      ...(interaction.data?.name === undefined ? {} : { commandName: interaction.data.name }),
      ...(options === undefined ? {} : { options }),
      ...(memberPermissions === undefined ? {} : { memberPermissions }),
    };

    await event.execute(context, payload);
  };

  bot.events.voiceStateUpdate = async (voiceState) => {
    const event = events.get("voiceStateUpdate");
    if (!event) return;
    const member = Reflect.get(voiceState, "member");
    const memberUser =
      typeof member === "object" && member !== null ? Reflect.get(member, "user") : undefined;
    const isBot =
      typeof memberUser === "object" &&
      memberUser !== null &&
      Reflect.get(memberUser, "bot") === true;
    const payload: VoiceStateUpdatePayload = {
      guildId: voiceState.guildId.toString(),
      userId: voiceState.userId.toString(),
      channelId: voiceState.channelId === undefined ? null : voiceState.channelId.toString(),
      ...(isBot ? { isBot: true } : {}),
    };
    await event.execute(context, payload);
  };

  bot.events.guildCreate = (guild) => {
    if (!context.j2c) return;
    const guildId = guild.id.toString();
    const voiceStatesRaw = Reflect.get(guild, "voiceStates");
    const seeded: { userId: string; channelId: string | null }[] = [];
    if (voiceStatesRaw && typeof voiceStatesRaw === "object") {
      const values =
        typeof Reflect.get(voiceStatesRaw, "values") === "function"
          ? [...(voiceStatesRaw as Map<unknown, { userId?: bigint; channelId?: bigint }>).values()]
          : Array.isArray(voiceStatesRaw)
            ? voiceStatesRaw
            : [];
      for (const state of values) {
        if (typeof state !== "object" || state === null) continue;
        const userId = Reflect.get(state, "userId");
        const channelId = Reflect.get(state, "channelId");
        if (userId === undefined) continue;
        seeded.push({
          userId: String(userId),
          channelId: channelId === undefined || channelId === null ? null : String(channelId),
        });
      }
    }
    context.j2c.occupancy.seedGuildVoiceStates(guildId, seeded);
    context.j2c.occupancy.markReady();
  };
}

export { bigintToSnowflake };
