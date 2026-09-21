// spec 010 R8 / spec 080 R2: a metered engine's first call requires the
// user's explicit provider/model/cost acknowledgement. A saved credential
// never implies one, and no paid provider is ever chosen implicitly.
import type { AppConfig } from "./config.ts";
import { hasMeteredAcknowledgement } from "./config.ts";

export interface MeteredGateInstance {
  instanceId: string;
  displayName: string;
  billingClass?: "metered" | "subscription" | "local";
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
  if (instance.billingClass !== "metered") return null;
  if (hasMeteredAcknowledgement(cfg, instance.instanceId, model)) return null;
  return (
    `${instance.displayName} is metered - runs on "${model}" bill this account. ` +
    `Confirm metered use for this model before sending.`
  );
}
