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

describe("activation failure reporting", () => {
  const absent = [hermes({ snapshot: { state: "unavailable" }, models: { default: "" } })];

  it("reports why preparing the runtime failed, not just that it is missing", () => {
    const status = bootstrapStatus(absent, false, "runtime.digest-mismatch");
    expect(status.code).toBe("runtime.digest-mismatch");
    expect(status.phase).toBe("activate");
    expect(status.state).toBe("repairable-error");
  });

  it("offers no retry where retrying cannot possibly help", () => {
    for (const code of ["runtime.unsupported-platform", "runtime.payload-missing", "runtime.manifest-invalid"]) {
      const status = bootstrapStatus(absent, false, code);
      expect(status.state, code).toBe("blocked-error");
      // No retry button: nothing on this machine can change the answer.
      expect(status.canRetry, code).toBe(false);
      expect(status.canContinueLimited, code).toBe(true);
    }
  });

  it("never lets an activation failure contradict a runtime that is actually ready", () => {
    expect(bootstrapStatus([hermes()], false, "runtime.digest-mismatch")).toMatchObject({ state: "ready" });
  });

  it("ignores an activation code it does not recognise rather than echoing it", () => {
    const status = bootstrapStatus(absent, false, "runtime.something-new");
    expect(status.code).toBe("runtime.absent");
  });

  it("keeps activation copy free of commands, paths and engine vocabulary", () => {
    const forbidden = /hermes|cli|curl|powershell|terminal|iex|harness|engine|sha256|\//i;
    for (const code of Object.keys({
      "runtime.unsupported-platform": 0,
      "runtime.payload-missing": 0,
      "runtime.manifest-invalid": 0,
      "runtime.digest-mismatch": 0,
      "runtime.archive-unsafe": 0,
      "runtime.executable-missing": 0,
      "runtime.activation-failed": 0,
    })) {
      expect(bootstrapStatus(absent, false, code).message, code).not.toMatch(forbidden);
    }
  });

  it("still offers a retry when a re-probe could find a runtime installed since", () => {
    const status = bootstrapStatus(absent);
    expect(status.code).toBe("runtime.absent");
    expect(status.canRetry).toBe(true);
  });

  it("offers no retry when the runtime is not registered at all", () => {
    const status = bootstrapStatus([]);
    expect(status.state).toBe("blocked-error");
    expect(status.canRetry).toBe(false);
    expect(status.canContinueLimited).toBe(true);
  });
});
