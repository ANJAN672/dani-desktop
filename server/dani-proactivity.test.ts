import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaniControlPlane } from "./dani-control-plane.ts";
import { DaniProactivity, type ProactiveTriggerRule } from "./dani-proactivity.ts";
import type { DaniEventInput } from "../shared/dani-runtime.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
const setup = (relevanceProbe?: () => boolean) => {
  const root = mkdtempSync(join(tmpdir(), "proact-"));
  roots.push(root);
  const plane = new DaniControlPlane(join(root, "control.db"));
  const engine = new DaniProactivity(join(root, "proactivity.db"), plane, relevanceProbe ? () => relevanceProbe() : undefined);
  return { root, plane, engine };
};
const rule = (patch: Partial<ProactiveTriggerRule> = {}): ProactiveTriggerRule => ({
  id: "r1", ownerId: "u", eventType: "mail", consent: true, dedupeWindowMs: 3_600_000, freshnessMs: 3_600_000,
  enabled: true, authorized: true, ...patch,
});
const event = (patch: Partial<DaniEventInput> = {}): DaniEventInput => ({
  ownerId: "u", source: "email", sourceId: `evt-${Math.random()}`, type: "mail",
  occurredAt: new Date().toISOString(), payload: { subject: "hello", urgency: 0.5, confidence: 0.6 }, ...patch,
});

describe("event normalization and dispatch", () => {
  it("evaluates a duplicate event exactly once", () => {
    const { engine } = setup();
    engine.upsertRule(rule());
    const e = event({ sourceId: "evt-1" });
    const first = engine.handleEvent(e);
    expect(first.duplicate).toBe(false);
    expect(first.fires).toHaveLength(1);
    const second = engine.handleEvent(e);
    expect(second.duplicate).toBe(true);
    expect(second.fires).toHaveLength(0);
    expect(engine.listNotifications("u")).toHaveLength(1);
  });

  it("surfaces a changed payload under the same sourceId as a conflict", () => {
    const { engine } = setup();
    engine.upsertRule(rule());
    engine.handleEvent(event({ sourceId: "evt-1", payload: { subject: "a" } }));
    const res = engine.handleEvent(event({ sourceId: "evt-1", payload: { subject: "b" } }));
    expect(res.duplicate).toBe(true);
    expect(res.conflict).toBe(true);
    expect(engine.auditLog().some(l => l.kind === "event.conflict")).toBe(true);
  });

  it("quarantines out-of-order events and skips stale events", () => {
    const { engine } = setup();
    engine.upsertRule(rule());
    const now = Date.now();
    engine.handleEvent(event({ sourceId: "new", occurredAt: new Date(now).toISOString() }));
    const outOfOrder = engine.handleEvent(event({ sourceId: "old", occurredAt: new Date(now - 60_000).toISOString() }));
    expect(outOfOrder.fires[0]).toMatchObject({ status: "skipped", reason: "out-of-order" });
    const stale = engine.handleEvent(event({ sourceId: "stale", occurredAt: new Date(now - 7_200_000).toISOString() }));
    expect(stale.fires[0]).toMatchObject({ status: "skipped", reason: "stale-event" });
  });

  it("never fires disabled or unauthorized triggers", () => {
    const { engine } = setup();
    engine.upsertRule(rule({ id: "disabled", enabled: false }));
    engine.upsertRule(rule({ id: "unauth", authorized: false }));
    const res = engine.handleEvent(event());
    expect(res.fires).toHaveLength(1);
    expect(res.fires[0]).toMatchObject({ ruleId: "unauth", status: "skipped", reason: "unauthorized" });
    expect(engine.listNotifications("u")).toHaveLength(0);
  });

  it("keeps persisted rules across restart", () => {
    const { root, plane } = setup();
    const first = new DaniProactivity(join(root, "proactivity.db"), plane);
    first.upsertRule(rule({ topic: "persisted" }));
    first.close();
    const second = new DaniProactivity(join(root, "proactivity.db"), plane);
    expect(second.getRule("r1")?.topic).toBe("persisted");
    const res = second.handleEvent(event());
    expect(res.fires[0]?.status).toBe("fired");
  });

  it("recovers a crash between fire and dispatch exactly once", () => {
    const { root, plane } = setup();
    class CrashyEngine extends DaniProactivity {
      protected override dispatchAct(): string { throw new Error("crash after fire"); }
    }
    const crashy = new CrashyEngine(join(root, "proactivity.db"), plane);
    crashy.upsertRule(rule({ risk: "write", objective: "follow up", successCriteria: ["done"] }));
    expect(() => crashy.handleEvent(event({ payload: { urgency: 0.9, confidence: 0.9, relevant: true } }))).toThrow("crash after fire");
    crashy.close();
    const recovered = new DaniProactivity(join(root, "proactivity.db"), plane);
    const sweep = recovered.recover();
    expect(sweep.dispatchedJobs).toHaveLength(1);
    expect(plane.job(sweep.dispatchedJobs[0]!).objective).toBe("follow up");
    expect(recovered.recover().dispatchedJobs).toHaveLength(0);
  });

  it("dispatches act jobs only after a fresh relevance recheck", () => {
    const { engine, plane } = setup(() => false);
    engine.upsertRule(rule({ risk: "write", objective: "act on it" }));
    const res = engine.handleEvent(event({ payload: { urgency: 0.9, confidence: 0.9, relevant: true } }));
    expect(res.fires[0]).toMatchObject({ status: "skipped", reason: "relevance-lost" });
    expect(plane.db.prepare("SELECT COUNT(*) c FROM dani_jobs").get()).toEqual({ c: 0 });
  });

  it("creates a broker-gated job for urgent relevant write-risk events", () => {
    const { engine, plane } = setup();
    engine.upsertRule(rule({ risk: "write", objective: "reply to client", successCriteria: ["sent"] }));
    const res = engine.handleEvent(event({ payload: { urgency: 0.9, confidence: 0.9, relevant: true } }));
    expect(res.fires[0]).toMatchObject({ level: "act", status: "fired" });
    const job = plane.job(res.fires[0]!.jobId!);
    expect(job.objective).toBe("reply to client");
    expect(engine.auditLog("r1").some(l => l.kind === "initiative.decided" && l.detail.requiresBrokerApproval === true)).toBe(true);
  });
});

describe("quiet hours, budgets and storms", () => {
  const quietRule = (patch: Partial<ProactiveTriggerRule> = {}) => rule({
    quietHours: { timezone: "Asia/Calcutta", start: "22:00", end: "07:00" }, ...patch,
  });
  // 2026-09-20T17:00:00Z is 22:30 IST: inside quiet hours.
  const quietNow = new Date("2026-09-20T17:00:00Z");
  const quietEnd = new Date("2026-09-21T01:30:00Z"); // 07:00 IST

  it("defers informs during quiet hours and releases one coalesced notification once", () => {
    const { engine } = setup();
    engine.upsertRule(quietRule());
    for (let i = 0; i < 3; i++) engine.handleEvent(event({ payload: { subject: `s${i}` } }), { now: quietNow });
    expect(engine.listNotifications("u")).toHaveLength(0);
    const released = engine.releaseDeferred(quietEnd);
    expect(released).toHaveLength(1);
    const notes = engine.listNotifications("u");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload.coalesced).toBe(3);
    expect(engine.releaseDeferred(new Date("2026-09-21T02:00:00Z"))).toHaveLength(0);
    expect(engine.listNotifications("u")).toHaveLength(1);
  });

  it("fails closed on invalid quiet-hours config", () => {
    const { engine } = setup();
    engine.upsertRule(rule({ quietHours: { timezone: "Not/AZone", start: "22:00", end: "07:00" } }));
    const res = engine.handleEvent(event());
    expect(res.fires[0]?.status).toBe("deferred");
    expect(engine.auditLog("r1").some(l => l.kind === "initiative.decided" && String(l.detail.reasons).includes("invalid-quiet-hours"))).toBe(true);
  });

  it("audits explicit urgent overrides during quiet hours", () => {
    const { engine, plane } = setup();
    engine.upsertRule(quietRule({ urgentOverride: true, risk: "write", objective: "urgent thing" }));
    const res = engine.handleEvent(event({ payload: { urgency: 0.95, confidence: 0.9, relevant: true } }), { now: quietNow });
    expect(res.fires[0]).toMatchObject({ level: "act", status: "fired" });
    expect(plane.db.prepare("SELECT COUNT(*) c FROM dani_jobs").get()).toEqual({ c: 1 });
    expect(engine.auditLog("r1").some(l => l.kind === "quiet.urgent-override")).toBe(true);
  });

  it("caps notifications at the configured budget", () => {
    const { engine } = setup();
    engine.upsertRule(rule({ notificationBudget: 2 }));
    for (let i = 0; i < 5; i++) engine.handleEvent(event({ payload: { subject: `n${i}` } }));
    expect(engine.listNotifications("u")).toHaveLength(2);
  });

  it("keeps 100 duplicates to one fire and 100 low-novelty heartbeats silent", () => {
    const { engine, plane } = setup();
    engine.upsertRule(rule());
    const dup = event({ sourceId: "evt-dup" });
    for (let i = 0; i < 100; i++) engine.handleEvent(dup);
    expect(engine.listNotifications("u")).toHaveLength(1);
    for (let i = 0; i < 100; i++) engine.handleEvent(event({ sourceId: `hb-${i}`, payload: { heartbeat: true } }));
    // The first novel heartbeat informs once; the remaining 99 identical payloads are suppressed as low-novelty.
    expect(engine.listNotifications("u")).toHaveLength(2);
    expect(plane.db.prepare("SELECT COUNT(*) c FROM dani_jobs").get()).toEqual({ c: 0 });
    expect(engine.auditLog("r1").filter(l => l.kind === "initiative.decided" && l.detail.reasons.includes("low-novelty"))).toHaveLength(99);
  });
});
