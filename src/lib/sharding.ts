/**
 * Deterministic shard-to-worker assignment.
 * Matches Discordeno's default calculateWorkerId formula: shardId % workerCount.
 * Never invents shards; never assigns one shard to two workers for a given count.
 */
export function assignWorker(shardId: number, activeWorkerCount: number): number {
  if (!Number.isInteger(shardId) || shardId < 0) {
    throw new Error(`shardId must be a non-negative integer, received ${shardId}`);
  }
  if (!Number.isInteger(activeWorkerCount) || activeWorkerCount < 1 || activeWorkerCount > 2) {
    throw new Error(`activeWorkerCount must be 1 or 2, received ${activeWorkerCount}`);
  }
  return shardId % activeWorkerCount;
}

export function assertExclusiveShardOwnership(
  shardIds: readonly number[],
  activeWorkerCount: number,
): ReadonlyMap<number, number> {
  const ownership = new Map<number, number>();

  for (const shardId of shardIds) {
    const workerId = assignWorker(shardId, activeWorkerCount);
    const existing = ownership.get(shardId);
    if (existing !== undefined && existing !== workerId) {
      throw new Error(`Shard ${shardId} would be owned by both worker ${existing} and ${workerId}`);
    }
    ownership.set(shardId, workerId);
  }

  return ownership;
}

export function shardsForWorker(
  shardIds: readonly number[],
  workerId: number,
  activeWorkerCount: number,
): readonly number[] {
  if (!Number.isInteger(workerId) || workerId < 0 || workerId >= activeWorkerCount) {
    throw new Error(`workerId ${workerId} is out of range for ${activeWorkerCount} workers`);
  }
  return shardIds.filter((shardId) => assignWorker(shardId, activeWorkerCount) === workerId);
}
