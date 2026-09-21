import { describe, expect, it } from "vitest";
import { meteredConsentRefusal, turnBilling } from "./metered-consent.ts";
import { hasMeteredAcknowledgement, withMeteredAcknowledgement, type AppConfig } from "./config.ts";

const cfg = (ack: AppConfig["meteredAcknowledgements"]): AppConfig => ({ meteredAcknowledgements: ack } as AppConfig);

const metered = { instanceId: "grok", displayName: "Grok", billingClass: "metered" as const };

describe("meteredConsentRefusal (spec 010 R8)", () => {
  it("refuses a metered call with no acknowledgement and says what bills", () => {
    const refusal = meteredConsentRefusal(metered, cfg([]), "grok-3-mini");
    expect(refusal).toContain("metered");
    expect(refusal).toContain("grok-3-mini");
    expect(refusal).toContain("Grok");
  });

  it("passes once the exact instance+model is acknowledged", () => {
    const list = withMeteredAcknowledgement(cfg([]), "grok", "grok-3-mini");
    expect(meteredConsentRefusal(metered, cfg(list), "grok-3-mini")).toBeNull();
  });

  it("a different model on the same engine still needs its own acknowledgement", () => {
    const list = withMeteredAcknowledgement(cfg([]), "grok", "grok-3-mini");
    expect(meteredConsentRefusal(metered, cfg(list), "grok-4")).not.toBeNull();
  });

  it("never gates subscription or local engines", () => {
    expect(meteredConsentRefusal({ ...metered, billingClass: "subscription" }, cfg([]), "m")).toBeNull();
    expect(meteredConsentRefusal({ ...metered, billingClass: "local" }, cfg([]), "m")).toBeNull();
  });

  it("fails closed on an unclassed engine - unknown never reads as free", () => {
    const unclassed = { instanceId: "newpaid", displayName: "New Paid Engine" };
    expect(turnBilling(unclassed, "m")).toBe("unknown");
    const refusal = meteredConsentRefusal(unclassed, cfg([]), "m");
    expect(refusal).toContain("unknown billing class");
    expect(refusal).toContain("New Paid Engine");
    expect(refusal).toContain('"m"');
    // it does NOT claim the engine is metered - it says we cannot tell
    expect(refusal).not.toContain("is metered -");
  });

  it("an acknowledged unclassed engine passes, per exact instance+model", () => {
    const unclassed = { instanceId: "newpaid", displayName: "New Paid Engine" };
    const list = withMeteredAcknowledgement(cfg([]), "newpaid", "m");
    expect(meteredConsentRefusal(unclassed, cfg(list), "m")).toBeNull();
    expect(meteredConsentRefusal(unclassed, cfg(list), "other-model")).not.toBeNull();
  });
});

describe("hermes per-model billing (spec 010 R8)", () => {
  const hermes = { instanceId: "hermes", displayName: "Dani Agent", driverKind: "hermesAgent" as const };

  it("an openrouter model is metered; the refusal names the provider it bills through", () => {
    expect(turnBilling(hermes, "openrouter:anthropic/claude-sonnet-4")).toBe("metered");
    const refusal = meteredConsentRefusal(hermes, cfg([]), "openrouter:anthropic/claude-sonnet-4");
    expect(refusal).toContain("via openrouter");
    expect(refusal).toContain("openrouter:anthropic/claude-sonnet-4");
  });

  it("subscription and local hermes providers are never gated", () => {
    expect(meteredConsentRefusal(hermes, cfg([]), "nous:hermes-3")).toBeNull();
    expect(meteredConsentRefusal(hermes, cfg([]), "ollama:qwen3")).toBeNull();
  });

  it("an unknown provider never reads as free - it is gated until acknowledged", () => {
    expect(turnBilling(hermes, "somefuture:model")).toBe("unknown");
    const refusal = meteredConsentRefusal(hermes, cfg([]), "somefuture:model");
    expect(refusal).toContain("unknown billing class");
    expect(refusal).toContain("via somefuture");
    const list = withMeteredAcknowledgement(cfg([]), "hermes", "somefuture:model");
    expect(meteredConsentRefusal(hermes, cfg(list), "somefuture:model")).toBeNull();
  });

  it("the acknowledgement is per model, not per hermes instance", () => {
    const list = withMeteredAcknowledgement(cfg([]), "hermes", "openrouter:anthropic/claude-sonnet-4");
    expect(meteredConsentRefusal(hermes, cfg(list), "openrouter:anthropic/claude-sonnet-4")).toBeNull();
    expect(meteredConsentRefusal(hermes, cfg(list), "openrouter:openai/gpt-5")).not.toBeNull();
  });
});

describe("withMeteredAcknowledgement", () => {
  it("records instance, model, and time; re-acknowledging is idempotent", () => {
    const once = withMeteredAcknowledgement(cfg([]), "grok", "grok-3-mini", "2026-09-22T00:00:00Z");
    expect(once).toEqual([{ instanceId: "grok", model: "grok-3-mini", acknowledgedAt: "2026-09-22T00:00:00Z" }]);
    const twice = withMeteredAcknowledgement(cfg(once), "grok", "grok-3-mini");
    expect(twice).toHaveLength(1);
    expect(hasMeteredAcknowledgement(cfg(twice), "grok", "grok-3-mini")).toBe(true);
  });
});
