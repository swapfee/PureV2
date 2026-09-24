import { expect, test } from "bun:test";

import { createVoiceStatsCardRenderer, resolveStatsFontFamily, STATS_CARD_HEIGHT, STATS_CARD_WIDTH } from "../src/lib/stats/card-renderer.ts";

test("voice stats renderer resolves an installed font instead of silently drawing blank text", () => {
  expect(resolveStatsFontFamily().length).toBeGreaterThan(0);
});

test("voice stats renderer creates a 1600x900 PNG", async () => {
  const png = await createVoiceStatsCardRenderer().render({
    guildId: "123456789012345678", userId: "234567890123456789", displayName: "Example Member",
    trackedSince: new Date("2026-09-01T00:00:00Z"), totalSeconds: 7_200, sessionCount: 4,
    activeDays: 3, currentSessionSeconds: 120,
    daily: Array.from({ length: 7 }, (_, index) => ({ day: new Date(Date.UTC(2026, 8, 17 + index)), seconds: index * 300 })),
    leaderboard: [{ userId: "234567890123456789", displayName: "Example Member", totalSeconds: 7_200 }],
  });
  expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(view.getUint32(16)).toBe(STATS_CARD_WIDTH);
  expect(view.getUint32(20)).toBe(STATS_CARD_HEIGHT);
});

test("voice stats renderer creates a valid zero-state card", async () => {
  const png = await createVoiceStatsCardRenderer().render({
    guildId: "123456789012345678", userId: "234567890123456789", displayName: "New Member",
    totalSeconds: 0, sessionCount: 0, activeDays: 0, currentSessionSeconds: 0,
    daily: Array.from({ length: 7 }, (_, index) => ({ day: new Date(Date.UTC(2026, 8, 17 + index)), seconds: 0 })),
    leaderboard: [],
  });
  expect(Array.from(png.slice(0, 4))).toEqual([137, 80, 78, 71]);
});
