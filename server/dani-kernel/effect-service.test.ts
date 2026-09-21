import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaniKernelRepository } from "./repository.ts";
import { DaniKernelEffectService, type KernelEffectAdapter } from "./effect-service.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function harness(overrides: Partial<KernelEffectAdapter> = {}) {
  const root = mkdtempSync(join(tmpdir(), "dani-effect-service-")); roots.push(root);
  const repo = new DaniKernelRepository(join(root, "kernel.sqlite"));
  const job = repo.admitJob({ ownerId: "user-1", objective: "submit", originatingRequestId: "request-1", turnId: "turn-1", provider: "hermes", threadId: "thread-1" });
  const effect = repo.proposeEffect({ jobId: String(job.id), generation: 1, idempotencyKey: "stable-key", adapter: "browser", normalizedInput: { click: "submit" }, risk: "representation", resource: "form", audience: "vendor" });
  repo.recordApproval({ effectId: String(effect.id), userId: "user-1", scope: "submit", resource: "form", audience: "vendor", limits: { once: true }, expiresAt: "2999-01-01T00:00:00Z", originatingRequestId: "request-1", decision: "approved" });
  const adapter: KernelEffectAdapter = {
    name: "browser", idempotency: "reconcile",
    execute: vi.fn(async () => ({ externalReference: "receipt-1" })),
    inspect: vi.fn(async () => ({ confirmed: true, sourceTimestamp: new Date().toISOString(), sourceReference: "https://example.test/receipt-1", inspection: { submitted: true } })),
    reconcile: vi.fn(async () => ({ confirmed: true, externalReference: "receipt-1", sourceTimestamp: new Date().toISOString(), sourceReference: "https://example.test/receipt-1", inspection: { submitted: true } })),
    ...overrides,
  };
  return { repo, job, effect, adapter, service: new DaniKernelEffectService(repo, new Map([[adapter.name, adapter]])) };
}

describe("DaniKernelEffectService", () => {
  it("dispatches once, inspects, records adapter evidence, then completes", async () => {
    const h = harness();
    await expect(h.service.execute(String(h.effect.id), 1)).resolves.toMatchObject({ status: "completed", externalReference: "receipt-1" });
    expect(h.adapter.execute).toHaveBeenCalledOnce();
    expect(h.adapter.inspect).toHaveBeenCalledOnce();
    expect(h.repo.effect(String(h.effect.id)).state).toBe("completed");
    expect(() => h.repo.beginDispatch(String(h.effect.id), 1)).toThrow();
    h.repo.close();
  });

  it("treats an adapter exception as uncertain and never retries automatically", async () => {
    const h = harness({ execute: vi.fn(async () => { throw new Error("socket reset after click"); }) });
    await expect(h.service.execute(String(h.effect.id), 1)).resolves.toMatchObject({ status: "uncertain" });
    expect(h.repo.effect(String(h.effect.id)).state).toBe("uncertain");
    await expect(h.service.execute(String(h.effect.id), 1)).rejects.toThrow();
    expect(h.adapter.execute).toHaveBeenCalledOnce();
    h.repo.close();
  });

  it("keeps an unconfirmed inspection uncertain", async () => {
    const h = harness({ inspect: vi.fn(async () => ({ confirmed: false, sourceTimestamp: new Date().toISOString(), sourceReference: "receipt-1", inspection: { found: false } })) });
    await expect(h.service.execute(String(h.effect.id), 1)).resolves.toMatchObject({ status: "uncertain" });
    expect(h.repo.effect(String(h.effect.id))).toMatchObject({ state: "uncertain", external_reference: "receipt-1" });
    h.repo.close();
  });

  it("reconciles uncertain work with a read and does not dispatch again", async () => {
    const h = harness({ execute: vi.fn(async () => { throw new Error("lost response"); }) });
    await h.service.execute(String(h.effect.id), 1);
    await expect(h.service.reconcile(String(h.effect.id), 1)).resolves.toMatchObject({ status: "completed", externalReference: "receipt-1" });
    expect(h.adapter.execute).toHaveBeenCalledOnce();
    expect(h.adapter.reconcile).toHaveBeenCalledOnce();
    expect(h.repo.effect(String(h.effect.id)).state).toBe("completed");
    h.repo.close();
  });

  it("rejects an adapter callback that returns after cancellation", async () => {
    let release!: (value: { externalReference: string }) => void;
    const execute = vi.fn(() => new Promise<{ externalReference: string }>(resolve => { release = resolve; }));
    const h = harness({ execute });
    const running = h.service.execute(String(h.effect.id), 1);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    h.repo.cancelJob(String(h.job.id), "user interrupted");
    release({ externalReference: "late-receipt" });
    await expect(running).rejects.toThrow("stale cancellation generation");
    expect(h.repo.job(String(h.job.id))).toMatchObject({ status: "cancelled", generation: 2 });
    expect(h.adapter.inspect).not.toHaveBeenCalled();
    h.repo.close();
  });

  it("stays uncertain when reconciliation cannot prove success", async () => {
    const h = harness({
      execute: vi.fn(async () => { throw new Error("lost response"); }),
      reconcile: vi.fn(async () => ({ confirmed: false, sourceTimestamp: new Date().toISOString(), sourceReference: "lookup", inspection: { found: false } })),
    });
    await h.service.execute(String(h.effect.id), 1);
    await expect(h.service.reconcile(String(h.effect.id), 1)).resolves.toMatchObject({ status: "uncertain" });
    expect(h.repo.effect(String(h.effect.id)).state).toBe("uncertain");
    h.repo.close();
  });
});
