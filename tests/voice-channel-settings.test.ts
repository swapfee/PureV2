import { describe, expect, test } from "bun:test";

import {
  bitsToKbps,
  formatVoiceRegion,
  isVoiceRegionValue,
  kbpsToBits,
  maxVoiceBitrateKbps,
  normalizeVoiceStatus,
  VOICE_BITRATE_MIN_KBPS,
  VOICE_STATUS_MAX_LENGTH,
} from "../src/lib/j2c/voice-channel-settings.ts";

describe("voice-channel-settings", () => {
  test("maps boost tiers to max bitrate", () => {
    expect(maxVoiceBitrateKbps(0)).toBe(96);
    expect(maxVoiceBitrateKbps(1)).toBe(128);
    expect(maxVoiceBitrateKbps(2)).toBe(256);
    expect(maxVoiceBitrateKbps(3)).toBe(384);
    expect(maxVoiceBitrateKbps(0, ["VIP_REGIONS"])).toBe(384);
    expect(VOICE_BITRATE_MIN_KBPS).toBe(8);
  });

  test("converts kbps and bits", () => {
    expect(kbpsToBits(96)).toBe(96_000);
    expect(bitsToKbps(128_000)).toBe(128);
  });

  test("validates regions and formats labels", () => {
    expect(isVoiceRegionValue("us-east")).toBe(true);
    expect(isVoiceRegionValue("automatic")).toBe(true);
    expect(isVoiceRegionValue("mars")).toBe(false);
    expect(formatVoiceRegion(null)).toBe("Automatic");
    expect(formatVoiceRegion("japan")).toBe("Japan");
  });

  test("normalizes voice status", () => {
    expect(normalizeVoiceStatus(undefined)).toBeNull();
    expect(normalizeVoiceStatus("   ")).toBeNull();
    expect(normalizeVoiceStatus("  hello   world ")).toBe("hello world");
    expect(normalizeVoiceStatus("x".repeat(VOICE_STATUS_MAX_LENGTH + 1))).toBeUndefined();
  });
});
