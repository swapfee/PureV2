import { expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";

import { createVoiceStatsCardRenderer, resolveStatsFontFamily, STATS_CARD_HEIGHT, STATS_CARD_WIDTH } from "../src/lib/stats/card-renderer.ts";

test("voice stats renderer resolves an installed font instead of silently drawing blank text", () => {
  expect(resolveStatsFontFamily().length).toBeGreaterThan(0);
});

test("voice stats renderer palette contains only neutral grayscale accents", () => {
  const source = readFileSync(new URL("../src/lib/stats/card-renderer.ts", import.meta.url), "utf8");
  for (const match of source.matchAll(/#([\da-f]{2})([\da-f]{2})([\da-f]{2})/gi)) {
    expect(match[1]?.toLowerCase()).toBe(match[2]?.toLowerCase());
    expect(match[2]?.toLowerCase()).toBe(match[3]?.toLowerCase());
  }
  for (const match of source.matchAll(/rgba\((\d+), (\d+), (\d+),/g)) {
    expect(match[1]).toBe(match[2]);
    expect(match[2]).toBe(match[3]);
  }
});

test("voice stats renderer creates a 1600x900 PNG", async () => {
  const png = await createVoiceStatsCardRenderer().render({
    guildId: "123456789012345678", userId: "234567890123456789", displayName: "Example Member",
    username: "example.user", serverName: "Example Server", timeZone: "America/Los_Angeles",
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
    username: "new.member", serverName: "Example Server", timeZone: "UTC",
    totalSeconds: 0, sessionCount: 0, activeDays: 0, currentSessionSeconds: 0,
    daily: Array.from({ length: 7 }, (_, index) => ({ day: new Date(Date.UTC(2026, 8, 17 + index)), seconds: 0 })),
    leaderboard: [],
  });
  expect(Array.from(png.slice(0, 4))).toEqual([137, 80, 78, 71]);
});

test("voice stats renderer draws the selected member avatar in the left profile", async () => {
  const avatar = createCanvas(16, 16);
  const avatarContext = avatar.getContext("2d");
  avatarContext.fillStyle = "#ff0000";
  avatarContext.fillRect(0, 0, 16, 16);
  const png = await createVoiceStatsCardRenderer().render({
    guildId: "123456789012345678", userId: "234567890123456789",
    displayName: "Avatar Member", username: "avatar.user", serverName: "Example Server",
    timeZone: "UTC", avatarData: avatar.toBuffer("image/png"),
    totalSeconds: 300, sessionCount: 1, activeDays: 1, currentSessionSeconds: 0,
    daily: Array.from({ length: 7 }, (_, index) => ({ day: new Date(Date.UTC(2026, 8, 17 + index)), seconds: 0 })),
    leaderboard: [],
  });
  const rendered = await loadImage(png);
  const inspect = createCanvas(STATS_CARD_WIDTH, STATS_CARD_HEIGHT);
  const inspectContext = inspect.getContext("2d");
  inspectContext.drawImage(rendered, 0, 0);
  expect(Array.from(inspectContext.getImageData(100, 104, 1, 1).data.slice(0, 3))).toEqual([255, 0, 0]);
});
