import { describe, expect, test } from "bun:test";

import {
  GUILD_ERROR_DEVELOPER_HINT,
  formatGuildErrorLogEmbed,
  solutionForDiscordOutcome,
} from "../src/lib/j2c/guild-error-log.ts";

describe("guild error log", () => {
  test("formats an embed with solution and developer contact", () => {
    const embed = formatGuildErrorLogEmbed({
      area: "permissions",
      summary: "Bot could not rename the channel.",
      detail: "Discord outcome: forbidden.",
      solution: solutionForDiscordOutcome("forbidden"),
      userId: "223456789012345678",
      channelId: "333456789012345678",
    });

    expect(embed.title).toBe("Error · Permissions");
    expect(embed.description).toContain("Bot could not rename the channel.");
    expect(embed.description).toContain("Possible solution");
    expect(embed.description).toContain("Manage Channels");
    expect(embed.description).toContain(GUILD_ERROR_DEVELOPER_HINT);
    expect(embed.description).toContain("<@223456789012345678>");
  });

  test("maps discord outcomes to actionable solutions", () => {
    expect(solutionForDiscordOutcome("forbidden")).toMatch(/Grant the bot/i);
    expect(solutionForDiscordOutcome("missing")).toMatch(/\/reset/i);
    expect(solutionForDiscordOutcome("transient")).toMatch(/temporary/i);
  });
});
