import { afterEach, describe, expect, test } from "bun:test";

import { createDashboardControlApi, type DashboardControlApi } from "../src/lib/coordinator/dashboard-api.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import {
  createMemoryGuildConfigRepository,
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import type { Logger } from "../src/lib/logger.ts";

const guildId = "1539918723396407357";
const lobbyChannelId = "1539918723396407358";
const categoryId = "1539918723396407359";
const temporaryChannelId = "1539918723396407360";
const authorization = "dashboard-test-authorization-secret";

const logger: Logger = {
  debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fixture(ready = true) {
  const configs = createMemoryGuildConfigRepository();
  const channels = createMemoryTemporaryChannelRepository();
  await configs.upsert({
    guildId,
    enabled: true,
    lobbyChannelId,
    categoryId,
    channelNameTemplate: "{username}'s channel",
    defaultUserLimit: 0,
    ownerCanEdit: true,
  });
  await channels.create({
    guildId,
    channelId: temporaryChannelId,
    ownerId: "1539918723396407361",
    lobbyChannelId,
    status: "active",
    reservationId: "reservation-1",
    creationRequestId: "request-1",
    occupantIds: ["1539918723396407361"],
  });
  const { discord, controls } = createFakeDiscord();
  for (const [id, name] of [
    [lobbyChannelId, "Join to Create"],
    [categoryId, "Temporary Voice Channel"],
    [temporaryChannelId, "Fonz's channel"],
  ] as const) {
    controls.channels.set(id, { id, name, guildId, permissionOverwrites: [] });
  }
  const api = createDashboardControlApi({
    host: "127.0.0.1",
    port: 0,
    authorization,
    bodyLimitBytes: 4096,
    configs,
    channels,
    discord,
    logger,
    isReady: () => ready,
  });
  await api.start();
  return { api, configs, controls };
}

const running: DashboardControlApi[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((api) => api.stop()));
});

describe("dashboard control API", () => {
  test("requires internal authorization and coordinator readiness", async () => {
    const unavailable = await fixture(false);
    running.push(unavailable.api);
    expect((await fetch(`${unavailable.api.url}/v1/dashboard/guilds/${guildId}/snapshot`)).status).toBe(401);
    const response = await fetch(`${unavailable.api.url}/v1/dashboard/guilds/${guildId}/snapshot`, {
      headers: { authorization },
    });
    expect(response.status).toBe(503);
  });

  test("returns a bounded snapshot for a configured guild", async () => {
    const current = await fixture();
    running.push(current.api);
    const response = await fetch(`${current.api.url}/v1/dashboard/guilds/${guildId}/snapshot`, {
      headers: { authorization },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    if (!isRecord(body) || !isRecord(body.snapshot)) throw new Error("missing snapshot");
    const snapshot = body.snapshot;
    if (!isRecord(snapshot.configuration) || !isRecord(snapshot.summary)) {
      throw new Error("invalid snapshot");
    }
    expect(snapshot.configuration.lobbyChannelName).toBe("Join to Create");
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.summary.connectedMembers).toBe(1);
  });

  test("updates persisted settings and routes channel renames through Discordeno port", async () => {
    const current = await fixture();
    running.push(current.api);
    const response = await fetch(`${current.api.url}/v1/dashboard/guilds/${guildId}/config`, {
      method: "PUT",
      headers: {
        authorization,
        "content-type": "application/json",
        "x-request-id": "browser-request-1",
      },
      body: JSON.stringify({ lobbyChannelName: "Create a Room", defaultUserLimit: 8 }),
    });
    expect(response.status).toBe(200);
    expect(current.controls.editCalls[0]?.requestId).toBe(
      `dashboard:config:${guildId}:lobby:browser-request-1`,
    );
    expect(current.controls.channels.get(lobbyChannelId)?.name).toBe("Create a Room");
    expect((await current.configs.findByGuildId(guildId))?.defaultUserLimit).toBe(8);
  });

  test("rejects unknown fields and oversized payloads", async () => {
    const current = await fixture();
    running.push(current.api);
    const invalid = await fetch(`${current.api.url}/v1/dashboard/guilds/${guildId}/config`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ token: "must-not-be-accepted" }),
    });
    expect(invalid.status).toBe(400);

    const oversized = await fetch(`${current.api.url}/v1/dashboard/guilds/${guildId}/config`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ lobbyChannelName: "x".repeat(5000) }),
    });
    expect(oversized.status).toBe(413);
  });
});
