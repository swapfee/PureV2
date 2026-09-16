export function computeRestartDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`attempt must be a non-negative integer, received ${attempt}`);
  }
  if (baseDelayMs <= 0 || maxDelayMs < baseDelayMs) {
    throw new Error("invalid restart delay bounds");
  }
  const delay = baseDelayMs * 2 ** attempt;
  return Math.min(maxDelayMs, delay);
}

export interface RestartBackoffState {
  readonly attempt: number;
  nextDelayMs(): number;
  success(): RestartBackoffState;
  failure(): RestartBackoffState;
}

export function createRestartBackoff(baseDelayMs: number, maxDelayMs: number): RestartBackoffState {
  const create = (attempt: number): RestartBackoffState => ({
    attempt,
    nextDelayMs: () => computeRestartDelayMs(attempt, baseDelayMs, maxDelayMs),
    success: () => create(0),
    failure: () => create(attempt + 1),
  });
  return create(0);
}
