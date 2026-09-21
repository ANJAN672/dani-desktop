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

/** Hermes is the only default runtime. An unavailable Hermes fails closed. */
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
  const hermes = candidates.find((candidate) => candidate.driverKind === "hermesAgent");
  if (!hermes) return { state: "no-model", instanceId: "", model: "", reason: "Hermes runtime is not configured" };
  if (hermes.snapshot.state !== "available") {
    return { state: "no-model", instanceId: "", model: "", reason: hermes.snapshot.reason || "Hermes runtime is unavailable" };
  }
  if (!hermes.models.default) return { state: "no-model", instanceId: "", model: "", reason: "Hermes has no configured model" };
  return { state: "ready", instanceId: hermes.instanceId, model: hermes.models.default };
}
