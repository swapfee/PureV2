import { describe, expect, test } from "bun:test";

import {
  displayNameFromVoiceMember,
  pickDisplayName,
} from "../src/lib/j2c/display-name.ts";

describe("display name resolution", () => {
  test("prefers nick, then global name, then username", () => {
    expect(
      pickDisplayName({
        nick: "Fonz",
        globalName: "Display",
        username: "fonz123",
      }),
    ).toBe("Fonz");
    expect(
      pickDisplayName({
        globalName: "Display",
        username: "fonz123",
      }),
    ).toBe("Display");
    expect(pickDisplayName({ username: "fonz123" })).toBe("fonz123");
    expect(pickDisplayName({})).toBeUndefined();
  });

  test("reads raw Discord voice-state member payloads", () => {
    const info = displayNameFromVoiceMember({
      nick: null,
      user: {
        username: "fonz123",
        global_name: "Fonz",
        bot: false,
      },
    });
    expect(info.displayName).toBe("Fonz");
    expect(info.isBot).toBe(false);
  });
});
