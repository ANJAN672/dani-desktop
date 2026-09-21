import { describe, expect, it } from "vitest";
import { selectDaniDefault } from "./dani-default-runtime.ts";

describe("Dani Hermes default", () => {
  it("selects available Hermes even when another engine is first", () => {
    expect(selectDaniDefault([
      { instanceId: "other", driverKind: "grok", models: { default: "g" }, snapshot: { state: "available" } },
      { instanceId: "hermes", driverKind: "hermesAgent", models: { default: "h" }, snapshot: { state: "available" } },
    ])).toMatchObject({ state: "ready", instanceId: "hermes", model: "h" });
  });
  it("fails closed instead of silently choosing another provider", () => {
    expect(selectDaniDefault([
      { instanceId: "other", driverKind: "grok", models: { default: "g" }, snapshot: { state: "available" } },
    ])).toMatchObject({ state: "no-model", instanceId: "", model: "" });
  });
});
