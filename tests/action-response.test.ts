import { describe, expect, test } from "bun:test";

import {
  ACTION_EMBED_COLORS,
  ACTION_EMOJIS,
  failureResponse,
  successResponse,
} from "../src/lib/j2c/action-response.ts";

describe("action-response", () => {
  test("formats success embed with emoji message", () => {
    const message = successResponse("Setup Complete");
    expect(message.embeds).toHaveLength(1);
    expect(message.embeds[0]?.description).toBe(`${ACTION_EMOJIS.success} Setup Complete.`);
    expect(message.embeds[0]?.color).toBe(ACTION_EMBED_COLORS.success);
  });

  test("formats failure embed with details", () => {
    const message = failureResponse(
      "Error setting Join to Create System",
      "Lack of permission on client or user side.",
    );
    expect(message.embeds[0]?.description).toBe(
      `${ACTION_EMOJIS.error} Error setting Join to Create System.\nLack of permission on client or user side.`,
    );
    expect(message.embeds[0]?.color).toBe(ACTION_EMBED_COLORS.error);
  });

  test("joins detail lines and drops blanks", () => {
    const message = successResponse("Factory Reset Complete", ["Line one", "", "Line two"]);
    expect(message.embeds[0]?.description).toBe(
      `${ACTION_EMOJIS.success} Factory Reset Complete.\nLine one.\nLine two.`,
    );
  });
});
