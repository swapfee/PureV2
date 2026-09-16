import { describe, expect, test } from "bun:test";
import { BitwisePermissionFlags, ChannelTypes } from "discordeno";

import { createMemoryGuildConfigRepository } from "../src/lib/j2c/memory-repositories.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { createSetupCommandService } from "../src/lib/j2c/setup-command-service.ts";
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
    options: [],
    ...overrides,
  };
}

describe("/setup command", () => {
  test("rejects users without Manage Server", async () => {
    const { discord } = createFakeDiscord();
    const replies: string[] = [];
    discord.respondToInteraction = async (request) => {
      replies.push(request.content);
    };

    const setup = createSetupCommandService({
      configs: createMemoryGuildConfigRepository(),
      discord,
      logger: createLogger({ service: "t", role: "t", level: "error", write: () => undefined }),
    });

    await setup.execute(baseInteraction({ memberPermissions: "0" }));
    expect(replies[0]).toMatch(/Manage Server/i);
  });

  test("creates category and lobby channels then saves guild config", async () => {
    const { discord, controls } = createFakeDiscord();
    const configs = createMemoryGuildConfigRepository();
    const setup = createSetupCommandService({
      configs,
      discord,
      logger: createLogger({ service: "t", role: "t", level: "error", write: () => undefined }),
    });

    await setup.execute(
      baseInteraction({
        options: [
          { name: "category_name", type: 3, value: "Voice Rooms" },
          { name: "lobby_name", type: 3, value: "Create Channel" },
          { name: "template", type: 3, value: "{username}'s room" },
          { name: "limit", type: 4, value: 4 },
        ],
      }),
    );

    expect(controls.deferredInteractions).toEqual(["987654321098765432"]);
    expect(controls.guildChannelCreates).toHaveLength(2);
    expect(controls.guildChannelCreates[0]?.type).toBe(ChannelTypes.GuildCategory);
    expect(controls.guildChannelCreates[0]?.name).toBe("Voice Rooms");
    expect(controls.guildChannelCreates[1]?.type).toBe(ChannelTypes.GuildVoice);
    expect(controls.guildChannelCreates[1]?.name).toBe("Create Channel");

    const categoryId = controls.guildChannelCreates[0]
      ? [...controls.channels.values()].find(
          (channel) => channel.name === "Voice Rooms" && channel.type === ChannelTypes.GuildCategory,
        )?.id
      : undefined;
    const lobbyId = controls.guildChannelCreates[1]
      ? [...controls.channels.values()].find(
          (channel) => channel.name === "Create Channel" && channel.type === ChannelTypes.GuildVoice,
        )?.id
      : undefined;

    expect(categoryId).toBeDefined();
    expect(lobbyId).toBeDefined();
    expect(controls.guildChannelCreates[1]?.parentId).toBe(categoryId);

    const saved = await configs.findByGuildId("123456789012345678");
    expect(saved?.enabled).toBe(true);
    expect(saved?.lobbyChannelId).toBe(lobbyId);
    expect(saved?.categoryId).toBe(categoryId);
    expect(saved?.channelNameTemplate).toBe("{username}'s room");
    expect(saved?.defaultUserLimit).toBe(4);

    const edited = controls.editedInteractions[0]?.content ?? "";
    expect(edited).toMatch(/ready/i);
  });

  test("compensates when lobby channel creation fails", async () => {
    const { discord, controls } = createFakeDiscord();
    let createCount = 0;
    const originalCreate = discord.createGuildChannel.bind(discord);
    discord.createGuildChannel = async (request) => {
      createCount += 1;
      if (createCount === 1) {
        return originalCreate(request);
      }
      return { kind: "forbidden" };
    };

    const setup = createSetupCommandService({
      configs: createMemoryGuildConfigRepository(),
      discord,
      logger: createLogger({ service: "t", role: "t", level: "error", write: () => undefined }),
    });

    await setup.execute(baseInteraction());

    expect(controls.deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(controls.editedInteractions[0]?.content).toMatch(/join-to-create voice channel/i);
  });
});
