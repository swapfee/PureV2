import { describe, expect, test } from "bun:test";

import {
  createMemoryCreationReservationRepository,
  createMemoryGuildConfigRepository,
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { validateUpsertGuildConfigInput, GuildConfigValidationError } from "../src/lib/j2c/validation.ts";
import { DEFAULT_CHANNEL_NAME_TEMPLATE, isSnowflake } from "../src/models/index.ts";

describe("guild config validation", () => {
  test("accepts valid configuration and rejects bad snowflakes", () => {
    const valid = validateUpsertGuildConfigInput({
      guildId: "123456789012345678",
      enabled: true,
      lobbyChannelId: "223456789012345678",
      categoryId: "323456789012345678",
      channelNameTemplate: "{username}'s room",
      defaultUserLimit: 5,
      moderatorRoleIds: ["423456789012345678"],
    });
    expect(valid.channelNameTemplate).toBe("{username}'s room");
    expect(isSnowflake(valid.guildId)).toBe(true);

    expect(() =>
      validateUpsertGuildConfigInput({
        guildId: "bad",
        enabled: true,
        lobbyChannelId: "223456789012345678",
        categoryId: "323456789012345678",
        channelNameTemplate: DEFAULT_CHANNEL_NAME_TEMPLATE,
      }),
    ).toThrow(GuildConfigValidationError);
  });
});

describe("memory guild config repository", () => {
  test("upserts one configuration per guild", async () => {
    const repo = createMemoryGuildConfigRepository();
    const first = await repo.upsert({
      guildId: "123456789012345678",
      enabled: true,
      lobbyChannelId: "223456789012345678",
      categoryId: "323456789012345678",
      channelNameTemplate: "{username}'s channel",
    });
    const second = await repo.upsert({
      guildId: "123456789012345678",
      enabled: false,
      lobbyChannelId: "223456789012345678",
      categoryId: "323456789012345678",
      channelNameTemplate: "Room {username}",
    });
    expect(first.guildId).toBe(second.guildId);
    expect(second.enabled).toBe(false);
    expect((await repo.findByGuildId("123456789012345678"))?.channelNameTemplate).toBe("Room {username}");
  });

  test("create refuses a second Join to Create config for the same guild", async () => {
    const repo = createMemoryGuildConfigRepository();
    const input = {
      guildId: "123456789012345678",
      enabled: true,
      lobbyChannelId: "223456789012345678",
      categoryId: "323456789012345678",
      channelNameTemplate: "{username}'s channel",
    } as const;
    const first = await repo.create(input);
    expect(first.kind).toBe("created");
    const second = await repo.create({
      ...input,
      lobbyChannelId: "423456789012345678",
      categoryId: "523456789012345678",
    });
    expect(second.kind).toBe("exists");
    if (second.kind === "exists") {
      expect(second.record.lobbyChannelId).toBe("223456789012345678");
    }
  });
});

describe("memory temporary channel repository", () => {
  test("tracks multiple rooms per owner and keeps channel ids unique", async () => {
    const repo = createMemoryTemporaryChannelRepository();
    await repo.create({
      guildId: "123456789012345678",
      channelId: "111111111111111111",
      ownerId: "999999999999999999",
      lobbyChannelId: "222222222222222222",
      status: "creating",
      reservationId: "res-1",
      creationRequestId: "req-1",
    });

    await repo.create({
      guildId: "123456789012345678",
      channelId: "333333333333333333",
      ownerId: "999999999999999999",
      lobbyChannelId: "222222222222222222",
      status: "active",
      reservationId: "res-2",
      creationRequestId: "req-2",
      occupantIds: ["777777777777777777"],
    });
    expect(await repo.listActiveOwned("123456789012345678", "999999999999999999")).toHaveLength(1);

    try {
      await repo.create({
        guildId: "123456789012345678",
        channelId: "111111111111111111",
        ownerId: "888888888888888888",
        lobbyChannelId: "222222222222222222",
        status: "active",
        reservationId: "res-3",
        creationRequestId: "req-3",
      });
      throw new Error("expected unique channel failure");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").toMatch(/already exists/);
    }
  });

  test("derived ownership updates after claim and deletion", async () => {
    const repo = createMemoryTemporaryChannelRepository();
    for (const [channelId, reservationId] of [
      ["111111111111111111", "res-1"],
      ["333333333333333333", "res-2"],
    ] as const) {
      await repo.create({
        guildId: "123456789012345678",
        channelId,
        ownerId: "999999999999999999",
        lobbyChannelId: "222222222222222222",
        status: "active",
        reservationId,
        creationRequestId: `req-${reservationId}`,
        occupantIds: ["777777777777777777"],
      });
    }

    expect(await repo.listActiveOwned("123456789012345678", "999999999999999999")).toHaveLength(2);
    await repo.transferOwner("333333333333333333", "888888888888888888");
    expect(await repo.listActiveOwned("123456789012345678", "999999999999999999")).toHaveLength(1);
    expect(await repo.listActiveOwned("123456789012345678", "888888888888888888")).toHaveLength(1);
    await repo.remove("111111111111111111");
    expect(await repo.listActiveOwned("123456789012345678", "999999999999999999")).toEqual([]);
  });
});

describe("memory creation reservation repository", () => {
  test("acquires once, detects concurrent reserve, and replays by event id", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const repo = createMemoryCreationReservationRepository(() => new Date(now));

    const first = await repo.acquire({
      reservationId: "res-a",
      guildId: "123456789012345678",
      memberId: "999999999999999999",
      eventId: "11111111-1111-4111-8111-111111111111",
      creationRequestId: "req-a",
      expiresAt: new Date(now + 60_000),
    });
    expect(first.outcome).toBe("acquired");

    const concurrent = await repo.acquire({
      reservationId: "res-b",
      guildId: "123456789012345678",
      memberId: "999999999999999999",
      eventId: "22222222-2222-4222-8222-222222222222",
      creationRequestId: "req-b",
      expiresAt: new Date(now + 60_000),
    });
    expect(concurrent.outcome).toBe("already_reserved");

    const replay = await repo.acquire({
      reservationId: "res-c",
      guildId: "123456789012345678",
      memberId: "999999999999999999",
      eventId: "11111111-1111-4111-8111-111111111111",
      creationRequestId: "req-c",
      expiresAt: new Date(now + 60_000),
    });
    expect(replay.outcome).toBe("replay");
    if (replay.outcome === "replay") {
      expect(replay.reservation.reservationId).toBe("res-a");
    }

    now += 120_000;
    expect(await repo.expireDue(new Date(now))).toBe(1);
  });
});
