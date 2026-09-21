import { describe, expect, it } from "vitest";

import { needsCli, needsSignIn, needsVerification } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("needsVerification (spec 040 R2)", () => {
  it("is its own state for a saved-but-unverified key, not install or sign-in", () => {
    const unverified = instance({ state: "available", authenticated: true, verification: { status: "unverified" } });
    expect(needsVerification(unverified)).toBe(true);
    expect(needsCli(unverified)).toBe(false);
    expect(needsSignIn(unverified)).toBe(false);
  });

  it("is not needed once the live probe passes", () => {
    const verified = instance({ state: "available", authenticated: true, verification: { status: "verified", checkedAt: "2026-09-22T00:00:00Z" } });
    expect(needsVerification(verified)).toBe(false);
  });

  it("does not apply to CLI engines or unavailable engines", () => {
    expect(needsVerification(instance({ state: "available", authenticated: true }))).toBe(false);
    expect(needsVerification(instance({ state: "unavailable", reason: "not found" }))).toBe(false);
  });
});
