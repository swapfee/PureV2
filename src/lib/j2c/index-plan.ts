import {
  REQUIRED_J2C_INDEX_SPECS,
  verifyRequiredIndexSpecs,
  type ListedMongoIndex,
  type RequiredIndexSpec,
} from "./index-requirements.ts";

export type IndexPlanAction = "create" | "match" | "conflict" | "unexpected";

export interface IndexPlanEntry {
  readonly modelName: string;
  readonly collectionName: string;
  readonly indexName: string;
  readonly action: IndexPlanAction;
  readonly expected?: RequiredIndexSpec;
  readonly actual?: ListedMongoIndex;
  readonly detail?: string;
}

export interface IndexPlan {
  readonly entries: readonly IndexPlanEntry[];
  readonly creates: readonly IndexPlanEntry[];
  readonly matches: readonly IndexPlanEntry[];
  readonly conflicts: readonly IndexPlanEntry[];
  readonly unexpected: readonly IndexPlanEntry[];
  readonly okToApply: boolean;
}

export const MODEL_COLLECTIONS: Readonly<Record<string, string>> = {
  GuildConfig: "guild_configs",
  TemporaryChannel: "temporary_channels",
  CreationReservation: "creation_reservations",
};

export function buildIndexCreateOptions(spec: RequiredIndexSpec): {
  readonly name: string;
  readonly unique?: boolean;
  readonly partialFilterExpression?: Readonly<Record<string, unknown>>;
  readonly expireAfterSeconds?: number;
  readonly collation?: Readonly<Record<string, unknown>>;
} {
  return {
    name: spec.name,
    ...(spec.unique === true ? { unique: true } : {}),
    ...(spec.partialFilterExpression
      ? { partialFilterExpression: spec.partialFilterExpression }
      : {}),
    ...(spec.expireAfterSeconds === undefined
      ? {}
      : { expireAfterSeconds: spec.expireAfterSeconds }),
    ...(spec.collation ? { collation: spec.collation } : {}),
  };
}

/**
 * Build a non-destructive index plan from currently listed indexes.
 * Does not create, modify, or drop anything.
 */
export function planJ2cIndexes(
  listings: readonly { readonly modelName: string; readonly indexes: readonly ListedMongoIndex[] }[],
): IndexPlan {
  const verification = verifyRequiredIndexSpecs(listings);
  const entries: IndexPlanEntry[] = [];
  const byModel = new Map(listings.map((listing) => [listing.modelName, listing.indexes]));

  for (const [modelName, required] of Object.entries(REQUIRED_J2C_INDEX_SPECS)) {
    const collectionName = MODEL_COLLECTIONS[modelName] ?? modelName;
    const listed = byModel.get(modelName) ?? [];
    for (const spec of required) {
      const actual = listed.find((index) => index.name === spec.name);
      const issues = verification.issues.filter(
        (issue) => issue.modelName === modelName && issue.indexName === spec.name,
      );
      if (!actual) {
        entries.push({
          modelName,
          collectionName,
          indexName: spec.name,
          action: "create",
          expected: spec,
          detail: "missing_required_index",
        });
        continue;
      }
      if (issues.length > 0) {
        entries.push({
          modelName,
          collectionName,
          indexName: spec.name,
          action: "conflict",
          expected: spec,
          actual,
          detail: issues.map((issue) => issue.reason).join(","),
        });
        continue;
      }
      entries.push({
        modelName,
        collectionName,
        indexName: spec.name,
        action: "match",
        expected: spec,
        actual,
      });
    }

    const requiredNames = new Set(required.map((spec) => spec.name));
    for (const index of listed) {
      const name = index.name ?? "unnamed";
      if (name === "_id_" || requiredNames.has(name)) continue;
      entries.push({
        modelName,
        collectionName,
        indexName: name,
        action: "unexpected",
        actual: index,
        detail: "not_managed_by_purev2_left_in_place",
      });
    }
  }

  const creates = entries.filter((entry) => entry.action === "create");
  const matches = entries.filter((entry) => entry.action === "match");
  const conflicts = entries.filter((entry) => entry.action === "conflict");
  const unexpected = entries.filter((entry) => entry.action === "unexpected");

  return {
    entries,
    creates,
    matches,
    conflicts,
    unexpected,
    okToApply: conflicts.length === 0,
  };
}

export interface IndexCliArgs {
  readonly apply: boolean;
  readonly confirmProduction: boolean;
  readonly verify: boolean;
  readonly help: boolean;
}

export function parseIndexCliArgs(argv: readonly string[]): IndexCliArgs {
  return {
    apply: argv.includes("--apply"),
    confirmProduction: argv.includes("--confirm-production"),
    verify: argv.includes("--verify"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

export function indexCliUsage(): string {
  return [
    "PureV2 index maintenance (dry-run by default)",
    "",
    "  bun run indexes:plan",
    "  bun run indexes:verify",
    "  bun run indexes:apply -- --confirm-production",
    "",
    "Flags:",
    "  (default)               Plan/dry-run — no mutations",
    "  --verify                Verify required indexes structurally",
    "  --apply                 Create missing required indexes only",
    "  --confirm-production    Required with --apply when NODE_ENV=production",
    "  --help                  Show this help",
    "",
    "Never drops indexes. Conflicting same-named indexes must be resolved manually.",
  ].join("\n");
}

export function assertIndexApplyAllowed(input: {
  readonly args: IndexCliArgs;
  readonly nodeEnv: string;
  readonly plan: IndexPlan;
}): void {
  if (!input.args.apply) {
    throw new Error("Refusing to mutate indexes without --apply (dry-run only)");
  }
  if (input.nodeEnv === "production" && !input.args.confirmProduction) {
    throw new Error("Refusing production index apply without --confirm-production");
  }
  if (!input.plan.okToApply) {
    throw new Error("Refusing to apply while conflicting indexes exist");
  }
}
