import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { LAYA_DECISION_SCHEMA_ID, LAYA_DECISION_SCHEMA_VERSION, type LayaDecisionRequest } from "./contract.ts";
import { LayaDecisionService } from "./service.ts";
import { LAYA_TYPED_DECISIONS } from "./manifest.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

const root = () => {
  const r = mkdtempSync(join(tmpdir(), "laya-svc-"));
  roots.push(r);
  return r;
};

const request = (): LayaDecisionRequest => ({
  schemaId: LAYA_DECISION_SCHEMA_ID,
  schemaVersion: LAYA_DECISION_SCHEMA_VERSION,
  taskId: "job-1",
  traceId: "trace-1",
  objective: "Which route should handle this request?",
  stateSummary: "one browser window, visible Submit button",
  options: [
    { id: "cua", label: "bounded single UI action via the computer-use driver" },
    { id: "hermes", label: "general Hermes agent turn" },
  ],
});

const pythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

describe("LayaDecisionService without a checkpoint", () => {
  it("reports invalid requests before touching python", async () => {
    const svc = new LayaDecisionService({ cacheDir: root() });
    const bad = await svc.decide({ ...request(), schemaVersion: 42 });
    expect(bad).toMatchObject({ ok: false, failure: "INVALID_REQUEST" });
    await svc.close();
  });
  it("fails stale deadlines as STALE_DEADLINE", async () => {
    const svc = new LayaDecisionService({ cacheDir: root() });
    const r = await svc.decide({ ...request(), deadlineAt: "2000-01-01T00:00:00Z" });
    expect(r).toMatchObject({ ok: false, failure: "STALE_DEADLINE" });
    await svc.close();
  });
  it("reports NOT_INSTALLED with the real download size, never spawns", async () => {
    const svc = new LayaDecisionService({ cacheDir: root() });
    const r = await svc.decide(request());
    expect(r).toMatchObject({ ok: false, failure: "NOT_INSTALLED" });
    if (!r.ok) expect(r.message).toContain(String(LAYA_TYPED_DECISIONS.downloadBytes));
    expect(svc.status().sidecar).toBe("stopped");
    expect(svc.status().requiredDownloadBytes).toBe(LAYA_TYPED_DECISIONS.downloadBytes);
    await svc.close();
  });
  it("rejects duplicate option labels (they could not be mapped back to ids)", async () => {
    const svc = new LayaDecisionService({ cacheDir: root() });
    const req = request();
    req.options.push({ id: "other", label: "general Hermes agent turn" });
    const r = await svc.decide(req);
    expect(r).toMatchObject({ ok: false, failure: "INVALID_REQUEST" });
    await svc.close();
  });
});

describe.skipIf(!pythonAvailable)("laya sidecar protocol (real python, no model)", () => {
  const send = (
    lines: Array<{ id: string; method: string; params?: Record<string, unknown> }>,
  ): Promise<Array<{ id?: string; ok?: boolean; result?: { pong?: boolean }; error?: { kind?: string } }>> =>
    new Promise((resolve, reject) => {
      const sidecar = join(__dirname, "sidecar", "laya_sidecar.py");
      const child = spawnSync("python3", [sidecar], {
        input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 << 20,
      });
      if (child.error) return reject(child.error);
      const out = child.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      resolve(out);
    });

  it("answers ping without any SDK or model", async () => {
    const [pong] = await send([{ id: "1", method: "ping" }]);
    expect(pong).toMatchObject({ id: "1", ok: true, result: { pong: true } });
  });

  it("fails load on a missing model dir with a typed NOT_INSTALLED", async () => {
    const [r] = await send([{ id: "1", method: "load", params: { model_dir: "/nonexistent/path" } }]);
    expect(r).toMatchObject({ id: "1", ok: false, error: { kind: "NOT_INSTALLED" } });
  });

  it("fails load on a real dir without the SDK as SDK_UNAVAILABLE (system python has no laya)", async () => {
    const hasSdk = spawnSync("python3", ["-c", "import laya"], { encoding: "utf8" }).status === 0;
    if (hasSdk) return; // environment already has the SDK; this case is untestable here
    const [r] = await send([{ id: "1", method: "load", params: { model_dir: tmpdir() } }]);
    expect(r).toMatchObject({ id: "1", ok: false, error: { kind: "SDK_UNAVAILABLE" } });
  });

  it("rejects unknown methods and keeps serving", async () => {
    const [bad, pong] = await send([
      { id: "1", method: "exec_shell_do_bad_things" },
      { id: "2", method: "ping" },
    ]);
    expect(bad).toMatchObject({ ok: false, error: { kind: "BAD_METHOD" } });
    expect(pong).toMatchObject({ ok: true, result: { pong: true } });
  });
});
