import { describe, expect, it } from "vitest";
import {
  LAYA_CHECKPOINTS,
  LAYA_HUB_REPO,
  LAYA_LICENSE,
  LAYA_PINNED_REVISION,
  LAYA_SDK,
  LAYA_TYPED_DECISIONS,
  layaCheckpointBySubfolder,
} from "./manifest.ts";

/** The manifest is the machine-readable half of spec 100 slice 1; drift
 * between it and the pinned upstream must fail loudly. */
describe("pinned Laya checkpoint manifest", () => {
  it("pins a full-length revision and repo", () => {
    expect(LAYA_PINNED_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(LAYA_HUB_REPO).toBe("convaiinnovations/laya");
    expect(LAYA_LICENSE).toBe("apache-2.0");
  });
  it("every checkpoint file carries a size and a hash", () => {
    for (const checkpoint of LAYA_CHECKPOINTS) {
      for (const file of checkpoint.files) {
        expect(file.bytes, file.path).toBeGreaterThan(0);
        expect(file.sha256 ?? file.gitBlob, file.path).toMatch(/^[0-9a-f]{64}$|^[0-9a-f]{40}$/);
      }
      expect(checkpoint.downloadBytes).toBe(checkpoint.files.reduce((n, f) => n + f.bytes, 0));
      expect(checkpoint.files.some((f) => f.path.endsWith("model.safetensors") && f.sha256)).toBe(true);
    }
  });
  it("records the SDK pin", () => {
    expect(LAYA_SDK.version).toBe("0.3.5");
    expect(LAYA_SDK.wheelSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("resolves checkpoints by subfolder", () => {
    expect(layaCheckpointBySubfolder("typed-decisions")).toBe(LAYA_TYPED_DECISIONS);
    expect(layaCheckpointBySubfolder("")).toBeDefined();
    expect(layaCheckpointBySubfolder("nonexistent")).toBeNull();
  });
});
