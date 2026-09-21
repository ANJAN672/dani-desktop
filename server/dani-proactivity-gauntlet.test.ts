/**
 * Controlled proactivity failure gauntlet (kit requirement). Each scenario is a
 * named adversarial case; every run must show no duplicate real-world effect,
 * no fabricated success, and honest blocked/deferred states.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaniControlPlane, digestJson } from "./dani-control-plane.ts";
import { DaniProactivity, type ProactiveTriggerRule } from "./dani-proactivity.ts";
import { DaniVerifier } from "./dani-verifier.ts";
import { MemorySidecar } from "./memory-sidecar.ts";
import type { DaniEventInput } from "../shared/dani-runtime.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-"));
  roots.push(root);
  const plane = new DaniControlPlane(join(root, "control.db"));
  const engine = new DaniProactivity(join(root, "proactivity.db"), plane);
  const memory = new MemorySidecar(join(root, "memory.db"));
  const verifier = new DaniVerifier(plane);
  return { root, plane, engine, memory, verifier };
};
const rule = (patch: Partial<ProactiveTriggerRule> = {}): ProactiveTriggerRule => ({
  id: "g1", ownerId: "u", eventType: "mail", consent: true, dedupeWindowMs: 3_600_000, freshnessMs: 3_600_000,
  enabled: true, authorized: true, ...patch,
});
const event = (patch: Partial<DaniEventInput> = {}): DaniEventInput => ({
  ownerId: "u", source: "email", sourceId: `evt-${Math.random()}`, type: "mail",
  occurredAt: new Date().toISOString(), payload: { subject: "hi", urgency: 0.5, confidence: 0.6 }, ...patch,
});

describe("proactivity gauntlet", () => {
  it("G1 duplicate webhook: one evaluation, one notification, zero jobs", () => {
    const { engine, plane } = setup();
    engine.upsertRule(rule());
    const e = event({ sourceId: "hook-1" });
    for (let i = 0; i < 5; i++) engine.handleEvent(e);
    expect(engine.listNotifications("u")).toHaveLength(1);
    expect(plane.db.prepare("SELECT COUNT(*) c FROM dani_jobs").get()).toEqual({ c: 0 });
  });

  it("G2 out-of-order and stale events are quarantined, a fresh later event still works", () => {
    const { engine } = setup();
    engine.upsertRule(rule());
    const now = Date.now();
    expect(engine.handleEvent(event({ sourceId: "a", occurredAt: new Date(now).toISOString() })).fires[0]?.status).toBe("fired");
    expect(engine.handleEvent(event({ sourceId: "b", occurredAt: new Date(now - 10_000).toISOString() })).fires[0]).toMatchObject({ status: "skipped", reason: "out-of-order" });
    expect(engine.handleEvent(event({ sourceId: "c", occurredAt: new Date(now - 86_400_000).toISOString() })).fires[0]).toMatchObject({ status: "skipped", reason: "stale-event" });
    expect(engine.handleEvent(event({ sourceId: "d", occurredAt: new Date(now + 5_000).toISOString(), payload: { subject: "fresh" } })).fires[0]?.status).toBe("fired");
  });

  it("G3 stale memory cannot satisfy a current-state read", () => {
    const { memory } = setup();
    memory.write({ ownerId: "u", kind: "fact", key: "server-status", value: "healthy", source: { type: "probe", id: "p1", observedAt: "2026-08-01T00:00:00Z" }, confidence: 1, freshForMs: 86_400_000 });
    const read = memory.current("u", "server-status", { now: new Date("2026-09-21T00:00:00Z") });
    expect(read.status).toBe("stale");
    expect(read.requiresRefresh).toBe(true);
  });

  it("G4 cross-owner access is denied by isolation on memory, rules and notifications", () => {
    const { engine, memory } = setup();
    memory.write({ ownerId: "u", kind: "profile", key: "secret", value: "s3cret", source: { type: "message", id: "1", observedAt: "2026-09-01T00:00:00Z" }, confidence: 1 });
    expect(memory.search("other", "secret")).toHaveLength(0);
    engine.upsertRule(rule({ ownerId: "u" }));
    const res = engine.handleEvent(event({ ownerId: "other" }));
    expect(res.fires).toHaveLength(0);
    expect(engine.listNotifications("other")).toHaveLength(0);
  });

  it("G5 a forget request is honored end to end", () => {
    const { memory } = setup();
    memory.write({ ownerId: "u", kind: "person", key: "ex", value: "details", source: { type: "message", id: "1", observedAt: "2026-09-01T00:00:00Z" }, confidence: 1 });
    expect(memory.forget({ ownerId: "u", key: "ex" })).toBe(1);
    expect(memory.search("u", "details")).toHaveLength(0);
    expect(memory.current("u", "ex").status).toBe("missing");
  });

  it("G6 revoked consent silences the trigger from the next event", () => {
    const { engine } = setup();
    engine.upsertRule(rule());
    expect(engine.handleEvent(event()).fires[0]?.status).toBe("fired");
    engine.upsertRule(rule({ consent: false }));
    const res = engine.handleEvent(event({ payload: { subject: "after revocation" } }));
    expect(res.fires[0]).toMatchObject({ status: "skipped", level: "silent" });
    expect(engine.auditLog("g1").some(l => l.kind === "initiative.decided" && l.detail.reasons.includes("no-consent"))).toBe(true);
  });

  it("G7 quiet-hour storm defers and coalesces instead of notifying", () => {
    const { engine } = setup();
    engine.upsertRule(rule({ quietHours: { timezone: "Asia/Calcutta", start: "22:00", end: "07:00" } }));
    const quietNow = new Date("2026-09-20T17:00:00Z"); // 22:30 IST
    for (let i = 0; i < 50; i++) engine.handleEvent(event({ payload: { subject: `storm-${i}` } }), { now: quietNow });
    expect(engine.listNotifications("u")).toHaveLength(0);
    // The notification budget (default 5) caps the storm even before coalescing.
    expect(engine.auditLog("g1").filter(l => l.kind === "initiative.decided" && l.detail.reasons.includes("rate-budget"))).toHaveLength(45);
    engine.releaseDeferred(new Date("2026-09-21T01:30:00Z")); // 07:00 IST
    expect(engine.listNotifications("u")).toHaveLength(1);
    expect(engine.listNotifications("u")[0]?.payload.coalesced).toBe(5);
  });

  it("G8 crash between dispatch and receipt recovers exactly one job", () => {
    const { root, plane } = setup();
    class Crashy extends DaniProactivity {
      protected override dispatchAct(): string { throw new Error("power loss"); }
    }
    const crashy = new Crashy(join(root, "proactivity.db"), plane);
    crashy.upsertRule(rule({ risk: "write", objective: "recover me" }));
    expect(() => crashy.handleEvent(event({ payload: { urgency: 0.9, confidence: 0.9, relevant: true } }))).toThrow("power loss");
    crashy.close();
    const recovered = new DaniProactivity(join(root, "proactivity.db"), plane);
    expect(recovered.recover().dispatchedJobs).toHaveLength(1);
    expect(recovered.recover().dispatchedJobs).toHaveLength(0);
    expect(plane.db.prepare("SELECT COUNT(*) c FROM dani_jobs").get()).toEqual({ c: 1 });
  });

  it("G9 sleeping or disconnected target reports blocked, never fabricated success", () => {
    const { plane, verifier } = setup();
    const job = plane.createJob({ ownerId: "u", objective: "desktop task", successCriteria: ["file-downloaded"] });
    const jobId = String(job.id);
    const createdAt = Date.parse(String((job as Record<string, unknown>).created_at));
    verifier.recordEvidence({ jobId, kind: "external_read", source: "desktop", observedAt: new Date(createdAt + 1000).toISOString(), observation: { criterion: "file-downloaded", ok: true }, digest: digestJson({ criterion: "file-downloaded", ok: true }) });
    const result = verifier.verifyJob(jobId, { now: new Date(createdAt + 60_000), sourceHealth: { desktop: "unreachable" } });
    expect(result.status).toBe("unverified");
    expect(result.criteria[0]?.status).toBe("blocked");
    expect(verifier.assertSucceedable(jobId, { now: new Date(createdAt + 60_000), sourceHealth: { desktop: "unreachable" } })).toMatchObject({ ok: false });
  });

  it("G10 verifier outage (no evidence, unreachable sources) holds success back", () => {
    const { plane, verifier } = setup();
    const jobId = String(plane.createJob({ ownerId: "u", objective: "verify me", successCriteria: ["confirmed"] }).id);
    expect(verifier.verifyJob(jobId).status).toBe("unverified");
    expect(verifier.verifyJob(jobId).criteria[0]?.status).toBe("missing");
  });
});
