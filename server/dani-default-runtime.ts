import type { BillingClass, ProviderSnapshot } from "./contracts.ts";

export type RuntimeCandidate = {
  instanceId: string;
  driverKind: string;
  models: { default: string };
  snapshot: ProviderSnapshot;
};

export type DaniDefaultSelection =
  | { state: "ready"; instanceId: string; model: string }
  | { state: "no-model"; instanceId: ""; model: ""; reason: string };

/** Hermes is the only default runtime. An unavailable Hermes fails closed —
 * it never falls through to another provider, and credential presence on a
 * non-Hermes provider never promotes it to the default. */
export function selectDaniDefault(
  candidates: RuntimeCandidate[],
  explicitTestInstanceId?: string,
  /**
   * Spend-safety billing for the candidate default. Production passes the
   * real resolver (server/provider-billing.ts); the default keeps Hermes
   * free so unit fixtures without a billing table behave as before.
   */
  billingOf: (driverKind: string, modelId: string) => BillingClass = (driverKind) =>
    driverKind === "hermesAgent" ? "free" : "unknown",
): DaniDefaultSelection {
  if (explicitTestInstanceId) {
    const fixture = candidates.find((candidate) => candidate.instanceId === explicitTestInstanceId);
    if (!fixture || fixture.snapshot.state !== "available" || !fixture.models.default) {
      return { state: "no-model", instanceId: "", model: "", reason: `Explicit test provider ${explicitTestInstanceId} is unavailable` };
    }
    // An explicitly named test provider is an explicit choice — the spend
    // gate below does not apply to it.
    return { state: "ready", instanceId: fixture.instanceId, model: fixture.models.default };
  }
  const hermes = candidates.find((candidate) => candidate.driverKind === "hermesAgent");
  if (!hermes) return { state: "no-model", instanceId: "", model: "", reason: "Hermes runtime is not configured" };
  if (hermes.snapshot.state !== "available") {
    return { state: "no-model", instanceId: "", model: "", reason: hermes.snapshot.reason || "Hermes runtime is unavailable" };
  }
  if (!hermes.models.default) return { state: "no-model", instanceId: "", model: "", reason: "Hermes has no configured model" };
  // ── FAIL-CLOSED SPEND INVARIANT (security/epic-9-D) ──────────────────
  // The implicit default may only ever be a provider with no per-request
  // cost. Credential presence (snapshot.authenticated) must NEVER select a
  // paid default: the silent-paid-fallback problem does not exist at this
  // baseline, and this assertion pins it for every future provider. A
  // Hermes whose default model is metered/unknown-cost fails closed to
  // "no-model" — the user then picks a provider explicitly, and the spend
  // gate (server/provider-spend-gate.ts) requires the cost acknowledgement
  // before the first request.
  const billingClass = billingOf(hermes.driverKind, hermes.models.default);
  if (billingClass !== "free") {
    return {
      state: "no-model",
      instanceId: "",
      model: "",
      reason: `Hermes default model "${hermes.models.default}" is ${billingClass} — pick a provider explicitly and acknowledge its cost`,
    };
  }
  return { state: "ready", instanceId: hermes.instanceId, model: hermes.models.default };
}
