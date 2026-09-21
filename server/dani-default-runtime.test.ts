import { describe, expect, it } from "vitest";
import { selectDaniDefault } from "./dani-default-runtime.ts";
import { resolveProviderBilling } from "./provider-billing.ts";

/** The production billing resolver — the same function index.ts passes in. */
const productionBillingOf = (driverKind: string, modelId: string) =>
  resolveProviderBilling({ driverKind, modelId }).billingClass;

describe("Dani Hermes default", () => {
  it("selects available Hermes even when another engine is first", () => {
    expect(selectDaniDefault([
      { instanceId: "other", driverKind: "grok", models: { default: "g" }, snapshot: { state: "available" } },
      { instanceId: "hermes", driverKind: "hermesAgent", models: { default: "h" }, snapshot: { state: "available" } },
    ])).toMatchObject({ state: "ready", instanceId: "hermes", model: "h" });
  });
  it("allows an explicit hermetic test provider without changing production selection", () => {
    expect(selectDaniDefault([
      { instanceId: "fixture", driverKind: "claudeAgent", models: { default: "fake" }, snapshot: { state: "available" } },
    ], "fixture")).toMatchObject({ state: "ready", instanceId: "fixture", model: "fake" });
  });
  it("fails closed instead of silently choosing another provider", () => {
    expect(selectDaniDefault([
      { instanceId: "other", driverKind: "grok", models: { default: "g" }, snapshot: { state: "available" } },
    ])).toMatchObject({ state: "no-model", instanceId: "", model: "" });
  });

  // ── FAIL-CLOSED SPEND INVARIANT (security/epic-9-D) ──────────────────
  // Credential presence must NEVER choose a paid default. These tests pin
  // the invariant with the production billing resolver: even a fully
  // authenticated metered provider cannot become the implicit default, and
  // a Hermes whose own default model is metered/unknown fails closed too.
  it("never defaults to a metered provider even when it is authenticated", () => {
    expect(selectDaniDefault(
      [
        {
          instanceId: "grok",
          driverKind: "grok",
          models: { default: "grok-4" },
          snapshot: { state: "available", authenticated: true },
        },
      ],
      undefined,
      productionBillingOf,
    )).toMatchObject({ state: "no-model", instanceId: "", model: "" });
  });

  it("never falls back to an authenticated metered provider when Hermes is down", () => {
    expect(selectDaniDefault(
      [
        {
          instanceId: "hermes",
          driverKind: "hermesAgent",
          models: { default: "ollama:llama3" },
          snapshot: { state: "unavailable", reason: "crashed" },
        },
        {
          instanceId: "grok",
          driverKind: "grok",
          models: { default: "grok-4" },
          snapshot: { state: "available", authenticated: true },
        },
      ],
      undefined,
      productionBillingOf,
    )).toMatchObject({ state: "no-model", instanceId: "", model: "" });
  });

  it("fails closed when the Hermes default model itself is metered", () => {
    const selection = selectDaniDefault(
      [
        {
          instanceId: "hermes",
          driverKind: "hermesAgent",
          models: { default: "openrouter:qwen/max" },
          snapshot: { state: "available", authenticated: true },
        },
      ],
      undefined,
      productionBillingOf,
    );
    expect(selection.state).toBe("no-model");
    if (selection.state === "no-model") expect(selection.reason).toMatch(/metered/i);
  });

  it("fails closed on an unknown-cost Hermes default (fail closed, not fail open)", () => {
    expect(selectDaniDefault(
      [
        {
          instanceId: "hermes",
          driverKind: "hermesAgent",
          models: { default: "mystery:model" },
          snapshot: { state: "available" },
        },
      ],
      undefined,
      productionBillingOf,
    )).toMatchObject({ state: "no-model" });
  });

  it("still selects a free Hermes default with the production resolver", () => {
    expect(selectDaniDefault(
      [
        {
          instanceId: "hermes",
          driverKind: "hermesAgent",
          models: { default: "ollama:llama3" },
          snapshot: { state: "available" },
        },
      ],
      undefined,
      productionBillingOf,
    )).toMatchObject({ state: "ready", instanceId: "hermes", model: "ollama:llama3" });
  });
});
