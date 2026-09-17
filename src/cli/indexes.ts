import mongoose from "mongoose";

import { parseIndexMaintenanceConfig } from "../lib/config.ts";
import {
  assertIndexApplyAllowed,
  buildIndexCreateOptions,
  indexCliUsage,
  parseIndexCliArgs,
  planJ2cIndexes,
  MODEL_COLLECTIONS,
} from "../lib/j2c/index-plan.ts";
import { verifyRequiredIndexSpecs } from "../lib/j2c/index-requirements.ts";
import { createLogger } from "../lib/logger.ts";
import { listJ2cIndexes } from "../models/index-sync.ts";
import { CreationReservationModel } from "../models/creation-reservation.ts";
import { GuildConfigModel } from "../models/guild-config.ts";
import { OwnerBlockListModel } from "../models/owner-block-list.ts";
import { TemporaryChannelModel } from "../models/temporary-channel.ts";

async function createMissingIndex(
  modelName: string,
  keys: Readonly<Record<string, 1 | -1>>,
  options: ReturnType<typeof buildIndexCreateOptions>,
): Promise<void> {
  const createOptions: {
    name: string;
    unique?: boolean;
    partialFilterExpression?: Record<string, unknown>;
    expireAfterSeconds?: number;
  } = {
    name: options.name,
  };
  if (options.unique === true) createOptions.unique = true;
  if (options.partialFilterExpression) {
    createOptions.partialFilterExpression = { ...options.partialFilterExpression };
  }
  if (options.expireAfterSeconds !== undefined) {
    createOptions.expireAfterSeconds = options.expireAfterSeconds;
  }
  if (options.collation) {
    throw new Error(
      `Refusing to create index ${modelName}/${options.name}: collation indexes must be created manually`,
    );
  }

  const keyDoc = { ...keys };
  switch (modelName) {
    case "GuildConfig":
      await GuildConfigModel.collection.createIndex(keyDoc, createOptions);
      return;
    case "TemporaryChannel":
      await TemporaryChannelModel.collection.createIndex(keyDoc, createOptions);
      return;
    case "CreationReservation":
      await CreationReservationModel.collection.createIndex(keyDoc, createOptions);
      return;
    case "OwnerBlockList":
      await OwnerBlockListModel.collection.createIndex(keyDoc, createOptions);
      return;
    default:
      throw new Error(`Unknown model ${modelName}`);
  }
}

async function listIndexesForPlan() {
  return listJ2cIndexes();
}

function printPlan(
  plan: ReturnType<typeof planJ2cIndexes>,
  logger: ReturnType<typeof createLogger>,
): void {
  logger.info("Index plan", {
    creates: plan.creates.map((entry) => `${entry.modelName}/${entry.indexName}`),
    matches: plan.matches.map((entry) => `${entry.modelName}/${entry.indexName}`),
    conflicts: plan.conflicts.map((entry) => ({
      index: `${entry.modelName}/${entry.indexName}`,
      detail: entry.detail,
    })),
    unexpected: plan.unexpected.map((entry) => `${entry.modelName}/${entry.indexName}`),
    okToApply: plan.okToApply,
  });
}

export async function runIndexCli(
  argv: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<number> {
  const args = parseIndexCliArgs(argv);
  if (args.help) {
    console.log(indexCliUsage());
    return 0;
  }

  const config = parseIndexMaintenanceConfig(environment);
  const logger = createLogger({
    service: "purev2",
    role: "index-maintenance",
    level: config.LOG_LEVEL,
    sensitiveValues: [config.MONGODB_URI],
  });

  await mongoose.connect(config.MONGODB_URI, {
    autoIndex: false,
    maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
    serverSelectionTimeoutMS: config.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    waitQueueTimeoutMS: config.MONGODB_WAIT_QUEUE_TIMEOUT_MS,
  });

  try {
    const listings = await listIndexesForPlan();
    const plan = planJ2cIndexes(listings);
    printPlan(plan, logger);

    if (args.verify) {
      const verification = verifyRequiredIndexSpecs(listings);
      if (!verification.ok) {
        logger.error("Index verification failed", { issues: verification.issues });
        return 1;
      }
      logger.info("Index verification succeeded");
      return 0;
    }

    if (!args.apply) {
      logger.info("Dry-run complete; no indexes were modified");
      return plan.conflicts.length > 0 ? 2 : 0;
    }

    assertIndexApplyAllowed({
      args,
      nodeEnv: config.NODE_ENV,
      plan,
    });

    for (const entry of plan.creates) {
      if (!entry.expected) continue;
      await createMissingIndex(entry.modelName, entry.expected.keys, buildIndexCreateOptions(entry.expected));
      logger.info("Created index", {
        modelName: entry.modelName,
        collection: MODEL_COLLECTIONS[entry.modelName],
        indexName: entry.indexName,
      });
    }

    const after = await listIndexesForPlan();
    const verification = verifyRequiredIndexSpecs(after);
    if (!verification.ok) {
      logger.error("Index verification failed after apply", { issues: verification.issues });
      return 1;
    }

    logger.info("Index apply and verification succeeded", {
      created: plan.creates.length,
      matched: plan.matches.length + plan.creates.length,
    });
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (import.meta.main) {
  void runIndexCli().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
