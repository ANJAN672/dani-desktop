import { vi } from "vitest";

// Module init reads window.dani for platform capabilities; tests run in node.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { readyNoteFor, ZeroReadyNotice } from "./Onboarding";
import type { InstanceInfo } from "@/state/store";

const baseInstance: InstanceInfo = {
  instanceId: "test",
  driverKind: "test-driver",
  displayName: "Test Engine",
  snapshot: { state: "available" },
  models: { default: "m", options: [] },
} as InstanceInfo;

describe("readyNoteFor", () => {
  it("labels a metered engine as billed per run, never as free", () => {
    const note = readyNoteFor({ ...baseInstance, access: "subscription", snapshot: { state: "available", billing: "metered" } } as InstanceInfo);
    expect(note).toContain("metered");
    expect(note).toContain("bill");
    expect(note).not.toContain("free");
  });

  it("labels a subscription engine as included", () => {
    const note = readyNoteFor({ ...baseInstance, access: "subscription", snapshot: { state: "available", billing: "subscription" } } as InstanceInfo);
    expect(note).toContain("subscription");
  });

  it("keeps the local-model note for custom-access engines", () => {
    const note = readyNoteFor({ ...baseInstance, access: "custom" } as InstanceInfo);
    expect(note).toContain("local model");
  });

  it("falls back to the neutral note when billing class is unknown", () => {
    const note = readyNoteFor({ ...baseInstance, access: "subscription", snapshot: { state: "available" } } as InstanceInfo);
    expect(note).toBe("Installed — ready to power bots.");
  });
});

describe("ZeroReadyNotice", () => {
  it("points at the setup rows when engines need setup", () => {
    const markup = renderToStaticMarkup(createElement(ZeroReadyNotice, { hasSetupRows: true }));
    expect(markup).toContain("No engine is ready yet.");
    expect(markup).toContain("pick one below");
  });

  it("says an install is needed when nothing was found at all", () => {
    const markup = renderToStaticMarkup(createElement(ZeroReadyNotice, { hasSetupRows: false }));
    expect(markup).toContain("No engine is ready yet.");
    expect(markup).toContain("until an engine is installed");
  });
});

describe("engineReady (spec 040 R2)", () => {
  it("treats a key-based engine with an unverified key as not ready", async () => {
    const { engineReady } = await import("./Onboarding");
    expect(engineReady({
      ...baseInstance,
      access: "subscription",
      snapshot: { state: "available", authenticated: true, verification: { status: "unverified" } },
    } as InstanceInfo)).toBe(false);
  });

  it("treats a key-based engine as ready only after a live probe", async () => {
    const { engineReady } = await import("./Onboarding");
    expect(engineReady({
      ...baseInstance,
      access: "subscription",
      snapshot: { state: "available", authenticated: true, verification: { status: "verified", checkedAt: "2026-09-22T00:00:00Z" } },
    } as InstanceInfo)).toBe(true);
  });

  it("keeps CLI engines on their existing authenticated signal", async () => {
    const { engineReady } = await import("./Onboarding");
    expect(engineReady({
      ...baseInstance,
      access: "subscription",
      snapshot: { state: "available", authenticated: true },
    } as InstanceInfo)).toBe(true);
    expect(engineReady({
      ...baseInstance,
      access: "subscription",
      snapshot: { state: "available", authenticated: false },
    } as InstanceInfo)).toBe(false);
  });
});
