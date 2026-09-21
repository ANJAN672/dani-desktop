import { describe, expect, it } from "vitest";
import { meteredConsentRefusal } from "./metered-consent.ts";
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

  it("never gates subscription, local, or unclassed engines", () => {
    expect(meteredConsentRefusal({ ...metered, billingClass: "subscription" }, cfg([]), "m")).toBeNull();
    expect(meteredConsentRefusal({ ...metered, billingClass: "local" }, cfg([]), "m")).toBeNull();
    expect(meteredConsentRefusal({ instanceId: "claude", displayName: "Claude" }, cfg([]), "m")).toBeNull();
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
