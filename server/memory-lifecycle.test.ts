import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MemorySidecar } from "./memory-sidecar.ts";

const roots: string[] = [];
const closables: { close(): void }[] = [];
// Close every SQLite handle before directory removal; Windows refuses to delete open files.
afterEach(() => {
  for (const c of closables.splice(0)) { try { c.close(); } catch { /* already closed */ } }
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
});
const open = (name = "m.db") => { const root = mkdtempSync(join(tmpdir(), "mem-lc-")); roots.push(root); const sidecar = new MemorySidecar(join(root, name)); closables.push(sidecar); return { sidecar, path: join(root, name) }; };
const src = (id: string, observedAt = "2026-09-01T00:00:00Z") => ({ type: "message", id, observedAt });

describe("memory lifecycle", () => {
  it("isolates owners and workspaces on identical keys", () => {
    const { sidecar: m } = open();
    m.write({ ownerId: "a", workspaceId: "w1", kind: "profile", key: "drink", value: "tea", source: src("1"), confidence: 0.9 });
    m.write({ ownerId: "a", workspaceId: "w2", kind: "profile", key: "drink", value: "coffee", source: src("2"), confidence: 0.9 });
    m.write({ ownerId: "b", workspaceId: "w1", kind: "profile", key: "drink", value: "water", source: src("3"), confidence: 0.9 });
    expect(m.search("a", "drink", { workspaceId: "w1" })[0]?.value).toBe("tea");
    expect(m.search("a", "drink", { workspaceId: "w2" })[0]?.value).toBe("coffee");
    expect(m.search("b", "drink", { workspaceId: "w1" })[0]?.value).toBe("water");
    expect(m.context("a", "drink", 4000, { workspaceId: "w1" })).not.toContain("water");
    m.close();
  });

  it("rejects source-less writes", () => {
    const { sidecar: m } = open();
    expect(() => m.write({ ownerId: "a", kind: "fact", key: "k", value: "v", source: { type: "", id: "", observedAt: "" }, confidence: 1 })).toThrow(/source/);
    expect(() => m.write({ ownerId: "a", kind: "fact", key: "k", value: "v", source: { type: "message", id: "1", observedAt: "not-a-date" }, confidence: 1 })).toThrow(/source/);
    m.close();
  });

  it("explicit correction supersedes a higher-confidence derived value and keeps history", () => {
    const { sidecar: m } = open();
    const oldId = m.write({ ownerId: "a", kind: "profile", key: "city", value: "Mumbai", source: src("1"), confidence: 0.95 });
    const newId = m.correct({ ownerId: "a", kind: "profile", key: "city", value: "Pune", source: src("2"), confidence: 0.4 });
    const result = m.search("a", "city");
    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe("Pune");
    expect(m.historyOf(oldId).some(h => h.type === "correction" && h.detail.supersededBy === newId)).toBe(true);
    expect(m.historyOf(newId).some(h => h.type === "correction" && h.detail.corrects === oldId)).toBe(true);
    m.close();
  });

  it("retracts a poisoned source and restores the best surviving value", () => {
    const { sidecar: m } = open();
    m.write({ ownerId: "a", kind: "fact", key: "timezone", value: "IST", source: src("good"), confidence: 0.6 });
    m.write({ ownerId: "a", kind: "fact", key: "timezone", value: "PST", source: src("bad"), confidence: 0.9 });
    expect(m.search("a", "timezone")[0]?.value).toBe("PST");
    expect(m.retractSource("a", { type: "message", id: "bad" })).toBe(1);
    const result = m.search("a", "timezone");
    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe("IST");
    expect(result[0]?.provenance.some(p => p.source_id === "bad")).toBe(false);
    m.close();
  });

  it("targeted forget removes the item, its FTS row and its provenance", () => {
    const { sidecar: m, path } = open();
    m.write({ ownerId: "a", kind: "person", key: "sam", value: "tennis friend", source: src("1"), confidence: 0.8 });
    m.write({ ownerId: "a", kind: "person", key: "maya", value: "neighbor", source: src("2"), confidence: 0.8 });
    expect(m.forget({ ownerId: "a", kind: "person", key: "sam" })).toBe(1);
    expect(m.search("a", "sam")).toHaveLength(0);
    expect(m.search("a", "maya")).toHaveLength(1);
    const db = new DatabaseSync(path); closables.push(db);
    expect(db.prepare("SELECT COUNT(*) c FROM memory_provenance").get() as { c: number }).toEqual({ c: 1 });
    db.close();
    m.close();
  });

  it("owner-wide delete clears every workspace without touching other owners", () => {
    const { sidecar: m } = open();
    m.write({ ownerId: "a", workspaceId: "w1", kind: "fact", key: "k1", value: 1, source: src("1"), confidence: 1 });
    m.write({ ownerId: "a", workspaceId: "w2", kind: "fact", key: "k2", value: 2, source: src("2"), confidence: 1 });
    m.write({ ownerId: "b", kind: "fact", key: "k3", value: 3, source: src("3"), confidence: 1 });
    expect(m.forgetOwner("a")).toBe(2);
    expect(m.search("a", "k1")).toHaveLength(0);
    expect(m.search("b", "k3")).toHaveLength(1);
    m.close();
  });

  it("expires retained items and survives a one-month restart with a deterministic clock", () => {
    const { sidecar: m, path } = open();
    m.write({ ownerId: "a", kind: "recap", key: "week", value: "summary", source: src("1"), confidence: 0.5, expiresAt: "2026-10-01T00:00:00Z" });
    m.close();
    const reopened = new MemorySidecar(path); closables.push(reopened);
    expect(reopened.sweepExpired("2026-09-30T00:00:00Z")).toBe(0);
    expect(reopened.search("a", "summary")).toHaveLength(1);
    expect(reopened.sweepExpired("2026-10-02T00:00:00Z")).toBe(1);
    expect(reopened.search("a", "summary")).toHaveLength(0);
    reopened.close();
  });

  it("stale memory may orient but never satisfies a current-state read", () => {
    const { sidecar: m } = open();
    m.write({ ownerId: "a", kind: "fact", key: "balance", value: 42, source: src("1", "2026-09-01T00:00:00Z"), confidence: 1, freshForMs: 60_000 });
    const fresh = m.current("a", "balance", { now: new Date("2026-09-01T00:00:30Z") });
    expect(fresh.status).toBe("fresh");
    const stale = m.current("a", "balance", { now: new Date("2026-09-01T00:02:00Z") });
    expect(stale.status).toBe("stale");
    expect(stale.requiresRefresh).toBe(true);
    const hit = m.search("a", "balance", { now: new Date("2026-09-01T00:02:00Z") })[0];
    expect(hit?.stale).toBe(true);
    expect(hit?.requiresRefresh).toBe(true);
    expect(m.search("a", "balance", { now: new Date("2026-09-01T00:02:00Z"), includeStale: false })).toHaveLength(0);
    expect(m.context("a", "balance", 4000, { now: new Date("2026-09-01T00:02:00Z") })).toContain("STALE");
    expect(m.current("a", "missing-key").status).toBe("missing");
    m.close();
  });

  it("versions procedural workflow memory separately from derived user memory", () => {
    const { sidecar: m } = open();
    m.write({ ownerId: "a", kind: "procedure", key: "deploy", value: { step: 1 }, source: src("1"), confidence: 1, category: "workflow" });
    m.write({ ownerId: "a", kind: "procedure", key: "deploy", value: { step: 2 }, source: src("2"), confidence: 1, category: "workflow" });
    const result = m.search("a", "deploy");
    expect(result).toHaveLength(1);
    expect(result[0]?.value).toEqual({ step: 2 });
    m.close();
  });

  it("persists items across close and reopen", () => {
    const { sidecar: m, path } = open();
    m.write({ ownerId: "a", kind: "profile", key: "name", value: "Somdipto", source: src("1"), confidence: 1 });
    m.close();
    const reopened = new MemorySidecar(path); closables.push(reopened);
    expect(reopened.search("a", "name")[0]?.value).toBe("Somdipto");
    reopened.close();
  });
});
