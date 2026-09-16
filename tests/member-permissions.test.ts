import { describe, expect, test } from "bun:test";
import { BitwisePermissionFlags } from "discordeno";

import { extractMemberPermissionBits } from "../src/lib/worker/dispatch.ts";

describe("extractMemberPermissionBits", () => {
  test("accepts string, number, and bigint bits", () => {
    expect(extractMemberPermissionBits("8")).toBe("8");
    expect(extractMemberPermissionBits(32)).toBe("32");
    expect(extractMemberPermissionBits(8n)).toBe("8");
  });

  test("reads Discordeno Permissions-like objects via bitfield/toJSON", () => {
    const manageGuild = BitwisePermissionFlags.MANAGE_GUILD;
    expect(
      extractMemberPermissionBits({
        bitfield: manageGuild,
      }),
    ).toBe(String(manageGuild));

    expect(
      extractMemberPermissionBits({
        toJSON: () => String(BitwisePermissionFlags.ADMINISTRATOR),
      }),
    ).toBe(String(BitwisePermissionFlags.ADMINISTRATOR));
  });

  test("returns undefined for missing or unreadable values", () => {
    expect(extractMemberPermissionBits(undefined)).toBeUndefined();
    expect(extractMemberPermissionBits({})).toBeUndefined();
    expect(extractMemberPermissionBits(null)).toBeUndefined();
  });
});
