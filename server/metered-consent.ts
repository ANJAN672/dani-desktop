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
export function turnBilling(instance: MeteredGateInstance, model: string): "metered" | "subscription" | "local" | "unknown" | undefined {
  if (instance.driverKind === "hermesAgent") return hermesProviderCapability(model).billing;
  return instance.billingClass;
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
  if (turnBilling(instance, model) !== "metered") return null;
  if (hasMeteredAcknowledgement(cfg, instance.instanceId, model)) return null;
  const viaProvider =
    instance.driverKind === "hermesAgent"
      ? ` via ${hermesProviderCapability(model).provider}`
      : "";
  return (
    `${instance.displayName ?? instance.instanceId}${viaProvider} is metered - runs on "${model}" bill this account. ` +
    `Confirm metered use for this model before sending.`
  );
}
