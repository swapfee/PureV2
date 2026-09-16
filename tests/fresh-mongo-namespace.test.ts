import { describe, expect, test } from "bun:test";

import { isMissingMongoNamespaceError, listJ2cIndexes } from "../src/models/index-sync.ts";

describe("fresh Mongo namespace handling", () => {
  test("detects NamespaceNotFound / ns does not exist", () => {
    expect(isMissingMongoNamespaceError({ code: 26, codeName: "NamespaceNotFound" })).toBe(true);
    expect(isMissingMongoNamespaceError(new Error("ns does not exist: test.guild_configs"))).toBe(true);
    expect(isMissingMongoNamespaceError(new Error("other failure"))).toBe(false);
  });

  test("listJ2cIndexes treats missing collections as empty", async () => {
    const listings = await listJ2cIndexes([
      {
        modelName: "GuildConfig",
        syncIndexes: async () => undefined,
        listIndexes: async () => {
          throw Object.assign(new Error("ns does not exist: purev2.guild_configs"), {
            code: 26,
            codeName: "NamespaceNotFound",
          });
        },
      },
    ]);
    expect(listings).toEqual([{ modelName: "GuildConfig", indexes: [] }]);
  });
});
