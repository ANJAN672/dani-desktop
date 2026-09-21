// Provider billing classification — security/epic-9-D (provider spend safety).
//
// Every provider request passes through resolveProviderBilling() before the
// spend gate decides whether the user must explicitly acknowledge the cost.
// The rule is fail-closed: anything that is not provably `free` requires an
// explicit user selection + cost acknowledgement before the first request.
//
// Billing classes:
//   free         — no per-request cost (local engines, bundled runtimes)
//   metered      — usage is billed per request/token
//   subscription — flat subscription; any reported cost is notional
//   unknown      — the driver does not declare billing; treated as metered
import type { BillingClass, ProviderDriver } from "./contracts.ts";
import { hermesProviderCapability } from "./hermes-provider-policy.ts";

/** Date this module's classifications were last reviewed against the
 * drivers. Bump it whenever a classification is added or changed — the UI
 * shows it next to the cost label so "unknown" is visibly a review date,
 * not a guess. */
export const BILLING_RATES_CHECKED_AT = "2026-09-21";

export interface ProviderBilling {
  billingClass: BillingClass;
  /** Where the classification came from — shown in the UI next to the label. */
  rateSource?: string;
  /** ISO date of the last billing review for this classification. */
  rateCheckedAt?: string;
  /** False only for `free`. Everything else blocks first use until the user
   * explicitly selects the provider/model and acknowledges the cost class. */
  requiresExplicitSelection: boolean;
}

export const BILLING_LABELS: Record<BillingClass, string> = {
  free: "Free",
  metered: "Metered",
  subscription: "Subscription",
  unknown: "Unknown cost",
};

function hermesModelBilling(modelId: string | undefined): ProviderBilling {
  // Hermes catalog ids are `provider:model` (e.g. `openrouter:qwen/...`);
  // local inject ids are `host::model`; ACP session ids are
  // `custom:host:model`. Normalize to `provider:rest` before classifying.
  let normalized = modelId ?? "";
  const injectSep = normalized.indexOf("::");
  if (injectSep > 0) normalized = `${normalized.slice(0, injectSep)}:${normalized.slice(injectSep + 2)}`;
  else if (normalized.startsWith("custom:")) normalized = normalized.slice("custom:".length);
  const capability = hermesProviderCapability(normalized);
  const billingClass: BillingClass =
    capability.billing === "local"
      ? "free"
      : capability.billing === "metered" || capability.billing === "subscription"
        ? capability.billing
        : "unknown";
  return {
    billingClass,
    rateSource: "hermes-provider-policy capability table",
    rateCheckedAt: BILLING_RATES_CHECKED_AT,
    requiresExplicitSelection: billingClass !== "free",
  };
}

/** Resolve the spend-safety billing for one (driver, model) pair. Precedence:
 *  1. driver-declared metadata.billingClass; 2. Hermes per-model capability
 *  table; 3. the instance snapshot's reported billing; 4. `unknown`
 *  (fail closed). Credential presence (`snapshot.authenticated`) is
 *  deliberately NOT an input — having a key must never imply consent to pay. */
export function resolveProviderBilling(input: {
  driverKind: string;
  modelId?: string;
  metadata?: ProviderDriver["metadata"];
  /** ProviderSnapshot["billing"] — "metered" | "subscription" when reported. */
  snapshotBilling?: "metered" | "subscription";
}): ProviderBilling {
  const declared = input.metadata?.billingClass;
  if (declared) {
    return {
      billingClass: declared,
      rateSource: input.metadata?.rateSource ?? "driver-declared",
      rateCheckedAt: input.metadata?.rateCheckedAt,
      requiresExplicitSelection: input.metadata?.requiresExplicitSelection ?? declared !== "free",
    };
  }
  if (input.driverKind === "hermesAgent") return hermesModelBilling(input.modelId);
  if (input.snapshotBilling === "metered" || input.snapshotBilling === "subscription") {
    return {
      billingClass: input.snapshotBilling,
      rateSource: "provider snapshot",
      rateCheckedAt: BILLING_RATES_CHECKED_AT,
      requiresExplicitSelection: true,
    };
  }
  // Fail closed: an undeclared driver is `unknown` and needs explicit
  // acknowledgement, even if it reports authenticated. A future driver gets
  // this behavior automatically — it cannot silently become a paid default.
  return {
    billingClass: "unknown",
    rateSource: "unclassified driver (fail closed)",
    rateCheckedAt: BILLING_RATES_CHECKED_AT,
    requiresExplicitSelection: true,
  };
}
