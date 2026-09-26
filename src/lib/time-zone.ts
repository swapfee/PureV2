export interface ZonedDayWindow {
  readonly key: string;
  readonly start: Date;
  readonly end: Date;
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function normalizeTimeZone(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 100) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function partsAt(value: Date, timeZone: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
} {
  type DatePartName = "year" | "month" | "day" | "hour" | "minute" | "second";
  const values = new Map(
    formatter(timeZone)
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const part = (name: DatePartName): number => {
    const result = values.get(name);
    if (result === undefined || !Number.isInteger(result)) throw new Error("invalid_time_zone_parts");
    return result;
  };
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

export function zonedDateKey(value: Date, timeZone: string): string {
  const parts = partsAt(value, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateKeyParts(key: string): { readonly year: number; readonly month: number; readonly day: number } {
  const match = DATE_KEY_PATTERN.exec(key);
  if (!match) throw new Error("invalid_date_key");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return { year, month, day };
}

function shiftDateKey(key: string, days: number): string {
  const parts = dateKeyParts(key);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return shifted.toISOString().slice(0, 10);
}

/** Convert a local calendar midnight to its UTC instant without using the host timezone. */
function zonedMidnight(key: string, timeZone: string): Date {
  const desired = dateKeyParts(key);
  const desiredEpoch = Date.UTC(desired.year, desired.month - 1, desired.day);
  let candidate = desiredEpoch;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = partsAt(new Date(candidate), timeZone);
    const representedEpoch = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const difference = desiredEpoch - representedEpoch;
    candidate += difference;
    if (difference === 0) break;
  }
  return new Date(candidate);
}

export function zonedDayWindows(
  now: Date,
  days: number,
  requestedTimeZone: string,
): readonly ZonedDayWindow[] {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new RangeError("days_out_of_range");
  const timeZone = normalizeTimeZone(requestedTimeZone);
  if (!timeZone) throw new RangeError("invalid_time_zone");
  const todayKey = zonedDateKey(now, timeZone);
  return Array.from({ length: days }, (_, index) => {
    const key = shiftDateKey(todayKey, index - days + 1);
    return {
      key,
      start: zonedMidnight(key, timeZone),
      end: zonedMidnight(shiftDateKey(key, 1), timeZone),
    };
  });
}

export function overlapSeconds(
  start: Date,
  end: Date,
  window: Pick<ZonedDayWindow, "start" | "end">,
): number {
  const overlapStart = Math.max(start.getTime(), window.start.getTime());
  const overlapEnd = Math.min(end.getTime(), window.end.getTime());
  return Math.max(0, Math.floor((overlapEnd - overlapStart) / 1_000));
}
