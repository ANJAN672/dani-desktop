import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaniKernelRepository } from "./repository.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const open = () => { const root = mkdtempSync(join(tmpdir(), "dani-proposals-")); roots.push(root); return { root, repo: new DaniKernelRepository(join(root, "kernel.sqlite")) }; };
const proposal = (repo: DaniKernelRepository, key = "schedule:2026-09-22T09:00Z", kind = "daily-brief") => repo.createProactiveProposal({
  ownerId: "owner-1", botId: "bot-1", threadId: "thread-1", triggerSource: "schedule", triggerKey: key,
  triggerKind: kind, reason: "Your daily brief is ready", objective: "Review today's schedule",
  evidenceReferences: ["calendar:event:1"], expiresAt: "2999-01-01T00:00:00Z",
});

describe("kernel proactive proposal ledger", () => {
  it("defaults to suggest-only and deduplicates one proposal across restart", () => {
    const { root, repo } = open();
    expect(repo.proactivePreferences("owner-1", "bot-1").autonomy).toBe("suggest-only");
    repo.setProactivePreferences({ ownerId: "owner-1", botId: "bot-1", autonomy: "suggest-only", proposalLimit: 1, proposalWindowMs: 3_600_000 });
    const first = proposal(repo); expect(first.duplicate).toBe(false); repo.close();
    const restarted = new DaniKernelRepository(join(root, "kernel.sqlite"));
    const duplicate = proposal(restarted); expect(duplicate.duplicate).toBe(true);
    expect(restarted.listProactiveProposals("owner-1")).toHaveLength(1); restarted.close();
  });

  it("accepts through the kernel job ledger atomically and idempotently", () => {
    const { repo } = open(); const created = proposal(repo).proposal!;
    const accepted = repo.acceptProactiveProposal(created.id, "owner-1");
    expect(accepted).toMatchObject({ duplicate: false, proposal: { status: "accepted" }, job: { status: "admitted", owner_id: "owner-1" } });
    expect(repo.acceptProactiveProposal(created.id, "owner-1")).toMatchObject({ duplicate: true, job: { id: accepted.job.id } });
    expect(repo.db.prepare("SELECT kind,detail_json FROM kernel_events WHERE job_id=?").get(String(accepted.job.id))).toMatchObject({ kind: "job.admitted" });
    repo.close();
  });

  it("never creates a job on suggestion, snooze, dismiss, off mode, or stale acceptance", () => {
    const { repo } = open(); const created = proposal(repo).proposal!;
    expect(repo.db.prepare("SELECT COUNT(*) c FROM kernel_jobs").get()).toEqual({ c: 0 });
    repo.snoozeProactiveProposal(created.id, "owner-1", "2998-01-01T00:00:00Z");
    expect(proposal(repo, "snoozed-equivalent", "daily-brief")).toMatchObject({ proposal: null, suppressed: "snoozed-kind" });
    repo.dismissProactiveProposal(created.id, "owner-1");
    expect(repo.db.prepare("SELECT COUNT(*) c FROM kernel_jobs").get()).toEqual({ c: 0 });
    expect(proposal(repo, "next", "daily-brief")).toMatchObject({ proposal: null, suppressed: "dismissed-kind" });
    repo.setProactivePreferences({ ownerId: "owner-1", botId: "bot-2", autonomy: "off", proposalLimit: 5, proposalWindowMs: 3_600_000 });
    expect(repo.createProactiveProposal({ ownerId: "owner-1", botId: "bot-2", threadId: "thread-1", triggerSource: "in-app-event", triggerKey: "x", triggerKind: "x", reason: "x", objective: "x", expiresAt: "2999-01-01T00:00:00Z" })).toMatchObject({ proposal: null, suppressed: "autonomy-off" });
    repo.close();
  });

  it("enforces owner isolation, reason/source provenance, expiry, and rate limits", () => {
    const { repo } = open();
    repo.setProactivePreferences({ ownerId: "owner-1", botId: "bot-1", autonomy: "act-with-approval", proposalLimit: 1, proposalWindowMs: 3_600_000 });
    const created = proposal(repo).proposal!;
    expect(created).toMatchObject({ reason: "Your daily brief is ready", triggerSource: "schedule", evidenceReferences: ["calendar:event:1"] });
    expect(() => repo.proactiveProposal(created.id, "owner-2")).toThrow("not found");
    expect(proposal(repo, "second", "other")).toMatchObject({ proposal: null, suppressed: "rate-limit" });
    expect(() => repo.createProactiveProposal({ ownerId: "owner-1", botId: "bot-x", threadId: "t", triggerSource: "routine", triggerKey: "expired", triggerKind: "x", reason: "old", objective: "old", expiresAt: "2000-01-01T00:00:00Z" })).toThrow("expired");
    repo.close();
  });

  it("backs up and migrates a v1 kernel without losing jobs", () => {
    const { root, repo } = open(); repo.admitJob({ ownerId: "owner-1", objective: "old", originatingRequestId: "old", turnId: "old", provider: "hermes", threadId: "old" });
    repo.db.exec("DROP TABLE kernel_proactive_queue; DROP TABLE kernel_proposals; DROP TABLE kernel_proactive_preferences; PRAGMA user_version=1"); repo.close();
    const migrated = new DaniKernelRepository(join(root, "kernel.sqlite"));
    expect(migrated.backupPath && existsSync(migrated.backupPath)).toBe(true);
    expect(migrated.db.prepare("SELECT COUNT(*) c FROM kernel_jobs").get()).toEqual({ c: 1 });
    expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    migrated.close();
  });
});
