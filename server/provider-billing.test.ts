// Billing classification tests — security/epic-9-D. The resolver is the
// single source of truth the spend gate and the default-selection invariant
// both consult.
import { describe, expect, it } from "vitest";
import { BILLING_RATES_CHECKED_AT, resolveProviderBilling } from "./provider-billing.ts";

describe("resolveProviderBilling", () => {
  it("classifies Hermes local models as free", () => {
    for (const model of ["ollama:llama3", "lmstudio:qwen", "vllm:mistral", "ollama::llama3", "custom:ollama:llama3"]) {
      const billing = resolveProviderBilling({ driverKind: "hermesAgent", modelId: model });
      expect(billing.billingClass).toBe("free");
      expect(billing.requiresExplicitSelection).toBe(false);
    }
  });

  it("classifies Hermes metered/subscription upstreams honestly", () => {
    expect(resolveProviderBilling({ driverKind: "hermesAgent", modelId: "openrouter:qwen/max" }).billingClass).toBe(
      "metered",
    );
    expect(resolveProviderBilling({ driverKind: "hermesAgent", modelId: "nous:deephermes" }).billingClass).toBe(
      "subscription",
    );
  });

  it("fails closed on Hermes models it cannot classify", () => {
    const billing = resolveProviderBilling({ driverKind: "hermesAgent", modelId: "mystery:model" });
    expect(billing.billingClass).toBe("unknown");
    expect(billing.requiresExplicitSelection).toBe(true);
  });

  it("honors driver-declared billing metadata when present", () => {
    const billing = resolveProviderBilling({
      driverKind: "whatever",
      modelId: "m",
      metadata: {
        displayName: "X",
        billingClass: "metered",
        rateSource: "driver-declared",
        rateCheckedAt: "2026-09-21",
        requiresExplicitSelection: true,
      },
    });
    expect(billing.billingClass).toBe("metered");
    expect(billing.rateSource).toBe("driver-declared");
    expect(billing.rateCheckedAt).toBe("2026-09-21");
  });

  it("falls back to the snapshot's reported billing, then to unknown", () => {
    expect(
      resolveProviderBilling({ driverKind: "grok", modelId: "grok-4", snapshotBilling: "metered" }).billingClass,
    ).toBe("metered");
    const unknown = resolveProviderBilling({ driverKind: "grok", modelId: "grok-4" });
    expect(unknown.billingClass).toBe("unknown");
    expect(unknown.requiresExplicitSelection).toBe(true);
  });

  it("never consults credential presence — authenticated is not an input", () => {
    // There is deliberately no `authenticated` parameter. If one is ever
    // added, this test documents that it must not change the outcome.
    const a = resolveProviderBilling({ driverKind: "claudeAgent", modelId: "sonnet" });
    const b = resolveProviderBilling({ driverKind: "claudeAgent", modelId: "sonnet" });
    expect(a).toEqual(b);
    expect(a.requiresExplicitSelection).toBe(true);
  });

  it("stamps a review date on every classification", () => {
    expect(BILLING_RATES_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const billing of [
      resolveProviderBilling({ driverKind: "hermesAgent", modelId: "openrouter:x" }),
      resolveProviderBilling({ driverKind: "nope", modelId: "x" }),
    ]) {
      expect(billing.rateCheckedAt).toBe(BILLING_RATES_CHECKED_AT);
    }
  });
});
