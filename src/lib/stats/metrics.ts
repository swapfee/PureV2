export interface VoiceStatsMetricsSnapshot {
  readonly sessionOpens: number;
  readonly sessionCloses: number;
  readonly deduplicatedEvents: number;
  readonly reconciliationFindings: number;
  readonly redisFailures: number;
  readonly renders: number;
  readonly renderFailures: number;
}

export type VoiceStatsCounter = keyof VoiceStatsMetricsSnapshot;

export interface VoiceStatsMetrics {
  increment(name: VoiceStatsCounter, by?: number): void;
  snapshot(): VoiceStatsMetricsSnapshot;
}

export function createVoiceStatsMetrics(): VoiceStatsMetrics {
  const values: Record<VoiceStatsCounter, number> = {
    sessionOpens: 0,
    sessionCloses: 0,
    deduplicatedEvents: 0,
    reconciliationFindings: 0,
    redisFailures: 0,
    renders: 0,
    renderFailures: 0,
  };
  return {
    increment(name, by = 1) { values[name] += by; },
    snapshot: () => ({ ...values }),
  };
}
