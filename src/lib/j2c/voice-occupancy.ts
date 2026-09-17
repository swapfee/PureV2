/**
 * Coordinator-owned (or injected) voice occupancy tracker.
 *
 * Discord REST cannot list voice-channel members. Occupancy is derived only from
 * Gateway VOICE_STATE_UPDATE events (and GUILD_CREATE voice_states snapshots).
 *
 * Ordering: each update carries a monotonic receivedSeq. Stale leaves that arrive
 * after a newer join for the same user are ignored.
 *
 * GUILD_CREATE seeding is authoritative for that guild: prior occupants are cleared,
 * and seed rows use sequence 0 so any subsequent real VSU (sequence >= 1) wins.
 */

export interface VoiceStateObservation {
  readonly guildId: string;
  readonly userId: string;
  /** null means disconnected from voice */
  readonly channelId: string | null;
  /** Monotonic sequence; higher wins for the same user */
  readonly sequence: number;
  readonly isBot?: boolean;
}

export type OccupancyLookup =
  | { readonly kind: "known"; readonly userIds: readonly string[] }
  | { readonly kind: "unknown" };

export interface VoiceOccupancyTracker {
  apply(observation: VoiceStateObservation): void;
  seedGuildVoiceStates(
    guildId: string,
    states: readonly { readonly userId: string; readonly channelId: string | null; readonly isBot?: boolean }[],
  ): void;
  getOccupants(guildId: string, channelId: string): OccupancyLookup;
  getUserChannel(guildId: string, userId: string): OccupancyLookup & { channelId?: string | null };
  markWarming(): void;
  markReady(): void;
  isReady(): boolean;
  clear(): void;
  trackedGuildCount(): number;
}

function userKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

export function createVoiceOccupancyTracker(): VoiceOccupancyTracker {
  /** userKey -> { channelId, sequence } */
  const byUser = new Map<string, { channelId: string | null; sequence: number }>();
  let ready = false;
  const seededGuilds = new Set<string>();

  return {
    apply(observation) {
      if (observation.isBot) return;
      const key = userKey(observation.guildId, observation.userId);
      const existing = byUser.get(key);
      if (existing && existing.sequence > observation.sequence) {
        // Stale event — ignore
        return;
      }
      if (existing && existing.sequence === observation.sequence) {
        // Duplicate — ignore
        return;
      }
      byUser.set(key, { channelId: observation.channelId, sequence: observation.sequence });
    },

    seedGuildVoiceStates(guildId, states) {
      // GUILD_CREATE voice_states is an authoritative snapshot for this guild.
      // Clear prior occupants first so earlier VOICE_STATE_UPDATE merges (and their
      // higher sequences) cannot override an empty/leave-while-offline seed.
      // Seed entries use sequence 0 so any subsequent real gateway VSU (seq >= 1) wins.
      const prefix = `${guildId}:`;
      for (const key of byUser.keys()) {
        if (key.startsWith(prefix)) {
          byUser.delete(key);
        }
      }
      for (const state of states) {
        if (state.isBot) continue;
        byUser.set(userKey(guildId, state.userId), {
          channelId: state.channelId,
          sequence: 0,
        });
      }
      seededGuilds.add(guildId);
    },

    getOccupants(guildId, channelId) {
      if (!ready) return { kind: "unknown" };
      // Until GUILD_CREATE seeds this guild, emptiness is unknown — never invent [].
      if (!seededGuilds.has(guildId)) return { kind: "unknown" };
      const userIds: string[] = [];
      for (const [key, value] of byUser) {
        if (!key.startsWith(`${guildId}:`)) continue;
        if (value.channelId === channelId) {
          userIds.push(key.slice(guildId.length + 1));
        }
      }
      return { kind: "known", userIds };
    },

    getUserChannel(guildId, userId) {
      if (!ready) return { kind: "unknown" };
      if (!seededGuilds.has(guildId)) return { kind: "unknown" };
      const existing = byUser.get(userKey(guildId, userId));
      if (!existing) return { kind: "known", userIds: [], channelId: null };
      return { kind: "known", userIds: existing.channelId ? [userId] : [], channelId: existing.channelId };
    },

    markWarming() {
      ready = false;
    },

    markReady() {
      ready = true;
    },

    isReady() {
      return ready;
    },

    clear() {
      byUser.clear();
      seededGuilds.clear();
      ready = false;
    },

    trackedGuildCount() {
      return seededGuilds.size;
    },
  };
}
