import {
  createRestManager,
  type RequestMethods,
  type RestManager,
  type FileContent,
} from "discordeno";

import type { Logger } from "../logger.ts";
import { createDiscordenoLogger } from "../logger.ts";
import { timingSafeEqualString } from "../security.ts";
import { createTtlCache } from "../ttl-cache.ts";
import type { CoordinatorMetrics } from "./metrics.ts";

export const REST_REQUEST_ID_HEADER = "x-purev2-request-id";

export interface CoordinatorRestOptions {
  readonly token: string;
  readonly applicationId?: string;
  readonly host: string;
  readonly port: number;
  readonly authorization: string;
  readonly bodyLimitBytes: number;
  readonly requestCacheLimit: number;
  readonly requestCacheTtlMs: number;
  readonly logger: Logger;
  readonly metrics: CoordinatorMetrics;
  /** Test seam: override Discord HTTP execution without contacting Discord. */
  readonly executeRequest?: (
    method: RequestMethods,
    route: string,
    body: unknown,
    files?: readonly FileContent[],
  ) => Promise<CachedResponse>;
}

export interface CoordinatorRest {
  readonly rest: RestManager;
  readonly baseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isListening(): boolean;
}

export interface CachedResponse {
  readonly status: number;
  readonly body: unknown;
}

function isRequestMethod(value: string): value is RequestMethods {
  switch (value) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
      return true;
    default:
      return false;
  }
}

function extractDiscordRoute(pathname: string): string | undefined {
  // Proxied Discordeno clients call `${baseUrl}/v${version}${route}`.
  // Verified against @discordeno/rest makeRequest when isProxied is true.
  const match = /^\/v\d+(\/.*)$/.exec(pathname);
  return match?.[1];
}

function isSafeDiscordRoute(routePath: string): boolean {
  if (!routePath.startsWith("/")) return false;
  if (routePath.includes("://")) return false;
  if (routePath.includes("..")) return false;
  return /^\/[A-Za-z0-9/_~\-.%@]+$/.test(routePath.split("?")[0] ?? routePath);
}

function routeClassification(route: string): string {
  if (/^\/webhooks\/\d+\/[^/]+\/messages\/@original/.test(route)) return "webhook_original_message";
  const first = route.split("?")[0]?.split("/").filter(Boolean)[0];
  return first ? `${first}_route` : "unknown_route";
}

function allowsMultipart(method: RequestMethods, route: string): boolean {
  return method === "PATCH" && /^\/webhooks\/\d+\/[^/]+\/messages\/@original(?:\?.*)?$/.test(route);
}

function readErrorStatus(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("cause" in error && typeof error.cause === "object" && error.cause !== null && "status" in error.cause) {
    const status = error.cause.status;
    if (typeof status === "number") return status;
  }
  return 500;
}

function structuredError(code: string, message: string, status: number): Response {
  return Response.json({ error: code, message }, { status });
}

export function createCoordinatorRest(options: CoordinatorRestOptions): CoordinatorRest {
  const rest = createRestManager({
    token: options.token,
    ...(options.applicationId === undefined ? {} : { applicationId: BigInt(options.applicationId) }),
    logger: createDiscordenoLogger(options.logger.child({ component: "rest" })),
  });

  const completed = createTtlCache<CachedResponse>({
    limit: options.requestCacheLimit,
    ttlMs: options.requestCacheTtlMs,
  });
  const inFlight = new Map<string, Promise<CachedResponse>>();

  let server: ReturnType<typeof Bun.serve> | undefined;

  const executeDiscordRequest = async (
    method: RequestMethods,
    route: string,
    body: unknown,
    files?: readonly FileContent[],
  ): Promise<CachedResponse> => {
    if (options.executeRequest) return options.executeRequest(method, route, body, files);
    const result = await rest.makeRequest(method, route, body === undefined && files === undefined ? undefined : {
      ...(body === undefined ? {} : { body }),
      ...(files === undefined ? {} : { files: [...files] }),
    });
    if (result === undefined) return { status: 204, body: null };
    return { status: 200, body: result };
  };

  return {
    rest,
    get baseUrl(): string {
      const port = server?.port ?? options.port;
      return `http://${options.host}:${port}`;
    },

    isListening(): boolean {
      return server !== undefined;
    },

    async start(): Promise<void> {
      if (server) return;

      server = Bun.serve({
        hostname: options.host,
        port: options.port,
        async fetch(request): Promise<Response> {
          const authorization = request.headers.get("authorization") ?? "";
          if (!timingSafeEqualString(authorization, options.authorization)) {
            return structuredError("unauthorized", "Invalid or missing authorization", 401);
          }

          const method = request.method.toUpperCase();
          if (!isRequestMethod(method)) {
            return structuredError("method_not_allowed", `Unsupported method ${method}`, 405);
          }

          const url = new URL(request.url);
          const routePath = extractDiscordRoute(url.pathname);
          if (!routePath || !isSafeDiscordRoute(routePath)) {
            return structuredError("invalid_route", "Route must be a Discord API path under /v{version}", 400);
          }

          if (url.search.includes("://")) {
            return structuredError("invalid_query", "Query string must not contain absolute URLs", 400);
          }

          const route = `${routePath}${url.search}`;
          const routeClass = routeClassification(route);
          options.metrics.increment("restProxyRequests");

          const requestId = request.headers.get(REST_REQUEST_ID_HEADER) ?? undefined;
          const cacheKey = requestId ? `${requestId}:${method}:${route}` : undefined;

          try {
            if (cacheKey) {
              const cached = completed.get(cacheKey);
              if (cached) {
                if (cached.status === 204) return new Response(null, { status: 204 });
                return Response.json(cached.body, { status: cached.status });
              }
              const pending = inFlight.get(cacheKey);
              if (pending) {
                const shared = await pending;
                if (shared.status === 204) return new Response(null, { status: 204 });
                return Response.json(shared.body, { status: shared.status });
              }
            }

            const contentLengthHeader = request.headers.get("content-length");
            if (contentLengthHeader !== null) {
              const contentLength = Number(contentLengthHeader);
              if (Number.isFinite(contentLength) && contentLength > options.bodyLimitBytes) {
                return structuredError("payload_too_large", "Request body exceeds configured limit", 413);
              }
            }

            let body: unknown;
            let files: readonly FileContent[] | undefined;
            if (method !== "GET" && method !== "DELETE") {
              const bytes = await request.arrayBuffer();
              if (bytes.byteLength > options.bodyLimitBytes) {
                return structuredError("payload_too_large", "Request body exceeds configured limit", 413);
              }
              const contentType = request.headers.get("content-type") ?? "";
              if (contentType.toLowerCase().startsWith("multipart/form-data")) {
                if (!allowsMultipart(method, route)) return structuredError("invalid_multipart_route", "Multipart is not permitted for this Discord route", 400);
                try {
                  const multipart = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
                  const entries = [...multipart.entries()];
                  if (entries.some(([name]) => name !== "payload_json" && name !== "files[0]")) return structuredError("invalid_multipart_field", "Multipart contains an unsupported field", 400);
                  const payloads = multipart.getAll("payload_json");
                  const uploads = multipart.getAll("files[0]");
                  if (payloads.length !== 1 || typeof payloads[0] !== "string") return structuredError("invalid_payload_json", "Multipart requires exactly one payload_json field", 400);
                  if (uploads.length !== 1 || !(uploads[0] instanceof File)) return structuredError("invalid_file_count", "Multipart requires exactly one file", 400);
                  const upload = uploads[0];
                  if (upload.type !== "image/png" || !/^[A-Za-z0-9._-]{1,100}\.png$/i.test(upload.name)) return structuredError("invalid_file", "Only a safely named PNG file is accepted", 400);
                  if (upload.size > options.bodyLimitBytes) return structuredError("payload_too_large", "PNG exceeds configured limit", 413);
                  const parsed: unknown = JSON.parse(payloads[0]);
                  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return structuredError("invalid_payload_json", "payload_json must be an object", 400);
                  body = parsed;
                  files = [{ name: upload.name, blob: upload }];
                } catch {
                  return structuredError("invalid_multipart", "Malformed multipart request", 400);
                }
              } else {
                const bodyText = new TextDecoder().decode(bytes);
                if (bodyText.length > 0) {
                  try {
                    const parsed: unknown = JSON.parse(bodyText);
                    if (typeof parsed !== "object" || parsed === null) return structuredError("invalid_body", "Request body must be a JSON object or array", 400);
                    body = parsed;
                  } catch {
                    return structuredError("invalid_body", "Request body must be valid JSON", 400);
                  }
                }
              }
            }

            const run = executeDiscordRequest(method, route, body, files);
            if (cacheKey) inFlight.set(cacheKey, run);

            try {
              const result = await run;
              if (cacheKey) completed.set(cacheKey, result);
              if (result.status === 204) return new Response(null, { status: 204 });
              return Response.json(result.body, { status: result.status });
            } finally {
              if (cacheKey) inFlight.delete(cacheKey);
            }
          } catch (error) {
            const status = readErrorStatus(error);
            // Discord returns 404 for lookups that miss (e.g. GET voice-state when
            // the member is not connected). That is expected application traffic.
            if (status === 404) {
              options.logger.debug("REST proxy upstream not found", {
                method,
                routeClass,
                requestId,
                status,
              });
            } else {
              options.metrics.increment("restProxyErrors");
              options.logger.error("REST proxy request failed", {
                method,
                routeClass,
                requestId,
                status,
                error,
              });
            }
            return structuredError(
              "proxy_request_failed",
              error instanceof Error ? error.message : "unknown_error",
              status,
            );
          }
        },
      });

      options.logger.info("Coordinator REST proxy listening", {
        host: options.host,
        port: options.port,
      });
    },

    async stop(): Promise<void> {
      if (!server) return;
      await server.stop(true);
      server = undefined;
      options.logger.info("Coordinator REST proxy stopped");
    },
  };
}
