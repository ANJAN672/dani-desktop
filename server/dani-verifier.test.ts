import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaniControlPlane, digestJson } from "./dani-control-plane.ts";
import { DaniVerifier } from "./dani-verifier.ts";
import type { DaniEvidenceInput } from "../shared/dani-runtime.ts";

const roots: string[] = [];
const closables: { close(): void }[] = [];
// Close every SQLite handle before directory removal; Windows refuses to delete open files.
afterEach(() => {
  for (const c of closables.splice(0)) { try { c.close(); } catch { /* already closed */ } }
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "verify-"));
  roots.push(root);
  const plane = new DaniControlPlane(join(root, "control.db"));
  const verifier = new DaniVerifier(plane);
  closables.push(plane);
  return { plane, verifier };
};
const makeJob = (plane: DaniControlPlane, criteria = ["sent"]) => {
  const job = plane.createJob({ ownerId: "u", objective: "do it", successCriteria: criteria });
  const createdAt = Date.parse(String((job as Record<string, unknown>).created_at));
  return { jobId: String(job.id), createdAt, now: new Date(createdAt + 60_000) };
};
const evidence = (jobId: string, createdAt: number, patch: Partial<DaniEvidenceInput> & { observation?: Record<string, unknown> } = {}): DaniEvidenceInput => ({
  jobId, kind: "external_read", source: "desktop", observedAt: new Date(createdAt + 1_000).toISOString(),
  observation: { criterion: "sent", ok: true }, digest: digestJson({ criterion: "sent", ok: true }), ...patch,
});

describe("truthful success verification", () => {
  it("blocks succeeded when no evidence is linked to a criterion", () => {
    const { plane, verifier } = setup();
    const { jobId, now } = makeJob(plane);
    const result = verifier.verifyJob(jobId, { now });
    expect(result.status).toBe("unverified");
    expect(result.criteria[0]).toMatchObject({ status: "missing" });
    expect(verifier.assertSucceedable(jobId, { now })).toMatchObject({ ok: false });
  });

  it("verifies only fresh source-linked positive evidence", () => {
    const { plane, verifier } = setup();
    const { jobId, createdAt, now } = makeJob(plane);
    verifier.recordEvidence(evidence(jobId, createdAt));
    expect(verifier.verifyJob(jobId, { now }).status).toBe("verified");
    expect(verifier.assertSucceedable(jobId, { now })).toEqual({ ok: true });
  });

  it("rejects stale evidence and evidence recorded before the job existed", () => {
    const { plane, verifier } = setup();
    const { jobId, createdAt, now } = makeJob(plane);
    verifier.recordEvidence(evidence(jobId, createdAt, { observedAt: new Date(createdAt - 600_000).toISOString() })); // recorded before the job existed
    expect(verifier.verifyJob(jobId, { now }).criteria[0]?.status).toBe("stale");
    const second = makeJob(plane, ["sent"]);
    verifier.recordEvidence(evidence(second.jobId, second.createdAt, { observedAt: new Date(second.createdAt + 1_000).toISOString() }));
    expect(verifier.verifyJob(second.jobId, { now: new Date(second.createdAt + 601_000) }).criteria[0]?.status).toBe("stale"); // past the freshness window
  });

  it("rejects contradictory fresh evidence", () => {
    const { plane, verifier } = setup();
    const { jobId, createdAt, now } = makeJob(plane);
    verifier.recordEvidence(evidence(jobId, createdAt));
    verifier.recordEvidence(evidence(jobId, createdAt, { observation: { criterion: "sent", ok: false }, digest: digestJson({ criterion: "sent", ok: false }) }));
    expect(verifier.verifyJob(jobId, { now }).criteria[0]?.status).toBe("contradictory");
  });

  it("treats uncertain and negative evidence truthfully", () => {
    const { plane, verifier } = setup();
    const j1 = makeJob(plane);
    verifier.recordEvidence(evidence(j1.jobId, j1.createdAt, { observation: { criterion: "sent", ok: null }, digest: digestJson({ criterion: "sent", ok: null }) }));
    expect(verifier.verifyJob(j1.jobId, { now: j1.now }).criteria[0]?.status).toBe("uncertain");
    const j2 = makeJob(plane);
    verifier.recordEvidence(evidence(j2.jobId, j2.createdAt, { observation: { criterion: "sent", ok: false }, digest: digestJson({ criterion: "sent", ok: false }) }));
    expect(verifier.verifyJob(j2.jobId, { now: j2.now }).criteria[0]?.status).toBe("negative");
  });

  it("converges duplicate evidence on the canonical row", () => {
    const { plane, verifier } = setup();
    const { jobId, createdAt } = makeJob(plane);
    const first = verifier.recordEvidence(evidence(jobId, createdAt));
    const second = verifier.recordEvidence(evidence(jobId, createdAt));
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ id: first.id, duplicate: true, canonicalId: first.id });
  });

  it("reports an offline or sleeping target as blocked, never success or silent failure", () => {
    const { plane, verifier } = setup();
    const { jobId, createdAt, now } = makeJob(plane);
    verifier.recordEvidence(evidence(jobId, createdAt));
    const result = verifier.verifyJob(jobId, { now, sourceHealth: { desktop: "unreachable" } });
    expect(result.criteria[0]).toMatchObject({ status: "blocked", reason: expect.stringContaining("unreachable") });
    expect(verifier.assertSucceedable(jobId, { now, sourceHealth: { desktop: "unreachable" } })).toMatchObject({ ok: false });
  });

  it("requires explicit opt-in for cloud-sourced evidence", () => {
    const { plane, verifier } = setup();
    const { jobId, createdAt, now } = makeJob(plane);
    verifier.recordEvidence(evidence(jobId, createdAt, { source: "cloud:drive" }));
    expect(verifier.verifyJob(jobId, { now }).criteria[0]?.status).toBe("blocked");
    expect(verifier.verifyJob(jobId, { now, cloudOptIn: true }).status).toBe("verified");
  });

  it("requires every criterion to be verified", () => {
    const { plane, verifier } = setup();
    const { jobId, createdAt, now } = makeJob(plane, ["sent", "archived"]);
    verifier.recordEvidence(evidence(jobId, createdAt));
    const result = verifier.verifyJob(jobId, { now });
    expect(result.status).toBe("unverified");
    expect(result.criteria.map(c => c.status)).toEqual(["verified", "missing"]);
  });
});
