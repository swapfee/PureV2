import { describe, expect, test } from "bun:test";

import { createLogger } from "../src/lib/logger.ts";
import { createCoordinatorMetrics } from "../src/lib/coordinator/metrics.ts";
import { createCoordinatorRest, REST_REQUEST_ID_HEADER } from "../src/lib/coordinator/rest.ts";
import { syntheticWorkerToken } from "../src/lib/worker/synthetic-token.ts";

const testToken = syntheticWorkerToken("123456789012345678");

describe("coordinator REST proxy", () => {
  test("rejects unauthorized, oversized, and invalid routes without contacting Discord", async () => {
    const metrics = createCoordinatorMetrics();
    const rest = createCoordinatorRest({
      token: testToken,
      applicationId: "123456789012345678",
      host: "127.0.0.1",
      port: 0,
      authorization: "0123456789abcdef",
      bodyLimitBytes: 64,
      requestCacheLimit: 100,
      requestCacheTtlMs: 60_000,
      logger: createLogger({
        service: "purev2-test",
        role: "test",
        level: "error",
        write: () => undefined,
      }),
      metrics,
      executeRequest: async () => {
        throw new Error("should not contact Discord in rejection tests");
      },
    });

    await rest.start();
    try {
      const unauthorized = await fetch(`${rest.baseUrl}/v10/users/@me`, {
        headers: { authorization: "wrong-secret-value" },
      });
      expect(unauthorized.status).toBe(401);

      const badRoute = await fetch(`${rest.baseUrl}/not-discord`, {
        headers: { authorization: "0123456789abcdef" },
      });
      expect(badRoute.status).toBe(400);

      const badMethod = await fetch(`${rest.baseUrl}/v10/users/@me`, {
        method: "TRACE",
        headers: { authorization: "0123456789abcdef" },
      });
      expect(badMethod.status).toBe(405);

      const oversized = await fetch(`${rest.baseUrl}/v10/channels/1/messages`, {
        method: "POST",
        headers: {
          authorization: "0123456789abcdef",
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "x".repeat(200) }),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await rest.stop();
    }
  });

  test("deduplicates stable request ids for completed responses", async () => {
    let calls = 0;
    const metrics = createCoordinatorMetrics();
    const rest = createCoordinatorRest({
      token: testToken,
      applicationId: "123456789012345678",
      host: "127.0.0.1",
      port: 0,
      authorization: "0123456789abcdef",
      bodyLimitBytes: 1_048_576,
      requestCacheLimit: 100,
      requestCacheTtlMs: 60_000,
      logger: createLogger({
        service: "purev2-test",
        role: "test",
        level: "error",
        write: () => undefined,
      }),
      metrics,
      executeRequest: async () => {
        calls += 1;
        return { status: 200, body: { id: "1", username: "purev2" } };
      },
    });

    await rest.start();
    try {
      const headers = {
        authorization: "0123456789abcdef",
        [REST_REQUEST_ID_HEADER]: "req-stable-1",
      };
      const first = await fetch(`${rest.baseUrl}/v10/users/@me`, { headers });
      expect(first.status).toBe(200);
      const second = await fetch(`${rest.baseUrl}/v10/users/@me`, { headers });
      expect(second.status).toBe(200);
      expect(calls).toBe(1);
      expect(await second.json()).toEqual({ id: "1", username: "purev2" });
    } finally {
      await rest.stop();
    }
  });
});
