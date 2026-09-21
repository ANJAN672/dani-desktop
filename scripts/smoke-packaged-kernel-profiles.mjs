import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable =
  process.env.DANI_SMOKE_EXECUTABLE ??
  path.join(root, "release", "linux-unpacked", "danibot");
if (!existsSync(executable))
  throw new Error(`missing packaged Electron executable: ${executable}`);
const workspace = mkdtempSync(
  path.join(tmpdir(), "dani-kernel-packaged-profiles-"),
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch(profileRoot, profileId) {
  const home = path.join(profileRoot, "home");
  const config = path.join(profileRoot, "config");
  const runtime = path.join(profileRoot, "runtime");
  for (const directory of [home, config, runtime])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const child = spawn(executable, ["--password-store=basic", "--disable-gpu"], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_RUNTIME_DIR: runtime,
      DANI_SMOKE_TEST: "1",
      DANI_SMOKE_CUA: "0",
      DANI_KERNEL_PROFILE_SMOKE: "1",
      DANI_KERNEL_PROFILE_ID: profileId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk;
    });
  const deadline = Date.now() + 90_000;
  let report = null;
  while (Date.now() < deadline) {
    const match = output.match(/\[smoke\] renderer-ready (\{.*\})\r?\n/);
    if (match) {
      report = JSON.parse(match[1]);
      break;
    }
    if (child.exitCode !== null)
      throw new Error(
        `packaged Electron exited ${child.exitCode} before smoke result\n${output}`,
      );
    await delay(100);
  }
  if (!report) {
    child.kill("SIGKILL");
    throw new Error(`timed out waiting for packaged Electron\n${output}`);
  }
  const exitDeadline = Date.now() + 15_000;
  while (child.exitCode === null && Date.now() < exitDeadline) await delay(50);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    throw new Error(`packaged Electron did not exit after smoke\n${output}`);
  }
  if (child.exitCode !== 0)
    throw new Error(`packaged Electron exited ${child.exitCode}\n${output}`);
  return report.kernelSmoke;
}

try {
  for (let index = 1; index <= 20; index += 1) {
    const profileId = `clean-${String(index).padStart(2, "0")}`;
    const profileRoot = path.join(workspace, profileId);
    const first = await launch(profileRoot, profileId);
    const restart = await launch(profileRoot, profileId);
    if (
      first?.phase !== "executed" ||
      first.externalWrites !== 1 ||
      first.evidenceCount !== 1 ||
      first.proactivePhase !== "proposed" ||
      first.proactiveProposalCount !== 1 ||
      first.proactiveCancelGeneration !== 2
    ) {
      throw new Error(
        `profile ${profileId} first launch invariant failed: ${JSON.stringify(first)}`,
      );
    }
    if (
      restart?.phase !== "recovered" ||
      !restart.duplicatePrevented ||
      restart.externalWrites !== 1 ||
      restart.evidenceCount !== 1 ||
      restart.proactivePhase !== "recovered" ||
      restart.proactiveProposalCount !== 1 ||
      restart.proactiveCancelGeneration !== 2
    ) {
      throw new Error(
        `profile ${profileId} restart invariant failed: ${JSON.stringify(restart)}`,
      );
    }
    console.log(
      `[kernel-profile-smoke] ${index}/20 ${profileId}: execute=1 restart-duplicates=0 evidence=1`,
    );
  }
  console.log(
    "[kernel-profile-smoke] OK: 20 clean packaged Electron profiles, 40 launches, zero duplicate effects",
  );
} finally {
  if (process.env.DANI_KEEP_KERNEL_SMOKE !== "1")
    rmSync(workspace, { recursive: true, force: true });
  else console.log(`[kernel-profile-smoke] kept ${workspace}`);
}
