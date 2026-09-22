// Migrating bots off a harness the product no longer offers (issue #18,
// "Migration and enforcement"; spec 110 R-RUNTIME-004).
//
// A user who created bots before the product settled on one runtime still has
// them, still has their conversations, and did nothing wrong. Deleting those
// bots, or silently leaving them pointing at a driver a release build refuses
// to dispatch, are both worse than moving the selection and saying so.
//
// Only `modelSelection` changes here. Bot identity, threads, tasks and
// transcripts are untouched, which is the whole requirement: "without losing
// conversations or bot identity".
import type { ModelSelection } from "./contracts.ts";

export interface MigrationFleet {
  instanceId: string;
  driverKind: string;
  snapshot: { state: "available" | "unavailable" };
  models: { default: string; options: readonly { id: string }[] };
}

export type SelectionMigration =
  /** Nothing to do: already Hermes, or this build allows other harnesses. */
  | { action: "keep" }
  /** Moved onto the ready Hermes runtime. */
  | { action: "migrate"; selection: ModelSelection; keptModel: boolean }
  /** Cannot be moved yet. The bot stays intact and reports a truthful state. */
  | { action: "blocked"; code: string };

/**
 * Decide what to do with one bot's saved selection.
 *
 * Deterministic and pure so the same input always yields the same outcome: a
 * migration that varied run to run would be worse than none, because two
 * launches would disagree about what a bot is.
 *
 * `productBuild` false leaves everything alone. Dev, CLI and e2e fleets keep
 * their adapters, exactly as the dispatch lock does.
 */
export function migrateSelection(
  current: ModelSelection,
  fleet: readonly MigrationFleet[],
  productBuild: boolean,
): SelectionMigration {
  if (!productBuild) return { action: "keep" };

  const currentInstance = fleet.find((entry) => entry.instanceId === current.instanceId);
  if (currentInstance?.driverKind === "hermesAgent") return { action: "keep" };

  const hermes = fleet.find((entry) => entry.driverKind === "hermesAgent");
  if (!hermes) return { action: "blocked", code: "runtime.not-configured" };
  if (hermes.snapshot.state !== "available") return { action: "blocked", code: "runtime.absent" };
  if (!hermes.models.default) return { action: "blocked", code: "runtime.no-model" };

  // "Preserve exact user-chosen Hermes model when it remains valid." A model id
  // the ready runtime still offers is the user's choice, not a coincidence, so
  // it survives the move even though the instance changes.
  const keptModel = hermes.models.options.some((option) => option.id === current.model);
  return {
    action: "migrate",
    keptModel,
    selection: {
      instanceId: hermes.instanceId,
      model: keptModel ? current.model : hermes.models.default,
      // Effort is a per-turn intensity, not a provider detail; carrying it over
      // keeps a migrated bot behaving like the one the user configured.
      ...(current.effort === undefined ? {} : { effort: current.effort }),
    },
  };
}

/** Migrate a whole fleet of saved selections, reporting what changed. */
export function migrateSelections(
  bots: readonly { id: string; modelSelection: ModelSelection }[],
  fleet: readonly MigrationFleet[],
  productBuild: boolean,
): {
  migrated: { id: string; selection: ModelSelection; keptModel: boolean }[];
  blocked: { id: string; code: string }[];
} {
  const migrated: { id: string; selection: ModelSelection; keptModel: boolean }[] = [];
  const blocked: { id: string; code: string }[] = [];
  for (const bot of bots) {
    const outcome = migrateSelection(bot.modelSelection, fleet, productBuild);
    if (outcome.action === "migrate") migrated.push({ id: bot.id, selection: outcome.selection, keptModel: outcome.keptModel });
    else if (outcome.action === "blocked") blocked.push({ id: bot.id, code: outcome.code });
  }
  return { migrated, blocked };
}
