import { describe, expect, test } from "bun:test";

import {
  assertExclusiveShardOwnership,
  assignWorker,
  shardsForWorker,
} from "../src/lib/sharding.ts";

describe("assignWorker", () => {
  test("routes all shards to worker 0 when only one worker is active", () => {
    expect(assignWorker(0, 1)).toBe(0);
    expect(assignWorker(1, 1)).toBe(0);
    expect(assignWorker(99, 1)).toBe(0);
  });

  test("uses shardId % activeWorkerCount for two workers", () => {
    expect(assignWorker(0, 2)).toBe(0);
    expect(assignWorker(1, 2)).toBe(1);
    expect(assignWorker(2, 2)).toBe(0);
    expect(assignWorker(3, 2)).toBe(1);
  });

  test("rejects invalid worker counts and shard ids", () => {
    expect(() => assignWorker(-1, 1)).toThrow(/shardId/);
    expect(() => assignWorker(0, 0)).toThrow(/activeWorkerCount/);
    expect(() => assignWorker(0, 3)).toThrow(/activeWorkerCount/);
  });
});

describe("assertExclusiveShardOwnership", () => {
  test("never assigns the same shard to two workers", () => {
    const ownership = assertExclusiveShardOwnership([0, 1, 2, 3], 2);
    expect(ownership.get(0)).toBe(0);
    expect(ownership.get(1)).toBe(1);
    expect(ownership.get(2)).toBe(0);
    expect(ownership.get(3)).toBe(1);
  });

  test("partitions shards without overlap for one and two workers", () => {
    const shards = [0, 1, 2, 3, 4];
    for (const workerCount of [1, 2] as const) {
      const seen = new Set<number>();
      for (let workerId = 0; workerId < workerCount; workerId += 1) {
        for (const shardId of shardsForWorker(shards, workerId, workerCount)) {
          expect(seen.has(shardId)).toBe(false);
          seen.add(shardId);
          expect(assignWorker(shardId, workerCount)).toBe(workerId);
        }
      }
      expect(seen.size).toBe(shards.length);
    }
  });
});
