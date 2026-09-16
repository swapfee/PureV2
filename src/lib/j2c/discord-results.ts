/** Typed Discord lookup / mutation outcomes for J2C. */
export type DiscordLookupResult<T> =
  | { readonly kind: "found"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "transient"; readonly message: string };

export type DiscordMutationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "missing" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "transient"; readonly message: string };

export function classifyDiscordError(error: unknown): DiscordLookupResult<never>["kind"] | "other" {
  const status = readStatus(error);
  if (status === 404) return "missing";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 400) return "forbidden";
  if (status >= 500 || status === 429 || status === 0) return "transient";
  return "other";
}

export function toDiscordOperationResult(error: unknown): DiscordMutationResult {
  const kind = classifyDiscordError(error);
  if (kind === "missing") return { kind: "missing" };
  if (kind === "forbidden") return { kind: "forbidden" };
  return {
    kind: "transient",
    message: error instanceof Error ? error.message : "transient_error",
  };
}

export function toDiscordValueResult<T>(error: unknown): DiscordLookupResult<T> {
  const operation = toDiscordOperationResult(error);
  if (operation.kind === "ok") {
    return { kind: "transient", message: "unexpected_ok" };
  }
  if (operation.kind === "transient") return operation;
  return operation;
}

function readStatus(error: unknown): number {
  if (typeof error !== "object" || error === null) return 0;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("cause" in error && typeof error.cause === "object" && error.cause !== null && "status" in error.cause) {
    const status = error.cause.status;
    if (typeof status === "number") return status;
  }
  return 0;
}
