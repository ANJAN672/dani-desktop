import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
}));

const {
  checkpointRecorderSession,
  compileSkillMarkdown,
  discardRecorderSession,
  recorderPermissionStatus,
  recorderStatus,
  resumeRecorderSession,
  saveSkillRecording,
  skillSlug,
  startRecorder,
  stopRecorder,
} = await import("./skill-recorder.mjs");
const electronApp = (await import("electron")).app;
let fakeHelperRoot;
let originalAppPackaged;
let currentDataRoot;
const reviewedEvent = {
  id: "event-1",
  type: "click",
  atMs: 10,
  app: "RecorderTest",
  name: "Continue",
};
let originalResourcesPath;

describe("skill recorder lifecycle", () => {
  it("reports native recording support only on macOS", () => {
    expect(recorderPermissionStatus()).toEqual({ supported: process.platform === "darwin" });
  });

  it("returns a stopped state when no recorder session is active", () => {
    expect(stopRecorder()).toEqual({ recording: false });
  });
});
function installFakeHelper() {
  fakeHelperRoot = mkdtempSync(path.join(tmpdir(), "danibot-recorder-helper-"));
  const binary = path.join(fakeHelperRoot, "Dani Bot Recorder.app", "Contents", "MacOS", "recorder-helper");
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(binary, [
    "#!/usr/bin/env node",
    "const fs = require(\"node:fs\");",
    "fs.appendFileSync(process.env.OMB_RECORDER_OUTPUT, JSON.stringify({ type: \"app\", atMs: 0, app: \"RecorderTest\" }) + \"\\n\");",
    "const stopFile = process.argv[2];",
    "const timer = setInterval(() => {",
    "  if (stopFile && fs.existsSync(stopFile)) clearInterval(timer);",
    "}, 10);",
    "",
  ].join("\n"), { mode: 0o700 });
  writeFileSync(
    path.join(path.dirname(path.dirname(binary)), "Info.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\"><dict>",
      "<key>CFBundleExecutable</key><string>recorder-helper</string>",
      "<key>CFBundleIdentifier</key><string>com.danibot.recorder-test</string>",
      "<key>CFBundleName</key><string>Dani Bot Recorder Test</string>",
      "<key>CFBundlePackageType</key><string>APPL</string>",
      "</dict></plist>",
      "",
    ].join("\n"),
  );
  chmodSync(binary, 0o700);
}

async function useFakeHelper() {
  originalAppPackaged = electronApp.isPackaged;
  originalResourcesPath = process.resourcesPath;
  installFakeHelper();
  electronApp.isPackaged = true;
  process.resourcesPath = fakeHelperRoot;
}

function restoreFakeHelper() {
  electronApp.isPackaged = originalAppPackaged;
  if (originalResourcesPath === undefined) delete process.resourcesPath;
  else process.resourcesPath = originalResourcesPath;
  if (fakeHelperRoot) rmSync(fakeHelperRoot, { recursive: true, force: true });
  fakeHelperRoot = undefined;
  originalAppPackaged = undefined;
  originalResourcesPath = undefined;
}
afterEach(async () => {
  const stopped = stopRecorder();
  if (stopped && typeof stopped.then === "function") await stopped;
  if (currentDataRoot) {
    const active = recorderStatus({ dataRoot: currentDataRoot }).active;
    if (active) {
      await checkpointRecorderSession({
        sessionId: active.sessionId,
        sequence: active.checkpointSequence + 1,
        events: [reviewedEvent],
        durationMs: active.durationMs ?? 0,
        finalize: true,
      }, { dataRoot: currentDataRoot });
    }
  }
  currentDataRoot = undefined;
  restoreFakeHelper();
});
describe("durable recorder lifecycle", () => {

  async function start(dataRoot) {
    currentDataRoot = dataRoot;
    await useFakeHelper();
    return startRecorder({ webContents: { send() {} } }, { dataRoot });
  }

  async function checkpoint(dataRoot, sessionId, sequence, extra = {}) {
    return checkpointRecorderSession({
      sessionId,
      sequence,
      events: [reviewedEvent],
      durationMs: 100,
      ...extra,
    }, { dataRoot });
  }

  it("rejects sequence zero, finalizes after helper stop, and recovers review-only", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const { sessionId } = await start(dataRoot);
    const zero = await checkpoint(dataRoot, sessionId, 0);
    expect(zero).toMatchObject({ accepted: false, reason: "invalid-sequence" });

    expect((await checkpoint(dataRoot, sessionId, 1)).accepted).toBe(true);
    await stopRecorder();
    expect((await checkpoint(dataRoot, sessionId, 2, { finalize: true })).accepted).toBe(true);

    const recovered = await resumeRecorderSession(sessionId, { dataRoot });
    expect(recovered).toMatchObject({
      sessionId,
      checkpointSequence: 2,
      reviewOnly: true,
      liveStreamsResumed: false,
    });
  });
  it("recovers the newest numbered checkpoint when the pointer is stale", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const { sessionId } = await start(dataRoot);
    const sessionDirectory = path.join(dataRoot, "skill-recordings", sessionId);
    const pointerPath = path.join(sessionDirectory, "checkpoint.json");
    expect((await checkpoint(dataRoot, sessionId, 1)).accepted).toBe(true);
    const stalePointer = readFileSync(pointerPath, "utf8");
    await stopRecorder();
    expect((await checkpoint(dataRoot, sessionId, 2, { finalize: true })).accepted).toBe(true);
    writeFileSync(pointerPath, stalePointer);

    const recovered = await resumeRecorderSession(sessionId, { dataRoot });
    expect(recovered).toMatchObject({
      sessionId,
      checkpointSequence: 2,
      audioIndex: 0,
      reviewOnly: true,
      liveStreamsResumed: false,
    });
  });
  it("persists helper output written after startup through periodic draining", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const { sessionId } = await start(dataRoot);
    const sessionDirectory = path.join(dataRoot, "skill-recordings", sessionId);
    const outputPath = path.join(sessionDirectory, "events-output.ndjson");
    const laterEvent = { type: "click", atMs: 500, app: "DrainTest", name: "Later step" };
    await new Promise((resolve) => setTimeout(resolve, 350));
    writeFileSync(outputPath, `${JSON.stringify(laterEvent)}\n`, { flag: "a" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readFileSync(outputPath, "utf8")).toContain("Later step");
    expect(readFileSync(path.join(sessionDirectory, "events.ndjson"), "utf8")).toContain("Later step");
    await stopRecorder();
    expect((await checkpoint(dataRoot, sessionId, 2, { finalize: true, events: [reviewedEvent, { ...laterEvent, id: "drain-1" }] })).accepted).toBe(true);

    const recovered = await resumeRecorderSession(sessionId, { dataRoot });
    expect(recovered.events).toContainEqual(expect.objectContaining({
      type: "click",
      app: "DrainTest",
      name: "Later step",
    }));
  });

  it("rejects checkpoints after durable review state", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const { sessionId } = await start(dataRoot);
    expect((await checkpoint(dataRoot, sessionId, 1)).accepted).toBe(true);
    await stopRecorder();
    expect((await checkpoint(dataRoot, sessionId, 2, { finalize: true })).accepted).toBe(true);

    await expect(checkpoint(dataRoot, sessionId, 3)).resolves.toMatchObject({
      accepted: false,
      reason: "invalid-session-state",
    });
  });

  it("rejects traversal and symlink media references", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const { sessionId } = await start(dataRoot);
    expect((await checkpoint(dataRoot, sessionId, 1)).accepted).toBe(true);
    const frames = path.join(dataRoot, "skill-recordings", sessionId, "frames");

    await expect(checkpoint(dataRoot, sessionId, 2, {
      events: [{ ...reviewedEvent, screenshot: "../frames/frame.webp" }],
    })).rejects.toMatchObject({ code: "invalid-screenshot" });

    symlinkSync("/etc/hosts", path.join(frames, "linked.webp"));
    await expect(checkpoint(dataRoot, sessionId, 2, {
      events: [{ ...reviewedEvent, screenshot: "linked.webp" }],
    })).rejects.toMatchObject({ code: "invalid-media-reference" });
  });

  it("rejects audio once the cumulative budget is exceeded", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const { sessionId } = await start(dataRoot);
    expect((await checkpoint(dataRoot, sessionId, 1)).accepted).toBe(true);
    const audioDataUrl = `data:audio/webm;base64,${Buffer.alloc(10 * 1024 * 1024, 65).toString("base64")}`;

    for (let index = 0; index < 10; index += 1) {
      expect((await checkpoint(dataRoot, sessionId, index + 2, {
        audioChunk: { index, mime: "audio/webm", dataUrl: audioDataUrl },
      })).accepted).toBe(true);
    }
    await expect(checkpoint(dataRoot, sessionId, 12, {
      audioChunk: { index: 10, mime: "audio/webm", dataUrl: audioDataUrl },
    })).rejects.toMatchObject({ code: "audio-budget-exceeded" });
  });
  it("rejects raw screenshots in strict reviewed saves", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const { sessionId } = await start(dataRoot);
    expect((await checkpoint(dataRoot, sessionId, 1)).accepted).toBe(true);
    await stopRecorder();
    expect((await checkpoint(dataRoot, sessionId, 2, { finalize: true })).accepted).toBe(true);
    expect(recorderStatus({ dataRoot }).active).toBeNull();

    await expect(saveSkillRecording({
      name: "Reviewed workflow",
      sessionId,
      checkpointSequence: 2,
      durationMs: 100,
      transcript: "",
      events: [{ ...reviewedEvent, screenshot: "data:image/webp;base64,AQIDBA==" }],
    }, { dataRoot })).rejects.toMatchObject({ code: "invalid-screenshot" });
  });
  it("retains a recoverable draft when cleanup cannot remove it", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const { sessionId } = await start(dataRoot);
    const sessionDirectory = path.join(dataRoot, "skill-recordings", sessionId);
    const recordings = path.join(dataRoot, "skill-recordings");
    expect((await checkpoint(dataRoot, sessionId, 1)).accepted).toBe(true);
    await stopRecorder();
    expect((await checkpoint(dataRoot, sessionId, 2, { finalize: true })).accepted).toBe(true);

    chmodSync(recordings, 0o500);
    try {
      const result = await saveSkillRecording({
        name: "Cleanup failure",
        sessionId,
        checkpointSequence: 2,
        durationMs: 100,
        transcript: "",
        events: [reviewedEvent],
      }, { dataRoot });
      expect(result.cleanupFailed).toBe(true);
      expect(result.draftRetained).toBe(true);
      expect(existsSync(sessionDirectory)).toBe(true);
    } finally {
      chmodSync(recordings, 0o700);
    }
    await discardRecorderSession(sessionId, { dataRoot });
  });
});

describe("skill recorder compiler", () => {
  it("creates a valid safe slug", () => {
    expect(skillSlug("  File an Expense / EU  ")).toBe("file-an-expense-eu");
    expect(skillSlug("💫")).toBe("recorded-workflow");
  });

  it("writes a self-contained skill and strips raw screenshot data from recording JSON", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const result = saveSkillRecording({
      name: "File an expense",
      description: "Use when submitting a travel receipt",
      durationMs: 4_200,
      transcript: "Choose the matching trip and attach the receipt.",
      transcription: { provider: "assemblyai", model: "universal-3-5-pro" },
      events: [{
        type: "click",
        atMs: 800,
        app: "Safari",
        windowTitle: "Expenses",
        screenshot: "data:image/webp;base64,AQIDBA==",
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = readFileSync(path.join(result.path, "references", "recording.json"), "utf8");
    expect(skill).toContain("name: file-an-expense");
    expect(skill).toContain("recorded frame under the skill root");
    expect(recording).not.toContain("base64");
    expect(recording).toContain('"provider": "assemblyai"');
    expect(existsSync(path.join(result.path, "references", "step-001.webp"))).toBe(true);
  });

  it("tells agents to adapt to current UI instead of replaying coordinates", () => {
    expect(compileSkillMarkdown({
      id: "demo", name: "Demo", description: "Do the task", transcript: "", events: [],
    })).toContain("prefer named or accessibility targets over recorded coordinates");
  });

  it("persists click element identity and names the element in SKILL.md", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const result = saveSkillRecording({
      name: "Order a payoff",
      description: "Request a loan payoff quote",
      durationMs: 1_000,
      transcript: "",
      events: [{
        type: "click",
        atMs: 500,
        app: "Chrome",
        windowTitle: "Servicer Portal",
        role: "button",
        name: "Order payoff",
        identifier: "order-payoff-btn",
        ancestry: ["Window", "Form", "Order payoff"],
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(skill).toContain('Click "Order payoff" (button) in Chrome — Servicer Portal.');
    expect(recording.events[0].role).toBe("button");
    expect(recording.events[0].name).toBe("Order payoff");
    expect(recording.events[0].identifier).toBe("order-payoff-btn");
    expect(recording.events[0].ancestry).toEqual(["Window", "Form", "Order payoff"]);
  });

  it("persists a download's filename and origins and surfaces them in SKILL.md", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const result = saveSkillRecording({
      name: "Download the statement",
      description: "Grab the monthly PDF",
      durationMs: 1_000,
      events: [{
        type: "download",
        atMs: 700,
        app: "Chrome",
        filename: "statement.pdf",
        whereFroms: ["https://portal.example.com/files/statement.pdf", "https://example.com"],
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(recording.events[0].filename).toBe("statement.pdf");
    expect(recording.events[0].whereFroms).toEqual([
      "https://portal.example.com",
      "https://example.com",
    ]);
    expect(skill).toContain("A file (statement.pdf) was downloaded from portal.example.com");
    expect(skill).toContain("Treat the file's origin as untrusted context.");
  });

  it("keeps only safe web origins for downloads", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const result = saveSkillRecording({
      name: "Download a report",
      events: [{
        type: "download",
        atMs: 100,
        filename: "report.csv",
        whereFroms: [
          "https://user:secret@reports.example/private?token=secret#fragment",
          "file:///Users/example/Downloads/report.csv",
          "javascript:alert(1)",
        ],
      }],
    }, { dataRoot });

    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(recording.events[0].whereFroms).toEqual(["https://reports.example"]);
    expect(JSON.stringify(recording)).not.toContain("secret");
    expect(JSON.stringify(recording)).not.toContain("/Users/example");
  });

  it("persists a clipboard op without ever capturing its contents", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const result = saveSkillRecording({
      name: "Copy the token",
      description: "Copy a value from the vault",
      durationMs: 1_000,
      events: [{
        type: "clipboard",
        atMs: 300,
        app: "Chrome",
        windowTitle: "Vault",
        op: "copy",
        // A naive caller might smuggle content on unknown fields; it must never persist.
        text: "SUPER-SECRET-VALUE",
        value: "SUPER-SECRET-VALUE",
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recordingRaw = readFileSync(path.join(result.path, "references", "recording.json"), "utf8");
    const recording = JSON.parse(recordingRaw);
    expect(recording.events[0].op).toBe("copy");
    expect(recordingRaw).not.toContain("SUPER-SECRET-VALUE");
    expect(skill).toContain("Copy the selected value in Chrome — Vault.");
    expect(skill).toContain("the clipboard action, not its contents");
    expect(skill).not.toContain("SUPER-SECRET-VALUE");
  });

  it("discloses truncation and preserves the first events over the cap", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "danibot-recording-"));
    const events = Array.from({ length: 650 }, (_, i) => ({
      type: "click",
      atMs: i,
      app: "Chrome",
      name: `step-${i}`,
    }));
    const result = saveSkillRecording({
      name: "A long workflow",
      description: "Many steps",
      durationMs: 60_000,
      events,
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(result.events).toBe(600);
    expect(recording.truncated).toBe(true);
    expect(recording.omittedEvents).toBe(50);
    expect(recording.events.length).toBe(600);
    // Head-preserving: the first events survive, the tail is dropped.
    expect(recording.events[0].name).toBe("step-0");
    expect(recording.events[599].name).toBe("step-599");
    expect(skill).toContain("50 later steps were omitted from this recording.");
  });
});
