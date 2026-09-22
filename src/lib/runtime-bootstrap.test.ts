// Contract tests for the managed-runtime bootstrap seam (issue #18 P0a).
// These exercise the real parsing/decision functions the UI renders from -
// no DOM, no fixtures standing in for product behavior.
import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_UNAVAILABLE,
  bootstrapDiagnostics,
  bootstrapView,
  parseBootstrapStatus,
  type RuntimeBootstrapStatus,
} from "./runtime-bootstrap";

const base: RuntimeBootstrapStatus = {
  schemaVersion: 1,
  state: "checking",
  phase: null,
  progress: null,
  runtime: { kind: "hermes", version: null, source: null },
  canRetry: false,
  canContinueLimited: false,
  error: null,
};

describe("parseBootstrapStatus", () => {
  it("accepts the exact v1 contract shape", () => {
    expect(parseBootstrapStatus(base)).toEqual(base);
  });

  it("rejects shapes that are not the contract - the UI must never invent ready", () => {
    expect(parseBootstrapStatus(null)).toBeNull();
    expect(parseBootstrapStatus("<html>404</html>")).toBeNull();
    expect(parseBootstrapStatus({ ...base, schemaVersion: 2 })).toBeNull();
    expect(parseBootstrapStatus({ ...base, state: "readyish" })).toBeNull();
    expect(parseBootstrapStatus({ ...base, runtime: { kind: "opencode", version: null, source: null } })).toBeNull();
    expect(parseBootstrapStatus({ ...base, progress: { completedBytes: "5", totalBytes: 10 } })).toBeNull();
    expect(parseBootstrapStatus({ ...base, error: { code: 1, message: "x" } })).toBeNull();
  });

  it("the absent-endpoint fallback is a repairable error, never ready", () => {
    expect(BOOTSTRAP_UNAVAILABLE.state).toBe("repairable-error");
    expect(BOOTSTRAP_UNAVAILABLE.canContinueLimited).toBe(true);
    const view = bootstrapView(BOOTSTRAP_UNAVAILABLE);
    expect(view.kind).toBe("error");
  });
});

describe("bootstrapView", () => {
  it("ready carries the verified version", () => {
    const view = bootstrapView({ ...base, state: "ready", runtime: { kind: "hermes", version: "0.21.0", source: "bundled" } });
    expect(view).toEqual({ kind: "ready", version: "0.21.0" });
  });

  it("installing maps phases to product language and computes bounded progress", () => {
    const downloading = bootstrapView({
      ...base,
      state: "installing",
      phase: "detect",
      progress: { completedBytes: 50, totalBytes: 200 },
    });
    expect(downloading).toEqual({ kind: "working", detail: "Downloading…", progressRatio: 0.25 });
    const probe = bootstrapView({ ...base, state: "installing", phase: "probe" });
    expect(probe).toEqual({ kind: "working", detail: "Running a final check…", progressRatio: null });
    // out-of-range byte counts clamp instead of rendering 400%
    const clamped = bootstrapView({
      ...base,
      state: "installing",
      phase: "detect",
      progress: { completedBytes: 400, totalBytes: 200 },
    });
    expect(clamped.kind === "working" && clamped.progressRatio).toBe(1);
    const zero = bootstrapView({
      ...base,
      state: "installing",
      phase: "detect",
      progress: { completedBytes: 0, totalBytes: 0 },
    });
    expect(zero.kind === "working" && zero.progressRatio).toBeNull();
  });

  it("repairable errors keep retry; blocked errors do not offer it", () => {
    const repairable = bootstrapView({
      ...base,
      state: "repairable-error",
      canRetry: true,
      canContinueLimited: true,
      error: { code: "download-failed", message: "The download did not finish." },
    });
    expect(repairable).toEqual({
      kind: "error",
      message: "The download did not finish.",
      canRetry: true,
      canContinueLimited: true,
    });
    const blocked = bootstrapView({
      ...base,
      state: "blocked-error",
      canRetry: true,
      canContinueLimited: false,
      error: { code: "unsupported", message: "This computer cannot run Dani." },
    });
    expect(blocked.kind === "error" && blocked.canRetry).toBe(false);
  });

  it("product copy never leaks harness vocabulary", () => {
    const views = [
      bootstrapView({ ...base, state: "checking" }),
      bootstrapView({ ...base, state: "installing", phase: "activate" }),
      bootstrapView(BOOTSTRAP_UNAVAILABLE),
    ];
    for (const view of views) {
      const text = JSON.stringify(view).toLowerCase();
      for (const banned of ["harness", "engine", "cli", "curl", "powershell", "provider registry", "model rail"]) {
        expect(text).not.toContain(banned);
      }
    }
  });
});

describe("bootstrapDiagnostics", () => {
  it("carries state, phase, runtime, and the redacted error only", () => {
    const text = bootstrapDiagnostics({
      ...base,
      state: "repairable-error",
      phase: "detect",
      runtime: { kind: "hermes", version: null, source: "external" },
      error: { code: "digest-mismatch", message: "Verification failed." },
    });
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      state: "repairable-error",
      phase: "detect",
      runtime: { kind: "hermes", version: null, source: "external" },
      error: { code: "digest-mismatch", message: "Verification failed." },
    });
  });
});
