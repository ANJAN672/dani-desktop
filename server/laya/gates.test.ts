import { describe, expect, it } from "vitest";
import { layaEnabled, layaRoutingEnabled, layaShadowEnabled, parseStoredConfig } from "../config.ts";

/** Spec 100 R5: every Laya gate defaults off and opens only on explicit
 * opt-in, mirroring features.proactive. */
describe("laya rollout gates", () => {
  it("default off on an empty config", () => {
    expect(layaEnabled({})).toBe(false);
    expect(layaShadowEnabled({})).toBe(false);
    expect(layaRoutingEnabled({})).toBe(false);
  });
  it("open only on explicit true", () => {
    const cfg = parseStoredConfig({ features: { laya: true, layaShadow: true, layaRouting: true } });
    expect(layaEnabled(cfg)).toBe(true);
    expect(layaShadowEnabled(cfg)).toBe(true);
    expect(layaRoutingEnabled(cfg)).toBe(true);
  });
  it("shadow and routing stay off when only the service gate opens", () => {
    const cfg = parseStoredConfig({ features: { laya: true } });
    expect(layaShadowEnabled(cfg)).toBe(false);
    expect(layaRoutingEnabled(cfg)).toBe(false);
  });
  it("parses the tuning block and preserves defaults", () => {
    const cfg = parseStoredConfig({ laya: { checkpoint: "multilingual", device: "cpu", minConfidence: 0.5 } });
    expect(cfg.laya?.checkpoint).toBe("multilingual");
    expect(cfg.laya?.device).toBe("cpu");
    expect(cfg.laya?.allowDownload).toBeUndefined();
    expect(parseStoredConfig({}).laya).toBeUndefined();
  });
  it("rejects an unknown checkpoint name", () => {
    expect(() => parseStoredConfig({ laya: { checkpoint: "nightly" } })).toThrow();
  });
  it("does not treat allowDownload as implied by the service gate", () => {
    const cfg = parseStoredConfig({ features: { laya: true } });
    expect(cfg.laya?.allowDownload).toBeUndefined();
  });
});
