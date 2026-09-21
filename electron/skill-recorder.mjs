import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRecorderHelper } from "./build-recorder-helper.mjs";
import { app } from "electron";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SESSION_STATES = new Set(["recording", "review", "interrupted", "cleanup-failed", "saved"]);
const CHECKPOINTABLE_STATES = new Set(["recording"]);
const RESUMABLE_STATES = new Set(["review", "interrupted", "cleanup-failed"]);
const NATIVE_EVENT_TYPES = new Set(["app", "click", "scroll", "key", "typing", "clipboard", "download"]);
const CHECKPOINT_EVENT_TYPES = new Set(["app", "click", "scroll", "shortcut", "typing", "clipboard", "download"]);
const AUDIO_MIME_EXTENSIONS = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/ogg", "ogg"],
]);
const IMAGE_MIME_EXTENSIONS = new Map([
  ["image/webp", "webp"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
]);

const MAX_EVENTS = 600;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_NDJSON_EVENTS = 600;
const HELPER_READY_TIMEOUT_MS = 5_000;
const HELPER_STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const sessionQueues = new Map();
const sessionRoots = new Map();
let activeSession = null;

function recorderError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "RecorderError";
  error.code = code;
  return error;
}

function resolveDataRoot(options = {}) {
  const hasDataRoot = options && typeof options === "object" &&
    Object.prototype.hasOwnProperty.call(options, "dataRoot");
  const configured = hasDataRoot ? options.dataRoot : options;
  const asRootPath = (value) => {
    if (typeof value === "string" && value.trim()) return value;
    if (Buffer.isBuffer(value)) {
      const text = value.toString();
      return text.trim() ? text : null;
    }
    if (value instanceof URL && value.protocol === "file:") {
      try {
        const text = fileURLToPath(value);
        return text.trim() ? text : null;
      } catch {
        return null;
      }
    }
    if (value && typeof value === "object" && typeof value.path === "string" && value.path.trim()) {
      return value.path;
    }
    return null;
  };
  const override = asRootPath(configured) ?? process.env.OMB_DATA_DIR;
  const root = asRootPath(override)
    ?? (() => {
        try {
          return path.join(app.getPath("home"), ".danibot");
        } catch {
          return path.join(os.homedir(), ".danibot");
        }
      })();
  return path.resolve(root);
}

function recordingsRoot(dataRoot) {
  return path.join(resolveDataRoot(dataRoot), "skill-recordings");
}

function assertUuid(sessionId) {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId) || path.basename(sessionId) !== sessionId) {
    throw recorderError("invalid-session-id", "A canonical recorder session UUID is required");
  }
  return sessionId;
}

function sessionDirectory(dataRoot, sessionId) {
  assertUuid(sessionId);
  return path.join(recordingsRoot(dataRoot), sessionId);
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows does not expose POSIX permission bits.
  }
}

function assertRealDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw recorderError("invalid-session-directory", "The recorder session directory is invalid");
  }
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is unavailable on some filesystems.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWriteBytes(filePath, bytes, mode = 0o600) {
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function atomicWriteJson(filePath, value, mode = 0o600) {
  atomicWriteBytes(filePath, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), mode);
}

function atomicWriteText(filePath, text, mode = 0o600) {
  atomicWriteBytes(filePath, Buffer.from(text, "utf8"), mode);
}

function copyDirectory(source, destination) {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw recorderError("invalid-session-directory", "The recorder draft cannot be copied safely");
  }
  ensurePrivateDirectory(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw recorderError("invalid-session-directory", "The recorder draft contains a symbolic link");
    }
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, destinationPath);
      chmodSync(destinationPath, 0o600);
    } else {
      throw recorderError("invalid-session-directory", "The recorder draft contains an unsupported file");
    }
  }
}

function cleanupBackupPath(directory) {
  return `${directory}.cleanup-${process.pid}-${randomUUID()}`;
}

function restoreDraftBackup(directory, backup, manifest) {
  let restored = false;
  if (existsSync(directory)) {
    const partial = `${directory}.failed-${randomUUID()}`;
    try {
      renameSync(directory, partial);
      rmSync(partial, { recursive: true, force: true });
    } catch {
      // Keep the complete backup if a partially deleted draft cannot be moved.
    }
  }
  try {
    renameSync(backup, directory);
    const failedAt = new Date().toISOString();
    writeManifest(directory, {
      ...manifest,
      state: "cleanup-failed",
      stoppedAt: failedAt,
      durationMs: manifest.durationMs || 0,
      updatedAt: failedAt,
    });
    restored = true;
  } catch {
    // The backup remains a complete recoverable draft even if restoration fails.
  }
  return restored || existsSync(backup) || existsSync(directory);
}

function removeCleanupBackup(backup) {
  try {
    rmSync(backup, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function manifestPath(directory) {
  return path.join(directory, "manifest.json");
}

function checkpointDirectory(directory) {
  return path.join(directory, "checkpoints");
}

function checkpointPath(directory, sequence) {
  return path.join(checkpointDirectory(directory), `${sequence}.json`);
}

function latestCheckpointPath(directory) {
  return path.join(directory, "checkpoint.json");
}

function eventsPath(directory) {
  return path.join(directory, "events.ndjson");
}

function framesDirectory(directory) {
  return path.join(directory, "frames");
}

function audioDirectory(directory) {
  return path.join(directory, "audio");
}

function readManifestForDirectory(directory, expectedSessionId) {
  let manifest;
  try {
    manifest = readJson(manifestPath(directory));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw recorderError("session-not-found", "The recorder session does not exist");
    }
    throw recorderError("invalid-session-manifest", "The recorder session manifest is invalid", error);
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.schemaVersion !== 1 ||
    manifest.sessionId !== expectedSessionId ||
    !SESSION_STATES.has(manifest.state) ||
    typeof manifest.startedAt !== "string" ||
    typeof manifest.updatedAt !== "string" ||
    (manifest.stoppedAt !== null && typeof manifest.stoppedAt !== "string") ||
    !Number.isFinite(manifest.durationMs) ||
    manifest.durationMs < 0
  ) {
    throw recorderError("invalid-session-manifest", "The recorder session manifest is invalid");
  }
  return manifest;
}

function readManifest(dataRoot, sessionId) {
  const directory = sessionDirectory(dataRoot, sessionId);
  assertRealDirectory(directory);
  return readManifestForDirectory(directory, sessionId);
}

function writeManifest(directory, manifest) {
  atomicWriteJson(manifestPath(directory), manifest);
}

function durationFromStartedAt(startedAt, fallback = 0) {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : Math.max(0, fallback);
}

function readNativeEvents(directory) {
  try {
    const text = readFileSync(eventsPath(directory), "utf8");
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = sanitizeNativeEvent(JSON.parse(line));
        if (event) events.push(event);
      } catch {
        // Ignore a partial or corrupt trailing line.
      }
    }
    return events.slice(-MAX_NDJSON_EVENTS);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw recorderError("invalid-native-events", "The native event stream is invalid", error);
  }
}

function writeNativeEvents(directory, events) {
  const bounded = events.slice(-MAX_NDJSON_EVENTS);
  atomicWriteText(eventsPath(directory), bounded.length ? `${bounded.map((event) => JSON.stringify(event)).join("\n")}\n` : "");
}

function latestCheckpointForDirectory(directory, expectedSessionId) {
  let latest = null;
  try {
    const checkpoint = readJson(latestCheckpointPath(directory));
    validateCheckpoint(checkpoint, expectedSessionId);
    latest = checkpoint;
  } catch {
    // A stale or transiently unreadable pointer is recoverable from numbered checkpoints.
  }

  try {
    const names = readdirSync(checkpointDirectory(directory));
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      let checkpoint;
      try {
        checkpoint = readJson(path.join(checkpointDirectory(directory), name));
        validateCheckpoint(checkpoint, expectedSessionId);
      } catch {
        // Ignore a partial or corrupt numbered checkpoint; the pointer may still be newer.
        continue;
      }
      if (!latest || checkpoint.sequence > latest.sequence) latest = checkpoint;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return latest;
}

function validateCheckpoint(checkpoint, sessionId) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    checkpoint.schemaVersion !== 1 ||
    checkpoint.sessionId !== sessionId ||
    !Number.isInteger(checkpoint.sequence) ||
    checkpoint.sequence < 0 ||
    !Array.isArray(checkpoint.events) ||
    checkpoint.events.length > MAX_EVENTS ||
    typeof checkpoint.transcript !== "string" ||
    typeof checkpoint.partialTranscript !== "string" ||
    !Number.isFinite(checkpoint.durationMs) ||
    checkpoint.durationMs < 0 ||
    (checkpoint.audioMime !== null && (typeof checkpoint.audioMime !== "string" || !AUDIO_MIME_EXTENSIONS.has(checkpoint.audioMime))) ||
    !Array.isArray(checkpoint.audioChunks) ||
    typeof checkpoint.updatedAt !== "string" ||
    (checkpoint.audioMime === null && checkpoint.audioChunks.length > 0)
  ) {
    throw recorderError("invalid-checkpoint", "The recorder checkpoint is invalid");
  }
  for (const event of checkpoint.events) {
    const sanitized = sanitizeCheckpointEvent(event);
    if (sanitized.screenshot?.startsWith("data:") || (sanitized.screenshot && path.basename(sanitized.screenshot) !== sanitized.screenshot)) {
      throw recorderError("invalid-screenshot", "The checkpoint screenshot is invalid");
    }
  }
  let expectedAudioIndex = 0;
  for (const chunk of checkpoint.audioChunks) {
    if (
      !chunk ||
      !Number.isInteger(chunk.index) ||
      chunk.index !== expectedAudioIndex ||
      typeof chunk.file !== "string" ||
      path.basename(chunk.file) !== chunk.file ||
      !Number.isInteger(chunk.bytes) ||
      chunk.bytes < 0 ||
      chunk.bytes > MAX_AUDIO_CHUNK_BYTES
    ) {
      throw recorderError("invalid-checkpoint", "The recorder checkpoint is invalid");
    }
    expectedAudioIndex += 1;
  }
}
function summarizeSession(dataRoot, sessionId, manifestOverride = null) {
  const directory = sessionDirectory(dataRoot, sessionId);
  assertRealDirectory(directory);
  const manifest = manifestOverride ?? readManifestForDirectory(directory, sessionId);
  const checkpoint = latestCheckpointForDirectory(directory, sessionId);
  const events = checkpoint?.events ?? readNativeEvents(directory);
  const hasAudio = Boolean(checkpoint?.audioChunks?.length);
  return {
    sessionId,
    state: manifest.state,
    startedAt: manifest.startedAt,
    stoppedAt: manifest.stoppedAt ?? null,
    durationMs: Number.isFinite(manifest.durationMs) ? manifest.durationMs : 0,
    eventCount: events.length,
    hasAudio,
    checkpointSequence: checkpoint?.sequence ?? 0,
  };
}

function listSessionIds(dataRoot) {
  const root = recordingsRoot(dataRoot);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw recorderError("invalid-recording-root", "The recorder storage root is invalid", error);
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    try {
      const manifest = readManifestForDirectory(path.join(root, entry.name), entry.name);
      if (manifest.state === "saved") continue;
      records.push({ sessionId: entry.name, startedAt: Date.parse(manifest.startedAt) });
    } catch {
      // A damaged unrelated session must not make the recorder status API unusable.
    }
  }
  records.sort((left, right) =>
    (Number.isFinite(right.startedAt) ? right.startedAt : 0) - (Number.isFinite(left.startedAt) ? left.startedAt : 0) ||
    right.sessionId.localeCompare(left.sessionId),
  );
  return records.map((record) => record.sessionId);
}

function markStaleRecordingSessions(dataRoot) {
  const root = recordingsRoot(dataRoot);
  for (const sessionId of listSessionIds(dataRoot)) {
    if (activeSession?.sessionId === sessionId) continue;
    const directory = path.join(root, sessionId);
    try {
      assertRealDirectory(directory);
      const manifest = readManifestForDirectory(directory, sessionId);
      if (manifest.state !== "recording") continue;
      const stoppedAt = new Date().toISOString();
      writeManifest(directory, {
        ...manifest,
        state: "interrupted",
        stoppedAt,
        durationMs: durationFromStartedAt(manifest.startedAt, manifest.durationMs),
        updatedAt: stoppedAt,
      });
    } catch (error) {
      if (error?.code === "session-not-found") continue;
      throw error;
    }
  }
}

function resolveSessionRoot(sessionId, options = {}) {
  assertUuid(sessionId);
  const knownRoot = sessionRoots.get(sessionId);
  const requestedRoot = options?.dataRoot ? resolveDataRoot(options) : null;
  if (knownRoot && requestedRoot && path.resolve(knownRoot) !== path.resolve(requestedRoot)) {
    throw recorderError("session-root-mismatch", "The recorder session belongs to another data root");
  }
  return path.resolve(knownRoot ?? requestedRoot ?? resolveDataRoot(options));
}

function enqueueSession(sessionId, operation) {
  assertUuid(sessionId);
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  sessionQueues.set(sessionId, current);
  return current.finally(() => {
    if (sessionQueues.get(sessionId) === current) sessionQueues.delete(sessionId);
  });
}

function helperBundlePath() {
  return app?.isPackaged
    ? path.join(process.resourcesPath, "Dani Bot Recorder.app")
    : path.join(moduleDirectory, "resources", "Dani Bot Recorder.app");
}

function helperBinaryPath() {
  return app?.isPackaged
    ? path.join(process.resourcesPath, "Dani Bot Recorder.app", "Contents", "MacOS", "recorder-helper")
    : path.join(moduleDirectory, "resources", "Dani Bot Recorder.app", "Contents", "MacOS", "recorder-helper");
}

function ensureBuilt() {
  if (app?.isPackaged) return;
  const source = path.join(moduleDirectory, "resources", "recorder-helper.swift");
  const info = path.join(moduleDirectory, "resources", "recorder-helper-Info.plist");
  const binary = helperBinaryPath();
  const stale = !existsSync(binary) ||
    Math.max(statSync(source).mtimeMs, statSync(info).mtimeMs) > statSync(binary).mtimeMs;
  if (stale) buildRecorderHelper();
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sanitizeNativeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!NATIVE_EVENT_TYPES.has(raw.type)) return null;
  const atMs = Number(raw.atMs);
  const event = {
    type: raw.type,
    atMs: Number.isFinite(atMs) && atMs >= 0 ? Math.round(atMs) : 0,
  };
  for (const field of ["app", "windowTitle", "role", "name", "identifier", "filename"]) {
    if (typeof raw[field] !== "string") continue;
    const value = cleanText(raw[field], field === "app" ? 80 : field === "windowTitle" ? 120 : 200);
    if (value) event[field] = value;
  }
  if (raw.direction === "up" || raw.direction === "down") event.direction = raw.direction;
  const deltaY = Number(raw.deltaY);
  if (Number.isFinite(deltaY)) event.deltaY = deltaY;
  if (["copy", "cut", "paste"].includes(raw.op)) event.op = raw.op;
  const keyCount = Number(raw.keyCount);
  if (Number.isFinite(keyCount) && keyCount > 0) event.keyCount = Math.round(keyCount);
  if (Number.isInteger(raw.keycode) && raw.keycode >= 0) event.keycode = raw.keycode;
  for (const modifier of ["meta", "control", "option", "shift"]) {
    if (raw[modifier] === true) event[modifier] = true;
  }
  if (Array.isArray(raw.ancestry)) {
    const ancestry = raw.ancestry.map((entry) => cleanText(entry, 120)).filter(Boolean).slice(0, 6);
    if (ancestry.length) event.ancestry = ancestry;
  }
  if (Array.isArray(raw.whereFroms)) {
    const origins = [...new Set(raw.whereFroms.map(safeWebOrigin).filter(Boolean))].slice(0, 5);
    if (origins.length) event.whereFroms = origins;
  }
  return event;
}

function sanitizeCheckpointEvent(raw) {
  if (!raw || typeof raw !== "object" || !CHECKPOINT_EVENT_TYPES.has(raw.type)) {
    throw recorderError("invalid-event", "The checkpoint contains an unsupported event");
  }
  if (typeof raw.id !== "string" || !raw.id) throw recorderError("invalid-event", "The checkpoint event ID is required");
  const atMs = Number(raw.atMs);
  const event = {
    id: raw.id,
    type: raw.type,
    atMs: Number.isFinite(atMs) && atMs >= 0 ? Math.round(atMs) : 0,
  };
  for (const field of ["app", "windowTitle", "shortcut", "role", "name", "identifier", "filename"]) {
    if (typeof raw[field] !== "string") continue;
    const value = cleanText(raw[field], field === "app" ? 80 : field === "windowTitle" ? 120 : field === "shortcut" ? 80 : 200);
    if (value) event[field] = value;
  }
  if (["copy", "cut", "paste"].includes(raw.op)) event.op = raw.op;
  const keyCount = Number(raw.keyCount);
  if (Number.isFinite(keyCount) && keyCount > 0) event.keyCount = Math.round(keyCount);
  if (Array.isArray(raw.ancestry)) {
    const ancestry = raw.ancestry.map((entry) => cleanText(entry, 120)).filter(Boolean).slice(0, 6);
    if (ancestry.length) event.ancestry = ancestry;
  }
  if (Array.isArray(raw.whereFroms)) {
    const origins = [...new Set(raw.whereFroms.map(safeWebOrigin).filter(Boolean))].slice(0, 5);
    if (origins.length) event.whereFroms = origins;
  }
  if (raw.screenshot !== undefined) {
    if (typeof raw.screenshot !== "string" || !raw.screenshot) {
      throw recorderError("invalid-screenshot", "The checkpoint screenshot is invalid");
    }
    event.screenshot = raw.screenshot;
  }
  return event;
}

function decodeCanonicalDataUrl(dataUrl, allowedMimes, maxBytes, error) {
  if (typeof dataUrl !== "string") throw recorderError(error, `The ${error.replace(/-/g, " ")} is invalid`);
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || !allowedMimes.includes(match[1])) throw recorderError(error, `The ${error.replace(/-/g, " ")} MIME type is unsupported`);
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2] || !bytes.length || bytes.length > maxBytes) {
    throw recorderError(error, `The ${error.replace(/-/g, " ")} is invalid or too large`);
  }
  return { mime: match[1], bytes };
}

function normalizeAudioMime(mime) {
  if (typeof mime !== "string") return null;
  const normalized = mime.split(";")[0].toLowerCase();
  return AUDIO_MIME_EXTENSIONS.has(normalized) ? normalized : null;
}

function safeSessionFile(directory, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.basename(relativePath) !== relativePath) {
    throw recorderError("invalid-media-reference", "The recorder media reference is invalid");
  }
  const filePath = path.join(directory, relativePath);
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw recorderError("invalid-media-reference", "The recorder media reference is invalid");
  return filePath;
}

function hydrateScreenshot(directory, reference) {
  if (reference.startsWith("data:")) return reference;
  const filePath = safeSessionFile(framesDirectory(directory), reference);
  const bytes = readFileSync(filePath);
  const extension = path.extname(reference).slice(1).toLowerCase();
  const mime = extension === "png" ? "image/png" : extension === "jpg" ? "image/jpeg" : "image/webp";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function hydrateAudio(directory, checkpoint) {
  if (!checkpoint.audioChunks.length) return "";
  const mime = checkpoint.audioMime || "audio/webm";
  const bytes = checkpoint.audioChunks
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((chunk) => readFileSync(safeSessionFile(audioDirectory(directory), chunk.file)));
  return `data:${mime};base64,${Buffer.concat(bytes).toString("base64")}`;
}

function semanticCheckpointEvent(event) {
  const { screenshot: _screenshot, ...identity } = event;
  return identity;
}

function eventPrefixMatches(previousEvents, nextEvents) {
  if (nextEvents.length < previousEvents.length) return false;
  for (let index = 0; index < previousEvents.length; index += 1) {
    if (JSON.stringify(semanticCheckpointEvent(previousEvents[index])) !== JSON.stringify(semanticCheckpointEvent(nextEvents[index]))) {
      return false;
    }
  }
  return true;
}

function reviewedCheckpointEvents(checkpoint, review) {
  const checkpointIds = new Map();
  for (const event of checkpoint.events) {
    if (checkpointIds.has(event.id)) throw recorderError("invalid-checkpoint", "The recorder checkpoint contains duplicate event IDs");
    checkpointIds.set(event.id, checkpointIds.size);
  }
  if (review.events === undefined) return checkpoint.events;
  if (!Array.isArray(review.events) || review.events.length > MAX_EVENTS) {
    throw recorderError("invalid-review", "The reviewed event list is invalid");
  }
  let nextCheckpointIndex = 0;
  const selected = new Map();
  for (const event of review.events) {
    if (!event || typeof event !== "object" || typeof event.id !== "string" || selected.has(event.id)) {
      throw recorderError("invalid-review", "The reviewed event list is invalid");
    }
    const checkpointIndex = checkpointIds.get(event.id);
    if (checkpointIndex === undefined || checkpointIndex < nextCheckpointIndex) {
      throw recorderError("review-event-mismatch", "The reviewed events do not match the durable checkpoint");
    }
    nextCheckpointIndex = checkpointIndex + 1;
    selected.set(event.id, event);
  }
  return checkpoint.events.filter((event) => selected.has(event.id));
}

function createRecorderSession(dataRoot) {
  const root = recordingsRoot(dataRoot);
  ensurePrivateDirectory(root);
  const sessionId = randomUUID();
  const directory = path.join(root, sessionId);
  ensurePrivateDirectory(directory);
  ensurePrivateDirectory(checkpointDirectory(directory));
  ensurePrivateDirectory(framesDirectory(directory));
  ensurePrivateDirectory(audioDirectory(directory));
  const startedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    sessionId,
    state: "recording",
    startedAt,
    stoppedAt: null,
    durationMs: 0,
    updatedAt: startedAt,
  };
  writeManifest(directory, manifest);
  atomicWriteText(eventsPath(directory), "");
  sessionRoots.set(sessionId, path.resolve(resolveDataRoot(dataRoot)));
  return { sessionId, directory, manifest };
}

function drainHelperOutput(session) {
  if (session.draining) return;
  session.draining = true;
  try {
    const stat = lstatSync(session.outputPath);
    if (!stat.isFile() || stat.size < session.outputOffset) session.outputOffset = 0;
    const buffer = Buffer.alloc(Math.max(0, stat.size - session.outputOffset));
    if (buffer.length) {
      const descriptor = openSync(session.outputPath, "r");
      try {
        readSync(descriptor, buffer, 0, buffer.length, session.outputOffset);
      } finally {
        closeSync(descriptor);
      }
      session.outputOffset = stat.size;
      session.outputTail += buffer.toString("utf8");
    }
    const lines = session.outputTail.split("\n");
    session.outputTail = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = sanitizeNativeEvent(JSON.parse(line));
        if (!event) continue;
        session.nativeEvents.push(event);
        if (session.nativeEvents.length > MAX_NDJSON_EVENTS) {
          session.nativeEvents = session.nativeEvents.slice(-MAX_NDJSON_EVENTS);
        }
        try {
          if (typeof session.emitEvent === "function") session.emitEvent(event);
        } catch {
          // A renderer observer must not disrupt durable event ingestion.
        }
        changed = true;
      } catch {
        // Ignore malformed helper output.
      }
    }
    if (changed) writeNativeEvents(session.directory, session.nativeEvents);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    session.draining = false;
  }
}

function emitRecorderEnd(session, info) {
  if (session.endEmitted) return;
  session.endEmitted = true;
  if (activeSession === session) activeSession = null;
  try {
    if (typeof session.emitEnd === "function") session.emitEnd(info);
  } catch {
    // A renderer observer must not disrupt durable session finalization.
  }
}

function emitRecorderWindow(target, channel, payload) {
  if (!target || typeof target.isDestroyed !== "function" || target.isDestroyed()) return;
  try {
    target.webContents?.send(channel, payload);
  } catch {
    // The renderer may close while the helper is finalizing.
  }
}

function finalizeHelperSession(session, state, code = null, reason, options = {}) {
  if (session.finalizing) return session.finalizing;
  const keepActive = options.keepActive === true;
  if (keepActive && (!session.stopping || !session.closed)) {
    throw recorderError("helper-not-stopped", "The native recorder must be closed before retaining the active review session");
  }
  if (session.drainTimer) {
    clearInterval(session.drainTimer);
    session.drainTimer = null;
  }
  session.finalizing = (async () => {
    try {
      drainHelperOutput(session);
      const manifest = readManifestForDirectory(session.directory, session.sessionId);
      const stoppedAt = new Date().toISOString();
      const next = {
        ...manifest,
        state,
        ...(state === "recording"
          ? { stoppedAt: manifest.stoppedAt ?? null }
          : { stoppedAt }),
        durationMs: Math.max(manifest.durationMs || 0, durationFromStartedAt(manifest.startedAt)),
        updatedAt: stoppedAt,
      };
      writeManifest(session.directory, next);
      writeNativeEvents(session.directory, session.nativeEvents);
      if (!keepActive) emitRecorderEnd(session, { code, ...(reason ? { reason } : {}) });
    } finally {
      if (!keepActive && activeSession === session) activeSession = null;
    }
  })();
  return session.finalizing;
}

function waitForHelperReady(session) {
  return (async () => {
    const deadline = Date.now() + HELPER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      drainHelperOutput(session);
      if (session.nativeEvents.length) return;
      if (session.helperError) throw recorderError("recorder-helper-launch", session.helperError.message, session.helperError);
      if (session.process?.exitCode !== null && session.process?.exitCode !== undefined) {
        drainHelperOutput(session);
        if (session.nativeEvents.length) return;
        throw recorderError("recorder-helper-exited", "The native recorder exited before becoming ready");
      }
      await delay(POLL_INTERVAL_MS);
    }
    drainHelperOutput(session);
    if (session.nativeEvents.length) return;
    throw recorderError("recorder-helper-timeout", "The native recorder did not become ready");
  })();
}

function launchRecorderHelper(session) {
  ensureBuilt();
  const bundle = helperBundlePath();
  const binary = helperBinaryPath();
  if (!existsSync(binary)) throw recorderError("recorder-helper-missing", "The native recorder helper is unavailable");
  const outputPath = session.outputPath;
  const errorPath = path.join(session.directory, "helper.stderr");
  const stopPath = session.stopPath;
  const environment = {
    ...process.env,
    OMB_RECORDER_OUTPUT: outputPath,
    OMB_RECORDER_ERROR: errorPath,
  };
  let processHandle;
  if (process.platform === "darwin") {
    processHandle = spawn("/usr/bin/open", [
      "-n",
      "-g",
      "-W",
      "-o",
      outputPath,
      "--stderr",
      errorPath,
      bundle,
      "--args",
      "--stop-file",
      stopPath,
    ], {
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } else {
    const outputDescriptor = openSync(outputPath, "a", 0o600);
    try {
      processHandle = spawn(binary, ["--stop-file", stopPath], {
        env: environment,
        stdio: ["ignore", outputDescriptor, "ignore"],
      });
    } finally {
      closeSync(outputDescriptor);
    }
  }
  session.process = processHandle;
  session.closed = false;
  processHandle.once("error", (error) => {
    session.helperError = error;
    session.closed = true;
  });
  processHandle.once("close", (code) => {
    session.exitCode = code;
    session.closed = true;
    drainHelperOutput(session);
    if (!session.finalizing) {
      void finalizeHelperSession(
        session,
        session.stopping ? "recording" : "interrupted",
        code,
        undefined,
        { keepActive: session.stopping },
      );
    }
  });
}

function stopActiveRecorder(session) {
  if (session.stopPromise) return session.stopPromise;
  if (session.finalizing) {
    session.stopPromise = session.finalizing.then(() => ({ recording: false }));
    return session.stopPromise;
  }
  session.stopping = true;
  session.stopPromise = (async () => {
    try {
      try {
        writeFileSync(session.stopPath, "stop", { mode: 0o600 });
      } catch {
        // The helper may already have exited.
      }
      let deadline = Date.now() + HELPER_STOP_TIMEOUT_MS;
      while (!session.closed && Date.now() < deadline) await delay(POLL_INTERVAL_MS);
      if (!session.closed && session.process?.kill) {
        try {
          session.process.kill("SIGTERM");
        } catch (error) {
          session.helperError = error;
        }
        deadline = Date.now() + 1_000;
        while (!session.closed && Date.now() < deadline) await delay(POLL_INTERVAL_MS);
      }
      if (!session.closed && session.process?.kill) {
        try {
          session.process.kill("SIGKILL");
        } catch (error) {
          session.helperError = error;
        }
        deadline = Date.now() + 1_000;
        while (!session.closed && Date.now() < deadline) await delay(POLL_INTERVAL_MS);
      }
      if (!session.closed) {
        session.closed = true;
        session.helperError = session.helperError ?? new Error("The native recorder did not close after forced shutdown.");
      }
      drainHelperOutput(session);
      await finalizeHelperSession(
        session,
        "recording",
        session.exitCode ?? null,
        session.helperError?.message,
        { keepActive: true },
      );
      return { recording: false };
    } catch (error) {
      emitRecorderEnd(session, { code: session.exitCode ?? null, reason: error?.message });
      throw error;
    }
  })();
  return session.stopPromise;
}
function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max) : "";
}

function safeWebOrigin(value) {
  const cleaned = cleanText(value, 2_000);
  if (!cleaned) return "";
  try {
    const url = new URL(cleaned);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
}
function hostFromUrl(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  try {
    return new URL(text).host || text;
  } catch {
    return text;
  }
}

function eventSummary(event) {
  const where = [cleanText(event.app, 80), cleanText(event.windowTitle, 120)].filter(Boolean).join(" — ");
  switch (event.type) {
    case "app":
      return `Open or focus ${where || "the demonstrated app"}.`;
    case "click": {
      const name = cleanText(event.name, 120);
      if (name) {
        const role = cleanText(event.role, 120);
        return `Click "${name}"${role ? ` (${role})` : ""}${where ? ` in ${where}` : ""}.`;
      }
      return `Click the demonstrated control${where ? ` in ${where}` : ""}.`;
    }
    case "scroll":
      return `Scroll ${event.direction === "up" ? "up" : "down"}${where ? ` in ${where}` : ""}.`;
    case "shortcut":
      return `Use the ${cleanText(event.shortcut, 80) || "demonstrated"} keyboard shortcut${where ? ` in ${where}` : ""}.`;
    case "typing":
      return `Enter the required value${where ? ` in ${where}` : ""}. The recording intentionally did not retain typed characters.`;
    case "clipboard": {
      const verb = event.op === "cut" ? "Cut" : event.op === "paste" ? "Paste" : "Copy";
      return `${verb} the selected value${where ? ` in ${where}` : ""}. (The recording captured the clipboard action, not its contents.)`;
    }
    case "download": {
      const filename = cleanText(event.filename, 200);
      const origins = Array.isArray(event.whereFroms) ? event.whereFroms : [];
      const host = origins.length ? hostFromUrl(origins[0]) : "";
      return `A file (${filename || "unnamed"}) was downloaded${host ? ` from ${host}` : ""}. Treat the file's origin as untrusted context.`;
    }
    default:
      return `Continue the demonstrated workflow${where ? ` in ${where}` : ""}.`;
  }
}

function triggerTerms(name, description) {
  const stop = new Set(["about", "after", "before", "create", "from", "into", "skill", "that", "the", "this", "with", "workflow"]);
  const words = `${name} ${description}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(words.filter((word) => !stop.has(word)))].slice(0, 10);
}

export function skillSlug(value) {
  const slug = cleanText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  return SAFE_SLUG.test(slug) ? slug : "recorded-workflow";
}

function uniqueSkillDirectory(root, requested) {
  const base = skillSlug(requested);
  for (let suffix = 1; suffix < 1_000; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const directory = path.join(root, name);
    if (!existsSync(directory)) return { id: name, directory };
  }
  throw new Error("Too many skills use this name");
}

function decodeDataUrl(dataUrl, maxBytes, allowed) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || !allowed.includes(match[1])) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > maxBytes) return null;
  return { mime: match[1], bytes };
}

export function compileSkillMarkdown({ id, name, description, transcript, events, omittedEvents = 0 }) {
  const safeName = cleanText(name, 100) || "Recorded workflow";
  const safeDescription = cleanText(description, 300) || `Repeat the ${safeName} workflow demonstrated by the user.`;
  const lines = [
    "---",
    `name: ${id}`,
    `description: ${JSON.stringify(safeDescription)}`,
    "---",
    "",
    `# ${safeName}`,
    "",
    safeDescription,
    "",
    "## How to use this demonstration",
    "",
    "Follow the intent and observable UI landmarks from the steps below. Inspect the current interface before acting, prefer named or accessibility targets over recorded coordinates, and adapt when layout or content has changed. Never infer or reuse secrets from screenshots. Stop and ask the user at password, MFA, CAPTCHA, payment, destructive, or ambiguous confirmation steps.",
    "",
  ];
  if (transcript) {
    lines.push("## User narration", "", cleanText(transcript, 12_000), "");
  }
  lines.push("## Demonstrated workflow", "");
  if (!events.length) {
    lines.push("1. Complete the workflow described above, checking the result before reporting success.");
  } else {
    events.forEach((event, index) => {
      const reference = event.reference ? ` Review the recorded frame under the skill root at ${event.reference} when visual context is useful.` : "";
      lines.push(`${index + 1}. ${eventSummary(event)}${reference}`);
    });
  }
  if (omittedEvents > 0) {
    lines.push("", `${omittedEvents} later steps were omitted from this recording.`);
  }
  lines.push("", "## Completion", "", "Verify the intended outcome in the current UI and report any step that could not be confirmed.", "");
  return lines.join("\n");
}

function saveSkillRecordingLegacy(payload, options = {}) {
  if (!payload || typeof payload !== "object") throw new Error("Recording data is required");
  const name = cleanText(payload.name, 100);
  if (!name) throw new Error("Name the skill before creating it");
  const description = cleanText(payload.description, 300);
  const dataRoot = resolveDataRoot(options);
  const skillsRoot = path.join(dataRoot, "skills");
  ensurePrivateDirectory(skillsRoot);
  const target = uniqueSkillDirectory(skillsRoot, name);
  const temporary = `${target.directory}.creating-${process.pid}`;
  const references = path.join(temporary, "references");
  mkdirSync(references, { recursive: true, mode: 0o700 });

  try {
    const incoming = Array.isArray(payload.events) ? payload.events : [];
    const omittedEvents = Math.max(0, incoming.length - MAX_EVENTS);
    const truncated = omittedEvents > 0;
    const events = [];
    for (const [index, raw] of incoming.slice(0, MAX_EVENTS).entries()) {
      if (!raw || typeof raw !== "object") continue;
      const type = ["app", "click", "scroll", "shortcut", "typing", "clipboard", "download"].includes(raw.type) ? raw.type : null;
      if (!type) continue;
      const keyCount = Number(raw.keyCount);
      const ancestry = Array.isArray(raw.ancestry)
        ? raw.ancestry.map((entry) => cleanText(entry, 120)).filter(Boolean).slice(0, 6)
        : undefined;
      const whereFroms = Array.isArray(raw.whereFroms)
        ? [...new Set(raw.whereFroms.map(safeWebOrigin).filter(Boolean))].slice(0, 5)
        : undefined;
      const event = {
        type,
        atMs: Math.max(0, Math.round(Number(raw.atMs) || 0)),
        app: cleanText(raw.app, 80) || undefined,
        windowTitle: cleanText(raw.windowTitle, 120) || undefined,
        direction: raw.direction === "up" ? "up" : raw.direction === "down" ? "down" : undefined,
        shortcut: cleanText(raw.shortcut, 80) || undefined,
        keyCount: Number.isFinite(keyCount) && keyCount > 0 ? Math.round(keyCount) : undefined,
        role: cleanText(raw.role, 120) || undefined,
        name: cleanText(raw.name, 120) || undefined,
        identifier: cleanText(raw.identifier, 120) || undefined,
        ancestry: ancestry && ancestry.length ? ancestry : undefined,
        op: ["copy", "cut", "paste"].includes(raw.op) ? raw.op : undefined,
        filename: cleanText(raw.filename, 200) || undefined,
        whereFroms: whereFroms && whereFroms.length ? whereFroms : undefined,
      };
      const image = decodeDataUrl(raw.screenshot, MAX_IMAGE_BYTES, ["image/webp", "image/jpeg", "image/png"]);
      if (image) {
        const extension = image.mime === "image/png" ? "png" : image.mime === "image/jpeg" ? "jpg" : "webp";
        const filename = `step-${String(index + 1).padStart(3, "0")}.${extension}`;
        writeFileSync(path.join(references, filename), image.bytes, { mode: 0o600 });
        event.reference = `references/${filename}`;
      }
      events.push(event);
    }

    const audio = decodeDataUrl(payload.audio, MAX_TOTAL_AUDIO_BYTES, ["audio/webm", "audio/mp4", "audio/ogg"]);
    let audioReference;
    if (audio) {
      const extension = audio.mime === "audio/mp4" ? "m4a" : audio.mime === "audio/ogg" ? "ogg" : "webm";
      audioReference = `references/narration.${extension}`;
      writeFileSync(path.join(temporary, audioReference), audio.bytes, { mode: 0o600 });
    }

    const transcript = cleanText(payload.transcript, 12_000);
    const transcription = payload.transcription?.provider === "assemblyai"
        ? { provider: "assemblyai", model: cleanText(payload.transcription.model, 80) || "universal-3-5-pro" }
      : undefined;
    const recording = {
      schemaVersion: 1,
      name,
      description,
      createdAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(Number(payload.durationMs) || 0)),
      transcript,
      transcription,
      audio: audioReference,
      events,
      truncated,
      omittedEvents,
      privacy: {
        rawKeystrokesRetained: false,
        clipboardContentsRetained: false,
        screenFramesMayContainVisibleText: true,
        reviewedBeforeInstall: true,
      },
    };
    writeFileSync(path.join(references, "recording.json"), `${JSON.stringify(recording, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(
      path.join(temporary, "SKILL.md"),
      compileSkillMarkdown({ id: target.id, name, description, transcript, events, omittedEvents }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(temporary, "manifest.json"),
      `${JSON.stringify({
        id: target.id,
        name,
        version: "1.0.0",
        description: description || `Repeat the ${name} workflow demonstrated by the user.`,
        defaultEnabled: true,
        triggerTerms: triggerTerms(name, description).length ? triggerTerms(name, description) : [target.id],
        requiredCapabilities: [],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, target.directory);
    return { id: target.id, path: target.directory, events: events.length };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
export function recorderPermissionStatus() {
  return { supported: process.platform === "darwin" };
}

export function stopRecorder() {
  if (!activeSession) return { recording: false };
  return stopActiveRecorder(activeSession);
}

export async function startRecorder(_window, options = {}) {
  if (activeSession) {
    throw recorderError("recorder-already-active", "A recorder session is already active");
  }
  const dataRoot = resolveDataRoot(options);
  markStaleRecordingSessions(dataRoot);
  const created = createRecorderSession(dataRoot);
  const session = {
    ...created,
    outputPath: path.join(created.directory, "events-output.ndjson"),
    stopPath: path.join(created.directory, "stop"),
    outputOffset: 0,
    outputTail: "",
    nativeEvents: [],
    emitEvent: typeof options.onEvent === "function"
      ? options.onEvent
      : (event) => emitRecorderWindow(_window, "skill-recorder:event", event),
    emitEnd: typeof options.onEnd === "function"
      ? options.onEnd
      : (info) => emitRecorderWindow(_window, "skill-recorder:end", info),
    endEmitted: false,
    finalizing: null,
    stopping: false,
    stopPromise: null,
    process: null,
    closed: false,
    exitCode: null,
    helperError: null,
    drainTimer: null,
    draining: false,
  };
  activeSession = session;
  try {
    launchRecorderHelper(session);
    await waitForHelperReady(session);
    session.drainTimer = setInterval(() => {
      try {
        drainHelperOutput(session);
      } catch (error) {
        session.helperError = error?.message ?? String(error);
      }
    }, 250);
    if (typeof session.drainTimer.unref === "function") session.drainTimer.unref();
    return { recording: true, sessionId: session.sessionId };
  } catch (error) {
    if (!session.finalizing) {
      try {
        await finalizeHelperSession(session, "interrupted", session.exitCode ?? null, error?.message);
      } catch {
        // Preserve the durable interrupted session even if final metadata cannot be written.
      }
    }
    if (activeSession === session) activeSession = null;
    throw error;
  }
}

export function recorderStatus(options = {}) {
  const dataRoot = resolveDataRoot(options);
  markStaleRecordingSessions(dataRoot);
  const active = activeSession
    ? summarizeSession(dataRoot, activeSession.sessionId, readManifestForDirectory(activeSession.directory, activeSession.sessionId))
    : null;
  const activeId = active?.sessionId;
  const recoverable = listSessionIds(dataRoot)
    .filter((sessionId) => sessionId !== activeId)
    .map((sessionId) => summarizeSession(dataRoot, sessionId));
  return { active, recoverable };
}

export function recoverRecorderSessions(options = {}) {
  const dataRoot = resolveDataRoot(options);
  markStaleRecordingSessions(dataRoot);
  const activeId = activeSession?.sessionId;
  return listSessionIds(dataRoot)
    .filter((sessionId) => sessionId !== activeId)
    .map((sessionId) => summarizeSession(dataRoot, sessionId));
}

export async function resumeRecorderSession(sessionId, options = {}) {
  return enqueueSession(sessionId, async () => {
    const dataRoot = resolveSessionRoot(sessionId, options);
    const directory = sessionDirectory(dataRoot, sessionId);
    assertRealDirectory(directory);
    let manifest = readManifestForDirectory(directory, sessionId);
    if (manifest.state === "recording") {
      if (activeSession?.sessionId === sessionId) {
        throw recorderError("session-still-recording", "The recorder session is still live");
      }
      const stoppedAt = new Date().toISOString();
      manifest = {
        ...manifest,
        state: "interrupted",
        stoppedAt,
        durationMs: durationFromStartedAt(manifest.startedAt, manifest.durationMs),
        updatedAt: stoppedAt,
      };
      writeManifest(directory, manifest);
    }
    if (!RESUMABLE_STATES.has(manifest.state)) {
      throw recorderError("invalid-session-state", "The recorder session cannot be resumed");
    }
    const checkpoint = latestCheckpointForDirectory(directory, sessionId);
    const events = checkpoint
      ? checkpoint.events.map((event) => event.screenshot
        ? { ...event, screenshot: hydrateScreenshot(directory, event.screenshot) }
        : event)
      : readNativeEvents(directory);
    const audio = checkpoint ? hydrateAudio(directory, checkpoint) : "";
    return {
      sessionId,
      state: "review",
      reviewOnly: true,
      liveStreamsResumed: false,
      startedAt: manifest.startedAt,
      stoppedAt: manifest.stoppedAt ?? null,
      durationMs: checkpoint?.durationMs ?? manifest.durationMs ?? 0,
      events,
      transcript: checkpoint?.transcript ?? "",
      partialTranscript: checkpoint?.partialTranscript ?? "",
      audioMime: checkpoint?.audioMime ?? null,
      audio: audio,
      updatedAt: checkpoint?.updatedAt ?? manifest.updatedAt,
      checkpointSequence: checkpoint?.sequence ?? 0,
      audioIndex: checkpoint?.audioChunks?.length ?? 0,
    };
  });
}

export async function checkpointRecorderSession(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    throw recorderError("invalid-checkpoint-payload", "A checkpoint payload is required");
  }
  const sessionId = payload.sessionId;
  assertUuid(sessionId);
  return enqueueSession(sessionId, async () => {
    const dataRoot = resolveSessionRoot(sessionId, options);
    const directory = sessionDirectory(dataRoot, sessionId);
    assertRealDirectory(directory);
    const session = activeSession;
    if (
      !session ||
      session.sessionId !== sessionId ||
      session.directory !== directory
    ) {
      const latest = latestCheckpointForDirectory(directory, sessionId);
      return {
        accepted: false,
        checkpointSequence: latest?.sequence ?? 0,
        audioIndex: latest?.audioChunks?.length ?? 0,
        reason: "invalid-session-state",
      };
    }
    const manifest = readManifestForDirectory(directory, sessionId);
    if (!CHECKPOINTABLE_STATES.has(manifest.state)) {
      return { accepted: false, checkpointSequence: latestCheckpointForDirectory(directory, sessionId)?.sequence ?? 0, audioIndex: latestCheckpointForDirectory(directory, sessionId)?.audioChunks?.length ?? 0, reason: "invalid-session-state" };
    }
    if (!Number.isInteger(payload.sequence) || payload.sequence < 1) {
      return { accepted: false, checkpointSequence: latestCheckpointForDirectory(directory, sessionId)?.sequence ?? 0, audioIndex: latestCheckpointForDirectory(directory, sessionId)?.audioChunks?.length ?? 0, reason: "invalid-sequence" };
    }
    if (!Array.isArray(payload.events)) {
      return { accepted: false, checkpointSequence: latestCheckpointForDirectory(directory, sessionId)?.sequence ?? 0, audioIndex: latestCheckpointForDirectory(directory, sessionId)?.audioChunks?.length ?? 0, reason: "invalid-events" };
    }
    const previous = latestCheckpointForDirectory(directory, sessionId);
    if (previous && payload.sequence <= previous.sequence) {
      return { accepted: false, sequence: previous.sequence, checkpointSequence: previous.sequence, audioIndex: previous.audioChunks.length, reason: "sequence-not-increasing" };
    }
    const finalize = payload.finalize === true;
    if (finalize && (!session.stopping || !session.closed)) {
      return { accepted: false, checkpointSequence: previous?.sequence ?? 0, audioIndex: previous?.audioChunks?.length ?? 0, reason: "helper-not-stopped" };
    }
    const durationValue = Number(payload.durationMs ?? previous?.durationMs ?? manifest.durationMs ?? 0);
    if (!Number.isFinite(durationValue) || durationValue < 0) {
      return { accepted: false, checkpointSequence: previous?.sequence ?? 0, audioIndex: previous?.audioChunks?.length ?? 0, reason: "invalid-duration" };
    }
    const events = payload.events.map(sanitizeCheckpointEvent);
    if (events.length > MAX_EVENTS) {
      return { accepted: false, checkpointSequence: previous?.sequence ?? 0, audioIndex: previous?.audioChunks?.length ?? 0, reason: "event-limit-exceeded" };
    }
    if (previous && !eventPrefixMatches(previous.events, events)) {
      return { accepted: false, sequence: payload.sequence, checkpointSequence: previous.sequence, audioIndex: previous.audioChunks.length, reason: "event-prefix-changed" };
    }

    const newMedia = [];
    const audioChunks = previous?.audioChunks ? [...previous.audioChunks] : [];
    let audioMime = previous?.audioMime ?? null;
    try {
      for (const event of events) {
        if (!event.screenshot || event.screenshot.startsWith("data:")) continue;
        if (path.basename(event.screenshot) !== event.screenshot) {
          throw recorderError("invalid-screenshot", "The checkpoint screenshot reference is invalid");
        }
        const referencePath = safeSessionFile(framesDirectory(directory), event.screenshot);
        const stat = lstatSync(referencePath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid screenshot reference");
      }
      for (const chunk of audioChunks) {
        if (typeof chunk.file !== "string" || path.basename(chunk.file) !== chunk.file) {
          throw recorderError("invalid-audio", "The checkpoint audio reference is invalid");
        }
        safeSessionFile(audioDirectory(directory), chunk.file);
      }
      for (const event of events) {
        if (!event.screenshot?.startsWith("data:")) continue;
        const image = decodeCanonicalDataUrl(event.screenshot, [...IMAGE_MIME_EXTENSIONS.keys()], MAX_IMAGE_BYTES, "invalid-screenshot");
        const extension = IMAGE_MIME_EXTENSIONS.get(image.mime);
        const filename = `frame-${String(payload.sequence).padStart(6, "0")}-${String(newMedia.length + 1).padStart(3, "0")}.${extension}`;
        const filePath = path.join(framesDirectory(directory), filename);
        atomicWriteBytes(filePath, image.bytes);
        newMedia.push(filePath);
        event.screenshot = filename;
      }

      if (payload.audioChunk !== undefined) {
        if (!payload.audioChunk || typeof payload.audioChunk !== "object") {
          throw recorderError("invalid-audio", "The checkpoint audio chunk is invalid");
        }
        const index = payload.audioChunk.index;
        const expectedIndex = audioChunks.length;
        if (!Number.isInteger(index) || index !== expectedIndex) {
          throw recorderError("invalid-audio-index", `The checkpoint audio index must be ${expectedIndex}`);
        }
        const mime = normalizeAudioMime(payload.audioChunk.mime);
        if (!mime) throw recorderError("invalid-audio", "The checkpoint audio MIME type is unsupported");
        const audio = decodeCanonicalDataUrl(payload.audioChunk.dataUrl, [...AUDIO_MIME_EXTENSIONS.keys()], MAX_AUDIO_CHUNK_BYTES, "invalid-audio");
        if (audio.mime !== mime || (audioMime && audioMime !== mime)) {
          throw recorderError("invalid-audio", "The checkpoint audio chunks must use one MIME type");
        }
        const totalAudioBytes = audioChunks.reduce((total, chunk) => total + (chunk.bytes || 0), 0) + audio.bytes.length;
        if (totalAudioBytes > MAX_TOTAL_AUDIO_BYTES) {
          throw recorderError("audio-budget-exceeded", "The recorder audio limit was exceeded");
        }
        const extension = AUDIO_MIME_EXTENSIONS.get(mime);
        const filename = `chunk-${String(index).padStart(6, "0")}.${extension}`;
        const filePath = path.join(audioDirectory(directory), filename);
        atomicWriteBytes(filePath, audio.bytes);
        newMedia.push(filePath);
        audioChunks.push({ index, file: filename, bytes: audio.bytes.length });
        audioMime = mime;
      }

      const checkpoint = {
        schemaVersion: 1,
        sessionId,
        sequence: payload.sequence,
        events,
        transcript: cleanText(payload.transcript ?? previous?.transcript ?? "", 12_000),
        partialTranscript: cleanText(payload.partialTranscript ?? previous?.partialTranscript ?? "", 4_000),
        durationMs: Math.round(durationValue),
        audioMime,
        audioChunks,
        updatedAt: new Date().toISOString(),
      };
      const serialized = JSON.stringify(checkpoint);
      if (Buffer.byteLength(serialized) > MAX_CHECKPOINT_BYTES) {
        throw recorderError("checkpoint-too-large", "The recorder checkpoint limit was exceeded");
      }
      atomicWriteJson(checkpointPath(directory, payload.sequence), checkpoint);
      atomicWriteJson(latestCheckpointPath(directory), checkpoint);
      if (finalize) {
        const stoppedAt = new Date().toISOString();
        const finalManifest = {
          ...manifest,
          state: "review",
          stoppedAt,
          durationMs: checkpoint.durationMs,
          updatedAt: stoppedAt,
        };
        writeManifest(directory, finalManifest);
        if (activeSession === session) activeSession = null;
        emitRecorderEnd(session, { code: session.exitCode ?? 0 });
      } else {
        writeManifest(directory, { ...manifest, updatedAt: checkpoint.updatedAt });
      }
      return { accepted: true, sequence: payload.sequence, checkpointSequence: payload.sequence, audioIndex: audioChunks.length };
    } catch (error) {
      for (const filePath of newMedia) rmSync(filePath, { force: true });
      throw error;
    }
  });
}

export async function discardRecorderSession(sessionId, options = {}) {
  return enqueueSession(sessionId, async () => {
    const dataRoot = resolveSessionRoot(sessionId, options);
    const directory = sessionDirectory(dataRoot, sessionId);
    assertRealDirectory(directory);
    const manifest = readManifestForDirectory(directory, sessionId);
    if (manifest.state === "saved") {
      throw recorderError("invalid-session-state", "A saved recorder session cannot be discarded");
    }
    const session = activeSession;
    if (session?.sessionId === sessionId) await stopActiveRecorder(session);
    rmSync(directory, { recursive: true, force: true });
    fsyncDirectory(path.dirname(directory));
    sessionRoots.delete(sessionId);
    if (activeSession?.sessionId === sessionId) activeSession = null;
    return { discarded: true, sessionId };
  });
}

export async function completeRecorderSession(sessionId, options = {}) {
  return enqueueSession(sessionId, async () => {
    const dataRoot = resolveSessionRoot(sessionId, options);
    const directory = sessionDirectory(dataRoot, sessionId);
    assertRealDirectory(directory);
    let manifest = readManifestForDirectory(directory, sessionId);
    if (manifest.state === "saved") return { cleaned: false, alreadySaved: true, sessionId };
    if (activeSession?.sessionId === sessionId) {
      throw recorderError("session-still-recording", "The recorder session is still live");
    }
    if (manifest.state === "recording") {
      const stoppedAt = new Date().toISOString();
      manifest = {
        ...manifest,
        state: "interrupted",
        stoppedAt,
        durationMs: durationFromStartedAt(manifest.startedAt, manifest.durationMs),
        updatedAt: stoppedAt,
      };
      writeManifest(directory, manifest);
    }
    try {
      rmSync(directory, { recursive: true, force: true });
      fsyncDirectory(path.dirname(directory));
      sessionRoots.delete(sessionId);
      return { cleaned: true, sessionId };
    } catch (error) {
      const failedAt = new Date().toISOString();
      const failedManifest = {
        ...manifest,
        state: "cleanup-failed",
        stoppedAt: manifest.stoppedAt ?? failedAt,
        durationMs: manifest.durationMs || durationFromStartedAt(manifest.startedAt),
        updatedAt: failedAt,
      };
      try {
        writeManifest(directory, failedManifest);
      } catch {
        // The original durable state is more useful than a second cleanup failure.
      }
      return { cleaned: false, cleanupFailed: true, sessionId, state: "cleanup-failed" };
    }
  });
}

function compileReviewedCheckpoint(directory, checkpoint, review, dataRoot) {
  const name = cleanText(review.name, 100) || "Recorded workflow";
  const description = cleanText(review.description, 300);
  const skillsRoot = path.join(dataRoot, "skills");
  ensurePrivateDirectory(skillsRoot);
  const target = uniqueSkillDirectory(skillsRoot, name);
  const temporary = `${target.directory}.creating-${process.pid}-${randomUUID()}`;
  const references = path.join(temporary, "references");
  mkdirSync(references, { recursive: true, mode: 0o700 });
  try {
    const reviewedById = new Map(Array.isArray(review.events) ? review.events.map((event) => [event.id, event]) : []);
    const selectedEvents = reviewedCheckpointEvents(checkpoint, review);
    const events = selectedEvents.map((event, index) => {
      const result = { ...event };
      const reviewedEvent = reviewedById.get(event.id);
      if (event.screenshot && reviewedEvent?.screenshot !== null) {
        const bytes = readFileSync(safeSessionFile(framesDirectory(directory), event.screenshot));
        const extension = path.extname(event.screenshot).slice(1).toLowerCase();
        const filename = `step-${String(index + 1).padStart(3, "0")}.${extension === "png" ? "png" : extension === "jpg" ? "jpg" : "webp"}`;
        atomicWriteBytes(path.join(references, filename), bytes);
        result.reference = `references/${filename}`;
        delete result.screenshot;
      }
      return result;
    });
    const audioBytes = checkpoint.audioChunks
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((chunk) => readFileSync(safeSessionFile(audioDirectory(directory), chunk.file)));
    let audioReference;
    if (audioBytes.length) {
      const mime = checkpoint.audioMime || "audio/webm";
      const extension = AUDIO_MIME_EXTENSIONS.get(mime);
      audioReference = `references/narration.${extension}`;
      atomicWriteBytes(path.join(temporary, audioReference), Buffer.concat(audioBytes));
    }
    const transcript = cleanText(review.transcript ?? checkpoint.transcript, 12_000);
    const recording = {
      schemaVersion: 1,
      name,
      description,
      createdAt: new Date().toISOString(),
      durationMs: checkpoint.durationMs || 0,
      transcript,
      transcription: review.transcription?.provider === "assemblyai"
        ? { provider: "assemblyai", model: cleanText(review.transcription.model, 80) || "universal-3-5-pro" }
        : undefined,
      audio: audioReference,
      events,
      truncated: false,
      omittedEvents: checkpoint.events.length - events.length,
      privacy: {
        rawKeystrokesRetained: false,
        clipboardContentsRetained: false,
        screenFramesMayContainVisibleText: true,
        reviewedBeforeInstall: true,
      },
    };
    atomicWriteJson(path.join(references, "recording.json"), recording);
    atomicWriteText(path.join(temporary, "SKILL.md"), compileSkillMarkdown({ id: target.id, name, description, transcript, events, omittedEvents: checkpoint.events.length - events.length }));
    atomicWriteJson(path.join(temporary, "manifest.json"), {
      id: target.id,
      name,
      version: "1.0.0",
      description: description || `Repeat the ${name} workflow demonstrated by the user.`,
      defaultEnabled: true,
      triggerTerms: triggerTerms(name, description).length ? triggerTerms(name, description) : [target.id],
      requiredCapabilities: [],
    });
    renameSync(temporary, target.directory);
    fsyncDirectory(skillsRoot);
    return { id: target.id, path: target.directory, events: events.length };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
function saveReviewedRecorderCheckpoint(sessionId, review, options = {}) {
  return enqueueSession(sessionId, async () => {
    const dataRoot = resolveSessionRoot(sessionId, options);
    const directory = sessionDirectory(dataRoot, sessionId);
    assertRealDirectory(directory);
    const manifest = readManifestForDirectory(directory, sessionId);
    if (manifest.state === "saved") throw recorderError("invalid-session-state", "The recorder session has already been saved");
    if (activeSession?.sessionId === sessionId) throw recorderError("session-still-recording", "The recorder session is still live");
    if (!review || typeof review !== "object") throw recorderError("invalid-review", "A reviewed recording payload is required");
    if (Array.isArray(review.events) && review.events.some((event) =>
      typeof event?.screenshot === "string" && event.screenshot.startsWith("data:"))) {
      throw recorderError("invalid-screenshot", "Reviewed save events must not contain raw screenshot data");
    }
    const checkpoint = latestCheckpointForDirectory(directory, sessionId);
    if (!checkpoint) throw recorderError("checkpoint-not-found", "The recorder session has no checkpoint to save");
    if (
      review.sessionId !== sessionId ||
      !Number.isInteger(review.checkpointSequence) ||
      review.checkpointSequence !== checkpoint.sequence
    ) {
      throw recorderError("checkpoint-mismatch", "The reviewed checkpoint identity does not match the durable checkpoint");
    }
    const savedManifest = {
      schemaVersion: 1,
      sessionId,
      state: "saved",
      startedAt: manifest.startedAt,
      stoppedAt: new Date().toISOString(),
      durationMs: checkpoint.durationMs || manifest.durationMs || 0,
      updatedAt: new Date().toISOString(),
    };
    const backup = cleanupBackupPath(directory);
    let cleanupFailed = false;
    let draftRetained = true;
    let backupComplete = false;
    let destructiveStarted = false;
    let compiled;
    try {
      copyDirectory(directory, backup);
      readManifestForDirectory(backup, sessionId);
      latestCheckpointForDirectory(backup, sessionId);
      backupComplete = true;
      compiled = compileReviewedCheckpoint(directory, checkpoint, review, dataRoot);
      destructiveStarted = true;
      rmSync(directory, { recursive: true, force: true });
      fsyncDirectory(path.dirname(directory));
      sessionRoots.delete(sessionId);
      ensurePrivateDirectory(directory);
      writeManifest(directory, savedManifest);
      if (!removeCleanupBackup(backup)) {
        throw new Error("The reviewed recording cleanup backup could not be removed");
      }
    } catch (error) {
      if (!backupComplete && !destructiveStarted) {
        cleanupFailed = true;
        draftRetained = existsSync(directory);
        removeCleanupBackup(backup);
        sessionRoots.set(sessionId, dataRoot);
      } else if (!destructiveStarted) {
        removeCleanupBackup(backup);
        throw error;
      } else {
        cleanupFailed = true;
        draftRetained = restoreDraftBackup(directory, backup, manifest);
        sessionRoots.set(sessionId, dataRoot);
      }
    }
    return {
      ...(compiled ?? {}),
      ...(cleanupFailed ? { draftRetained, cleanupFailed } : {}),
    };
  });
}
export function saveSkillRecording(payload, options = {}) {
  const strict = options?.requireSession === true || Boolean(payload?.sessionId || payload?.checkpointSequence);
  if (strict) {
    if (!payload?.sessionId) throw recorderError("session-required", "A recorder session is required");
    return saveReviewedRecorderCheckpoint(payload.sessionId, payload, options);
  }
  return saveSkillRecordingLegacy(payload, options);
}

export function saveReviewedSkillRecording(payload, options = {}) {
  if (!payload?.sessionId) throw recorderError("session-required", "A recorder session is required");
  return saveReviewedRecorderCheckpoint(payload.sessionId, payload, options);
}
