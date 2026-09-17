/** Discord voice bitrate floor (kbps). API uses bits = kbps × 1000. */
export const VOICE_BITRATE_MIN_KBPS = 8;

/** Region choice value that maps to Discord `rtc_region: null` (automatic). */
export const VOICE_REGION_AUTOMATIC = "automatic";

export const VOICE_REGION_OPTIONS = [
  { name: "Automatic", value: VOICE_REGION_AUTOMATIC },
  { name: "Brazil", value: "brazil" },
  { name: "Hong Kong", value: "hongkong" },
  { name: "India", value: "india" },
  { name: "Japan", value: "japan" },
  { name: "Rotterdam", value: "rotterdam" },
  { name: "Russia", value: "russia" },
  { name: "Singapore", value: "singapore" },
  { name: "South Africa", value: "southafrica" },
  { name: "Sydney", value: "sydney" },
  { name: "US Central", value: "us-central" },
  { name: "US East", value: "us-east" },
  { name: "US South", value: "us-south" },
  { name: "US West", value: "us-west" },
] as const;

export type VoiceRegionValue = (typeof VOICE_REGION_OPTIONS)[number]["value"];

const VOICE_REGION_VALUES = new Set<string>(VOICE_REGION_OPTIONS.map((entry) => entry.value));

/** Discord voice channel status max length. */
export const VOICE_STATUS_MAX_LENGTH = 500;

/**
 * Maximum voice bitrate (kbps) for a guild based on boost tier / VIP_REGIONS.
 * @see https://discord.com/developers/docs/resources/channel#modify-channel
 */
export function maxVoiceBitrateKbps(
  premiumTier: number,
  features: readonly string[] = [],
): number {
  if (features.includes("VIP_REGIONS") || premiumTier >= 3) return 384;
  if (premiumTier === 2) return 256;
  if (premiumTier === 1) return 128;
  return 96;
}

export function kbpsToBits(kbps: number): number {
  return kbps * 1000;
}

export function bitsToKbps(bits: number): number {
  return Math.round(bits / 1000);
}

export function isVoiceRegionValue(value: string): value is VoiceRegionValue {
  return VOICE_REGION_VALUES.has(value);
}

export function formatVoiceRegion(region: string | null | undefined): string {
  if (region === null || region === undefined || region === "") {
    return "Automatic";
  }
  const match = VOICE_REGION_OPTIONS.find((entry) => entry.value === region);
  return match?.name ?? region;
}

export function normalizeVoiceStatus(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");
  if (trimmed.length === 0) return null;
  if (trimmed.length > VOICE_STATUS_MAX_LENGTH) return undefined;
  return trimmed;
}
