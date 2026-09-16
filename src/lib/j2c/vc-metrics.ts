/** Bounded-cardinality metrics for /vc management commands. */
export type VcSubcommand = "invite" | "rename" | "limit" | "lock" | "unlock";

export interface VcMetricsSnapshot {
  readonly attempts: Readonly<Record<VcSubcommand, number>>;
  readonly successes: Readonly<Record<VcSubcommand, number>>;
  readonly authorizationFailures: number;
  readonly validationFailures: number;
  readonly restFailures: number;
  readonly cooldownRejections: number;
  readonly replayDedups: number;
}

export interface VcMetrics {
  attempt(subcommand: VcSubcommand): void;
  success(subcommand: VcSubcommand): void;
  authorizationFailure(): void;
  validationFailure(): void;
  restFailure(): void;
  cooldownRejection(): void;
  replayDedup(): void;
  snapshot(): VcMetricsSnapshot;
}

function emptySubcounts(): Record<VcSubcommand, number> {
  return { invite: 0, rename: 0, limit: 0, lock: 0, unlock: 0 };
}

export function createVcMetrics(): VcMetrics {
  const attempts = emptySubcounts();
  const successes = emptySubcounts();
  let authorizationFailures = 0;
  let validationFailures = 0;
  let restFailures = 0;
  let cooldownRejections = 0;
  let replayDedups = 0;

  return {
    attempt(subcommand) {
      attempts[subcommand] += 1;
    },
    success(subcommand) {
      successes[subcommand] += 1;
    },
    authorizationFailure() {
      authorizationFailures += 1;
    },
    validationFailure() {
      validationFailures += 1;
    },
    restFailure() {
      restFailures += 1;
    },
    cooldownRejection() {
      cooldownRejections += 1;
    },
    replayDedup() {
      replayDedups += 1;
    },
    snapshot() {
      return {
        attempts: { ...attempts },
        successes: { ...successes },
        authorizationFailures,
        validationFailures,
        restFailures,
        cooldownRejections,
        replayDedups,
      };
    },
  };
}
