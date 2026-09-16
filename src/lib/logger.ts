export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

interface LoggerOptions {
  readonly service: string;
  readonly role: string;
  readonly level: LogLevel;
  readonly context?: LogContext;
  readonly sensitiveValues?: readonly string[];
  readonly write?: (line: string) => void;
}

const levelPriority: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const sensitiveKeyPattern = /authorization|cookie|credential|mongo(db)?(_?uri)?|password|secret|token/i;

function redactString(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) redacted = redacted.replaceAll(sensitiveValue, "[REDACTED]");
  }
  return redacted;
}

function sanitize(value: unknown, sensitiveValues: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value, sensitiveValues);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, sensitiveValues),
      stack: value.stack ? redactString(value.stack, sensitiveValues) : undefined,
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitize(item, sensitiveValues, seen));

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = sensitiveKeyPattern.test(key)
      ? "[REDACTED]"
      : sanitize(nestedValue, sensitiveValues, seen);
  }
  return sanitized;
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const baseContext = options.context ?? {};
  const sensitiveValues = (options.sensitiveValues ?? []).filter((value) => value.length > 0);

  const log = (level: LogLevel, message: string, context: LogContext = {}): void => {
    if (levelPriority[level] < levelPriority[options.level]) return;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      service: options.service,
      role: options.role,
      message,
      ...baseContext,
      ...context,
    };
    write(JSON.stringify(sanitize(record, sensitiveValues, new WeakSet<object>())));
  };

  return {
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context),
    fatal: (message, context) => log("fatal", message, context),
    child: (context) => createLogger({ ...options, context: { ...baseContext, ...context }, write }),
  };
}

export function createDiscordenoLogger(logger: Logger): {
  debug: (...arguments_: unknown[]) => void;
  info: (...arguments_: unknown[]) => void;
  warn: (...arguments_: unknown[]) => void;
  error: (...arguments_: unknown[]) => void;
  fatal: (...arguments_: unknown[]) => void;
} {
  const forward = (level: LogLevel, arguments_: readonly unknown[]): void => {
    const [first, ...rest] = arguments_;
    const message = typeof first === "string" ? first : "Discordeno log event";
    const context = rest.length > 0 || typeof first !== "string" ? { arguments: arguments_ } : undefined;
    logger[level](message, context);
  };

  return {
    debug: (...arguments_) => forward("debug", arguments_),
    info: (...arguments_) => forward("info", arguments_),
    warn: (...arguments_) => forward("warn", arguments_),
    error: (...arguments_) => forward("error", arguments_),
    fatal: (...arguments_) => forward("fatal", arguments_),
  };
}
