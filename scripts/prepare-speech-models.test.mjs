import { join } from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { assets, assertManifest } from "./prepare-speech-models.mjs";

test("speech model manifest is complete and pinned", () => {
  assert.equal(assertManifest(), 152_590_981);
  // assets use path.join for the platform's separators; compare against the
  // same construction so the check stays exact on Windows too.
  assert.deepEqual(assets.map((asset) => asset.path), [
    join("whisper", "ggml-base-q5_1.bin"),
    join("kokoro", "model_quantized.onnx"),
    join("kokoro", "voices", "af_heart.bin"),
  ]);
});

test("speech model manifest rejects duplicate destinations", () => {
  assert.throws(() => assertManifest([assets[0], assets[0]]), /duplicate/);
});
