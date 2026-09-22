import type { ProviderSnapshot } from "./contracts.ts";

export type RuntimeCandidate = {
  instanceId: string;
  driverKind: string;
  models: { default: string };
  snapshot: ProviderSnapshot;
};

export type DaniDefaultSelection =
  | { state: "ready"; instanceId: string; model: string }
  | { state: "no-model"; instanceId: ""; model: ""; reason: string };

/** Hermes is Dani's fixed production harness. Tests may name an explicit
 * hermetic fixture, but product selection never falls back to another harness. */
export function selectDaniDefault(
  candidates: RuntimeCandidate[],
  explicitTestInstanceId?: string,
): DaniDefaultSelection {
  if (explicitTestInstanceId) {
    const fixture = candidates.find((candidate) => candidate.instanceId === explicitTestInstanceId);
    if (!fixture || fixture.snapshot.state !== "available" || !fixture.models.default) {
      return { state: "no-model", instanceId: "", model: "", reason: `Explicit test provider ${explicitTestInstanceId} is unavailable` };
    }
    return { state: "ready", instanceId: fixture.instanceId, model: fixture.models.default };
  }
  const readySelection = (candidate: RuntimeCandidate | undefined): DaniDefaultSelection | null =>
    candidate && candidate.snapshot.state === "available" && candidate.models.default
      ? { state: "ready", instanceId: candidate.instanceId, model: candidate.models.default }
      : null;
  const hermesSelection = readySelection(candidates.find((candidate) => candidate.driverKind === "hermesAgent"));
  if (hermesSelection) return hermesSelection;
  const hermes = candidates.find((candidate) => candidate.driverKind === "hermesAgent");
  if (!hermes) return { state: "no-model", instanceId: "", model: "", reason: "Hermes runtime is not configured" };
  if (hermes.snapshot.state === "available" && !hermes.models.default) {
    return { state: "no-model", instanceId: "", model: "", reason: "Hermes has no configured model" };
  }
  return { state: "no-model", instanceId: "", model: "", reason: hermes.snapshot.reason || "Hermes runtime is unavailable" };
}

/** Whether a production build must refuse this bot selection (spec 110
 * R-RUNTIME-004, acceptance criterion 5).
 *
 * A release app dispatches Hermes and nothing else, so neither a stale config
 * nor a crafted local request can name another harness. An unknown instance
 * fails closed for the same reason: an unresolvable driver is not a Hermes
 * driver.
 *
 * `productBuild` is false for dev, CLI, headless and test boots, which keep
 * their adapters and hermetic fixtures exactly as before — the same
 * compatibility carve-out the execution kernel already relies on.
 */
export function rejectsNonHermesSelection(
  driverKind: string | undefined | null,
  productBuild: boolean,
): boolean {
  return productBuild && driverKind !== "hermesAgent";
}
