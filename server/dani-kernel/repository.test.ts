import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { DaniKernelRepository } from "./repository.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const repository = () => {
  const root = mkdtempSync(join(tmpdir(), "dani-kernel-"));
  roots.push(root);
  return new DaniKernelRepository(join(root, "kernel.sqlite"));
};
const admitted = (repo: DaniKernelRepository, request = "request-1") => repo.admitJob({
  ownerId: "user-1", objective: "send the message", originatingRequestId: request,
  turnId: "turn-1", provider: "hermes", threadId: "thread-1",
});
const proposed = (repo: DaniKernelRepository, jobId: string, key = "effect-1") => repo.proposeEffect({
  jobId, generation: 1, idempotencyKey: key, adapter: "browser",
  normalizedInput: { action: "click", target: "submit" }, risk: "representation",
  resource: "https://example.test/form", audience: "vendor",
});
const approve = (repo: DaniKernelRepository, effectId: string) => repo.recordApproval({
  effectId, userId: "user-1", scope: "submit form", resource: "https://example.test/form",
  audience: "vendor", limits: { once: true }, expiresAt: "2999-01-01T00:00:00.000Z",
  originatingRequestId: "request-1", decision: "approved",
});

describe("DaniKernelRepository", () => {
  it("deduplicates admission and binds idempotency keys to normalized input", () => {
    const repo = repository();
    const job = admitted(repo);
    expect(job.duplicate).toBe(false);
    expect(admitted(repo).duplicate).toBe(true);
    const effect = proposed(repo, String(job.id));
    expect(effect.duplicate).toBe(false);
    expect(proposed(repo, String(job.id)).duplicate).toBe(true);
    expect(() => repo.proposeEffect({
      jobId: String(job.id), generation: 1, idempotencyKey: "effect-1", adapter: "browser",
      normalizedInput: { action: "click", target: "other" }, risk: "representation",
      resource: "https://example.test/form", audience: "vendor",
    })).toThrow("idempotency key conflicts");
    repo.close();
  });

  it("requires an exact owner/request/resource/audience approval before dispatch", () => {
    const repo = repository();
    const job = admitted(repo);
    const effect = proposed(repo, String(job.id));
    expect(() => repo.beginDispatch(String(effect.id), 1)).toThrow("valid approval required");
    expect(() => repo.recordApproval({
      effectId: String(effect.id), userId: "user-1", scope: "submit form",
      resource: "https://example.test/form", audience: "someone-else", limits: {},
      expiresAt: "2999-01-01T00:00:00.000Z", originatingRequestId: "request-1", decision: "approved",
    })).toThrow("resource or audience");
    approve(repo, String(effect.id));
    expect(repo.beginDispatch(String(effect.id), 1).state).toBe("dispatching");
    repo.close();
  });

  it("fences stale provider and adapter callbacks after cancellation", () => {
    const repo = repository();
    const job = admitted(repo);
    const effect = proposed(repo, String(job.id));
    approve(repo, String(effect.id));
    expect(repo.cancelJob(String(job.id), "user interrupted").generation).toBe(2);
    expect(() => repo.beginDispatch(String(effect.id), 1)).toThrow("stale cancellation generation");
    expect(() => repo.beginTurn(String(job.id), 1)).toThrow("stale or non-runnable");
    repo.close();
  });

  it("keeps a pre-dispatch crash retryable without dispatching it", () => {
    const repo = repository();
    const path = repo.path;
    const job = admitted(repo);
    const effect = proposed(repo, String(job.id));
    approve(repo, String(effect.id));
    repo.close(); // crash point: approval persisted, dispatch never began

    const restarted = new DaniKernelRepository(path);
    expect(restarted.reconcileAfterRestart()).toBe(0);
    expect(restarted.effect(String(effect.id)).state).toBe("approved");
    expect(restarted.beginDispatch(String(effect.id), 1).state).toBe("dispatching");
    expect(() => restarted.beginDispatch(String(effect.id), 1)).toThrow("cannot dispatch");
    restarted.close();
  });

  it("suppresses retry when external success was persisted but inspection had not run", () => {
    const repo = repository();
    const path = repo.path;
    const job = admitted(repo);
    const effect = proposed(repo, String(job.id));
    approve(repo, String(effect.id));
    repo.beginDispatch(String(effect.id), 1);
    repo.markExternalResult(String(effect.id), 1, "external-success-1");
    repo.close(); // crash point: external success persisted, adapter inspection missing

    const restarted = new DaniKernelRepository(path);
    expect(restarted.reconcileAfterRestart()).toBe(1);
    expect(restarted.effect(String(effect.id))).toMatchObject({ state: "uncertain", external_reference: "external-success-1" });
    expect(() => restarted.beginDispatch(String(effect.id), 1)).toThrow();
    restarted.close();
  });

  it("does not allow a second dispatch while a prior attempt or retry is unresolved", () => {
    const repo = repository();
    const job = admitted(repo);
    const effect = proposed(repo, String(job.id));
    approve(repo, String(effect.id));
    repo.beginDispatch(String(effect.id), 1);
    expect(() => repo.beginDispatch(String(effect.id), 1)).toThrow("cannot dispatch");
    repo.close();
  });

  it("never retries a crash after dispatch and requires adapter evidence to complete", () => {
    const repo = repository();
    const path = repo.path;
    const job = admitted(repo);
    const effect = proposed(repo, String(job.id));
    approve(repo, String(effect.id));
    repo.beginDispatch(String(effect.id), 1); // crash point: after dispatch marker, before persisted result
    repo.close();

    const restarted = new DaniKernelRepository(path);
    expect(restarted.reconcileAfterRestart()).toBe(1);
    expect(restarted.effect(String(effect.id)).state).toBe("uncertain");
    expect(restarted.job(String(job.id)).status).toBe("uncertain");
    expect(() => restarted.beginDispatch(String(effect.id), 1)).toThrow();
    expect(restarted.reconcileAfterRestart()).toBe(0);
    restarted.close();
  });

  it("does not accept model prose as completion evidence", () => {
    const repo = repository();
    const job = admitted(repo);
    const effect = proposed(repo, String(job.id));
    approve(repo, String(effect.id));
    repo.beginDispatch(String(effect.id), 1);
    repo.markExternalResult(String(effect.id), 1, "receipt-42");
    expect(() => repo.completeEffect(String(effect.id), 1)).toThrow("adapter evidence required");
    expect(() => repo.recordAdapterEvidence({
      effectId: String(effect.id), adapter: "hermes", sourceTimestamp: new Date().toISOString(),
      sourceReference: "model text", inspection: { claim: "done" },
    })).toThrow("does not match");
    repo.recordAdapterEvidence({
      effectId: String(effect.id), adapter: "browser", sourceTimestamp: new Date().toISOString(),
      sourceReference: "https://example.test/receipt/42", inspection: { submitted: true },
    });
    repo.completeEffect(String(effect.id), 1);
    expect(repo.job(String(job.id)).status).toBe("completed");
    repo.close();
  });

  it("creates a consistent backup before migrating an existing database", () => {
    const root = mkdtempSync(join(tmpdir(), "dani-kernel-old-"));
    roots.push(root);
    const path = join(root, "kernel.sqlite");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('keep-me'); PRAGMA user_version=0");
    old.close();
    const repo = new DaniKernelRepository(path);
    expect(repo.backupPath).not.toBeNull();
    expect(existsSync(String(repo.backupPath))).toBe(true);
    const backup = new DatabaseSync(String(repo.backupPath));
    expect((backup.prepare("SELECT value FROM legacy").get() as { value: string }).value).toBe("keep-me");
    backup.close();
    repo.close();
  });

  it("fails closed instead of downgrading a newer database", () => {
    const root = mkdtempSync(join(tmpdir(), "dani-kernel-new-"));
    roots.push(root);
    const path = join(root, "kernel.sqlite");
    const future = new DatabaseSync(path);
    future.exec("PRAGMA user_version=99");
    future.close();
    expect(() => new DaniKernelRepository(path)).toThrow("newer than supported");
  });
});
