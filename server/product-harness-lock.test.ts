// Spec 110 R-RUNTIME-004 / acceptance criterion 5, at the serving path.
//
// The predicate has its own unit test. This covers the wiring a unit test
// cannot: that a locked server really refuses another harness over HTTP, and
// that the same boot still answers the first-run bootstrap contract.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(SERVER_DIR, "..");
// 43 base64url chars, satisfying OWNER_CAPABILITY_PATTERN (server/config.ts);
// a shorter string is silently replaced by a freshly minted capability.
const OWNER = "productHarnessLockFixtureOwnerCapability123";

let child: ChildProcess;
let port: number;
let home: string;
let stderr = "";

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "x-danibot-desktop-owner": OWNER,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: (await response.json()) as any };
};

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = mkdtempSync(join(tmpdir(), "dani-harness-lock-"));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_OWNER_TOKEN: OWNER,
    // The one flag a packaged build sets. Nothing else about this boot is
    // special, which is the point: the lock must not depend on desktop mode.
    DANI_PRODUCT_HARNESS_LOCK: "1",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early\n${stderr}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200) return;
    } catch {
      /* still starting */
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}, 60_000);

afterAll(async () => {
  // Wait for the child to actually be gone before removing its home: on
  // Windows a just-killed process still holds handles there, and the delete
  // fails with EPERM long after every assertion has passed.
  await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
}, 30_000);

describe("packaged builds run one harness", () => {
  it("refuses a bot bound to another harness", async () => {
    const instances = await call("GET", "/api/instances");
    const other = (instances.body.instances as Array<{ instanceId: string; driverKind: string }>)
      .find((instance) => instance.driverKind !== "hermesAgent");
    // The fleet always carries non-Hermes adapters; without one there is
    // nothing to prove and a silent pass would be the wrong answer.
    expect(other, "expected at least one non-Hermes instance in the fleet").toBeTruthy();

    const created = await call("POST", "/api/bots", {
      modelSelection: { instanceId: other!.instanceId, model: "any-model" },
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toMatch(/another engine cannot be selected/i);
  });

  it("refuses an instance id that resolves to no driver", async () => {
    const created = await call("POST", "/api/bots", {
      modelSelection: { instanceId: "no-such-instance", model: "any-model" },
    });
    expect(created.status).toBe(400);
  });

  it("still answers the first-run bootstrap contract", async () => {
    const status = await call("GET", "/api/runtime/bootstrap");
    expect(status.status).toBe(200);
    expect(["checking", "installing", "ready", "repairable-error", "blocked-error"]).toContain(status.body.state);
    expect(typeof status.body.code).toBe("string");
    // Safe copy: no command, path or engine vocabulary reaches the renderer.
    expect(status.body.message).not.toMatch(/hermes|curl|terminal|powershell|\//i);
  });
});
