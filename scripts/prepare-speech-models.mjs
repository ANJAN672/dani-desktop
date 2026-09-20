// Download and verify the pinned local speech-model payload. Files land outside
// ASAR under dist-native/speech-models and are reused only after a full hash.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { SPEECH_MODEL_BUNDLE, SPEECH_MODEL_BUNDLE_BYTES } from "../server/speech-model-bundle.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const output = join(root, "dist-native", "speech-models");
export const assets = Object.freeze([
  Object.freeze({ ...SPEECH_MODEL_BUNDLE.stt, path: join("whisper", SPEECH_MODEL_BUNDLE.stt.file) }),
  Object.freeze({ ...SPEECH_MODEL_BUNDLE.tts.model, path: join("kokoro", SPEECH_MODEL_BUNDLE.tts.model.file) }),
  Object.freeze({ ...SPEECH_MODEL_BUNDLE.tts.voice, path: join("kokoro", "voices", SPEECH_MODEL_BUNDLE.tts.voice.file) }),
]);

export function assertManifest(entries = assets) {
  const paths = new Set();
  let bytes = 0;
  for (const asset of entries) {
    if (!asset.path || paths.has(asset.path)) throw new Error(`duplicate or empty speech-model path: ${asset.path}`);
    if (!/^https:\/\//.test(asset.url)) throw new Error(`speech model must use HTTPS: ${asset.path}`);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`invalid SHA-256 for ${asset.path}`);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) throw new Error(`invalid size for ${asset.path}`);
    paths.add(asset.path); bytes += asset.bytes;
  }
  if (bytes !== SPEECH_MODEL_BUNDLE_BYTES) throw new Error(`speech-model size mismatch: ${bytes}`);
  return bytes;
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function valid(path, asset) {
  try { return (await stat(path)).size === asset.bytes && (await sha256(path)) === asset.sha256; }
  catch { return false; }
}

async function stage(asset) {
  const destination = join(output, asset.path);
  if (await valid(destination, asset)) return;
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.download`;
  await rm(temporary, { force: true });
  const response = await fetch(asset.url, { redirect: "follow", headers: { "user-agent": "DaniBot-packager" } });
  if (!response.ok || !response.body) throw new Error(`speech model download failed (${response.status}): ${asset.path}`);
  await pipeline(response.body, createWriteStream(temporary, { mode: 0o644 }));
  if (!(await valid(temporary, asset))) {
    await rm(temporary, { force: true });
    throw new Error(`speech model failed size or SHA-256 verification: ${asset.path}`);
  }
  await rename(temporary, destination);
}

export async function prepareSpeechModels() {
  assertManifest();
  for (const asset of assets) await stage(asset);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await prepareSpeechModels();
  console.log(`Prepared ${SPEECH_MODEL_BUNDLE_BYTES} bytes of pinned speech models.`);
}
