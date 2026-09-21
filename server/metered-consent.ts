// spec 010 R8 / spec 080 R2: a metered engine's first call requires the
// user's explicit provider/model/cost acknowledgement. A saved credential
// never implies one, and no paid provider is ever chosen implicitly.
import type { AppConfig } from "./config.ts";
import { hasMeteredAcknowledgement } from "./config.ts";
import { hermesProviderCapability } from "./hermes-provider-policy.ts";

export interface MeteredGateInstance {
  instanceId: string;
  displayName?: string;
  driverKind?: string;
  billingClass?: "metered" | "subscription" | "local";
}

/** The cost class this exact turn would run under: the instance's static
 * class for key engines, or the per-provider policy for Hermes models
 * (`<provider>:<model>` ids - OpenRouter bills; Nous is a subscription;
 * local runtimes are free). Unknown never reads as free. */
export function turnBilling(instance: MeteredGateInstance, model: string): "metered" | "subscription" | "local" | "unknown" {
  if (instance.driverKind === "hermesAgent") return hermesProviderCapability(model).billing;
  // An engine that never declared its cost class is UNKNOWN, never free:
  // that is what keeps a newly added paid provider from silently billing.
  return instance.billingClass ?? "unknown";
}

/** The refusal message when this turn would spend money the user has not
 * acknowledged, or null when the turn may proceed. startTurn throws it as a
 * 409 with code metered_consent_required; the message itself tells the user
 * exactly what bills and where to confirm. */
export function meteredConsentRefusal(
  instance: MeteredGateInstance,
  cfg: AppConfig,
  model: string,
): string | null {
  const billing = turnBilling(instance, model);
  if (billing === "subscription" || billing === "local") return null;
  if (hasMeteredAcknowledgement(cfg, instance.instanceId, model)) return null;
  const viaProvider =
    instance.driverKind === "hermesAgent"
      ? ` via ${hermesProviderCapability(model).provider}`
      : "";
  const name = `${instance.displayName ?? instance.instanceId}${viaProvider}`;
  // Fail closed: an unclassed engine gets the same one-tap acknowledgement
  // as a known metered one, with copy that says WHY it is being asked.
  return billing === "unknown"
    ? `${name} has an unknown billing class - Dani cannot tell whether runs on "${model}" bill this account. ` +
      `Confirm metered use for this model before sending, or ask the engine to declare its billing class.`
    : `${name} is metered - runs on "${model}" bill this account. ` +
      `Confirm metered use for this model before sending.`;
}
