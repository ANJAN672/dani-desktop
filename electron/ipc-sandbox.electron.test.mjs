// Spawns real Electron and runs the malicious-renderer probe fixture
// (electron/fixtures/ipc-sandbox-probe.cjs): proves raw Electron/Node APIs
// and unexposed IPC channels are unreachable from a sandboxed renderer while
// the legitimate preload bridge keeps working.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electron = require("electron");
const fixture = fileURLToPath(new URL("./fixtures/ipc-sandbox-probe.cjs", import.meta.url));
const xvfb = process.platform === "linux" && !process.env.DISPLAY
  ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim()
  : "";
const canRun = process.platform !== "linux" || Boolean(process.env.DISPLAY) || Boolean(xvfb);
const fixtureTimeoutMs = 45_000;

const expectedMarkers = [
  "fixture-ready",
  "malicious-raw-apis-unreachable",
  "malicious-no-invoke-path",
  "bridge-surface-intact",
  "bridge-invoke-roundtrip-ok",
  "malicious-canary-unreached",
];

it.runIf(canRun)("sandboxed renderer cannot reach raw APIs or unexposed IPC channels", async () => {
  const command = xvfb || electron;
  const args = xvfb ? ["-a", electron, "--no-sandbox", fixture] : [fixture];
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, fixtureTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  const diagnostics = [
    `Electron exit code: ${result.code}; signal: ${result.signal ?? "none"}`,
    `Fixture deadline exceeded: ${result.timedOut}`,
    `stdout:\n${result.stdout || "<empty>"}`,
    `stderr:\n${result.stderr || "<empty>"}`,
  ].join("\n");
  expect(result, diagnostics).toMatchObject({ code: 0, signal: null, timedOut: false });
  for (const marker of expectedMarkers) {
    expect(result.stdout, diagnostics).toContain(marker);
  }
}, 60_000);
