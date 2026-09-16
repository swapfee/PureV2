export const DEFAULT_SETUP_CATEGORY_NAME = "Temporary Voice Channel";
export const DEFAULT_SETUP_LOBBY_NAME = "Join to Create";

/** Discord channel names: 1–100 characters after trim. */
export function normalizeSetupChannelName(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? fallback).trim().replace(/\s+/g, " ");
  if (trimmed.length < 1) return fallback.slice(0, 100);
  return trimmed.slice(0, 100);
}
