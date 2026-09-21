import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaniKernelRepository } from "./repository.ts";
import { kernelDiagnostic, redactKernelDetail } from "./diagnostics.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe("kernel diagnostics", () => {
  it("exposes terminal state and inspectable adapter evidence without normalized inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "dani-diagnostic-")); roots.push(root);
    const repo = new DaniKernelRepository(join(root, "kernel.sqlite"));
    const job = repo.admitJob({ ownerId: "user-1", objective: "private prompt body", originatingRequestId: "request-1", turnId: "turn-1", provider: "hermes", threadId: "thread-1" });
    const effect = repo.proposeEffect({ jobId: String(job.id), generation: 1, idempotencyKey: "key-1", adapter: "browser", normalizedInput: { password: "never expose", click: "submit" }, risk: "read", resource: "receipt", audience: null });
    repo.beginDispatch(String(effect.id), 1);
    repo.markExternalResult(String(effect.id), 1, "receipt-1");
    repo.recordAdapterEvidence({ effectId: String(effect.id), adapter: "browser", sourceTimestamp: "2026-09-21T00:00:00Z", sourceReference: "https://example.test/receipt/1", inspection: { ok: true, token: "hidden" } });
    repo.completeEffect(String(effect.id), 1);
    const diagnostic = kernelDiagnostic(repo, String(job.id));
    expect(diagnostic.job).toMatchObject({ status: "completed", provider: "hermes", turnId: "turn-1" });
    expect(diagnostic.effects[0]).toMatchObject({ state: "completed", externalReference: "receipt-1", evidence: [{ sourceReference: "https://example.test/receipt/1", inspection: { ok: true, token: "[redacted]" } }] });
    expect(JSON.stringify(diagnostic)).not.toContain("never expose");
    expect(JSON.stringify(diagnostic)).not.toContain("private prompt body");
    repo.close();
  });

  it("redacts nested secret-like keys while preserving useful metrics", () => {
    expect(redactKernelDetail({ token: "x", nested: { password: "y", attempt: 2 }, metrics: [{ toolCalls: 1 }] })).toEqual({
      token: "[redacted]", nested: { password: "[redacted]", attempt: 2 }, metrics: [{ toolCalls: 1 }],
    });
  });
});
