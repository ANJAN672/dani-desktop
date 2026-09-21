// Owner-capability acceptance (Security Epic #9, workstream B).
//
// Every loopback client is untrusted: every state-changing HTTP route
// requires the per-launch owner capability in desktop, dev, CLI and
// headless modes. These tests boot the REAL server as a SEPARATE process
// (no shared memory) against a throwaway home directory. The "second local
// process" is this test process: it scrapes the token from the boot log —
// the documented distribution channel — and attempts the forbidden calls
// with and without it.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const OWNER_HEADER = "x-danibot-desktop-owner";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type BootedServer = {
  child: ChildProcess;
  base: string;
  home: string;
  token: string | null;
  stdout: string;
};

const live: BootedServer[] = [];

afterEach(async () => {
  while (live.length) {
    const server = live.pop()!;
    await waitForExit(server.child, { signal: "SIGTERM", graceMs: 5_000 });
    removeTempDir(server.home);
  }
});

/** Boot the real server in another process. Returns once /api/health is up
 * AND the boot log's owner-capability line has been observed (or not). */
async function bootServer(extraEnv: Record<string, string> = {}): Promise<BootedServer> {
  const home = mkdtempSync(join(tmpdir(), "omb-owner-"));
  const port = await freePortBlock([0, 1]);
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server: BootedServer = { child, base: `http://127.0.0.1:${port}`, home, token: null, stdout: "" };
  live.push(server);
  let stderr = "";
  child.stdout!.on("data", (c) => {
    server.stdout += c;
    const m = /\[owner\] (?:DANI|OMB)_OWNER_TOKEN=([A-Za-z0-9_-]{43})/.exec(server.stdout);
    if (m) server.token = m[1];
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited during boot (code=${child.exitCode}). stderr:\n${stderr}\nstdout:\n${server.stdout}`);
    }
    try {
      const res = await fetch(`${server.base}/api/health`);
      if (res.ok) {
        const health = (await res.json()) as { app?: string; pid?: number };
        if (health.app === "danibot" && health.pid === child.pid) break;
      }
    } catch {
      /* still starting */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}\nstdout:\n${server.stdout}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  // Give the boot log a beat to flush the owner line after listen.
  const tokenDeadline = Date.now() + 10_000;
  while (!server.token && Date.now() < tokenDeadline) await new Promise((r) => setTimeout(r, 100));
  return server;
}

async function call(
  server: BootedServer,
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  // null = explicitly no token; undefined = use the scraped one.
  const token = options.token === undefined ? server.token : options.token;
  if (token) headers[OWNER_HEADER] = token;
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("owner capability", () => {
  it("rejects loopback mutations without the token, across modes", async () => {
    const server = await bootServer();
    expect(server.token, "boot log must print the per-launch token").toMatch(TOKEN_PATTERN);

    // invoke /api/cli-test (spawns a local binary)
    const cliTest = await call(server, "POST", "/api/cli-test", {
      body: { cli: process.execPath },
      token: null,
    });
    expect(cliTest.status).toBe(403);
    // mutate config
    const config = await call(server, "PATCH", "/api/config", {
      body: { features: { showToolCalls: true } },
      token: null,
    });
    expect(config.status).toBe(403);
    // start work (create a bot)
    const create = await call(server, "POST", "/api/bots", { body: {}, token: null });
    expect(create.status).toBe(403);
    // answer approvals
    const respond = await call(server, "POST", "/api/bots/no-such-bot/respond", {
      body: { requestId: "r1", behavior: "allow" },
      token: null,
    });
    expect(respond.status).toBe(403);
    expect(respond.body.error).toMatch(/desktop app or a paired device/);
    // wrong token is the same as no token
    const wrong = await call(server, "POST", "/api/bots", { body: {}, token: "0".repeat(43) });
    expect(wrong.status).toBe(403);

    // reads stay open: liveness and identity carry no secrets
    expect((await call(server, "GET", "/api/health", { token: null })).status).toBe(200);
    expect((await call(server, "GET", "/api/config", { token: null })).status).toBe(200);
    expect((await call(server, "GET", "/api/edition", { token: null })).status).toBe(200);
  }, 90_000);

  it("accepts loopback mutations presenting the token", async () => {
    const server = await bootServer();

    const cliTest = await call(server, "POST", "/api/cli-test", { body: { cli: process.execPath, explicitCustomPath: true } });
    expect(cliTest.status).toBe(200);
    expect(cliTest.body.ok).toBe(true);

    const config = await call(server, "PATCH", "/api/config", { body: { features: { showToolCalls: true } } });
    expect(config.status).toBe(200);

    const create = await call(server, "POST", "/api/bots", { body: {} });
    expect(create.status).toBe(201);
    expect(typeof create.body.bot?.id).toBe("string");

    // past the owner gate: a bogus bot id now fails in the handler, not at auth
    const respond = await call(server, "POST", "/api/bots/no-such-bot/respond", {
      body: { requestId: "r1", behavior: "allow" },
    });
    expect(respond.status).toBe(404);
  }, 90_000);

  it("mints a fresh capability on every launch", async () => {
    const first = await bootServer();
    expect(first.token).toMatch(TOKEN_PATTERN);
    await waitForExit(first.child, { signal: "SIGTERM", graceMs: 5_000 });
    live.splice(live.indexOf(first), 1);
    removeTempDir(first.home);

    const second = await bootServer();
    expect(second.token).toMatch(TOKEN_PATTERN);
    expect(second.token).not.toBe(first.token);
  }, 120_000);

  it("honors an operator-supplied OMB_OWNER_TOKEN and keeps it out of probe wrappers", async () => {
    const supplied = `operator-supplied-owner-${"1".repeat(19)}`;
    expect(supplied).toMatch(TOKEN_PATTERN);
    // Simulate the operator exporting the token for the CLI: the server
    // inherits it from its environment.
    const server = await bootServer({ OMB_OWNER_TOKEN: supplied });
    expect(server.token).toBe(supplied);

    const create = await call(server, "POST", "/api/bots", { body: {}, token: supplied });
    expect(create.status).toBe(201);

    // The probed wrapper is an arbitrary binary: it must not see the
    // capability even though the operator exported it into the server's env.
    const dumpFile = join(server.home, "probe-env.json");
    const script = join(server.home, "env-dump-probe.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(process.env));\n` +
        `console.log("dumped");\n`,
    );
    chmodSync(script, 0o755);
    const probe = await call(server, "POST", "/api/cli-test", {
      body: { cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, explicitCustomPath: true },
      token: supplied,
    });
    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({ ok: true, version: "dumped" });
    const dumped = JSON.parse(readFileSync(dumpFile, "utf8")) as Record<string, string>;
    expect(dumped.OMB_OWNER_TOKEN).toBeUndefined();
  }, 90_000);
});
