import { describe, expect, it } from "vitest";
import { bootstrapStatus, type BootstrapCandidate } from "./runtime-bootstrap.ts";

const hermes = (over: Partial<BootstrapCandidate> = {}): BootstrapCandidate => ({
  driverKind: "hermesAgent",
  snapshot: { state: "available" },
  models: { default: "hermes-default" },
  managedInstall: true,
  ...over,
});

describe("runtime bootstrap status", () => {
  it("is checking before the probe answers", () => {
    expect(bootstrapStatus(null)).toMatchObject({ state: "checking", code: "runtime.checking" });
  });

  it("is ready only when Hermes is available and has a model", () => {
    expect(bootstrapStatus([hermes()])).toMatchObject({ state: "ready", code: "runtime.ready" });
  });

  it("refuses ready when the runtime is available but has no model", () => {
    const status = bootstrapStatus([hermes({ models: { default: "" } })]);
    expect(status.state).toBe("repairable-error");
    expect(status.code).toBe("runtime.no-model");
  });

  it("never reports ready from another available harness", () => {
    const status = bootstrapStatus([
      { driverKind: "grok", snapshot: { state: "available" }, models: { default: "g" }, managedInstall: false },
      hermes({ snapshot: { state: "unavailable" }, models: { default: "" } }),
    ]);
    expect(status.state).not.toBe("ready");
    expect(status.code).toBe("runtime.absent");
  });

  it("separates an absent runtime from a wrong-version runtime", () => {
    expect(bootstrapStatus([hermes({ snapshot: { state: "unavailable" }, models: { default: "" } })]).code)
      .toBe("runtime.absent");
    expect(bootstrapStatus([hermes({ snapshot: { state: "unavailable", version: "0.19.0" }, models: { default: "" } })]).code)
      .toBe("runtime.version-mismatch");
  });

  it("blocks rather than offers repair when the driver cannot install itself", () => {
    const status = bootstrapStatus([hermes({ snapshot: { state: "unavailable" }, models: { default: "" }, managedInstall: false })]);
    expect(status.state).toBe("blocked-error");
    expect(status.canContinueLimited).toBe(true);
  });

  it("treats a missing Hermes registration as a blocked install fault", () => {
    expect(bootstrapStatus([])).toMatchObject({ state: "blocked-error", code: "runtime.not-configured" });
  });

  it("reports an in-flight repair without claiming readiness", () => {
    const status = bootstrapStatus([hermes({ snapshot: { state: "unavailable" }, models: { default: "" } })], true);
    expect(status.state).toBe("installing");
    expect(status.canRetry).toBe(false);
  });

  it("does not leak commands, paths or engine vocabulary into user copy", () => {
    const forbidden = /hermes|cli|curl|powershell|terminal|iex|harness|engine|\//i;
    for (const candidates of [null, [], [hermes()], [hermes({ snapshot: { state: "unavailable" }, models: { default: "" } })]]) {
      expect(bootstrapStatus(candidates as BootstrapCandidate[] | null).message).not.toMatch(forbidden);
    }
  });
});
