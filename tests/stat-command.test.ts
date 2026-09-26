import { describe, expect, test } from "bun:test";

import { createCooldownStore } from "../src/handlers/cooldowns.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { createMemoryTemporaryChannelRepository } from "../src/lib/j2c/memory-repositories.ts";
import { createLogger } from "../src/lib/logger.ts";
import { createVoiceStatsMetrics } from "../src/lib/stats/metrics.ts";
import { createStatsCommandService } from "../src/lib/stats/command-service.ts";
import type { VoiceStatsSnapshot, VoiceStatsService } from "../src/lib/stats/service.ts";
import type { VoiceStatsCardData } from "../src/lib/stats/card-renderer.ts";

const guildId = "123456789012345678";
const callerId = "234567890123456789";
const targetId = "345678901234567890";
const channelId = "456789012345678901";

const snapshot: VoiceStatsSnapshot = {
  guildId, userId: targetId, displayName: "Target", timeZone: "UTC",
  totalSeconds: 60, sessionCount: 1,
  activeDays: 1, currentSessionSeconds: 0,
  daily: Array.from({ length: 7 }, (_, index) => ({ day: new Date(Date.UTC(2026, 8, 17 + index)), seconds: index * 10 })),
  leaderboard: [],
};

async function fixture(renderer: { render(snapshot: VoiceStatsCardData): Promise<Uint8Array> } = { render: async () => new Uint8Array([137, 80, 78, 71]) }) {
  const fake = createFakeDiscord();
  const channels = createMemoryTemporaryChannelRepository();
  await channels.create({ guildId, channelId, ownerId: callerId, lobbyChannelId: "567890123456789012", status: "active", reservationId: "reservation", creationRequestId: "create" });
  fake.controls.voiceByUser.set(`${guildId}:${callerId}`, channelId);
  fake.controls.members.set(`${guildId}:${callerId}`, { id: callerId, bot: false, username: "Caller" });
  fake.controls.members.set(`${guildId}:${targetId}`, { id: targetId, bot: false, username: "Target" });
  const stats: VoiceStatsService = {
    handle: async () => undefined, reconcileGuild: async () => undefined, checkpointGuild: async () => undefined,
    expectGuilds: () => undefined, isReady: () => true,
    getSnapshot: async (_guild, user, name) => ({ ...snapshot, userId: user, displayName: name }),
    stopGuildTracking: async () => undefined,
    purgeGuild: async () => ({ sessions: 0, members: 0, daily: 0, events: 0 }),
  };
  const service = createStatsCommandService({
    stats, discord: fake.discord,
    renderer,
    cooldowns: createCooldownStore({ maxEntries: 10 }),
    metrics: createVoiceStatsMetrics(),
    logger: createLogger({ service: "test", role: "stat", level: "fatal", write: () => undefined }),
  });
  return { ...fake, channels, service };
}

function interaction(overrides: Record<string, unknown> = {}) {
  return { id: "interaction-1", token: "interaction-token", type: 2, applicationId: "678901234567890123", guildId, userId: callerId, commandName: "stat", ...overrides };
}

describe("/stat command", () => {
  test("rejects DMs before sending a progress response", async () => {
    const fx = await fixture();
    await fx.service.execute(interaction({ guildId: undefined }));
    expect(fx.controls.responses[0]?.embeds?.[0]?.description).toContain("<:error:1543407530380624037> Statistics are only available in a server.");
    expect(fx.controls.responses[0]?.embeds?.[0]?.color).toBeUndefined();
    expect(fx.controls.deferredInteractions).toHaveLength(0);
  });

  test("allows the caller to view statistics while outside a managed channel", async () => {
    const fx = await fixture();
    fx.controls.voiceByUser.set(`${guildId}:${callerId}`, null);
    await fx.service.execute(interaction());
    expect(fx.controls.deferredInteractions).toHaveLength(0);
    expect(fx.controls.responses[0]?.embeds?.[0]?.description).toBe(
      "<a:iconloading:1552886322589470781> <@234567890123456789>: Generating statistics card...",
    );
    expect(fx.controls.editedInteractions[0]?.files?.[0]?.name).toBe("voice-stats.png");
    expect(fx.controls.editedInteractions[0]?.embeds?.[0]?.description).toContain("<:success:1543407529302949908> Voice statistics generated.");
  });

  test("defaults to self and supports another human guild member with a private PNG", async () => {
    const fx = await fixture();
    await fx.service.execute(interaction({ options: [{ name: "member", type: 6, value: targetId }] }));
    const response = fx.controls.editedInteractions[0];
    expect(response?.files?.[0]?.name).toBe("voice-stats.png");
    expect(response?.requestId).toBe("stat:interaction-1:render");
    expect(response?.embeds?.[0]?.description).toContain("<:success:1543407529302949908> Voice statistics generated.");
    expect(response?.embeds?.[0]?.color).toBeUndefined();
  });

  test("passes a validated IANA timezone to statistics and rejects invalid zones", async () => {
    let receivedTimeZone: string | undefined;
    const fx = await fixture();
    const service = createStatsCommandService({
      stats: {
        handle: async () => undefined, reconcileGuild: async () => undefined,
        checkpointGuild: async () => undefined, expectGuilds: () => undefined,
        isReady: () => true,
        getSnapshot: async (_guild, user, name, timeZone) => {
          receivedTimeZone = timeZone;
          return { ...snapshot, userId: user, displayName: name, timeZone: timeZone ?? "UTC" };
        },
        stopGuildTracking: async () => undefined,
        purgeGuild: async () => ({ sessions: 0, members: 0, daily: 0, events: 0 }),
      },
      discord: fx.discord,
      renderer: { render: async () => new Uint8Array([137, 80, 78, 71]) },
      cooldowns: createCooldownStore({ maxEntries: 10 }),
      metrics: createVoiceStatsMetrics(),
      logger: createLogger({ service: "test", role: "stat", level: "fatal", write: () => undefined }),
    });
    await service.execute(interaction({
      options: [{ name: "timezone", type: 3, value: "America/Los_Angeles" }],
    }));
    expect(receivedTimeZone).toBe("America/Los_Angeles");

    const invalid = await fixture();
    await invalid.service.execute(interaction({
      options: [{ name: "timezone", type: 3, value: "VPS/Local" }],
    }));
    expect(invalid.controls.editedInteractions[0]?.embeds?.[0]?.description).toContain(
      "Enter a valid IANA timezone",
    );
  });

  test("passes the selected member username and loaded avatar to the card", async () => {
    let card: VoiceStatsCardData | undefined;
    const fx = await fixture();
    fx.controls.members.set(`${guildId}:${targetId}`, {
      id: targetId,
      bot: false,
      nick: "Display Name",
      username: "target.username",
      avatarUrl: "https://cdn.discordapp.com/avatars/345678901234567890/hash.webp?size=256",
    });
    fx.controls.guilds.set(guildId, {
      id: guildId,
      name: "Pure Development",
      premiumTier: 0,
      features: [],
    });
    const avatar = new Uint8Array([1, 2, 3]);
    const service = createStatsCommandService({
      stats: {
        handle: async () => undefined, reconcileGuild: async () => undefined, checkpointGuild: async () => undefined,
        expectGuilds: () => undefined, isReady: () => true,
        getSnapshot: async (_guild, user, name) => ({ ...snapshot, userId: user, displayName: name }),
        stopGuildTracking: async () => undefined,
        purgeGuild: async () => ({ sessions: 0, members: 0, daily: 0, events: 0 }),
      },
      discord: fx.discord,
      renderer: { render: async (value) => { card = value; return new Uint8Array([137, 80, 78, 71]); } },
      avatarLoader: { load: async () => avatar },
      cooldowns: createCooldownStore({ maxEntries: 10 }),
      metrics: createVoiceStatsMetrics(),
      logger: createLogger({ service: "test", role: "stat", level: "fatal", write: () => undefined }),
    });
    await service.execute(interaction({ options: [{ name: "member", type: 6, value: targetId }] }));
    expect(card?.displayName).toBe("Display Name");
    expect(card?.username).toBe("target.username");
    expect(card?.serverName).toBe("Pure Development");
    expect(card?.avatarData).toBe(avatar);
  });

  test("rejects bot targets", async () => {
    const fx = await fixture();
    fx.controls.members.set(`${guildId}:${targetId}`, { id: targetId, bot: true, username: "Bot" });
    await fx.service.execute(interaction({ options: [{ name: "member", type: 6, value: targetId }] }));
    expect(fx.controls.editedInteractions[0]?.embeds?.[0]?.description).toContain("<:error:1543407530380624037> Bot accounts");
  });

  test("rejects missing targets and rate limits repeated renders", async () => {
    const fx = await fixture();
    await fx.service.execute(interaction({ id: "missing", options: [{ name: "member", type: 6, value: "987654321098765432" }] }));
    expect(fx.controls.editedInteractions[0]?.embeds?.[0]?.description).toContain("<:error:1543407530380624037> That member could not be found");
    const fresh = await fixture();
    await fresh.service.execute(interaction({ id: "first" }));
    await fresh.service.execute(interaction({ id: "second" }));
    expect(fresh.controls.editedInteractions[1]?.embeds?.[0]?.description).toContain("<:error:1543407530380624037> Please wait");
  });

  test("returns a safe private failure when rendering fails", async () => {
    const fx = await fixture({ render: async () => { throw new Error("renderer-secret-detail"); } });
    await fx.service.execute(interaction());
    expect(fx.controls.deferredInteractions).toHaveLength(0);
    expect(fx.controls.responses[0]?.embeds?.[0]?.description).toContain(
      "Generating statistics card...",
    );
    expect(fx.controls.editedInteractions[0]?.embeds?.[0]?.description).toContain("<:error:1543407530380624037> The statistics card could not be generated");
    expect(fx.controls.editedInteractions[0]?.embeds?.[0]?.description).not.toContain("renderer-secret-detail");
  });
});
