import { describe, expect, test } from "bun:test";

import { createLogger } from "../src/lib/logger.ts";

describe("createLogger", () => {
  test("redacts sensitive values and keys", () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "purev2",
      role: "test",
      level: "info",
      sensitiveValues: ["super-secret-token", "mongodb://secret"],
      write: (line) => lines.push(line),
    });

    logger.info("boot", {
      token: "super-secret-token",
      nested: { mongodbUri: "mongodb://secret", ok: true },
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line.includes("super-secret-token")).toBe(false);
    expect(line.includes("mongodb://secret")).toBe(false);
    expect(line.includes("[REDACTED]")).toBe(true);
    expect(line.includes('"ok":true')).toBe(true);
  });
});
