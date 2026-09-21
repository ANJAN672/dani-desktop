import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { browserSurfaceSupported } = require("./browser-platform.cjs");

describe("built-in browser platform gate", () => {
  it("keeps the sandboxed surface available on verified desktop platforms", () => {
    expect(browserSurfaceSupported("darwin")).toBe(true);
    expect(browserSurfaceSupported("linux")).toBe(true);
  });

  it("fails closed on Windows until its real sandbox fixture can block CI", () => {
    expect(browserSurfaceSupported("win32")).toBe(false);
  });

  it("fails closed on unknown platforms", () => {
    expect(browserSurfaceSupported("freebsd")).toBe(false);
  });

  it("keeps the sandboxed preload free of local module imports", () => {
    const preload = readFileSync(fileURLToPath(new URL("./preload.cjs", import.meta.url)), "utf8");
    expect(preload).not.toMatch(/require\(["']\.\//);
  });

  it("keeps recorder and transcription APIs local-only", () => {
    const preload = readFileSync(fileURLToPath(new URL("./preload.cjs", import.meta.url)), "utf8");
    expect(preload).toContain("skillRecorder:");
    expect(preload).toContain("transcription:");
    expect(preload).toContain('const REMOTE_SAFE = new Set(["platform", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount", "permStatus"]);');
    expect(preload).not.toContain('"skillRecorder"');
    expect(preload).not.toContain('"transcription"');
  });
});
