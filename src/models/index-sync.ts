import { CreationReservationModel } from "./creation-reservation.ts";
import { GuildConfigModel } from "./guild-config.ts";
import { TemporaryChannelModel } from "./temporary-channel.ts";

export interface IndexSyncResult {
  readonly modelName: string;
  readonly indexes: readonly string[];
}

export interface ListedMongoIndex {
  readonly name?: string;
  readonly key?: Readonly<Record<string, unknown>>;
  readonly unique?: boolean;
  readonly partialFilterExpression?: Readonly<Record<string, unknown>>;
  readonly expireAfterSeconds?: number;
  readonly collation?: Readonly<Record<string, unknown>>;
}

export interface IndexListingResult {
  readonly modelName: string;
  readonly indexes: readonly ListedMongoIndex[];
}

interface IndexableModel {
  readonly modelName: string;
  syncIndexes(): Promise<unknown>;
  listIndexes(): Promise<ListedMongoIndex[]>;
}

const defaultModels: readonly IndexableModel[] = [
  GuildConfigModel,
  TemporaryChannelModel,
  CreationReservationModel,
];

/**
 * Explicit index synchronization for production maintenance.
 * Do not call during normal startup.
 */
export async function synchronizeJ2cIndexes(
  models: readonly IndexableModel[] = defaultModels,
): Promise<readonly IndexSyncResult[]> {
  const results: IndexSyncResult[] = [];
  for (const model of models) {
    await model.syncIndexes();
    const indexes = await model.listIndexes();
    results.push({
      modelName: model.modelName,
      indexes: indexes.map((index) => index.name ?? "unnamed"),
    });
  }
  return results;
}

function isMissingNamespaceError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; codeName?: unknown; message?: unknown };
  if (record.code === 26 || record.codeName === "NamespaceNotFound") return true;
  return typeof record.message === "string" && /ns does not exist/i.test(record.message);
}

/** Exported for unit tests of fresh-database namespace handling. */
export function isMissingMongoNamespaceError(error: unknown): boolean {
  return isMissingNamespaceError(error);
}

/**
 * List indexes for Join-to-Create models.
 * Missing collections (fresh database) are treated as empty index lists so
 * verification/plan can report creates instead of crashing.
 */
export async function listJ2cIndexes(
  models: readonly IndexableModel[] = defaultModels,
): Promise<readonly IndexListingResult[]> {
  const results: IndexListingResult[] = [];
  for (const model of models) {
    try {
      const indexes = await model.listIndexes();
      results.push({ modelName: model.modelName, indexes });
    } catch (error: unknown) {
      if (isMissingNamespaceError(error)) {
        results.push({ modelName: model.modelName, indexes: [] });
        continue;
      }
      throw error;
    }
  }
  return results;
}

/** @deprecated Prefer listJ2cIndexes + verifyRequiredIndexSpecs */
export async function verifyJ2cIndexes(
  models: readonly IndexableModel[] = defaultModels,
): Promise<readonly IndexSyncResult[]> {
  const listings = await listJ2cIndexes(models);
  return listings.map((listing) => ({
    modelName: listing.modelName,
    indexes: listing.indexes.map((index) => index.name ?? "unnamed"),
  }));
}
