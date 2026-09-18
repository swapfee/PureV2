import { describe, expect, test } from "bun:test";

import { createJ2cMetrics } from "../src/lib/j2c/metrics.ts";
import {
  createMemoryCreationReservationRepository,
  createMemoryTemporaryChannelRepository,
} from "../src/lib/j2c/memory-repositories.ts";
import { createOwnershipService, OwnershipError } from "../src/lib/j2c/ownership.ts";
import { createReservationService } from "../src/lib/j2c/reservation-service.ts";

const guildId = "123456789012345678";
const memberId = "999999999999999999";
const lobbyId = "222222222222222222";

describe("ownership service", () => {
  test("asserts owner-only access for active channels", async () => {
    const channels = createMemoryTemporaryChannelRepository();
    await channels.create({
      guildId,
      channelId: "111111111111111111",
      ownerId: memberId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-1",
      creationRequestId: "req-1",
    });
    const ownership = createOwnershipService(channels);

    expect(await ownership.isOwner("111111111111111111", memberId)).toBe(true);
    expect(await ownership.isOwner("111111111111111111", "888888888888888888")).toBe(false);
    try {
      await ownership.assertOwner("111111111111111111", "888888888888888888");
      throw new Error("expected OwnershipError");
    } catch (error) {
      expect(error).toBeInstanceOf(OwnershipError);
    }
    const owned = await ownership.assertOwner("111111111111111111", memberId);
    expect(owned.channelId).toBe("111111111111111111");
  });
});

describe("reservation service", () => {
  test("acquires reservations and prevents concurrent duplicates", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const reservations = createMemoryCreationReservationRepository(() => new Date(now));
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    const service = createReservationService({
      reservations,
      channels,
      metrics,
      now: () => new Date(now),
    });

    const first = await service.beginCreation({
      reservationId: "res-a",
      guildId,
      memberId,
      eventId: "event-a",
      creationRequestId: "req-a",
    });
    expect(first.outcome).toBe("acquired");

    const duplicate = await service.beginCreation({
      reservationId: "res-b",
      guildId,
      memberId,
      eventId: "event-b",
      creationRequestId: "req-b",
    });
    expect(duplicate.outcome).toBe("duplicate_in_flight");
    expect(metrics.snapshot().duplicateCreationsPrevented).toBe(1);

    const replay = await service.beginCreation({
      reservationId: "res-c",
      guildId,
      memberId,
      eventId: "event-a",
      creationRequestId: "req-c",
    });
    expect(replay.outcome).toBe("replay");
  });

  test("blocks creation while an owned active channel is empty", async () => {
    const reservations = createMemoryCreationReservationRepository();
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    await channels.create({
      guildId,
      channelId: "111111111111111111",
      ownerId: memberId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-existing",
      creationRequestId: "req-existing",
    });
    const service = createReservationService({ reservations, channels, metrics });

    const result = await service.beginCreation({
      reservationId: "res-new",
      guildId,
      memberId,
      eventId: "event-new",
      creationRequestId: "req-new",
    });
    expect(result.outcome).toBe("owner_has_channel");
    if (result.outcome === "owner_has_channel") {
      expect(result.channelId).toBe("111111111111111111");
    }
    expect(metrics.snapshot().duplicateCreationsPrevented).toBe(1);
  });

  test("allows creation when every existing owned channel remains occupied", async () => {
    const reservations = createMemoryCreationReservationRepository();
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    await channels.create({
      guildId,
      channelId: "111111111111111111",
      ownerId: memberId,
      lobbyChannelId: lobbyId,
      status: "active",
      reservationId: "res-existing",
      creationRequestId: "req-existing",
      occupantIds: ["888888888888888888"],
    });
    const service = createReservationService({ reservations, channels, metrics });

    const result = await service.beginCreation({
      reservationId: "res-new",
      guildId,
      memberId,
      eventId: "event-new",
      creationRequestId: "req-new",
    });
    expect(result.outcome).toBe("acquired");
  });

  test("expires due reservations and allows a new acquisition", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const reservations = createMemoryCreationReservationRepository(() => new Date(now));
    const channels = createMemoryTemporaryChannelRepository();
    const metrics = createJ2cMetrics();
    const service = createReservationService({
      reservations,
      channels,
      metrics,
      now: () => new Date(now),
    });

    const first = await service.beginCreation({
      reservationId: "res-a",
      guildId,
      memberId,
      eventId: "event-a",
      creationRequestId: "req-a",
      ttlMs: 1_000,
    });
    expect(first.outcome).toBe("acquired");

    now += 5_000;
    expect(await service.expireDue()).toBe(1);

    const second = await service.beginCreation({
      reservationId: "res-b",
      guildId,
      memberId,
      eventId: "event-b",
      creationRequestId: "req-b",
      ttlMs: 1_000,
    });
    expect(second.outcome).toBe("acquired");
  });
});
