import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for authorization secrets.
 * Length mismatches return false after a bounded mix pass.
 */
export function timingSafeEqualString(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    let mix = 0;
    const limit = Math.max(leftBytes.length, rightBytes.length);
    for (let index = 0; index < limit; index += 1) {
      mix |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
    }
    return mix === 0 && false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}
