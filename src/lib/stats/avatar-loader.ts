const MAX_AVATAR_BYTES = 2_000_000;
const AVATAR_TIMEOUT_MS = 5_000;
const ALLOWED_AVATAR_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export interface VoiceStatsAvatarLoader {
  load(url: string): Promise<Uint8Array>;
}

export type VoiceStatsAvatarFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createVoiceStatsAvatarLoader(
  fetchAvatar: VoiceStatsAvatarFetch = fetch,
): VoiceStatsAvatarLoader {
  return {
    async load(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !ALLOWED_AVATAR_HOSTS.has(parsed.hostname)) {
        throw new Error("invalid_discord_avatar_url");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS);
      try {
        const response = await fetchAvatar(parsed, { signal: controller.signal });
        if (!response.ok) throw new Error(`avatar_fetch_${response.status}`);
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.startsWith("image/")) throw new Error("avatar_not_image");
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) {
          throw new Error("avatar_too_large");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
          throw new Error("avatar_size_invalid");
        }
        return bytes;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
