import { describe, expect, test } from "bun:test";
import { BitwisePermissionFlags, ChannelTypes } from "discordeno";

import {
  createMemoryCreationReservationRepository,
  createMemoryGuildConfigRepository,
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { createSetupCommandService } from "../src/lib/j2c/setup-command-service.ts";
import { createVoiceOccupancyTracker } from "../src/lib/j2c/voice-occupancy.ts";
import { DEFAULT_SETUP_CATEGORY_NAME } from "../src/lib/j2c/setup-channel-names.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { InteractionCreatePayload } from "../src/lib/runtime-types.ts";

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

function createSetupDeps() {
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
  test("rejects users without Manage Server", async () => {
    const { setup, discord } = createSetupDeps();
    const replies: string[] = [];
    discord.respondToInteraction = async (request) => {
      replies.push(request.embeds?.[0]?.description ?? request.content ?? "");
    };

    await setup.execute(baseInteraction({ memberPermissions: "0" }));
    expect(replies[0]).toMatch(/Error setting Join to Create System/i);
    expect(replies[0]).toMatch(/Lack of permission on client or user side/i);
  });

  test("creates category and lobby channels then saves guild config", async () => {
    const { setup, controls, configs } = createSetupDeps();

    await setup.execute(
      baseInteraction({
        options: [
          {
            name: "create",
            type: 1,
            options: [
              { name: "category_name", type: 3, value: "Voice Rooms" },
              { name: "lobby_name", type: 3, value: "Create Channel" },
              { name: "template", type: 3, value: "{username}'s room" },
              { name: "limit", type: 4, value: 4 },
            ],
          },
        ],
      }),
    );

    expect(controls.deferredInteractions).toEqual(["987654321098765432"]);
    expect(controls.guildChannelCreates).toHaveLength(2);
    expect(controls.guildChannelCreates[0]?.type).toBe(ChannelTypes.GuildCategory);
    expect(controls.guildChannelCreates[0]?.name).toBe("Voice Rooms");
    expect(controls.guildChannelCreates[1]?.type).toBe(ChannelTypes.GuildVoice);
    expect(controls.guildChannelCreates[1]?.name).toBe("Create Channel");

    const categoryId = [...controls.channels.values()].find(
      (channel) => channel.name === "Voice Rooms" && channel.type === ChannelTypes.GuildCategory,
    )?.id;
    const lobbyId = [...controls.channels.values()].find(
      (channel) => channel.name === "Create Channel" && channel.type === ChannelTypes.GuildVoice,
    )?.id;

    expect(categoryId).toBeDefined();
    expect(lobbyId).toBeDefined();
    expect(controls.guildChannelCreates[1]?.parentId).toBe(categoryId);

    const saved = await configs.findByGuildId("123456789012345678");
    expect(saved?.enabled).toBe(true);
    expect(saved?.lobbyChannelId).toBe(lobbyId);
    expect(saved?.categoryId).toBe(categoryId);
    expect(saved?.channelNameTemplate).toBe("{username}'s room");
    expect(saved?.defaultUserLimit).toBe(4);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Setup Complete/i);
    expect(lastEmbedDescription(controls.editedInteractions)).toContain(
      "<:success:1543407529302949908>",
    );
  });

  test("defaults category name to Temporary Voice Channel", async () => {
    const { setup, controls } = createSetupDeps();
    await setup.execute(baseInteraction());
    expect(controls.guildChannelCreates[0]?.name).toBe(DEFAULT_SETUP_CATEGORY_NAME);
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
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /Error setting Join to Create System/i,
    );
    expect(lastEmbedDescription(controls.editedInteractions)).toContain(
      "<:error:1543407530380624037>",
    );
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /Lack of permission on client or user side/i,
    );
  });

  test("rejects create when Join to Create System already exists", async () => {
    const { setup, controls } = createSetupDeps();
    await setup.execute(baseInteraction());
    await setup.execute(
      baseInteraction({
        id: "987654321098765433",
        options: [{ name: "create", type: 1, options: [] }],
      }),
    );

    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /Error setting Join to Create System/i,
    );
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(
      /Join to Create System already exists/i,
    );
    expect(controls.guildChannelCreates).toHaveLength(2);
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
        options: [{ name: "reset", type: 1, options: [] }],
      }),
    );

    expect(await configs.findByGuildId("123456789012345678")).toBeUndefined();
    expect(await channels.findByChannelId(emptyId)).toBeUndefined();
    expect(await channels.findByChannelId(occupiedId)).toBeDefined();
    expect(controls.channels.has(config!.lobbyChannelId)).toBe(false);
    expect(controls.channels.has(emptyId)).toBe(false);
    expect(controls.channels.has(occupiedId)).toBe(true);
    expect(controls.channels.has(config!.categoryId)).toBe(true);
    expect(controls.editCalls.some((call) => call.channelId === config!.categoryId)).toBe(true);
    expect(lastEmbedDescription(controls.editedInteractions)).toMatch(/Factory Reset Complete/i);
    expect(lastEmbedDescription(controls.editedInteractions)).toContain(
      "<:success:1543407529302949908>",
    );
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
        options: [{ name: "reset", type: 1, options: [] }],
      }),
    );

    expect(controls.channels.has(config!.categoryId)).toBe(false);
    expect(controls.channels.has(emptyId)).toBe(false);
    expect(await configs.findByGuildId("123456789012345678")).toBeUndefined();
  });
});
