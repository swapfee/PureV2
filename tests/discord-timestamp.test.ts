import { describe, expect, test } from "bun:test";

import {
  cooldownExpiresUnixSeconds,
  cooldownFailureMessage,
  discordTimestamp,
} from "../src/lib/discord-timestamp.ts";

describe("discord timestamps", () => {
  test("formats relative timestamps for Discord clients", () => {
    expect(discordTimestamp(1_700_000_000, "R")).toBe("<t:1700000000:R>");
  });

  test("cooldown message uses a live relative timestamp", () => {
    const nowMs = 1_700_000_000_000;
    const remainingMs = 5_500;
    expect(cooldownExpiresUnixSeconds(remainingMs, nowMs)).toBe(1_700_000_006);
    expect(cooldownFailureMessage(remainingMs, nowMs)).toBe(
      "This command is on cooldown. Try again <t:1700000006:R>",
    );
  });
});
