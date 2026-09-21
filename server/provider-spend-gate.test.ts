// Spend-gate tests — security/epic-9-D. A fresh install cannot make a
// metered provider request until the user explicitly chooses the
// provider/model AND acknowledges the cost class. Credential presence alone
// never satisfies the gate.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProviderBilling } from "./provider-billing.ts";
import { SpendAckStore, checkSpendGate } from "./provider-spend-gate.ts";

function freshStore(): SpendAckStore {
  return new SpendAckStore(mkdtempSync(join(tmpdir(), "spend-ack-test-")));
}

const metered = resolveProviderBilling({ driverKind: "grok", modelId: "grok-4", snapshotBilling: "metered" });
const free = resolveProviderBilling({ driverKind: "hermesAgent", modelId: "ollama:llama3" });
const unknown = resolveProviderBilling({ driverKind: "some-future-driver", modelId: "x" });

describe("provider spend gate", () => {
  it("blocks a metered request on a fresh install (no acknowledgements)", () => {
    const store = freshStore();
    const verdict = checkSpendGate({
      billing: metered,
      ack: store.find("grok-1", "grok-4"),
      instanceId: "grok-1",
      model: "grok-4",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/acknowledge the cost/i);
  });

  it("allows a metered request after explicit selection + acknowledgement", () => {
    const store = freshStore();
    store.record({ instanceId: "grok-1", model: "grok-4", billingClass: "metered", acknowledgedAt: "" });
    const verdict = checkSpendGate({
      billing: metered,
      ack: store.find("grok-1", "grok-4"),
      instanceId: "grok-1",
      model: "grok-4",
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("credential presence alone still blocks: authenticated snapshot without an ack", () => {
    // The gate never sees `authenticated` — this test pins that a provider
    // which merely reports credentials gets no implicit consent.
    const store = freshStore();
    const verdict = checkSpendGate({
      billing: resolveProviderBilling({ driverKind: "grok", modelId: "grok-4", snapshotBilling: undefined }),
      ack: store.find("grok-1", "grok-4"),
      instanceId: "grok-1",
      model: "grok-4",
    });
    expect(verdict.ok).toBe(false);
  });

  it("treats unknown-cost providers as metered (fail closed)", () => {
    expect(unknown.billingClass).toBe("unknown");
    expect(unknown.requiresExplicitSelection).toBe(true);
    const store = freshStore();
    const verdict = checkSpendGate({
      billing: unknown,
      ack: store.find("future-1", "x"),
      instanceId: "future-1",
      model: "x",
    });
    expect(verdict.ok).toBe(false);
  });

  it("lets free providers through with no acknowledgement", () => {
    expect(free.billingClass).toBe("free");
    const store = freshStore();
    expect(
      checkSpendGate({ billing: free, ack: store.find("h", "ollama:llama3"), instanceId: "h", model: "ollama:llama3" }),
    ).toEqual({ ok: true });
  });

  it("is scoped to the exact model: ack for model A does not unlock model B", () => {
    const store = freshStore();
    store.record({ instanceId: "grok-1", model: "grok-4", billingClass: metered.billingClass, acknowledgedAt: "" });
    const verdict = checkSpendGate({
      billing: metered,
      ack: store.find("grok-1", "grok-4-heavy"),
      instanceId: "grok-1",
      model: "grok-4-heavy",
    });
    expect(verdict.ok).toBe(false);
  });

  it("requires re-acknowledgement when the resolved billing class changes", () => {
    const store = freshStore();
    store.record({ instanceId: "grok-1", model: "grok-4", billingClass: "subscription", acknowledgedAt: "" });
    const verdict = checkSpendGate({
      billing: metered,
      ack: store.find("grok-1", "grok-4"),
      instanceId: "grok-1",
      model: "grok-4",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/re-acknowledge/i);
  });

  it("persists acknowledgements across store instances (same data dir)", () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ack-persist-"));
    new SpendAckStore(dir).record({
      instanceId: "grok-1",
      model: "grok-4",
      billingClass: "metered",
      acknowledgedAt: "",
    });
    const reloaded = new SpendAckStore(dir).find("grok-1", "grok-4");
    expect(reloaded?.billingClass).toBe("metered");
    expect(reloaded?.acknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("a corrupt ack file fails closed instead of crashing or failing open", () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ack-corrupt-"));
    writeFileSync(join(dir, "spend-acknowledgements.json"), "not json{{", "utf8");
    const store = new SpendAckStore(dir);
    expect(store.find("grok-1", "grok-4")).toBeUndefined();
    expect(
      checkSpendGate({ billing: metered, ack: store.find("grok-1", "grok-4"), instanceId: "grok-1", model: "grok-4" }).ok,
    ).toBe(false);
    // recording still works after corruption — the store recovers
    store.record({ instanceId: "grok-1", model: "grok-4", billingClass: "metered", acknowledgedAt: "" });
    expect(store.find("grok-1", "grok-4")?.billingClass).toBe("metered");
  });
});
