import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/);

const gatewayPayloadSchema = z.object({
  op: z.number().int(),
  t: z.string().nullable().optional(),
  s: z.number().int().nullable().optional(),
  d: z.unknown().optional(),
});

const statsMetricsSchema = z.object({
  sessionOpens: z.number().int().nonnegative(),
  sessionCloses: z.number().int().nonnegative(),
  deduplicatedEvents: z.number().int().nonnegative(),
  reconciliationFindings: z.number().int().nonnegative(),
  redisFailures: z.number().int().nonnegative(),
  renders: z.number().int().nonnegative(),
  renderFailures: z.number().int().nonnegative(),
});

export const workerHelloMessageSchema = z.object({
  type: z.literal("workerHello"),
  workerId: z.number().int().min(0).max(1),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
});

export const workerReadyMessageSchema = z.object({
  type: z.literal("workerReady"),
  workerId: z.number().int().min(0).max(1),
  mongoReady: z.boolean(),
  modulesReady: z.boolean(),
  statsReady: z.boolean(),
  statsMetrics: statsMetricsSchema,
  at: z.string().datetime(),
});

export const heartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
  workerId: z.number().int().min(0).max(1),
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime(),
  inFlightCount: z.number().int().nonnegative(),
  mongoReady: z.boolean(),
  statsReady: z.boolean(),
  statsMetrics: statsMetricsSchema,
});

export const gatewayEventMessageSchema = z.object({
  type: z.literal("gatewayEvent"),
  eventId: z.string().uuid(),
  shardId: z.number().int().nonnegative(),
  guildId: snowflakeSchema.optional(),
  payload: gatewayPayloadSchema,
  enqueuedAt: z.string().datetime(),
  attempt: z.number().int().min(1).default(1),
});

const voiceSnapshotStateSchema = z.object({
  userId: snowflakeSchema,
  channelId: snowflakeSchema,
});

export const voiceStateSnapshotMessageSchema = z.object({
  type: z.literal("voiceStateSnapshot"),
  snapshotId: z.string().uuid(),
  workerId: z.number().int().min(0).max(1),
  guilds: z.array(z.object({
    guildId: snowflakeSchema,
    states: z.array(voiceSnapshotStateSchema).max(10_000),
  })).max(10_000),
  at: z.string().datetime(),
});

export const voiceStateSnapshotAckMessageSchema = z.object({
  type: z.literal("voiceStateSnapshotAck"),
  snapshotId: z.string().uuid(),
  workerId: z.number().int().min(0).max(1),
  ok: z.boolean(),
  statsReady: z.boolean(),
  at: z.string().datetime(),
  error: z.string().min(1).max(2_000).optional(),
});

export const eventAckMessageSchema = z.object({
  type: z.literal("eventAck"),
  workerId: z.number().int().min(0).max(1),
  eventId: z.string().uuid(),
  at: z.string().datetime(),
});

export const eventNackMessageSchema = z.object({
  type: z.literal("eventNack"),
  workerId: z.number().int().min(0).max(1),
  eventId: z.string().uuid(),
  at: z.string().datetime(),
  reason: z.string().min(1).max(2_000),
  retryable: z.boolean(),
});

export const shutdownMessageSchema = z.object({
  type: z.literal("shutdown"),
  reason: z.string().min(1).max(200),
  deadlineAt: z.string().datetime(),
});

export const workerFatalMessageSchema = z.object({
  type: z.literal("workerFatal"),
  workerId: z.number().int().min(0).max(1),
  at: z.string().datetime(),
  message: z.string().min(1).max(2_000),
});

export const ipcMessageSchema = z.discriminatedUnion("type", [
  workerHelloMessageSchema,
  workerReadyMessageSchema,
  heartbeatMessageSchema,
  gatewayEventMessageSchema,
  voiceStateSnapshotMessageSchema,
  voiceStateSnapshotAckMessageSchema,
  eventAckMessageSchema,
  eventNackMessageSchema,
  shutdownMessageSchema,
  workerFatalMessageSchema,
]);

export type WorkerHelloMessage = z.infer<typeof workerHelloMessageSchema>;
export type WorkerReadyMessage = z.infer<typeof workerReadyMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
export type GatewayEventMessage = z.infer<typeof gatewayEventMessageSchema>;
export type VoiceStateSnapshotMessage = z.infer<typeof voiceStateSnapshotMessageSchema>;
export type VoiceStateSnapshotAckMessage = z.infer<typeof voiceStateSnapshotAckMessageSchema>;
export type EventAckMessage = z.infer<typeof eventAckMessageSchema>;
export type EventNackMessage = z.infer<typeof eventNackMessageSchema>;
export type ShutdownMessage = z.infer<typeof shutdownMessageSchema>;
export type WorkerFatalMessage = z.infer<typeof workerFatalMessageSchema>;
export type IpcMessage = z.infer<typeof ipcMessageSchema>;

export type ParseIpcResult =
  | { readonly ok: true; readonly message: IpcMessage }
  | { readonly ok: false; readonly error: string };

export function parseIpcMessage(value: unknown): ParseIpcResult {
  const result = ipcMessageSchema.safeParse(value);
  if (result.success) return { ok: true, message: result.data };
  return { ok: false, error: z.prettifyError(result.error) };
}

export function assertIpcMessage(value: unknown): IpcMessage {
  const parsed = parseIpcMessage(value);
  if (!parsed.ok) throw new Error(`Invalid IPC message:\n${parsed.error}`);
  return parsed.message;
}
