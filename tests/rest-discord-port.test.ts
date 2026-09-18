import { describe, expect, test } from "bun:test";
import type { RestManager } from "discordeno";

import { createRestManagerDiscordPort } from "../src/lib/j2c/rest-discord-port.ts";

describe("coordinator Discord REST port", () => {
  test("supports the identity, permission, and panel operations used by deletion retries", async () => {
    const calls: { method: string; route: string; body?: unknown }[] = [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused test double implements the exercised RestManager routes.
    const rest = {
      routes: {
        user: (userId: string) => `/users/${userId}`,
        guilds: {
          members: {
            member: (guildId: string, userId: string) =>
              `/guilds/${guildId}/members/${userId}`,
          },
        },
        channels: {
          channel: (channelId: string) => `/channels/${channelId}`,
          overwrite: (channelId: string, overwriteId: string) =>
            `/channels/${channelId}/permissions/${overwriteId}`,
          messages: (channelId: string) => `/channels/${channelId}/messages`,
        },
      },
      async makeRequest(method: string, route: string, options?: { body?: unknown }) {
        calls.push({ method, route, ...(options?.body === undefined ? {} : { body: options.body }) });
        if (route === "/guilds/guild/members/member") {
          return {
            nick: "Guild Name",
            user: {
              id: "member",
              username: "username",
              global_name: "Global Name",
              bot: false,
            },
          };
        }
        if (route === "/users/member") {
          return { id: "member", username: "username", global_name: "Global Name", bot: false };
        }
        if (route === "/users/@me") return { id: "bot", username: "Pure" };
        if (route === "/channels/channel" && method === "GET") {
          return {
            id: "channel",
            name: "room",
            position: 4,
            permission_overwrites: [
              { id: "guild", type: 0, allow: "1", deny: "2" },
            ],
          };
        }
        if (route === "/channels/channel/messages") return { id: "message" };
        return {};
      },
    } as unknown as RestManager;
    const discord = createRestManagerDiscordPort(rest);

    const member = await discord.getGuildMember({ guildId: "guild", userId: "member" });
    expect(member).toEqual({
      kind: "found",
      value: {
        id: "member",
        bot: false,
        nick: "Guild Name",
        username: "username",
        globalName: "Global Name",
      },
    });
    expect(await discord.getUser({ userId: "member" })).toEqual({
      kind: "found",
      value: {
        id: "member",
        bot: false,
        username: "username",
        globalName: "Global Name",
      },
    });
    expect(await discord.getCurrentUser()).toEqual({
      kind: "found",
      value: { id: "bot", username: "Pure" },
    });

    const channel = await discord.getChannel({ channelId: "channel" });
    expect(channel).toEqual({
      kind: "found",
      value: {
        id: "channel",
        name: "room",
        position: 4,
        permissionOverwrites: [{ id: "guild", type: 0, allow: "1", deny: "2" }],
      },
    });
    expect(await discord.editChannelPermissionOverwrite({
      channelId: "channel",
      overwriteId: "member",
      type: 1,
      allow: "1",
      deny: "0",
      requestId: "permission-request",
    })).toEqual({ kind: "ok" });
    expect(await discord.sendChannelMessage({
      channelId: "channel",
      content: "panel",
      requestId: "panel-request",
    })).toEqual({ kind: "found", value: { id: "message" } });

    expect(calls.some((call) =>
      call.method === "PUT" && call.route === "/channels/channel/permissions/member"
    )).toBe(true);
    expect(calls.some((call) =>
      call.method === "POST" && call.route === "/channels/channel/messages"
    )).toBe(true);
  });
});
