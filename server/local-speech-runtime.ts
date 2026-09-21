import { access, readFile, stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "./config.ts";
import { SPEECH_MODEL_BUNDLE } from "./speech-model-bundle.ts";

export type LocalSpeechComponent = { ready: boolean; reason?: string };
export type LocalSpeechStatus = { enabled: boolean; ready: boolean; stt: LocalSpeechComponent; tts: LocalSpeechComponent };
type ResolvedStatus = LocalSpeechStatus & { paths: { whisper: string; whisperModel: string; kokoro: string; kokoroModel: string; kokoroVoices: string } };

function resourcesRoot() { return process.env.DANI_RESOURCES_PATH?.trim() || resolve(process.cwd(), "dist-native"); }
function executableName(name: string) { return process.platform === "win32" ? `${name}.exe` : name; }
async function usableFile(path: string, executable = false) {
  try { if (!(await stat(path)).isFile()) return false; if (executable && process.platform !== "win32") await access(path, constants.X_OK); return true; }
  catch { return false; }
}
function reason(enabled: boolean, binary: boolean, data: boolean, label: string) {
  if (!enabled) return "Local speech is disabled";
  if (!binary) return `${label} is not packaged for ${process.platform}-${process.arch}`;
  if (!data) return "The pinned local speech model is missing";
}
async function resolveStatus(cfg: AppConfig): Promise<ResolvedStatus> {
  const enabled = cfg.features?.localSpeech === true;
  const root = resourcesRoot();
  const runtime = join(root, "speech-runtime", `${process.platform}-${process.arch}`);
  const modelRoot = join(root, "speech-models");
  const paths = {
    whisper: process.env.DANI_WHISPER_CLI?.trim() || join(runtime, executableName("whisper-cli")),
    whisperModel: join(modelRoot, "whisper", SPEECH_MODEL_BUNDLE.stt.file),
    kokoro: process.env.DANI_KOKORO_CLI?.trim() || join(runtime, executableName("kokoro-cli")),
    kokoroModel: join(modelRoot, "kokoro", SPEECH_MODEL_BUNDLE.tts.model.file),
    kokoroVoices: join(modelRoot, "kokoro", "voices", SPEECH_MODEL_BUNDLE.tts.voice.file),
  };
  const [wb, wm, kb, km, kv] = await Promise.all([usableFile(paths.whisper, true), usableFile(paths.whisperModel), usableFile(paths.kokoro, true), usableFile(paths.kokoroModel), usableFile(paths.kokoroVoices)]);
  const stt = { ready: enabled && wb && wm, reason: reason(enabled, wb, wm, "whisper-cli") };
  const tts = { ready: enabled && kb && km && kv, reason: reason(enabled, kb, km && kv, "kokoro-cli") };
  return { enabled, ready: stt.ready && tts.ready, stt, tts, paths };
}
export async function localSpeechStatus(cfg: AppConfig): Promise<LocalSpeechStatus> {
  const { paths: _, ...status } = await resolveStatus(cfg); return status;
}
function run(binary: string, args: string[], timeoutMs: number) {
  return new Promise<void>((resolveRun, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const stderr: Buffer[] = []; let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", (part) => stderr.push(Buffer.from(part)));
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on("close", (code, signal) => { if (settled) return; settled = true; clearTimeout(timer); const detail = Buffer.concat(stderr).toString("utf8").trim(); code === 0 ? resolveRun() : reject(new Error(`${basename(binary)} failed (${signal || code})${detail ? `: ${detail.slice(0, 500)}` : ""}`)); });
  });
}
export async function transcribeLocalWav(cfg: AppConfig, wav: Uint8Array) {
  const status = await resolveStatus(cfg); if (!status.stt.ready) throw new Error(status.stt.reason || "Local STT is unavailable");
  const dir = await mkdtemp(join(tmpdir(), "dani-whisper-"));
  try { const input = join(dir, "input.wav"), output = join(dir, "transcript"); await writeFile(input, wav, { mode: 0o600 }); await run(status.paths.whisper, ["-m", status.paths.whisperModel, "-f", input, "-otxt", "-of", output, "--no-prints"], 120_000); return (await readFile(`${output}.txt`, "utf8")).trim(); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
export async function synthesizeLocal(cfg: AppConfig, text: string) {
  const status = await resolveStatus(cfg); if (!status.tts.ready) throw new Error(status.tts.reason || "Local TTS is unavailable");
  const dir = await mkdtemp(join(tmpdir(), "dani-kokoro-"));
  try { const input = join(dir, "input.txt"), output = join(dir, "output.wav"); await writeFile(input, text, { encoding: "utf8", mode: 0o600 }); await run(status.paths.kokoro, [input, output, "--model", status.paths.kokoroModel, "--voices", status.paths.kokoroVoices, "--voice", "af_heart", "--lang", "en-us", "--format", "wav"], 120_000); return { bytes: new Uint8Array(await readFile(output)), mime: "audio/wav" }; }
  finally { await rm(dir, { recursive: true, force: true }); }
}
