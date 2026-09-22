// Activation wired into a real server (issue #18 acceptance criteria 1 and 3).
//
// The unit tests prove the activator. This proves the wiring around it: that a
// booting server reads the bundled payload for its own platform, reports a
// failed verification as a specific cause rather than a shrug, and on success
// resolves the runtime to an absolute managed path instead of trusting PATH.
//
// The payload here contains a placeholder executable. It is not a Hermes
// runtime and this file never claims the product is ready; asserting `ready`
// off a placeholder is exactly the fake green issue #18 forbids.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { selectTarget } from "./hermes-runtime.ts";

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const OWNER = "hermesActivationE2eOwnerCapability12345678";
const TAR_BLOCK = 512;

const target = selectTarget(process.platform, process.arch);
const runner = target ? describe : describe.skip;

const cleanup: { child?: ChildProcess; dirs: string[] } = { dirs: [] };
afterEach(async () => {
  await waitForExit(cleanup.child, { signal: "SIGTERM" });
  cleanup.child = undefined;
  while (cleanup.dirs.length) await removeTempDir(cleanup.dirs.pop()!);
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hermes-e2e-${label}-`));
  cleanup.dirs.push(dir);
  return dir;
}

/** One regular file in a real ustar archive. */
function tarFile(name: string, body: string): Buffer {
  const content = Buffer.from(body, "utf8");
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write("0000755\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("0", 156, 1, "utf8");
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
  const padded = Buffer.alloc(Math.ceil(content.length / TAR_BLOCK) * TAR_BLOCK);
  content.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(TAR_BLOCK * 2)]);
}

function writePayload(options: { corruptDigest?: boolean } = {}): { dir: string; executableRelPath: string } {
  const dir = tempDir("payload");
  const executableRelPath = process.platform === "win32" ? "bin/hermes-acp.cmd" : "bin/hermes-acp";
  const archive = gzipSync(tarFile(executableRelPath, "placeholder\n"));
  writeFileSync(join(dir, `${target}.tar.gz`), archive);
  writeFileSync(
    join(dir, `${target}.manifest.json`),
    JSON.stringify({
      manifestVersion: 1,
      name: "hermes-runtime-payload",
      target,
      version: "0.21.4",
      archiveSha256: options.corruptDigest
        ? "a".repeat(64)
        : createHash("sha256").update(archive).digest("hex"),
      archiveSize: archive.length,
      unpackedSize: 4096,
      format: "tar.gz",
      executableRelPath,
      degradations: [],
    }),
  );
  return { dir, executableRelPath };
}

async function bootServer(payloadDir: string): Promise<{ port: number; home: string }> {
  const port = await freePortBlock([0, 1]);
  const home = tempDir("home");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_OWNER_TOKEN: OWNER,
    DANI_HERMES_PAYLOAD_DIR: payloadDir,
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  cleanup.child = child;
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early\n${stderr}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200) return { port, home };
    } catch {
      /* still starting */
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The runtime path this server resolved, or "" when it activated nothing. */
function managedCli(home: string): string {
  try {
    const config = JSON.parse(readFileSync(join(home, ".danibot", "config.json"), "utf8")) as {
      instances?: Record<string, { config?: { cli?: string } }>;
    };
    return config.instances?.hermes?.config?.cli ?? "";
  } catch {
    return "";
  }
}

const bootstrapOf = async (port: number) =>
  (await (await fetch(`http://127.0.0.1:${port}/api/runtime/bootstrap`)).json()) as {
    state: string;
    phase: string;
    code: string;
    message: string;
    canRetry: boolean;
    canContinueLimited: boolean;
  };

runner("bundled runtime activation on a real server", () => {
  it("activates the payload and resolves the runtime to an absolute managed path", async () => {
    const { dir, executableRelPath } = writePayload();
    const { port, home } = await bootServer(dir);

    // The requirement is that a GUI process launches by absolute path rather
    // than inheriting a terminal's PATH. The saved instance config is where
    // that resolution has to land.
    const cli = managedCli(home);
    expect(cli).toContain(join("runtimes", "hermes", "versions"));
    expect(cli.endsWith(executableRelPath.split("/").join(sep))).toBe(true);

    // Honest about what a placeholder proves: activation happened, so the
    // cause is no longer a missing payload. Readiness is a separate claim and
    // is not made here.
    const status = await bootstrapOf(port);
    expect(status.code).not.toBe("runtime.payload-missing");
    expect(status.state).not.toBe("ready");
  }, 90_000);

  it("reports a failed verification as its own cause and activates nothing", async () => {
    const { dir } = writePayload({ corruptDigest: true });
    const { port, home } = await bootServer(dir);

    const status = await bootstrapOf(port);
    expect(status.code).toBe("runtime.digest-mismatch");
    expect(status.phase).toBe("activate");
    expect(status.canContinueLimited).toBe(true);
    // Safe copy survives the whole round trip, not just the unit test.
    expect(status.message).not.toMatch(/hermes|sha256|[/\\]/i);

    // Nothing was activated, so nothing was written. A config that does not
    // exist and a config with no managed path are the same answer here.
    expect(managedCli(home)).toBe("");
  }, 90_000);

  it("reports a missing payload as a blocked state that offers limited mode", async () => {
    const empty = tempDir("empty");
    mkdirSync(join(empty, "unused"), { recursive: true });
    const { port } = await bootServer(empty);

    const status = await bootstrapOf(port);
    expect(status.code).toBe("runtime.payload-missing");
    expect(status.state).toBe("blocked-error");
    expect(status.canContinueLimited).toBe(true);
  }, 90_000);
});
