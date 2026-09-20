import test from "node:test";
import assert from "node:assert/strict";
import { assets, assertManifest } from "./prepare-speech-models.mjs";

test("speech model manifest is complete and pinned", () => {
  assert.equal(assertManifest(), 152_590_981);
  assert.deepEqual(assets.map((asset) => asset.path), [
    "whisper/ggml-base-q5_1.bin",
    "kokoro/model_quantized.onnx",
    "kokoro/voices/af_heart.bin",
  ]);
});

test("speech model manifest rejects duplicate destinations", () => {
  assert.throws(() => assertManifest([assets[0], assets[0]]), /duplicate/);
});
