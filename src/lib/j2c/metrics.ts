export interface J2cMetricsSnapshot {
  readonly creationAttempts: number;
  readonly creationSuccesses: number;
  readonly duplicateCreationsPrevented: number;
  readonly creationFailures: number;
  readonly compensatingDeletions: number;
  readonly emptyDeletionAttempts: number;
  readonly deletionSuccesses: number;
  readonly reconciliationFindings: number;
  readonly poisonedLifecycleOperations: number;
  readonly activeTemporaryChannels: number;
}

type J2cCounterName = keyof Omit<J2cMetricsSnapshot, "activeTemporaryChannels">;

export interface J2cMetrics {
  increment(name: J2cCounterName, by?: number): void;
  setActiveTemporaryChannels(count: number): void;
  snapshot(): J2cMetricsSnapshot;
}

export function createJ2cMetrics(): J2cMetrics {
  const counts: Record<keyof J2cMetricsSnapshot, number> = {
    creationAttempts: 0,
    creationSuccesses: 0,
    duplicateCreationsPrevented: 0,
    creationFailures: 0,
    compensatingDeletions: 0,
    emptyDeletionAttempts: 0,
    deletionSuccesses: 0,
    reconciliationFindings: 0,
    poisonedLifecycleOperations: 0,
    activeTemporaryChannels: 0,
  };

  return {
    increment(name, by = 1): void {
      counts[name] += by;
    },
    setActiveTemporaryChannels(count): void {
      counts.activeTemporaryChannels = count;
    },
    snapshot(): J2cMetricsSnapshot {
      return { ...counts };
    },
  };
}
