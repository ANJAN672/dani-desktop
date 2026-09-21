import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FREE_CATALOG, type FreeCatalog, type FreeModel } from "./catalog.ts";
import { startFreeProxy, type StartedFreeProxy } from "./proxy.ts";

const NOW = new Date("2026-09-20T00:00:00Z");

function model(overrides: Partial<FreeModel> & Pick<FreeModel, "id">): FreeModel {
  return {
    label: overrides.id,
    upstream: "zen",
    wireId: overrides.id.replace("dani-free/", ""),
    contextWindow: 128_000,
    privacy: "open",
    evidence: { source: "https://example.test/free", observedAt: "2026-09-01", expiresAt: "2026-12-01", quote: "free" },
    ...overrides,
  };
}

const CATALOG: FreeCatalog = {
  version: 42,
  generatedAt: "2026-09-01",
  expiresAt: "2026-12-01",
  models: [
    model({ id: "dani-free/open-model", privacy: "open" }),
    model({ id: "dani-free/trainer-model", privacy: "may-train" }),
    model({ id: "dani-free/trial-model", privacy: "trial-only" }),
  ],
};

let running: StartedFreeProxy | null = null;
afterEach(async () => {
  if (running) await running.close();
  running = null;
});

/** Records every upstream call so a test can assert what was (not) sent. */
function recorder(response: Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | undefined }> = [];
  // Deliberately not typed as `typeof fetch`: the server tsconfig has no DOM
  // lib, so RequestInfo is not in scope. A structural shape plus a cast at the
  // call site keeps this honest without pulling in DOM types.
  const impl = (async (input: string | URL, init?: { headers?: Record<string, string>; body?: string }) => {
    const headers = init?.headers ?? {};
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      auth: headers.authorization,
    });
    return response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

async function start(env: Record<string, string> = {}, response?: Response) {
  const rec = response ? recorder(response) : null;
  running = await startFreeProxy({
    port: 0,
    catalog: CATALOG,
    now: () => NOW,
    env: env as NodeJS.ProcessEnv,
    ...(rec ? { fetchImpl: rec.impl } : {}),
  });
  return { proxy: running, rec };
}

function post(proxy: StartedFreeProxy, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${proxy.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("binding", () => {
  it("listens on loopback only", async () => {
    const { proxy } = await start();
    expect(proxy.host).toBe("127.0.0.1");
    expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  });
});

describe("GET /v1/models", () => {
  it("defaults to the private view when the caller declares nothing", async () => {
    const { proxy } = await start();
    const body = (await (await fetch(`${proxy.baseUrl}/models`)).json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["dani-free/open-model"]);
  });

  it("offers the wider set when the caller declares the request public", async () => {
    const { proxy } = await start();
    const res = await fetch(`${proxy.baseUrl}/models`, { headers: { "x-dani-privacy": "public" } });
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual([
      "dani-free/open-model",
      "dani-free/trainer-model",
      "dani-free/trial-model",
    ]);
  });

  it("treats an unrecognised privacy value as private", async () => {
    const { proxy } = await start();
    const res = await fetch(`${proxy.baseUrl}/models`, { headers: { "x-dani-privacy": "whatever" } });
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["dani-free/open-model"]);
  });
});

describe("free-only enforcement at the choke point", () => {
  it("refuses a model that is not in the catalog", async () => {
    const { proxy, rec } = await start({ DANI_FREE_ZEN_API_KEY: "k" }, new Response("{}"));
    const res = await post(proxy, { model: "gpt-4o", messages: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown-model");
    expect(rec?.calls).toHaveLength(0);
  });

  it("refuses a private request aimed at a training model, even when asked for by name", async () => {
    const { proxy, rec } = await start({ DANI_FREE_ZEN_API_KEY: "k" }, new Response("{}"));
    const res = await post(proxy, { model: "dani-free/trainer-model", messages: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("privacy-not-permitted");
    expect(rec?.calls).toHaveLength(0);
  });
});

describe("credentials", () => {
  it("reports which upstream is unsigned-in rather than failing vaguely", async () => {
    const { proxy } = await start({});
    const res = await post(proxy, { model: "dani-free/open-model", messages: [] });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no-credential:zen");
  });
});

describe("forwarding", () => {
  it("sends the upstream's own id, not the Dani alias, and streams the answer back", async () => {
    const upstreamBody = JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "hi" } }] });
    const { proxy, rec } = await start(
      { DANI_FREE_ZEN_API_KEY: "secret-key" },
      new Response(upstreamBody, { status: 200, headers: { "content-type": "application/json" } }),
    );

    const res = await post(proxy, { model: "dani-free/open-model", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(upstreamBody);

    expect(rec?.calls).toHaveLength(1);
    expect(rec?.calls[0].url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(rec?.calls[0].body.model).toBe("open-model");
    expect(rec?.calls[0].auth).toBe("Bearer secret-key");
  });

  it("passes a tool-call request through as data and executes nothing", async () => {
    const toolCall = JSON.stringify({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"/etc/passwd"}' } }] } }],
    });
    const { proxy } = await start(
      { DANI_FREE_ZEN_API_KEY: "k" },
      new Response(toolCall, { status: 200, headers: { "content-type": "application/json" } }),
    );

    const res = await post(proxy, { model: "dani-free/open-model", messages: [], tools: [] });
    const echoed = (await res.json()) as { choices: Array<{ message: { tool_calls: unknown[] } }> };
    // The request survives the proxy intact — the proxy is a pipe, not an actor.
    expect(echoed.choices[0].message.tool_calls).toHaveLength(1);
  });

  it("reports an unreachable upstream as 502 rather than pretending success", async () => {
    running = await startFreeProxy({
      port: 0,
      catalog: CATALOG,
      now: () => NOW,
      env: { DANI_FREE_ZEN_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const res = await post(running, { model: "dani-free/open-model", messages: [] });
    expect(res.status).toBe(502);
  });
});

describe("GET /health", () => {
  it("reports the catalog version, its expiry, and whether it has gone stale", async () => {
    const { proxy } = await start();
    const body = (await (await fetch(`${proxy.baseUrl.replace("/v1", "")}/health`)).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.catalog_version).toBe(42);
    expect(body.catalog_expired).toBe(false);
    expect(body.eligible_private).toEqual(["dani-free/open-model"]);
  });
});

describe("anything else", () => {
  it("404s instead of guessing", async () => {
    const { proxy } = await start();
    const res = await fetch(`${proxy.baseUrl}/embeddings`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("the spawnable entry", () => {
  it("starts as its own process and announces its port on stdout", async () => {
    const entry = fileURLToPath(new URL("../dani-free-proxy.ts", import.meta.url));
    const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
      env: { ...process.env, DANI_FREE_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no announcement within 15s")), 15_000);
        let buffer = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const newline = buffer.indexOf("\n");
          if (newline >= 0) {
            clearTimeout(timer);
            resolve(buffer.slice(0, newline));
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`exited early with ${code}`));
        });
      });

      const announced = JSON.parse(line) as { daniFreeProxy: boolean; port: number; baseUrl: string };
      expect(announced.daniFreeProxy).toBe(true);
      expect(announced.port).toBeGreaterThan(0);

      const health = await fetch(`http://127.0.0.1:${announced.port}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { catalog_version: number };
      expect(body.catalog_version).toBe(FREE_CATALOG.version);
    } finally {
      child.kill("SIGTERM");
    }
  }, 25_000);
});
