import { RedisClient } from "bun";

import type { VoiceStatsSessionRecord } from "../../models/voice-stats-session.ts";

const ACTIVE_TTL_SECONDS = 900;
const QUERY_TTL_SECONDS = 30;
const EVENT_TTL_SECONDS = 600;

export interface VoiceStatsCache {
  connect(): Promise<void>;
  refresh(): Promise<boolean>;
  isReady(): boolean;
  close(): void;
  setActive(session: VoiceStatsSessionRecord): Promise<void>;
  deleteActive(guildId: string, userId: string): Promise<void>;
  getJson(key: string): Promise<string | undefined>;
  setJson(key: string, value: string, ttlSeconds?: number): Promise<void>;
  hasRecentEvent(eventId: string): Promise<boolean>;
  markRecentEvent(eventId: string): Promise<void>;
  purgeGuild(guildId: string): Promise<void>;
}

function activeKey(guildId: string, userId: string): string {
  return `purev2:stats:active:${guildId}:${userId}`;
}

export function statsQueryCacheKey(guildId: string, userId: string): string {
  return `purev2:stats:query:${guildId}:${userId}`;
}

function eventKey(eventId: string): string { return `purev2:stats:event:${eventId}`; }

function isScanResponse(value: unknown): value is [string, string[]] {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "string" && Array.isArray(value[1]) &&
    value[1].every((item) => typeof item === "string");
}

export function createRedisVoiceStatsCache(url: string): VoiceStatsCache {
  const client = new RedisClient(url, {
    autoReconnect: true,
    maxRetries: 5,
    connectionTimeout: 5_000,
    enableOfflineQueue: false,
  });
  let ready = false;
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { const result = await operation(); ready = client.connected; return result; } catch (error) { ready = false; throw error; }
  };
  const deletePattern = async (pattern: string): Promise<void> => {
    let cursor = "0";
    do {
      const response = await run(() => client.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "100"]));
      if (!isScanResponse(response)) throw new Error("Redis SCAN returned an invalid response");
      cursor = response[0];
      if (response[1].length > 0) {
        await run(() => client.send("DEL", response[1]));
      }
    } while (cursor !== "0");
  };
  return {
    async connect() {
      await run(() => client.connect());
      const pong = await run(() => client.send("PING", []));
      if (pong !== "PONG") throw new Error("Redis PING failed");
      ready = true;
    },
    async refresh() {
      if (!client.connected) await run(() => client.connect());
      const pong = await run(() => client.send("PING", []));
      ready = pong === "PONG";
      return ready;
    },
    isReady: () => ready && client.connected,
    close() { ready = false; client.close(); },
    async setActive(session) {
      await run(() => client.set(activeKey(session.guildId, session.userId), JSON.stringify(session), "EX", ACTIVE_TTL_SECONDS));
    },
    async deleteActive(guildId, userId) { await run(() => client.del(activeKey(guildId, userId))); },
    async getJson(key) { return (await run(() => client.get(key))) ?? undefined; },
    async setJson(key, value, ttlSeconds = QUERY_TTL_SECONDS) { await run(() => client.set(key, value, "EX", ttlSeconds)); },
    async hasRecentEvent(eventId) { return (await run(() => client.get(eventKey(eventId)))) === "completed"; },
    async markRecentEvent(eventId) { await run(() => client.set(eventKey(eventId), "completed", "EX", EVENT_TTL_SECONDS)); },
    async purgeGuild(guildId) {
      await deletePattern(`purev2:stats:active:${guildId}:*`);
      await deletePattern(`purev2:stats:query:${guildId}:*`);
    },
  };
}

export function createMemoryVoiceStatsCache(): VoiceStatsCache & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  let ready = false;
  return {
    values,
    async connect() { ready = true; },
    async refresh() { return ready; },
    isReady: () => ready,
    close() { ready = false; values.clear(); },
    async setActive(session) { values.set(activeKey(session.guildId, session.userId), JSON.stringify(session)); },
    async deleteActive(guildId, userId) { values.delete(activeKey(guildId, userId)); },
    async getJson(key) { return values.get(key); },
    async setJson(key, value) { values.set(key, value); },
    async hasRecentEvent(eventId) { return values.get(eventKey(eventId)) === "completed"; },
    async markRecentEvent(eventId) { values.set(eventKey(eventId), "completed"); },
    async purgeGuild(guildId) {
      const activePrefix = `purev2:stats:active:${guildId}:`;
      const queryPrefix = `purev2:stats:query:${guildId}:`;
      for (const key of values.keys()) {
        if (key.startsWith(activePrefix) || key.startsWith(queryPrefix)) values.delete(key);
      }
    },
  };
}
