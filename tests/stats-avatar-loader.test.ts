import { expect, test } from "bun:test";

import { createVoiceStatsAvatarLoader } from "../src/lib/stats/avatar-loader.ts";

async function errorMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test("voice stats avatar loader accepts bounded Discord CDN images", async () => {
  let requested = "";
  const loader = createVoiceStatsAvatarLoader(async (input) => {
    requested = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    });
  });
  expect(await loader.load("https://cdn.discordapp.com/avatars/1/hash.png")).toEqual(new Uint8Array([1, 2, 3]));
  expect(requested).toBe("https://cdn.discordapp.com/avatars/1/hash.png");
});

test("voice stats avatar loader rejects arbitrary hosts and oversized files", async () => {
  const loader = createVoiceStatsAvatarLoader(async () => new Response(new Uint8Array([1]), {
    status: 200,
    headers: { "content-type": "image/png", "content-length": "2000001" },
  }));
  expect(await errorMessage(loader.load("https://example.com/avatar.png"))).toBe("invalid_discord_avatar_url");
  expect(await errorMessage(loader.load("https://cdn.discordapp.com/avatars/1/hash.png"))).toBe("avatar_too_large");
});
