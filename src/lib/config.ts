import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake");

const mongoUriSchema = z.string().refine(
  (value) => value.startsWith("mongodb://") || value.startsWith("mongodb+srv://"),
  "must use the mongodb:// or mongodb+srv:// scheme",
);

const loopbackHostSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === "127.0.0.1" || value === "localhost" || value === "::1",
    "must bind to a loopback address (127.0.0.1, localhost, or ::1)",
  );

/** Health may bind all interfaces inside Docker; Compose must publish only to host loopback. */
const healthHostSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value === "127.0.0.1" ||
      value === "localhost" ||
      value === "::1" ||
      value === "0.0.0.0",
    "must bind to loopback or 0.0.0.0 (Docker health binding only)",
  );

const commonSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "fatal"]).default("info"),
});

const databaseSchema = z.object({
  MONGODB_URI: mongoUriSchema,
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(20).default(3),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  MONGODB_WAIT_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
});

const restProxySchema = z.object({
  REST_PROXY_HOST: loopbackHostSchema.default("127.0.0.1"),
  REST_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
  REST_PROXY_AUTHORIZATION: z.string().min(16, "must be at least 16 characters"),
  REST_PROXY_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
  REST_REQUEST_CACHE_LIMIT: z.coerce.number().int().min(1).max(50_000).default(5_000),
  REST_REQUEST_CACHE_TTL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
});

/** Private coordinator API for the dashboard container; never publish this port. */
const dashboardApiSchema = z.object({
  DASHBOARD_API_HOST: healthHostSchema.default("127.0.0.1"),
  DASHBOARD_API_PORT: z.coerce.number().int().min(1).max(65_535).default(8082),
  DASHBOARD_API_AUTHORIZATION: z.string().min(32).optional(),
  DASHBOARD_API_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(32_768),
});

const workerLifecycleSchema = z.object({
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
  WORKER_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
  WORKER_RESTART_BASE_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  WORKER_RESTART_MAX_DELAY_MS: z.coerce.number().int().min(500).max(300_000).default(30_000),
  WORKER_EVENT_ACK_TIMEOUT_MS: z.coerce.number().int().min(500).max(300_000).default(30_000),
  WORKER_EVENT_BUFFER_LIMIT: z.coerce.number().int().min(1).max(10_000).default(1_000),
  WORKER_EVENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  WORKER_EVENT_DEDUP_LIMIT: z.coerce.number().int().min(1).max(100_000).default(5_000),
  WORKER_EVENT_DEDUP_TTL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
});

const coordinatorSchema = commonSchema
  .extend({
    DISCORD_TOKEN: z.string().min(1, "is required"),
    DISCORD_APPLICATION_ID: snowflakeSchema,
    MONGODB_URI: databaseSchema.shape.MONGODB_URI,
    MONGODB_MAX_POOL_SIZE: databaseSchema.shape.MONGODB_MAX_POOL_SIZE,
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: databaseSchema.shape.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    MONGODB_WAIT_QUEUE_TIMEOUT_MS: databaseSchema.shape.MONGODB_WAIT_QUEUE_TIMEOUT_MS,
    BOT_WORKER_COUNT: z.coerce.number().int().min(1).max(2).default(1),
    HEALTH_HOST: healthHostSchema.default("127.0.0.1"),
    HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  })
  .extend(restProxySchema.shape)
  .extend(dashboardApiSchema.shape)
  .extend(workerLifecycleSchema.shape)
  .superRefine((value, context) => {
    if (value.WORKER_HEARTBEAT_TIMEOUT_MS <= value.WORKER_HEARTBEAT_INTERVAL_MS) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_HEARTBEAT_TIMEOUT_MS"],
        message: "must be greater than WORKER_HEARTBEAT_INTERVAL_MS",
      });
    }
    if (value.WORKER_RESTART_MAX_DELAY_MS < value.WORKER_RESTART_BASE_DELAY_MS) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_RESTART_MAX_DELAY_MS"],
        message: "must be greater than or equal to WORKER_RESTART_BASE_DELAY_MS",
      });
    }
    // Production: REST proxy must never leave loopback (health may use 0.0.0.0 in Docker).
    if (
      value.NODE_ENV === "production" &&
      value.REST_PROXY_HOST !== "127.0.0.1" &&
      value.REST_PROXY_HOST !== "localhost" &&
      value.REST_PROXY_HOST !== "::1"
    ) {
      context.addIssue({
        code: "custom",
        path: ["REST_PROXY_HOST"],
        message: "must remain loopback in production",
      });
    }
  });

/**
 * Worker processes never receive DISCORD_TOKEN.
 * Discordeno createBot still requires a token string for ID parsing; workers use a
 * synthetic token derived from DISCORD_APPLICATION_ID (see worker/bot.ts).
 */
const workerSchema = commonSchema
  .extend({
    DISCORD_APPLICATION_ID: snowflakeSchema,
    MONGODB_URI: databaseSchema.shape.MONGODB_URI,
    MONGODB_MAX_POOL_SIZE: databaseSchema.shape.MONGODB_MAX_POOL_SIZE,
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: databaseSchema.shape.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    MONGODB_WAIT_QUEUE_TIMEOUT_MS: databaseSchema.shape.MONGODB_WAIT_QUEUE_TIMEOUT_MS,
    BOT_WORKER_ID: z.coerce.number().int().min(0),
    BOT_WORKER_COUNT: z.coerce.number().int().min(1).max(2),
    WORKER_HEARTBEAT_INTERVAL_MS: workerLifecycleSchema.shape.WORKER_HEARTBEAT_INTERVAL_MS,
    WORKER_EVENT_DEDUP_LIMIT: workerLifecycleSchema.shape.WORKER_EVENT_DEDUP_LIMIT,
    WORKER_EVENT_DEDUP_TTL_MS: workerLifecycleSchema.shape.WORKER_EVENT_DEDUP_TTL_MS,
    REST_PROXY_HOST: restProxySchema.shape.REST_PROXY_HOST,
    REST_PROXY_PORT: restProxySchema.shape.REST_PROXY_PORT,
    REST_PROXY_AUTHORIZATION: restProxySchema.shape.REST_PROXY_AUTHORIZATION,
    PUREV2_REST_PROXY_BASE_URL: z.string().url().optional(),
  })
  .superRefine((value, context) => {
    if (value.BOT_WORKER_ID >= value.BOT_WORKER_COUNT) {
      context.addIssue({
        code: "custom",
        path: ["BOT_WORKER_ID"],
        message: "must be less than BOT_WORKER_COUNT",
      });
    }
  });

const registrationSchema = commonSchema.extend({
  DISCORD_TOKEN: z.string().min(1, "is required"),
  DISCORD_APPLICATION_ID: snowflakeSchema,
});

/** Index maintenance needs Mongo only — no Discord token, Gateway, or workers. */
const indexMaintenanceSchema = commonSchema.extend({
  MONGODB_URI: databaseSchema.shape.MONGODB_URI,
  MONGODB_MAX_POOL_SIZE: databaseSchema.shape.MONGODB_MAX_POOL_SIZE,
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: databaseSchema.shape.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
  MONGODB_WAIT_QUEUE_TIMEOUT_MS: databaseSchema.shape.MONGODB_WAIT_QUEUE_TIMEOUT_MS,
});

export type CoordinatorConfig = Readonly<z.infer<typeof coordinatorSchema>>;
export type WorkerConfig = Readonly<z.infer<typeof workerSchema>>;
export type RegistrationConfig = Readonly<z.infer<typeof registrationSchema>>;
export type IndexMaintenanceConfig = Readonly<z.infer<typeof indexMaintenanceSchema>>;

type Environment = Readonly<Record<string, string | undefined>>;

function parseConfig<T>(schema: z.ZodType<T>, environment: Environment, role: string): Readonly<T> {
  const result = schema.safeParse(environment);
  if (result.success) return Object.freeze(result.data);

  const issues = result.error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "environment";
    return `${field}: ${issue.message}`;
  });

  throw new Error(`Invalid ${role} configuration:\n${issues.join("\n")}`);
}

export function parseCoordinatorConfig(environment: Environment = Bun.env): CoordinatorConfig {
  return parseConfig(coordinatorSchema, environment, "coordinator");
}

export function parseWorkerConfig(environment: Environment = Bun.env): WorkerConfig {
  if (environment.DISCORD_TOKEN !== undefined) {
    throw new Error("Invalid worker configuration:\nDISCORD_TOKEN: must not be present in worker processes");
  }
  return parseConfig(workerSchema, environment, "worker");
}

export function parseRegistrationConfig(environment: Environment = Bun.env): RegistrationConfig {
  return parseConfig(registrationSchema, environment, "command registration");
}

export function parseIndexMaintenanceConfig(
  environment: Environment = Bun.env,
): IndexMaintenanceConfig {
  return parseConfig(indexMaintenanceSchema, environment, "index maintenance");
}

export function restProxyBaseUrl(
  config: Pick<CoordinatorConfig, "REST_PROXY_HOST" | "REST_PROXY_PORT"> | Pick<WorkerConfig, "REST_PROXY_HOST" | "REST_PROXY_PORT" | "PUREV2_REST_PROXY_BASE_URL">,
): string {
  if ("PUREV2_REST_PROXY_BASE_URL" in config && config.PUREV2_REST_PROXY_BASE_URL) {
    return config.PUREV2_REST_PROXY_BASE_URL;
  }
  return `http://${config.REST_PROXY_HOST}:${config.REST_PROXY_PORT}`;
}

/** Explicit allowlist of environment variables passed to child workers. Never includes DISCORD_TOKEN. */
export function buildWorkerProcessEnv(
  config: CoordinatorConfig,
  workerId: number,
  restProxyUrl: string,
): Record<string, string> {
  return {
    NODE_ENV: config.NODE_ENV,
    LOG_LEVEL: config.LOG_LEVEL,
    DISCORD_APPLICATION_ID: config.DISCORD_APPLICATION_ID,
    MONGODB_URI: config.MONGODB_URI,
    MONGODB_MAX_POOL_SIZE: String(config.MONGODB_MAX_POOL_SIZE),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: String(config.MONGODB_SERVER_SELECTION_TIMEOUT_MS),
    MONGODB_WAIT_QUEUE_TIMEOUT_MS: String(config.MONGODB_WAIT_QUEUE_TIMEOUT_MS),
    BOT_WORKER_ID: String(workerId),
    BOT_WORKER_COUNT: String(config.BOT_WORKER_COUNT),
    WORKER_HEARTBEAT_INTERVAL_MS: String(config.WORKER_HEARTBEAT_INTERVAL_MS),
    WORKER_EVENT_DEDUP_LIMIT: String(config.WORKER_EVENT_DEDUP_LIMIT),
    WORKER_EVENT_DEDUP_TTL_MS: String(config.WORKER_EVENT_DEDUP_TTL_MS),
    REST_PROXY_HOST: config.REST_PROXY_HOST,
    REST_PROXY_PORT: String(config.REST_PROXY_PORT),
    REST_PROXY_AUTHORIZATION: config.REST_PROXY_AUTHORIZATION,
    PUREV2_REST_PROXY_BASE_URL: restProxyUrl,
  };
}

/**
 * Build a child-process environment that retains OS essentials (PATH, etc.)
 * while stripping Discord credentials and overlaying the worker allowlist.
 */
export function buildWorkerSpawnEnv(
  config: CoordinatorConfig,
  workerId: number,
  restProxyUrl: string,
  parentEnv: Environment = Bun.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value !== "string") continue;
    if (key === "DISCORD_TOKEN") continue;
    if (/token|secret|password|authorization/i.test(key) && key !== "REST_PROXY_AUTHORIZATION") {
      // Drop parent secrets; workers only receive the explicit allowlist values below.
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...buildWorkerProcessEnv(config, workerId, restProxyUrl) };
}
