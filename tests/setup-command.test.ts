import { describe, expect, test } from "bun:test";
import { BitwisePermissionFlags, ChannelTypes, type CreateApplicationCommand } from "discordeno";

import {
  createMemoryCreationReservationRepository,
  createMemoryGuildConfigRepository,
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { createSetupCommandService } from "../src/lib/j2c/setup-command-service.ts";
import { createVoiceOccupancyTracker } from "../src/lib/j2c/voice-occupancy.ts";
import {
  DEFAULT_SETUP_CATEGORY_NAME,
  DEFAULT_SETUP_INTERFACE_NAME,
  DEFAULT_SETUP_LOBBY_NAME,
} from "../src/lib/j2c/setup-channel-names.ts";
import { GLOBAL_VOICE_PANEL_PREFIX, IS_COMPONENTS_V2 } from "../src/lib/j2c/voice-panel.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { InteractionCreatePayload } from "../src/lib/runtime-types.ts";
import resetCommand from "../src/commands/reset.command.ts";

function baseInteraction(
  overrides: Partial<InteractionCreatePayload> = {},
): InteractionCreatePayload {
  return {
    id: "987654321098765432",
    token: "token",
    type: 2,
    applicationId: "111111111111111111",
    guildId: "123456789012345678",
    userId: "223456789012345678",
    memberPermissions: String(BitwisePermissionFlags.MANAGE_GUILD),
    commandName: "setup",
    options: [{ name: "create", type: 1, options: [] }],
    ...overrides,
  };
}

function createSetupDeps(stats?: {
  stopGuildTracking(guildId: string, eventId: string): Promise<void>;
  purgeGuild(guildId: string): Promise<unknown>;
}) {
  const { discord, controls } = createFakeDiscord();
  const configs = createMemoryGuildConfigRepository();
  const channels = createMemoryTemporaryChannelRepository();
  const reservations = createMemoryCreationReservationRepository();
  const occupancy = createVoiceOccupancyTracker();
  occupancy.markReady();
  const setup = createSetupCommandService({
    configs,
    channels,
    reservations,
    occupancy,
    discord,
    logger: createLogger({ service: "t", role: "t", level: "error", write: () => undefined }),
    ...(stats ? { stats } : {}),
  });
  return { discord, controls, configs, channels, reservations, occupancy, setup };
}

function lastEmbedDescription(
  edited: { embeds?: readonly { description: string }[]; content?: string }[],
): string {
  const last = edited.at(-1);
  return last?.embeds?.[0]?.description ?? last?.content ?? "";
}

describe("/setup command", () => {
  test("/reset exposes an optional stat boolean that defaults to preserving statistics", () => {
    const commandData = resetCommand.data as CreateApplicationCommand & {
      readonly options?: readonly {
        readonly name: string;
        readonly type: number;
        readonly required?: boolean;
      }[];
    };
    expect(commandData.options).toEqual([
      expect.objectContaining({ name: "stat", type: 5, required: false }),
    ]);
  });

  test("rejects users without Manage Server", async () => {
    const { setup, discord } = createSetupDeps();
    const replies: string[] = [];
    discord.respondToInteraction = async (request) => {
      replies.push(request.embeds?.[0]?.description ?? request.content ?? "");
    };

    await setup.execute(baseInteraction({ memberPermissions: "0" }));
    expect(replies[0]).toMatch(/Insufficient permissions to complete this action/i);
    expect(replies[0]).toContain("<:error:1543407530380624037>");
  });

  test("/setup create creates category, lobby, and private error-log channel", async () => {
    const { setup, controls, configs } = createSetupDeps();
    controls.currentUser = { id: "111111111111111111", username: "PureV2" };

    await setup.execute(baseInteraction());

    expect(controls.deferredInteractions).toHaveLength(0);
    expect(controls.responses[0]?.embeds?.[0]?.description).toBe(
      "<a:iconloading:1552886322589470781> <@223456789012345678>: Creating Join to Create...",
    );
    expect(controls.guildChannelCreates).toHaveLength(3);
    expect(controls.guildChannelCreates[0]?.type).toBe(ChannelTypes.GuildCategory);
    expect(controls.guildChannelCreates[0]?.name).toBe(DEFAULT_SETUP_CATEGORY_NAME);
    expect(controls.guildChannelCreates[1]?.type).toBe(ChannelTypes.GuildVoice);
    expect(controls.guildChannelCreates[1]?.name).toBe(DEFAULT_SETUP_LOBBY_NAME);
    expect(controls.guildChannelCreates[2]?.type).toBe(ChannelTypes.GuildText);
    expect(controls.guildChannelCreates[2]?.name).toBe("error-logs");

    const categoryId = [...controls.channels.values()].find(
      (channel) =>
        channel.name === DEFAULT_SETUP_CATEGORY_NAME && channel.type === ChannelTypes.GuildCategory,
    )?.id;
    const lobbyId = [...controls.channels.values()].find(
      (channel) =>
        channel.name === DEFAULT_SETUP_LOBBY_NAME && channel.type === ChannelTypes.GuildVoice,
    )?.id;

    expect(categoryId).toBeDefined();
    expect(lobbyId).toBeDefined();
    expect(controls.guildChannelCreates[1]?.parentId).toBe(categoryId);
    expect(controls.guildChannelCreates[2]?.parentId).toBe(categoryId);

    const saved = await configs.findByGuildId("123456789012345678");
    expect(saved?.enabled).toBe(true);
    expect(saved?.lobbyChannelId).toBe(lobbyId);
    expect(saved?.categoryId).toBe(categoryId);
    expect(saved?.errorLogChannelId).toBeDefined();
    expect(saved?.channelNameTemplate).toBe("{username}'s channel");
    expect(saved?.ownerCanEdit).toBe(false);
    expect(saved?.permissionSource).toBe("category");
    expect(saved?.namingMode).toBe("template");
    expect(saved?.channelHoist).toBe("bottom");
    expect(controls.overwriteCalls.some((call) => call.overwriteId === "123456789012345678")).toBe(
      true,
    );
    expect(controls.channelMessages).toHaveLength(0);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Setup Complete/i);
  });

  test("/setup with no subcommand options still creates", async () => {
    const { setup, configs, controls } = createSetupDeps();
    await setup.execute(baseInteraction({ options: [] }));
    expect(await configs.findByGuildId("123456789012345678")).toBeDefined();
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Setup Complete/i);
  });

  test("/setup config updates settings with username template naming", async () => {
    const { setup, configs, controls } = createSetupDeps();
    await setup.execute(baseInteraction());
    const saved = await configs.findByGuildId("123456789012345678");
    expect(saved).toBeDefined();

    await setup.execute(
      baseInteraction({
        id: "987654321098765433",
        options: [
          {
            name: "config",
            type: 1,
            options: [
              { name: "editable", type: 5, value: true },
              { name: "name", type: 3, value: "{username}'s room" },
              { name: "limit", type: 4, value: 8 },
              { name: "permission", type: 3, value: "lobby" },
              { name: "hoist", type: 3, value: "top" },
            ],
          },
        ],
      }),
    );

    const updated = await configs.findByGuildId("123456789012345678");
    expect(updated?.ownerCanEdit).toBe(true);
    expect(updated?.namingMode).toBe("template");
    expect(updated?.channelNameTemplate).toBe("{username}'s room");
    expect(updated?.defaultUserLimit).toBe(8);
    expect(updated?.permissionSource).toBe("lobby");
    expect(updated?.channelHoist).toBe("top");
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Setup Updated/i);
  });

  test("/setup config category only updates temp VC category without moving lobby", async () => {
    const { setup, configs, controls } = createSetupDeps();
    await setup.execute(baseInteraction());
    const saved = await configs.findByGuildId("123456789012345678");
    expect(saved).toBeDefined();

    const otherCategoryId = "888888888888888888";
    controls.channels.set(otherCategoryId, {
      id: otherCategoryId,
      name: "Other category",
      type: ChannelTypes.GuildCategory,
      guildId: "123456789012345678",
      permissionOverwrites: [],
    });

    await setup.execute(
      baseInteraction({
        id: "987654321098765435",
        options: [
          {
            name: "config",
            type: 1,
            options: [
              { name: "category", type: 7, value: otherCategoryId },
            ],
          },
        ],
      }),
    );

    const updated = await configs.findByGuildId("123456789012345678");
    expect(updated?.categoryId).toBe(otherCategoryId);
    expect(controls.editCalls.some((call) => call.channelId === saved!.lobbyChannelId)).toBe(false);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Setup Updated/i);
  });

  test("/setup config rejects when Join to Create is not configured", async () => {
    const { setup, controls } = createSetupDeps();

    await setup.execute(
      baseInteraction({
        id: "987654321098765434",
        options: [
          {
            name: "config",
            type: 1,
            options: [{ name: "editable", type: 5, value: true }],
          },
        ],
      }),
    );

    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /not configured in this server/i,
    );
  });

  test("/setup interface enables and disables a shared global voice panel", async () => {
    const { setup, controls, configs } = createSetupDeps();
    controls.currentUser = { id: "111111111111111111", username: "Pure" };
    await setup.execute(baseInteraction());

    await setup.execute(
      baseInteraction({
        id: "987654321098765440",
        options: [
          {
            name: "interface",
            type: 1,
            options: [{ name: "enabled", type: 5, value: true }],
          },
        ],
      }),
    );

    const enabled = await configs.findByGuildId("123456789012345678");
    expect(enabled?.interfaceChannelId).toBeDefined();
    const create = controls.guildChannelCreates.at(-1);
    expect(create?.name).toBe(DEFAULT_SETUP_INTERFACE_NAME);
    expect(create?.type).toBe(ChannelTypes.GuildText);
    expect(create?.parentId).toBe(enabled?.categoryId);
    const panel = controls.channelMessages.at(-1);
    expect(panel?.channelId).toBe(enabled?.interfaceChannelId);
    expect(panel?.flags).toBe(IS_COMPONENTS_V2);
    expect(JSON.stringify(panel?.components)).toContain(`${GLOBAL_VOICE_PANEL_PREFIX}:lock`);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Voice Interface Enabled/i);

    await setup.execute(
      baseInteraction({
        id: "987654321098765441",
        options: [
          {
            name: "interface",
            type: 1,
            options: [{ name: "enabled", type: 5, value: false }],
          },
        ],
      }),
    );

    const disabled = await configs.findByGuildId("123456789012345678");
    expect(disabled?.interfaceChannelId).toBeUndefined();
    expect(controls.channels.has(enabled!.interfaceChannelId!)).toBe(false);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Voice Interface Disabled/i);
  });

  test("compensates when lobby channel creation fails", async () => {
    const { setup, discord, controls } = createSetupDeps();
    let createCount = 0;
    const originalCreate = discord.createGuildChannel.bind(discord);
    discord.createGuildChannel = async (request) => {
      createCount += 1;
      if (createCount === 1) {
        return originalCreate(request);
      }
      return { kind: "forbidden" };
    };

    await setup.execute(baseInteraction());

    expect(controls.deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(lastEmbedDescription(controls.editedInteractions)).toContain(
      "<:error:1543407530380624037>",
    );
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /Insufficient permissions to complete this action/i,
    );
  });

  test("rejects create when Join to Create System already exists", async () => {
    const { setup, controls, configs } = createSetupDeps();
    await setup.execute(baseInteraction());
    const first = await configs.findByGuildId("123456789012345678");
    expect(first).toBeDefined();

    await setup.execute(
      baseInteraction({
        id: "987654321098765433",
        options: [{ name: "create", type: 1, options: [] }],
      }),
    );

    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /already has a Join to Create system/i,
    );
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/\/setup config/i);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/\/reset/i);
    expect(controls.guildChannelCreates).toHaveLength(3);
    const stillFirst = await configs.findByGuildId("123456789012345678");
    expect(stillFirst?.lobbyChannelId).toBe(first!.lobbyChannelId);
    expect(stillFirst?.categoryId).toBe(first!.categoryId);
  });

  test("factory reset deletes empty channels and config but keeps occupied rooms and category", async () => {
    const { setup, configs, channels, occupancy, controls, discord } = createSetupDeps();

    await setup.execute(baseInteraction());
    const config = await configs.findByGuildId("123456789012345678");
    expect(config).toBeDefined();

    const emptyId = "555555555555555555";
    const occupiedId = "666666666666666666";
    controls.channels.set(emptyId, {
      id: emptyId,
      name: "Empty room",
      type: ChannelTypes.GuildVoice,
      guildId: "123456789012345678",
      parentId: config!.categoryId,
      permissionOverwrites: [],
    });
    controls.channels.set(occupiedId, {
      id: occupiedId,
      name: "Busy room",
      type: ChannelTypes.GuildVoice,
      guildId: "123456789012345678",
      parentId: config!.categoryId,
      permissionOverwrites: [],
    });

    await channels.create({
      guildId: "123456789012345678",
      channelId: emptyId,
      ownerId: "223456789012345678",
      lobbyChannelId: config!.lobbyChannelId,
      status: "active",
      reservationId: "r1",
      creationRequestId: "c1",
      occupantIds: [],
    });
    await channels.create({
      guildId: "123456789012345678",
      channelId: occupiedId,
      ownerId: "333456789012345678",
      lobbyChannelId: config!.lobbyChannelId,
      status: "active",
      reservationId: "r2",
      creationRequestId: "c2",
      occupantIds: ["333456789012345678"],
    });
    occupancy.apply({
      guildId: "123456789012345678",
      userId: "333456789012345678",
      channelId: occupiedId,
      sequence: 1,
    });

    await setup.execute(
      baseInteraction({
        commandName: "reset",
        options: [{ name: "stat", type: 5, value: false }],
      }),
    );

    expect(await configs.findByGuildId("123456789012345678")).toBeUndefined();
    expect(await channels.findByChannelId(emptyId)).toBeUndefined();
    expect((await channels.findByChannelId(occupiedId))?.cleanupCategoryId).toBe(
      config!.categoryId,
    );
    expect(controls.channels.has(config!.lobbyChannelId)).toBe(false);
    expect(controls.channels.has(emptyId)).toBe(false);
    expect(controls.channels.has(occupiedId)).toBe(true);
    expect(controls.channels.has(config!.categoryId)).toBe(true);
    expect(controls.editCalls.some((call) => call.channelId === config!.categoryId)).toBe(true);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Factory Reset Complete/i);
    expect(discord).toBeDefined();
  });

  test("factory reset deletes category when no occupied temporary channels remain", async () => {
    const { setup, configs, channels, controls } = createSetupDeps();
    await setup.execute(baseInteraction());
    const config = await configs.findByGuildId("123456789012345678");
    expect(config).toBeDefined();

    const emptyId = "777777777777777777";
    controls.channels.set(emptyId, {
      id: emptyId,
      name: "Gone soon",
      type: ChannelTypes.GuildVoice,
      guildId: "123456789012345678",
      parentId: config!.categoryId,
      permissionOverwrites: [],
    });
    await channels.create({
      guildId: "123456789012345678",
      channelId: emptyId,
      ownerId: "223456789012345678",
      lobbyChannelId: config!.lobbyChannelId,
      status: "active",
      reservationId: "r3",
      creationRequestId: "c3",
      occupantIds: [],
    });

    await setup.execute(
      baseInteraction({
        commandName: "reset",
        options: [],
      }),
    );

    expect(await configs.findByGuildId("123456789012345678")).toBeUndefined();
    expect(controls.channels.has(config!.categoryId)).toBe(false);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Factory Reset Complete/i);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/statistics were preserved/i);
  });

  test("factory reset deletes guild statistics only when stat is true", async () => {
    const purgedGuilds: string[] = [];
    const { setup, controls } = createSetupDeps({
      async stopGuildTracking() {},
      async purgeGuild(guildId) { purgedGuilds.push(guildId); },
    });
    await setup.execute(baseInteraction());

    await setup.execute(
      baseInteraction({
        commandName: "reset",
        options: [{ name: "stat", type: 5, value: true }],
      }),
    );

    expect(purgedGuilds).toEqual(["123456789012345678"]);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /voice statistics were permanently deleted/i,
    );
  });

  test("factory reset reports a partial failure when statistics cannot be deleted", async () => {
    const { setup, controls } = createSetupDeps({
      async stopGuildTracking() {},
      async purgeGuild() { throw new Error("database unavailable"); },
    });
    await setup.execute(baseInteraction());

    await setup.execute(
      baseInteraction({
        commandName: "reset",
        options: [{ name: "stat", type: 5, value: true }],
      }),
    );

    expect(lastEmbedDescription(controls.editedInteractions)).toContain(
      "<:error:1543407530380624037>",
    );
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /was reset, but voice statistics could not be deleted/i,
    );
  });

  test("reset rejects when Join to Create is not configured", async () => {
    const { setup, controls } = createSetupDeps();

    await setup.execute(
      baseInteraction({
        commandName: "reset",
        options: [],
      }),
    );

    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /not configured in this server/i,
    );
  });

  test("stat true can retry a statistics purge after Join to Create was already reset", async () => {
    const purgedGuilds: string[] = [];
    const { setup, controls } = createSetupDeps({
      async stopGuildTracking() {},
      async purgeGuild(guildId) { purgedGuilds.push(guildId); },
    });

    await setup.execute(
      baseInteraction({
        commandName: "reset",
        options: [{ name: "stat", type: 5, value: true }],
      }),
    );

    expect(purgedGuilds).toEqual(["123456789012345678"]);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /Voice Statistics Reset Complete/i,
    );
  });
});

describe("channel name templates", () => {
  test("renderChannelName substitutes username and display-name aliases", async () => {
    const { renderChannelName } = await import("../src/lib/j2c/channel-name.ts");
    expect(renderChannelName("{username}'s channel", "Alice")).toBe("Alice's channel");
    expect(renderChannelName("{displayname}'s room", "Bob")).toBe("Bob's room");
    expect(renderChannelName("{display_name} VC", "Carol")).toBe("Carol VC");
    expect(renderChannelName("{displayUsername} lounge", "Dan")).toBe("Dan lounge");
    expect(renderChannelName("{user.username}'s place", "Eve")).toBe("Eve's place");
  });

  test("renderSequentialChannelName appends the number", async () => {
    const { renderSequentialChannelName } = await import("../src/lib/j2c/channel-name.ts");
    expect(renderSequentialChannelName("Gaming", 1)).toBe("Gaming 1");
    expect(renderSequentialChannelName("Gaming", 12)).toBe("Gaming 12");
  });

  test("allocateSequenceNumber gap-fills the lowest free number", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    await channels.create({
      guildId: "123456789012345678",
      channelId: "111111111111111111",
      ownerId: "aaaaaaaaaaaaaaaaaa",
      lobbyChannelId: "223456789012345678",
      status: "active",
      reservationId: "r1",
      creationRequestId: "c1",
      sequenceNumber: 1,
    });
    await channels.create({
      guildId: "123456789012345678",
      channelId: "222222222222222222",
      ownerId: "bbbbbbbbbbbbbbbbbb",
      lobbyChannelId: "223456789012345678",
      status: "active",
      reservationId: "r2",
      creationRequestId: "c2",
      sequenceNumber: 3,
    });

    expect(await channels.allocateSequenceNumber("123456789012345678")).toBe(2);

    await channels.create({
      guildId: "123456789012345678",
      channelId: "333333333333333333",
      ownerId: "cccccccccccccccccc",
      lobbyChannelId: "223456789012345678",
      status: "active",
      reservationId: "r3",
      creationRequestId: "c3",
      sequenceNumber: 2,
    });
    expect(await channels.allocateSequenceNumber("123456789012345678")).toBe(4);

    await channels.remove("222222222222222222");
    expect(await channels.allocateSequenceNumber("123456789012345678")).toBe(3);
  });
});
