export interface CoordinatorMetricsSnapshot {
  readonly eventsForwarded: number;
  readonly eventsAcked: number;
  readonly eventsNacked: number;
  readonly workerRestarts: number;
  readonly restProxyRequests: number;
  readonly restProxyErrors: number;
}

export interface CoordinatorMetrics {
  increment(name: keyof CoordinatorMetricsSnapshot, by?: number): void;
  snapshot(): CoordinatorMetricsSnapshot;
}

export function createCoordinatorMetrics(): CoordinatorMetrics {
  const counts: Record<keyof CoordinatorMetricsSnapshot, number> = {
    eventsForwarded: 0,
    eventsAcked: 0,
    eventsNacked: 0,
    workerRestarts: 0,
    restProxyRequests: 0,
    restProxyErrors: 0,
  };

  return {
    increment(name, by = 1): void {
      counts[name] += by;
    },
    snapshot(): CoordinatorMetricsSnapshot {
      return { ...counts };
    },
  };
}
