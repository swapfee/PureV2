/**
 * Structural MongoDB index requirements for Join-to-Create.
 * Production startup verifies key fields, order, unique, partial filters, TTL, and collation.
 * Names alone are never sufficient.
 */

export type IndexKeyDirection = 1 | -1;

export interface RequiredIndexSpec {
  readonly name: string;
  readonly keys: Readonly<Record<string, IndexKeyDirection>>;
  readonly unique?: boolean;
  readonly partialFilterExpression?: Readonly<Record<string, unknown>>;
  readonly expireAfterSeconds?: number;
  readonly collation?: Readonly<Record<string, unknown>>;
}

export interface ListedMongoIndex {
  readonly name?: string;
  readonly key?: Readonly<Record<string, unknown>>;
  readonly unique?: boolean;
  readonly partialFilterExpression?: Readonly<Record<string, unknown>>;
  readonly expireAfterSeconds?: number;
  readonly collation?: Readonly<Record<string, unknown>>;
}

export const REQUIRED_J2C_INDEX_SPECS: Readonly<Record<string, readonly RequiredIndexSpec[]>> = {
  GuildConfig: [
    {
      name: "guild_configs_guildId_unique",
      keys: { guildId: 1 },
      unique: true,
    },
  ],
  TemporaryChannel: [
    {
      name: "temporary_channels_channelId_unique",
      keys: { channelId: 1 },
      unique: true,
    },
    {
      name: "temporary_channels_owner_status",
      keys: { guildId: 1, ownerId: 1, status: 1 },
    },
    {
      name: "temporary_channels_status_updatedAt",
      keys: { status: 1, updatedAt: 1 },
    },
    {
      name: "temporary_channels_guild_status",
      keys: { guildId: 1, status: 1 },
    },
  ],
  CreationReservation: [
    {
      name: "creation_reservations_one_active",
      keys: { guildId: 1, memberId: 1 },
      unique: true,
      partialFilterExpression: { status: "reserved" },
    },
    {
      name: "creation_reservations_expiresAt",
      keys: { expiresAt: 1 },
    },
    {
      name: "creation_reservations_eventId",
      keys: { eventId: 1 },
    },
  ],
  OwnerBlockList: [
    {
      name: "owner_block_lists_guild_owner_unique",
      keys: { guildId: 1, ownerId: 1 },
      unique: true,
    },
  ],
};

/** Exact former index that enforced one live channel per owner. */
export const LEGACY_SINGLE_OWNER_INDEX: RequiredIndexSpec = {
  name: "temporary_channels_one_active_owner",
  keys: { guildId: 1, ownerId: 1 },
  unique: true,
  partialFilterExpression: { status: { $in: ["creating", "active", "deleting"] } },
};

export interface IndexVerificationIssue {
  readonly modelName: string;
  readonly indexName: string;
  readonly reason: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

function normalizeKeys(keys: Readonly<Record<string, unknown>> | undefined): Record<string, number> | undefined {
  if (!keys) return undefined;
  const normalized: Record<string, number> = {};
  for (const [field, value] of Object.entries(keys)) {
    if (typeof value !== "number") return undefined;
    normalized[field] = value;
  }
  return normalized;
}

function keysEqual(
  expected: Readonly<Record<string, IndexKeyDirection>>,
  actual: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const normalized = normalizeKeys(actual);
  if (!normalized) return false;
  const expectedEntries = Object.entries(expected);
  const actualEntries = Object.entries(normalized);
  if (expectedEntries.length !== actualEntries.length) return false;
  for (let i = 0; i < expectedEntries.length; i += 1) {
    const expectedEntry = expectedEntries[i];
    const actualEntry = actualEntries[i];
    if (!expectedEntry || !actualEntry) return false;
    if (expectedEntry[0] !== actualEntry[0] || expectedEntry[1] !== actualEntry[1]) return false;
  }
  return true;
}

function jsonStable(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested).toSorted(([a], [b]) => a.localeCompare(b)));
    }
    return nested;
  });
}

function partialEqual(expected: unknown, actual: unknown): boolean {
  return jsonStable(expected) === jsonStable(actual);
}

function collationEqual(expected: unknown, actual: unknown): boolean {
  if (expected === undefined && actual === undefined) return true;
  return jsonStable(expected) === jsonStable(actual);
}

export function isLegacySingleOwnerIndex(index: ListedMongoIndex): boolean {
  return index.name === LEGACY_SINGLE_OWNER_INDEX.name &&
    keysEqual(LEGACY_SINGLE_OWNER_INDEX.keys, index.key) &&
    index.unique === true &&
    partialEqual(
      LEGACY_SINGLE_OWNER_INDEX.partialFilterExpression,
      index.partialFilterExpression,
    ) &&
    index.expireAfterSeconds === undefined &&
    index.collation === undefined;
}

export function verifyRequiredIndexSpecs(
  listedByModel: Readonly<
    Record<string, readonly ListedMongoIndex[]> | ReadonlyArray<{ readonly modelName: string; readonly indexes: readonly ListedMongoIndex[] }>
  >,
): { readonly ok: boolean; readonly issues: readonly IndexVerificationIssue[] } {
  const byModel = new Map<string, readonly ListedMongoIndex[]>();
  if (Array.isArray(listedByModel)) {
    for (const entry of listedByModel) {
      byModel.set(entry.modelName, entry.indexes);
    }
  } else {
    for (const [modelName, indexes] of Object.entries(listedByModel)) {
      byModel.set(modelName, indexes);
    }
  }

  const issues: IndexVerificationIssue[] = [];

  for (const [modelName, required] of Object.entries(REQUIRED_J2C_INDEX_SPECS)) {
    const listed = byModel.get(modelName) ?? [];
    for (const spec of required) {
      const found = listed.find((index) => index.name === spec.name);
      if (!found) {
        issues.push({
          modelName,
          indexName: spec.name,
          reason: "missing_required_index",
        });
        continue;
      }

      if (!keysEqual(spec.keys, found.key)) {
        issues.push({
          modelName,
          indexName: spec.name,
          reason: "incorrect_keys",
          expected: spec.keys,
          actual: found.key,
        });
      }

      const expectUnique = spec.unique === true;
      const actualUnique = found.unique === true;
      if (expectUnique !== actualUnique) {
        issues.push({
          modelName,
          indexName: spec.name,
          reason: "incorrect_unique_option",
          expected: expectUnique,
          actual: actualUnique,
        });
      }

      if (!partialEqual(spec.partialFilterExpression, found.partialFilterExpression)) {
        issues.push({
          modelName,
          indexName: spec.name,
          reason: "incorrect_partial_filter",
          expected: spec.partialFilterExpression,
          actual: found.partialFilterExpression,
        });
      }

      if (spec.expireAfterSeconds !== found.expireAfterSeconds) {
        if (spec.expireAfterSeconds !== undefined || found.expireAfterSeconds !== undefined) {
          issues.push({
            modelName,
            indexName: spec.name,
            reason: "incorrect_ttl_option",
            expected: spec.expireAfterSeconds,
            actual: found.expireAfterSeconds,
          });
        }
      }

      if (!collationEqual(spec.collation, found.collation)) {
        issues.push({
          modelName,
          indexName: spec.name,
          reason: "incorrect_collation",
          expected: spec.collation,
          actual: found.collation,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/** @deprecated Prefer verifyRequiredIndexSpecs — name-only checks are insufficient. */
export const REQUIRED_J2C_INDEX_NAMES = {
  GuildConfig: (REQUIRED_J2C_INDEX_SPECS.GuildConfig ?? []).map((spec) => spec.name),
  TemporaryChannel: (REQUIRED_J2C_INDEX_SPECS.TemporaryChannel ?? []).map((spec) => spec.name),
  CreationReservation: (REQUIRED_J2C_INDEX_SPECS.CreationReservation ?? []).map((spec) => spec.name),
  OwnerBlockList: (REQUIRED_J2C_INDEX_SPECS.OwnerBlockList ?? []).map((spec) => spec.name),
} as const;

/** @deprecated Prefer verifyRequiredIndexSpecs */
export function hasRequiredJ2cIndexes(
  results: readonly { readonly modelName: string; readonly indexes: readonly string[] }[],
): { readonly ok: boolean; readonly missing: readonly string[] } {
  const missing: string[] = [];
  for (const [modelName, required] of Object.entries(REQUIRED_J2C_INDEX_NAMES)) {
    const found = results.find((result) => result.modelName === modelName);
    const names = new Set(found?.indexes ?? []);
    for (const indexName of required) {
      if (!names.has(indexName)) missing.push(`${modelName}:${indexName}`);
    }
  }
  return { ok: missing.length === 0, missing };
}
