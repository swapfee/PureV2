import { describe, expect, test } from "bun:test";

import {
  ACTION_EMOJIS,
  failureResponse,
  loadingResponse,
  successResponse,
} from "../src/lib/j2c/action-response.ts";

describe("action-response", () => {
  test("formats success embed as a single emoji line", () => {
    const message = successResponse("Setup Complete");
    expect(message.embeds).toHaveLength(1);
    expect(message.embeds[0]?.description).toBe(`${ACTION_EMOJIS.success} Setup Complete.`);
    expect(message.embeds[0]).not.toHaveProperty("color");
  });

  test("formats failure embed as a single emoji line", () => {
    const message = failureResponse("Lack of permission on client or user side");
    expect(message.embeds[0]?.description).toBe(
      `${ACTION_EMOJIS.error} Lack of permission on client or user side.`,
    );
    expect(message.embeds[0]).not.toHaveProperty("color");
  });

  test("does not add a second period when message already ends with punctuation", () => {
    const message = successResponse("Channel locked.");
    expect(message.embeds[0]?.description).toBe(`${ACTION_EMOJIS.success} Channel locked.`);
  });

  test("formats a colorless loading embed addressed to the requester", () => {
    const message = loadingResponse("Generating statistics card...", "123456789012345678");
    expect(message.embeds[0]?.description).toBe(
      `${ACTION_EMOJIS.loading} <@123456789012345678>: Generating statistics card...`,
    );
    expect(message.embeds[0]).not.toHaveProperty("color");
  });
});
