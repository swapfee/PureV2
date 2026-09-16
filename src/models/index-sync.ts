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

export async function listJ2cIndexes(
  models: readonly IndexableModel[] = defaultModels,
): Promise<readonly IndexListingResult[]> {
  const results: IndexListingResult[] = [];
  for (const model of models) {
    const indexes = await model.listIndexes();
    results.push({ modelName: model.modelName, indexes });
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
