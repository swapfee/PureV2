import { describe, expect, test } from "bun:test";

import { createLogger } from "../src/lib/logger.ts";
import { createCoordinatorMetrics } from "../src/lib/coordinator/metrics.ts";
import { createCoordinatorRest, REST_REQUEST_ID_HEADER } from "../src/lib/coordinator/rest.ts";
import { syntheticWorkerToken } from "../src/lib/worker/synthetic-token.ts";

const testToken = syntheticWorkerToken("123456789012345678");

function buildPngMultipart(type = "image/png", name = "voice-stats.png"): FormData {
  const form = new FormData();
  form.set("payload_json", JSON.stringify({ content: "" }));
  form.set("files[0]", new File([new Uint8Array([137, 80, 78, 71])], name, { type }));
  return form;
}

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

  test("treats upstream 404 as expected and does not count it as a proxy error", async () => {
    const metrics = createCoordinatorMetrics();
    const errorLogs: string[] = [];
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
        level: "debug",
        write: (line) => {
          if (line.includes('"level":"error"')) errorLogs.push(line);
        },
      }),
      metrics,
      executeRequest: async () => {
        const error = Object.assign(new Error("Failed to send request to discord."), {
          status: 404,
        });
        throw error;
      },
    });

    await rest.start();
    try {
      const response = await fetch(
        `${rest.baseUrl}/v10/guilds/1/voice-states/2`,
        { headers: { authorization: "0123456789abcdef" } },
      );
      expect(response.status).toBe(404);
      expect(metrics.snapshot().restProxyErrors).toBe(0);
      expect(errorLogs).toHaveLength(0);
    } finally {
      await rest.stop();
    }
  });

  test("validates and deduplicates one PNG multipart upload", async () => {
    let calls = 0;
    let receivedFileName: string | undefined;
    const rest = createCoordinatorRest({
      token: testToken, applicationId: "123456789012345678", host: "127.0.0.1", port: 0,
      authorization: "0123456789abcdef", bodyLimitBytes: 2_048, requestCacheLimit: 10, requestCacheTtlMs: 60_000,
      logger: createLogger({ service: "test", role: "rest", level: "fatal", write: () => undefined }),
      metrics: createCoordinatorMetrics(),
      executeRequest: async (_method, _route, _body, files) => {
        calls += 1;
        receivedFileName = files?.[0]?.name;
        return { status: 200, body: { ok: true } };
      },
    });
    await rest.start();
    try {
      const headers = { authorization: "0123456789abcdef", [REST_REQUEST_ID_HEADER]: "stat:interaction:render" };
      const url = `${rest.baseUrl}/v10/webhooks/123456789012345678/interaction-token/messages/@original`;
      expect((await fetch(url, { method: "PATCH", headers, body: buildPngMultipart() })).status).toBe(200);
      expect((await fetch(url, { method: "PATCH", headers, body: buildPngMultipart() })).status).toBe(200);
      expect(calls).toBe(1);
      expect(receivedFileName).toBe("voice-stats.png");
      expect((await fetch(`${rest.baseUrl}/v10/channels/1/messages`, { method: "POST", headers, body: buildPngMultipart() })).status).toBe(400);
      expect((await fetch(url, { method: "PATCH", headers: { authorization: "0123456789abcdef" }, body: buildPngMultipart("text/plain", "voice-stats.txt") })).status).toBe(400);

      expect((await fetch(url, {
        method: "PATCH",
        headers: { authorization: "wrong-secret-value" },
        body: buildPngMultipart(),
      })).status).toBe(401);

      const malformed = buildPngMultipart();
      malformed.set("payload_json", "not-json");
      expect((await fetch(url, {
        method: "PATCH",
        headers: { authorization: "0123456789abcdef" },
        body: malformed,
      })).status).toBe(400);

      const multiple = buildPngMultipart();
      multiple.append("files[0]", new File([new Uint8Array([137, 80, 78, 71])], "second.png", { type: "image/png" }));
      expect((await fetch(url, {
        method: "PATCH",
        headers: { authorization: "0123456789abcdef" },
        body: multiple,
      })).status).toBe(400);

      const oversized = new FormData();
      oversized.set("payload_json", "{}");
      oversized.set("files[0]", new File([new Uint8Array(3_000)], "voice-stats.png", { type: "image/png" }));
      expect((await fetch(url, {
        method: "PATCH",
        headers: { authorization: "0123456789abcdef" },
        body: oversized,
      })).status).toBe(413);
      expect(calls).toBe(1);
    } finally {
      await rest.stop();
    }
  });
});
