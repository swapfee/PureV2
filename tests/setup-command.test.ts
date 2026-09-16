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
    id: "1",
    token: "token",
    type: 2,
    applicationId: "100",
    guildId: "123456789012345678",
    userId: "223456789012345678",
    memberPermissions: String(BitwisePermissionFlags.MANAGE_GUILD),
    commandName: "setup",
    options: [
      { name: "lobby", type: 7, value: "333456789012345678" },
      { name: "category", type: 7, value: "443456789012345678" },
    ],
    ...overrides,
  };
}

describe("/setup command", () => {
  test("rejects users without Manage Server", async () => {
    const { discord, controls } = createFakeDiscord();
    const replies: string[] = [];
    discord.respondToInteraction = async (request) => {
      replies.push(request.content);
    };
    controls.channels.set("333456789012345678", {
      id: "333456789012345678",
      name: "Lobby",
      type: ChannelTypes.GuildVoice,
      guildId: "123456789012345678",
      permissionOverwrites: [],
    });
    controls.channels.set("443456789012345678", {
      id: "443456789012345678",
      name: "Temp",
      type: ChannelTypes.GuildCategory,
      guildId: "123456789012345678",
      permissionOverwrites: [],
    });

    const setup = createSetupCommandService({
      configs: createMemoryGuildConfigRepository(),
      discord,
      logger: createLogger({ service: "t", role: "t", level: "error", write: () => undefined }),
    });

    await setup.execute(baseInteraction({ memberPermissions: "0" }));
    expect(replies[0]).toMatch(/Manage Server/i);
  });

  test("upserts guild config for an authorized admin", async () => {
    const { discord, controls } = createFakeDiscord();
    const replies: string[] = [];
    discord.respondToInteraction = async (request) => {
      replies.push(request.content);
    };
    controls.channels.set("333456789012345678", {
      id: "333456789012345678",
      name: "Lobby",
      type: ChannelTypes.GuildVoice,
      guildId: "123456789012345678",
      permissionOverwrites: [],
    });
    controls.channels.set("443456789012345678", {
      id: "443456789012345678",
      name: "Temp",
      type: ChannelTypes.GuildCategory,
      guildId: "123456789012345678",
      permissionOverwrites: [],
    });

    const configs = createMemoryGuildConfigRepository();
    const setup = createSetupCommandService({
      configs,
      discord,
      logger: createLogger({ service: "t", role: "t", level: "error", write: () => undefined }),
    });

    await setup.execute(
      baseInteraction({
        options: [
          { name: "lobby", type: 7, value: "333456789012345678" },
          { name: "category", type: 7, value: "443456789012345678" },
          { name: "template", type: 3, value: "{username}'s room" },
          { name: "limit", type: 4, value: 4 },
        ],
      }),
    );

    const saved = await configs.findByGuildId("123456789012345678");
    expect(saved?.enabled).toBe(true);
    expect(saved?.lobbyChannelId).toBe("333456789012345678");
    expect(saved?.categoryId).toBe("443456789012345678");
    expect(saved?.channelNameTemplate).toBe("{username}'s room");
    expect(saved?.defaultUserLimit).toBe(4);
    expect(replies[0]).toMatch(/configured/i);
  });

  test("rejects non-voice lobby channels", async () => {
    const { discord, controls } = createFakeDiscord();
    const replies: string[] = [];
    discord.respondToInteraction = async (request) => {
      replies.push(request.content);
    };
    controls.channels.set("333456789012345678", {
      id: "333456789012345678",
      name: "not-voice",
      type: ChannelTypes.GuildText,
      guildId: "123456789012345678",
      permissionOverwrites: [],
    });
    controls.channels.set("443456789012345678", {
      id: "443456789012345678",
      name: "Temp",
      type: ChannelTypes.GuildCategory,
      guildId: "123456789012345678",
      permissionOverwrites: [],
    });

    const setup = createSetupCommandService({
      configs: createMemoryGuildConfigRepository(),
      discord,
      logger: createLogger({ service: "t", role: "t", level: "error", write: () => undefined }),
    });

    await setup.execute(baseInteraction());
    expect(replies[0]).toMatch(/voice channel/i);
  });
});
