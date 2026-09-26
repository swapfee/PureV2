import { z } from "zod";

import type { DiscordApiPort } from "../runtime-types.ts";
import type { Logger } from "../logger.ts";
import type {
  GuildConfigRepository,
  TemporaryChannelRepository,
} from "../j2c/repositories.ts";
import type { VoiceStatsRepository } from "../stats/repositories.ts";
import { normalizeTimeZone, overlapSeconds, zonedDayWindows } from "../time-zone.ts";
import { timingSafeEqualString } from "../security.ts";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/);
const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    lobbyChannelName: z.string().trim().min(1).max(100).optional(),
    categoryName: z.string().trim().min(1).max(100).optional(),
    channelNameTemplate: z.string().trim().min(1).max(100).optional(),
    defaultUserLimit: z.number().int().min(0).max(99).optional(),
    ownerCanEdit: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one setting is required");

export type DashboardConfigUpdate = Readonly<z.infer<typeof updateSchema>>;

export interface DashboardControlApiOptions {
  readonly host: string;
  readonly port: number;
  readonly authorization: string;
  readonly bodyLimitBytes: number;
  readonly configs: GuildConfigRepository;
  readonly channels: TemporaryChannelRepository;
  readonly stats: Pick<VoiceStatsRepository, "listGuildSessionsOverlapping">;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly isReady: () => boolean;
  readonly now?: () => Date;
}

export interface DashboardControlApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  isListening(): boolean;
  readonly url: string;
}

interface DashboardSnapshotDto {
  readonly guildId: string;
  readonly timeZone: string;
  readonly configuration: {
    readonly enabled: boolean;
    readonly lobbyChannelId: string;
    readonly lobbyChannelName: string;
    readonly categoryId: string;
    readonly categoryName: string;
    readonly channelNameTemplate: string;
    readonly defaultUserLimit: number;
    readonly ownerCanEdit: boolean;
    readonly interfaceEnabled: boolean;
    readonly updatedAt: string;
  };
  readonly channels: readonly {
    readonly id: string;
    readonly name: string;
    readonly ownerId: string;
    readonly memberCount: number;
    readonly userLimit: number;
    readonly locked: boolean;
    readonly hidden: boolean;
    readonly createdAt: string;
  }[];
  readonly summary: {
    readonly activeChannels: number;
    readonly connectedMembers: number;
    readonly voiceSeconds: number;
    readonly voiceSessions: number;
  };
  readonly voiceActivity: readonly {
    readonly day: string;
    readonly seconds: number;
  }[];
}

type DashboardRangeDays = 7 | 30;

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

async function readJson(request: Request, bodyLimitBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new TypeError("content_type");

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > bodyLimitBytes) {
    throw new RangeError("body_too_large");
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > bodyLimitBytes) throw new RangeError("body_too_large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new SyntaxError("invalid_json");
  }
}

async function resolveChannelName(
  discord: DiscordApiPort,
  channelId: string,
  fallback: string,
): Promise<string> {
  const result = await discord.getChannel({ channelId });
  return result.kind === "found" && result.value.name ? result.value.name : fallback;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  let cursor = 0;
  const batches = await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      const batch: { readonly index: number; readonly result: R }[] = [];
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value !== undefined) batch.push({ index, result: await transform(value) });
      }
      return batch;
    }),
  );
  return batches.flat().toSorted((left, right) => left.index - right.index).map(({ result }) => result);
}

async function buildVoiceActivity(
  guildId: string,
  days: DashboardRangeDays,
  now: Date,
  timeZone: string,
  stats: DashboardControlApiOptions["stats"],
): Promise<{
  readonly points: readonly { readonly day: string; readonly seconds: number }[];
  readonly totalSeconds: number;
  readonly sessionCount: number;
}> {
  const windows = zonedDayWindows(now, days, timeZone);
  const firstWindow = windows[0];
  if (!firstWindow) return { points: [], totalSeconds: 0, sessionCount: 0 };
  const sessions = await stats.listGuildSessionsOverlapping(guildId, firstWindow.start, now);
  const secondsByDay = new Map(windows.map((window) => [window.key, 0]));
  let sessionCount = 0;

  for (const session of sessions) {
    const sessionEnd = session.status === "active"
      ? now
      : session.endedAt ?? session.lastConfirmedAt;
    let counted = false;
    for (const window of windows) {
      const seconds = overlapSeconds(session.startedAt, sessionEnd, window);
      if (seconds === 0) continue;
      counted = true;
      secondsByDay.set(window.key, (secondsByDay.get(window.key) ?? 0) + seconds);
    }
    if (counted) sessionCount += 1;
  }

  const points = windows.map((window) => ({
    day: window.key,
    seconds: secondsByDay.get(window.key) ?? 0,
  }));
  return {
    points,
    totalSeconds: points.reduce((total, point) => total + point.seconds, 0),
    sessionCount,
  };
}

async function buildSnapshot(
  guildId: string,
  options: DashboardControlApiOptions,
  days: DashboardRangeDays = 7,
  timeZone = "UTC",
): Promise<DashboardSnapshotDto | undefined> {
  const config = await options.configs.findByGuildId(guildId);
  if (!config) return undefined;

  const records = await options.channels.listByGuild(guildId);
  const activeRecords = records.filter((record) => record.status === "active").slice(0, 100);
  const now = options.now?.() ?? new Date();
  const [lobbyChannelName, categoryName, channelNames, voice] = await Promise.all([
    resolveChannelName(options.discord, config.lobbyChannelId, "Join to Create"),
    resolveChannelName(options.discord, config.categoryId, "Temporary Voice Channel"),
    mapWithConcurrency(
      activeRecords,
      5,
      (record) => resolveChannelName(
        options.discord,
        record.channelId,
        `Channel ${record.channelId.slice(-4)}`,
      ),
    ),
    buildVoiceActivity(guildId, days, now, timeZone, options.stats),
  ]);

  const activeChannels = activeRecords.map((record, index) => ({
    id: record.channelId,
    name: channelNames[index] ?? `Channel ${record.channelId.slice(-4)}`,
    ownerId: record.ownerId,
    memberCount: record.occupantIds.length,
    userLimit: config.defaultUserLimit ?? 0,
    locked: record.locked,
    hidden: false,
    createdAt: record.createdAt.toISOString(),
  }));

  return {
    guildId,
    timeZone,
    configuration: {
      enabled: config.enabled,
      lobbyChannelId: config.lobbyChannelId,
      lobbyChannelName,
      categoryId: config.categoryId,
      categoryName,
      channelNameTemplate: config.channelNameTemplate,
      defaultUserLimit: config.defaultUserLimit ?? 0,
      ownerCanEdit: config.ownerCanEdit,
      interfaceEnabled: config.interfaceChannelId !== undefined,
      updatedAt: config.updatedAt.toISOString(),
    },
    channels: activeChannels,
    voiceActivity: voice.points,
    summary: {
      activeChannels: activeChannels.length,
      connectedMembers: activeChannels.reduce((total, channel) => total + channel.memberCount, 0),
      voiceSeconds: voice.totalSeconds,
      voiceSessions: voice.sessionCount,
    },
  };
}

async function updateConfiguration(
  guildId: string,
  update: DashboardConfigUpdate,
  options: DashboardControlApiOptions,
  requestId: string,
  days: DashboardRangeDays,
  timeZone: string,
): Promise<DashboardSnapshotDto | undefined> {
  const current = await options.configs.findByGuildId(guildId);
  if (!current) return undefined;

  const renameRequests = [
    update.lobbyChannelName === undefined
      ? undefined
      : { channelId: current.lobbyChannelId, name: update.lobbyChannelName, suffix: "lobby" },
    update.categoryName === undefined
      ? undefined
      : { channelId: current.categoryId, name: update.categoryName, suffix: "category" },
  ].filter((value): value is { channelId: string; name: string; suffix: string } => value !== undefined);

  for (const rename of renameRequests) {
    const result = await options.discord.editChannel({
      channelId: rename.channelId,
      name: rename.name,
      requestId: `dashboard:config:${guildId}:${rename.suffix}:${requestId}`,
      reason: "Pure dashboard configuration update",
    });
    if (result.kind !== "ok") {
      throw new Error(`Discord channel update failed: ${result.kind}`);
    }
  }

  await options.configs.upsert({
    guildId,
    enabled: update.enabled ?? current.enabled,
    lobbyChannelId: current.lobbyChannelId,
    categoryId: current.categoryId,
    ...(current.errorLogChannelId === undefined ? {} : { errorLogChannelId: current.errorLogChannelId }),
    ...(current.interfaceChannelId === undefined ? {} : { interfaceChannelId: current.interfaceChannelId }),
    channelNameTemplate: update.channelNameTemplate ?? current.channelNameTemplate,
    ...(update.defaultUserLimit === undefined && current.defaultUserLimit === undefined
      ? {}
      : { defaultUserLimit: update.defaultUserLimit ?? current.defaultUserLimit }),
    ownerCanEdit: update.ownerCanEdit ?? current.ownerCanEdit,
    permissionSource: current.permissionSource,
    namingMode: current.namingMode,
    sequenceNext: current.sequenceNext,
    channelHoist: current.channelHoist,
    moderatorRoleIds: current.moderatorRoleIds,
  });

  return buildSnapshot(guildId, options, days, timeZone);
}

export function createDashboardControlApi(options: DashboardControlApiOptions): DashboardControlApi {
  let server: ReturnType<typeof Bun.serve> | undefined;

  return {
    get url(): string {
      return `http://${options.host}:${server?.port ?? options.port}`;
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
            return errorResponse("unauthorized", "Invalid or missing authorization", 401);
          }
          if (!options.isReady()) {
            return errorResponse("not_ready", "Coordinator is not ready", 503);
          }

          const url = new URL(request.url);
          const match = /^\/v1\/dashboard\/guilds\/(\d{17,20})\/(snapshot|config)$/.exec(url.pathname);
          if (!match) return errorResponse("not_found", "Route not found", 404);
          const guildId = match[1];
          const resource = match[2];
          if (!guildId || !snowflakeSchema.safeParse(guildId).success || !resource) {
            return errorResponse("invalid_route", "Invalid guild route", 400);
          }
          const requestedDays = Number(url.searchParams.get("days") ?? "7");
          if (requestedDays !== 7 && requestedDays !== 30) {
            return errorResponse("invalid_range", "Statistics range must be 7 or 30 days", 400);
          }
          const requestedTimeZone = url.searchParams.get("timezone") ?? "UTC";
          const timeZone = normalizeTimeZone(requestedTimeZone);
          if (!timeZone) {
            return errorResponse("invalid_timezone", "Timezone must be a valid IANA timezone", 400);
          }

          try {
            if (request.method === "GET") {
              const snapshot = await buildSnapshot(guildId, options, requestedDays, timeZone);
              if (!snapshot) return errorResponse("not_configured", "Join to Create is not configured", 404);
              if (resource === "snapshot") return Response.json({ ok: true, snapshot });
              return Response.json({ ok: true, configuration: snapshot.configuration });
            }

            if (request.method === "PUT" && resource === "config") {
              const parsed = updateSchema.safeParse(await readJson(request, options.bodyLimitBytes));
              if (!parsed.success) {
                return errorResponse("invalid_configuration", "Configuration payload is invalid", 400);
              }
              const requestId = request.headers.get("x-request-id")?.slice(0, 100) || crypto.randomUUID();
              const snapshot = await updateConfiguration(
                guildId,
                parsed.data,
                options,
                requestId,
                requestedDays,
                timeZone,
              );
              if (!snapshot) return errorResponse("not_configured", "Join to Create is not configured", 404);
              options.logger.info("Dashboard configuration updated", { guildId });
              return Response.json({ ok: true, snapshot });
            }

            return errorResponse("method_not_allowed", "Method not allowed", 405);
          } catch (error) {
            if (error instanceof RangeError) return errorResponse("body_too_large", "Request body is too large", 413);
            if (error instanceof TypeError) return errorResponse("unsupported_media_type", "Content-Type must be application/json", 415);
            if (error instanceof SyntaxError) return errorResponse("invalid_json", "Request body is not valid JSON", 400);
            options.logger.error("Dashboard control API request failed", {
              guildId,
              error: error instanceof Error ? error.message : "unknown_error",
            });
            return errorResponse("internal_error", "Unable to process dashboard request", 500);
          }
        },
      });
      options.logger.info("Dashboard control API listening", { host: options.host, port: server.port });
    },

    async stop(): Promise<void> {
      if (!server) return;
      await server.stop(true);
      server = undefined;
    },
  };
}
