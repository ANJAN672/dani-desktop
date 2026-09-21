import { describe, expect, it } from "vitest";

import type { ModelCatalog, ProviderSnapshot } from "./contracts.ts";
import { selectDefaultModelSelection } from "./default-model-selection.ts";

const codex = {
  instanceId: "codex",
  driverKind: "codex",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: {
    default: "codex-default",
    options: [{ id: "codex-default", label: "Default" }, { id: "selected-model", label: "Selected" }],
  } satisfies ModelCatalog,
  capabilities: { effortLevels: ["low", "high"] as const },
};
const claude = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: { default: "claude-default", options: [{ id: "claude-default", label: "Claude" }] },
};
const daniFree = {
  instanceId: "dani-free",
  driverKind: "openai-compat",
  install: { managed: { kind: "dani-free" as const } },
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: { default: "dani-free-model", options: [{ id: "dani-free-model", label: "Dani-Free" }] },
};
const hermes = {
  instanceId: "hermes",
  driverKind: "hermesAgent",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: { default: "hermes-model", options: [{ id: "hermes-model", label: "Hermes" }] },
};

describe("new bot default model selection", () => {
  it.each(["low", "high"] as const)("honors the configured provider, model, and supported %s effort ahead of the Claude preference", (effort) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort };
    const selection = selectDefaultModelSelection([claude, codex], preferred);
    expect(selection).toEqual(preferred);
    expect(selection).not.toBe(preferred);
  });

  it.each([
    { label: "missing capabilities", capabilities: undefined },
    { label: "no effort control", capabilities: {} },
    { label: "empty effort list", capabilities: { effortLevels: [] } },
    { label: "changed effort support", capabilities: { effortLevels: ["low"] as const } },
  ])("omits stale effort for $label without changing the provider, model, or saved preference", ({ capabilities }) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort: "high" as const };
    const selection = selectDefaultModelSelection([
      { ...claude, capabilities: { effortLevels: ["high"] } },
      { ...codex, capabilities },
    ], preferred);
    expect(selection).toEqual({ instanceId: "codex", model: "selected-model" });
    expect(selection).not.toHaveProperty("effort");
    expect(preferred.effort).toBe("high");
  });

  it("accepts the provider default even when it is not repeated in its options", () => {
    expect(selectDefaultModelSelection(
      [{ ...codex, models: { default: "codex-default", options: [] } }],
      { instanceId: "codex", model: "codex-default" },
    )).toEqual({ instanceId: "codex", model: "codex-default" });
  });

  it.each([
    { label: "missing provider", instances: [claude] },
    { label: "unavailable provider", instances: [claude, { ...codex, snapshot: { state: "unavailable" as const } }] },
    { label: "signed-out provider", instances: [claude, { ...codex, snapshot: { state: "available" as const, authenticated: false } }] },
    { label: "removed model", instances: [claude, { ...codex, models: { default: "new-model", options: [] } }] },
  ])("returns setup for a saved $label without changing provider", ({ instances }) => {
    expect(selectDefaultModelSelection(instances, { instanceId: "codex", model: "selected-model" }))
      .toEqual({ instanceId: "", model: "" });
  });

  it("prefers available Dani-Free, then Hermes, only when no default was saved", () => {
    expect(selectDefaultModelSelection([codex, hermes, daniFree, claude]))
      .toEqual({ instanceId: "dani-free", model: "dani-free-model" });
    expect(selectDefaultModelSelection([codex, hermes, claude]))
      .toEqual({ instanceId: "hermes", model: "hermes-model" });
    expect(selectDefaultModelSelection([{ ...daniFree, snapshot: { state: "unavailable" } }, hermes, codex]))
      .toEqual({ instanceId: "hermes", model: "hermes-model" });
    expect(selectDefaultModelSelection([daniFree, codex], { instanceId: "codex", model: "selected-model" }))
      .toEqual({ instanceId: "codex", model: "selected-model" });
  });

  it("keeps the first available non-priority provider when no default was saved", () => {
    expect(selectDefaultModelSelection([codex, claude])).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(selectDefaultModelSelection([codex])).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(selectDefaultModelSelection([])).toEqual({ instanceId: "", model: "" });
  });
});
