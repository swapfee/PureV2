import { describe, expect, test } from "bun:test";

import {
  normalizeTimeZone,
  overlapSeconds,
  zonedDateKey,
  zonedDayWindows,
} from "../src/lib/time-zone.ts";

describe("timezone boundaries", () => {
  test("validates IANA zones without reading the host timezone", () => {
    expect(normalizeTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(normalizeTimeZone("not/a-zone")).toBeUndefined();
    expect(zonedDateKey(new Date("2026-09-25T02:00:00Z"), "America/Los_Angeles")).toBe("2026-09-24");
  });

  test("builds local-day windows across daylight-saving transitions", () => {
    const spring = zonedDayWindows(new Date("2026-03-09T12:00:00Z"), 2, "America/Los_Angeles");
    expect(spring[0]?.key).toBe("2026-03-08");
    expect((spring[0]?.end.getTime() ?? 0) - (spring[0]?.start.getTime() ?? 0)).toBe(23 * 3_600_000);

    const fall = zonedDayWindows(new Date("2026-11-02T12:00:00Z"), 2, "America/Los_Angeles");
    expect(fall[0]?.key).toBe("2026-11-01");
    expect((fall[0]?.end.getTime() ?? 0) - (fall[0]?.start.getTime() ?? 0)).toBe(25 * 3_600_000);
  });

  test("clips session duration to a viewer-local day", () => {
    const [window] = zonedDayWindows(new Date("2026-09-25T12:00:00Z"), 1, "America/Los_Angeles");
    if (!window) throw new Error("missing window");
    expect(overlapSeconds(
      new Date("2026-09-25T06:30:00Z"),
      new Date("2026-09-25T08:30:00Z"),
      window,
    )).toBe(5_400);
  });
});
