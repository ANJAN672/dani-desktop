import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DaniControlPlane, digestJson } from "./dani-control-plane.ts";
import { decideInitiative, nextQuietEnd, stableTriggerKey, triggerMatches, validateQuietHours, withinQuietHours, type InitiativeLevel } from "./dani-policy.ts";
import type { DaniEventInput } from "../shared/dani-runtime.ts";

export interface ProactiveTriggerRule {
  id: string; ownerId: string; workspaceId?: string; eventType: string;
  predicate?: Record<string, string | number | boolean>;
  consent: boolean; topic?: string;
  risk?: "read" | "write" | "representation" | "money" | "destructive";
  objective?: string; successCriteria?: string[];
  dedupeWindowMs: number; freshnessMs: number;
  quietHours?: { timezone: string; start: string; end: string } | null;
  urgentOverride?: boolean;
  notificationBudget?: number; notificationWindowMs?: number;
  preparable?: boolean;
  enabled: boolean; authorized: boolean;
}
export interface FireRecord { id: string; ruleId: string; level: InitiativeLevel; status: "fired" | "deferred" | "skipped"; reason: string | null; jobId: string | null }

const now = () => new Date().toISOString();
const DEFAULT_WINDOW_MS = 3_600_000, DEFAULT_BUDGET = 5, RECENT_DIGEST_CAP = 50;

/**
 * Persisted trigger registry + event evaluator + quiet-hours dispatcher.
 * Exactly-once: one fire row per (rule, stable event key); act jobs are created by
 * dispatchAct and backfilled by recover() only while job_id is still NULL.
 */
export class DaniProactivity {
  readonly db: DatabaseSync;
  constructor(path: string, private plane: DaniControlPlane, private relevanceProbe?: (rule: ProactiveTriggerRule, event: DaniEventInput) => boolean) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS proactivity_rules(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,event_type TEXT NOT NULL,predicate TEXT,consent INTEGER NOT NULL,topic TEXT,risk TEXT,objective TEXT,success_criteria TEXT,dedupe_window_ms INTEGER NOT NULL,freshness_ms INTEGER NOT NULL,quiet_hours TEXT,urgent_override INTEGER NOT NULL DEFAULT 0,notification_budget INTEGER NOT NULL DEFAULT ${DEFAULT_BUDGET},notification_window_ms INTEGER NOT NULL DEFAULT ${DEFAULT_WINDOW_MS},preparable INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL,authorized INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proactivity_fires(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,event_key TEXT NOT NULL,event_row_id TEXT NOT NULL,level TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,job_id TEXT,created_at TEXT NOT NULL,UNIQUE(rule_id,event_key));
      CREATE TABLE IF NOT EXISTS proactivity_rule_state(rule_id TEXT PRIMARY KEY,last_occurred_at TEXT,recent_digests TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS proactivity_notifications(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,level TEXT NOT NULL,summary TEXT NOT NULL,payload TEXT NOT NULL,fire_id TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proactivity_deferred(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,fire_id TEXT NOT NULL,coalesce_key TEXT NOT NULL,level TEXT NOT NULL,summary TEXT NOT NULL,payload TEXT NOT NULL,not_before TEXT NOT NULL,released INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proactivity_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,rule_id TEXT,kind TEXT NOT NULL,detail TEXT NOT NULL,at TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  private log(ruleId: string | null, kind: string, detail: unknown) {
    this.db.prepare("INSERT INTO proactivity_log(rule_id,kind,detail,at) VALUES(?,?,?,?)").run(ruleId, kind, JSON.stringify(detail), now());
  }

  upsertRule(rule: ProactiveTriggerRule) {
    const at = now(), existing = this.db.prepare("SELECT id FROM proactivity_rules WHERE id=?").get(rule.id);
    const fields = [rule.ownerId, rule.workspaceId ?? "default", rule.eventType, rule.predicate ? JSON.stringify(rule.predicate) : null, rule.consent ? 1 : 0, rule.topic ?? null, rule.risk ?? null, rule.objective ?? null, rule.successCriteria ? JSON.stringify(rule.successCriteria) : null, rule.dedupeWindowMs, rule.freshnessMs, rule.quietHours ? JSON.stringify(rule.quietHours) : null, rule.urgentOverride ? 1 : 0, rule.notificationBudget ?? DEFAULT_BUDGET, rule.notificationWindowMs ?? DEFAULT_WINDOW_MS, rule.preparable ? 1 : 0, rule.enabled ? 1 : 0, rule.authorized ? 1 : 0];
    if (existing) this.db.prepare("UPDATE proactivity_rules SET owner_id=?,workspace_id=?,event_type=?,predicate=?,consent=?,topic=?,risk=?,objective=?,success_criteria=?,dedupe_window_ms=?,freshness_ms=?,quiet_hours=?,urgent_override=?,notification_budget=?,notification_window_ms=?,preparable=?,enabled=?,authorized=?,updated_at=? WHERE id=?").run(...fields as [never], at, rule.id);
    else this.db.prepare("INSERT INTO proactivity_rules VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(rule.id, ...fields as [never], at, at);
    this.log(rule.id, existing ? "rule.updated" : "rule.created", { eventType: rule.eventType, enabled: rule.enabled, authorized: rule.authorized });
    return rule.id;
  }
  getRule(id: string): ProactiveTriggerRule | null {
    const r = this.db.prepare("SELECT * FROM proactivity_rules WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? this.toRule(r) : null;
  }
  listRules(ownerId: string, workspaceId = "default") {
    return (this.db.prepare("SELECT * FROM proactivity_rules WHERE owner_id=? AND workspace_id=? ORDER BY created_at").all(ownerId, workspaceId) as Record<string, unknown>[]).map(r => this.toRule(r));
  }
  deleteRule(id: string) { this.db.prepare("DELETE FROM proactivity_rules WHERE id=?").run(id); this.log(id, "rule.deleted", {}); }
  private toRule(r: Record<string, unknown>): ProactiveTriggerRule {
    return { id: String(r.id), ownerId: String(r.owner_id), workspaceId: String(r.workspace_id), eventType: String(r.event_type), predicate: r.predicate ? JSON.parse(String(r.predicate)) : undefined, consent: r.consent === 1, topic: r.topic ? String(r.topic) : undefined, risk: (r.risk as ProactiveTriggerRule["risk"]) ?? undefined, objective: r.objective ? String(r.objective) : undefined, successCriteria: r.success_criteria ? JSON.parse(String(r.success_criteria)) : undefined, dedupeWindowMs: Number(r.dedupe_window_ms), freshnessMs: Number(r.freshness_ms), quietHours: r.quiet_hours ? JSON.parse(String(r.quiet_hours)) : null, urgentOverride: r.urgent_override === 1, notificationBudget: Number(r.notification_budget), notificationWindowMs: Number(r.notification_window_ms), preparable: r.preparable === 1, enabled: r.enabled === 1, authorized: r.authorized === 1 };
  }

  private ruleState(ruleId: string) {
    this.db.prepare("INSERT OR IGNORE INTO proactivity_rule_state(rule_id,recent_digests) VALUES(?, '[]')").run(ruleId);
    const r = this.db.prepare("SELECT * FROM proactivity_rule_state WHERE rule_id=?").get(ruleId) as { last_occurred_at: string | null; recent_digests: string };
    return { lastOccurredAt: r.last_occurred_at, recentDigests: JSON.parse(r.recent_digests) as string[] };
  }
  private saveRuleState(ruleId: string, lastOccurredAt: string | null, digests: string[]) {
    this.db.prepare("UPDATE proactivity_rule_state SET last_occurred_at=?,recent_digests=? WHERE rule_id=?").run(lastOccurredAt, JSON.stringify(digests.slice(-RECENT_DIGEST_CAP)), ruleId);
  }
  private notificationsInWindow(ownerId: string, windowMs: number, at: Date) {
    const since = new Date(at.getTime() - windowMs).toISOString();
    return Number((this.db.prepare("SELECT COUNT(*) c FROM proactivity_fires f JOIN proactivity_rules r ON r.id=f.rule_id WHERE r.owner_id=? AND f.level IN ('inform','prepare','act') AND f.status IN ('fired','deferred') AND f.created_at>=?").get(ownerId, since) as { c: number }).c);
  }
  private quietActive(rule: ProactiveTriggerRule, at: Date) {
    if (!rule.quietHours) return { active: false, invalid: false };
    const valid = validateQuietHours(rule.quietHours);
    if (!valid.ok) return { active: true, invalid: true, reason: valid.reason };
    return { active: withinQuietHours(at, rule.quietHours), invalid: false };
  }

  private recordFire(ruleId: string, eventKey: string, eventRowId: string, level: InitiativeLevel, status: FireRecord["status"], reason: string | null) {
    const id = randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO proactivity_fires(id,rule_id,event_key,event_row_id,level,status,reason,job_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, ruleId, eventKey, eventRowId, level, status, reason, null, now());
    const row = this.db.prepare("SELECT * FROM proactivity_fires WHERE rule_id=? AND event_key=?").get(ruleId, eventKey) as { id: string };
    return row.id;
  }

  handleEvent(event: DaniEventInput, opts: { now?: Date } = {}) {
    const at = opts.now ?? new Date();
    const ingest = this.plane.ingestEvent(event);
    if (ingest.duplicate) {
      if (ingest.digest !== digestJson(event.payload)) {
        this.log(null, "event.conflict", { source: event.source, sourceId: event.sourceId, storedDigest: ingest.digest, receivedDigest: digestJson(event.payload) });
        return { duplicate: true, conflict: true, eventRowId: ingest.id, fires: [] as FireRecord[] };
      }
      return { duplicate: true, conflict: false, eventRowId: ingest.id, fires: [] as FireRecord[] };
    }
    const fires: FireRecord[] = [];
    const rules = this.listRules(event.ownerId).filter(r => r.enabled && r.eventType === event.type);
    for (const rule of rules) {
      if (!triggerMatches({ id: rule.id, eventType: rule.eventType, predicate: rule.predicate, dedupeWindowMs: rule.dedupeWindowMs, enabled: rule.enabled }, { type: event.type, payload: event.payload })) continue;
      const eventKey = stableTriggerKey(rule.id, { sourceId: event.sourceId, type: event.type, payload: event.payload });
      const skip = (reason: string, level: InitiativeLevel = "silent") => { const id = this.recordFire(rule.id, eventKey, ingest.id, level, "skipped", reason); this.log(rule.id, "fire.skipped", { reason, eventKey }); fires.push({ id, ruleId: rule.id, level, status: "skipped", reason, jobId: null }); };
      if (!rule.authorized) { skip("unauthorized"); continue; }
      if (Date.parse(event.occurredAt) + rule.freshnessMs < at.getTime()) { skip("stale-event"); continue; }
      const state = this.ruleState(rule.id);
      if (state.lastOccurredAt && event.occurredAt < state.lastOccurredAt) { skip("out-of-order"); continue; }
      const existing = this.db.prepare("SELECT id,created_at FROM proactivity_fires WHERE rule_id=? AND event_key=?").get(rule.id, eventKey) as { id: string; created_at: string } | undefined;
      if (existing) { skip("duplicate-window"); continue; }
      const payloadDigest = digestJson(event.payload);
      const novelty = state.recentDigests.includes(payloadDigest) ? 0 : 1;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const urgency = typeof payload.urgency === "number" ? payload.urgency : 0.5;
      const confidence = typeof payload.confidence === "number" ? payload.confidence : 1;
      const relevant = typeof payload.relevant === "boolean" ? payload.relevant : true;
      const quiet = this.quietActive(rule, at);
      let decision = decideInitiative({ consent: rule.consent, novelty, urgency, confidence, risk: rule.risk, notificationsInWindow: this.notificationsInWindow(event.ownerId, rule.notificationWindowMs ?? DEFAULT_WINDOW_MS, at), notificationBudget: rule.notificationBudget ?? DEFAULT_BUDGET, relevantToCurrentTask: relevant, quietHoursActive: quiet.active, urgentOverride: rule.urgentOverride, preparable: rule.preparable });
      if (decision.deferred) {
        // Keep the level the event will have once quiet hours end; the deferral itself is the quiet-hours decision.
        const eventual = decideInitiative({ consent: rule.consent, novelty, urgency, confidence, risk: rule.risk, notificationsInWindow: this.notificationsInWindow(event.ownerId, rule.notificationWindowMs ?? DEFAULT_WINDOW_MS, at), notificationBudget: rule.notificationBudget ?? DEFAULT_BUDGET, relevantToCurrentTask: relevant, quietHoursActive: false, urgentOverride: rule.urgentOverride, preparable: rule.preparable });
        decision = { ...eventual, deferred: true, reasons: [...decision.reasons, ...eventual.reasons] };
      }
      if (quiet.invalid) decision.reasons.push(`invalid-quiet-hours:${quiet.reason}`);
      if (rule.urgentOverride && quiet.active) this.log(rule.id, "quiet.urgent-override", { eventKey });
      this.saveRuleState(rule.id, event.occurredAt, [...state.recentDigests, payloadDigest]);
      this.log(rule.id, "initiative.decided", { eventKey, level: decision.level, reasons: decision.reasons, deferred: decision.deferred, requiresBrokerApproval: decision.requiresBrokerApproval });
      if (decision.level === "silent" && !decision.deferred) { const id = this.recordFire(rule.id, eventKey, ingest.id, "silent", "skipped", decision.reasons.join(",")); fires.push({ id, ruleId: rule.id, level: "silent", status: "skipped", reason: decision.reasons.join(","), jobId: null }); continue; }
      const summary = rule.topic ?? rule.objective ?? `${event.type} event`;
      if (decision.deferred) {
        const fireId = this.recordFire(rule.id, eventKey, ingest.id, decision.level, "deferred", "quiet-hours");
        const notBefore = rule.quietHours && !quiet.invalid ? nextQuietEnd(at, rule.quietHours).toISOString() : new Date(at.getTime() + DEFAULT_WINDOW_MS).toISOString();
        this.db.prepare("INSERT INTO proactivity_deferred(id,rule_id,fire_id,coalesce_key,level,summary,payload,not_before,released,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)").run(randomUUID(), rule.id, fireId, `${rule.id}:${decision.level}`, decision.level, summary, JSON.stringify(event.payload), notBefore, now());
        fires.push({ id: fireId, ruleId: rule.id, level: decision.level, status: "deferred", reason: "quiet-hours", jobId: null });
        continue;
      }
      if (decision.level === "act") {
        if (this.relevanceProbe && !this.relevanceProbe(rule, event)) { skip("relevance-lost", "act"); continue; }
        const fireId = this.recordFire(rule.id, eventKey, ingest.id, "act", "fired", null);
        const jobId = this.dispatchAct(fireId, rule, event);
        fires.push({ id: fireId, ruleId: rule.id, level: "act", status: "fired", reason: null, jobId });
        continue;
      }
      const fireId = this.recordFire(rule.id, eventKey, ingest.id, decision.level, "fired", null);
      this.db.prepare("INSERT INTO proactivity_notifications(id,owner_id,workspace_id,level,summary,payload,fire_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), event.ownerId, rule.workspaceId ?? "default", decision.level, summary, JSON.stringify(event.payload), fireId, now());
      fires.push({ id: fireId, ruleId: rule.id, level: decision.level, status: "fired", reason: null, jobId: null });
    }
    return { duplicate: false, conflict: false, eventRowId: ingest.id, fires };
  }

  /** Creates the act job. Separated so recovery can replay it exactly once. */
  protected dispatchAct(fireId: string, rule: ProactiveTriggerRule, event: DaniEventInput): string {
    const job = this.plane.createJob({ ownerId: event.ownerId, objective: rule.objective ?? `${rule.eventType}: ${rule.topic ?? "proactive follow-up"}`, successCriteria: rule.successCriteria ?? ["completed with source-linked evidence"] });
    this.db.prepare("UPDATE proactivity_fires SET job_id=? WHERE id=? AND job_id IS NULL").run(String(job.id), fireId);
    this.log(rule.id, "job.dispatched", { fireId, jobId: String(job.id), note: "broker authorization still required before any effect" });
    return String(job.id);
  }

  /** Crash/restart sweep: backfill act jobs for fires that never dispatched, release due deferred notifications once. */
  recover(opts: { now?: Date } = {}) {
    const at = opts.now ?? new Date();
    const pending = this.db.prepare("SELECT f.id fire_id, f.rule_id, r.* FROM proactivity_fires f JOIN proactivity_rules r ON r.id=f.rule_id WHERE f.level='act' AND f.status='fired' AND f.job_id IS NULL").all() as Record<string, unknown>[];
    const dispatched: string[] = [];
    for (const row of pending) {
      const rule = this.toRule(row);
      const job = this.plane.createJob({ ownerId: rule.ownerId, objective: rule.objective ?? `${rule.eventType}: ${rule.topic ?? "proactive follow-up"}`, successCriteria: rule.successCriteria ?? ["completed with source-linked evidence"] });
      const res = this.db.prepare("UPDATE proactivity_fires SET job_id=? WHERE id=? AND job_id IS NULL").run(String(job.id), String(row.fire_id));
      if (res.changes) { dispatched.push(String(job.id)); this.log(rule.id, "job.recovered", { fireId: String(row.fire_id), jobId: String(job.id) }); }
    }
    return { dispatchedJobs: dispatched, released: this.releaseDeferred(at) };
  }

  /** Releases deferred items whose quiet window ended. Inform/prepare coalesce into one notification per rule+level; deferred acts re-check relevance and dispatch their job. Every row is released exactly once. */
  releaseDeferred(at: Date) {
    const due = this.db.prepare("SELECT * FROM proactivity_deferred WHERE released=0 AND not_before<=?").all(at.toISOString()) as Record<string, unknown>[];
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of due) {
      const key = String(row.coalesce_key);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const released: string[] = [];
    for (const [key, rows] of groups) {
      const ruleRow = this.db.prepare("SELECT * FROM proactivity_rules WHERE id=?").get(String(rows[0]!.rule_id)) as Record<string, unknown>;
      const rule = this.toRule(ruleRow);
      const level = String(rows[0]!.level);
      if (level === "act") {
        for (const row of rows) {
          const event: DaniEventInput = { ownerId: rule.ownerId, source: "schedule", sourceId: String(row.fire_id), type: rule.eventType, occurredAt: String(row.created_at), payload: JSON.parse(String(row.payload)) };
          if (this.relevanceProbe && !this.relevanceProbe(rule, event)) {
            this.log(rule.id, "deferred.relevance-lost", { fireId: String(row.fire_id) });
          } else {
            const job = this.plane.createJob({ ownerId: rule.ownerId, objective: rule.objective ?? `${rule.eventType}: ${rule.topic ?? "proactive follow-up"}`, successCriteria: rule.successCriteria ?? ["completed with source-linked evidence"] });
            const res = this.db.prepare("UPDATE proactivity_fires SET job_id=?,status='fired' WHERE id=? AND job_id IS NULL").run(String(job.id), String(row.fire_id));
            if (res.changes) this.log(rule.id, "job.dispatched", { fireId: String(row.fire_id), jobId: String(job.id), afterDeferral: true });
          }
        }
      } else {
        const summary = rows.length === 1 ? String(rows[0]!.summary) : `${rows.length} deferred updates on ${rows[0]!.summary}`;
        this.db.prepare("INSERT INTO proactivity_notifications(id,owner_id,workspace_id,level,summary,payload,fire_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), String(ruleRow.owner_id), String(ruleRow.workspace_id), level, summary, JSON.stringify({ coalesced: rows.length, items: rows.map(r => JSON.parse(String(r.payload))) }), String(rows[0]!.fire_id), now());
      }
      for (const row of rows) this.db.prepare("UPDATE proactivity_deferred SET released=1 WHERE id=? AND released=0").run(String(row.id));
      this.log(String(rows[0]!.rule_id), "deferred.released", { coalesceKey: key, count: rows.length });
      released.push(key);
    }
    return released;
  }

  listNotifications(ownerId: string, workspaceId = "default") {
    return (this.db.prepare("SELECT * FROM proactivity_notifications WHERE owner_id=? AND workspace_id=? ORDER BY created_at").all(ownerId, workspaceId) as Record<string, unknown>[]).map(r => ({ id: String(r.id), level: String(r.level), summary: String(r.summary), payload: JSON.parse(String(r.payload)), createdAt: String(r.created_at) }));
  }
  auditLog(ruleId?: string) {
    const rows = ruleId
      ? this.db.prepare("SELECT kind,detail,at FROM proactivity_log WHERE rule_id=? ORDER BY seq").all(ruleId)
      : this.db.prepare("SELECT kind,detail,at FROM proactivity_log ORDER BY seq").all();
    return (rows as Record<string, unknown>[]).map(r => ({ kind: String(r.kind), detail: JSON.parse(String(r.detail)), at: String(r.at) }));
  }
}
