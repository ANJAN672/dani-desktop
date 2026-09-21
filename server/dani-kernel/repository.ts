import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdapterEvidenceInput, AdmitJobInput, ApprovalGrantInput, KernelEffectState, KernelJobStatus, ProactivePreferencesInput, ProactiveProposalInput, ProposeEffectInput } from "./types.ts";

const SCHEMA_VERSION = 2;
const TERMINAL_JOB_STATES = new Set<KernelJobStatus>(["completed", "failed", "cancelled", "uncertain"]);
const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    : value;
const encode = (value: unknown) => JSON.stringify(canonical(value));
export const kernelDigest = (value: unknown) => createHash("sha256").update(encode(value)).digest("hex");
const now = () => new Date().toISOString();
const quoteSqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
export type KernelRow = Record<string, unknown> & { id: string };
type Row = KernelRow;

export class DaniKernelRepository {
  readonly db: DatabaseSync;
  readonly backupPath: string | null;

  readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    const existed = existsSync(path);
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`Dani kernel database version ${version} is newer than supported version ${SCHEMA_VERSION}`);
    }
    if (existed && version < SCHEMA_VERSION) {
      this.backupPath = `${path}.pre-v${version}-to-v${SCHEMA_VERSION}-${Date.now()}.sqlite`;
      this.db.exec(`VACUUM INTO ${quoteSqlString(this.backupPath)}`);
    } else {
      this.backupPath = null;
    }
    this.migrate(version);
  }

  private migrate(fromVersion: number) {
    if (fromVersion < 1) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE kernel_jobs(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, objective TEXT NOT NULL,
          originating_request_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL DEFAULT 1, provider TEXT NOT NULL,
          thread_id TEXT NOT NULL, provider_cursor TEXT,
          cancellation_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(owner_id, originating_request_id)
        );
        CREATE TABLE kernel_effects(
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES kernel_jobs(id),
          generation INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
          adapter TEXT NOT NULL, normalized_input TEXT NOT NULL,
          input_digest TEXT NOT NULL, risk_class TEXT NOT NULL,
          resource TEXT NOT NULL, audience TEXT, state TEXT NOT NULL,
          approval_id TEXT, external_reference TEXT, error TEXT,
          dispatch_started_at TEXT, completed_at TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(job_id, idempotency_key)
        );
        CREATE TABLE kernel_approvals(
          id TEXT PRIMARY KEY, effect_id TEXT NOT NULL UNIQUE REFERENCES kernel_effects(id),
          user_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
          audience TEXT, limits_json TEXT NOT NULL, expires_at TEXT NOT NULL,
          originating_request_id TEXT NOT NULL, decision TEXT NOT NULL,
          decided_at TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE kernel_evidence(
          id TEXT PRIMARY KEY, effect_id TEXT NOT NULL REFERENCES kernel_effects(id),
          authored_by TEXT NOT NULL CHECK(authored_by='adapter'), adapter TEXT NOT NULL,
          source_timestamp TEXT NOT NULL, source_reference TEXT NOT NULL,
          inspection_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(effect_id, digest)
        );
        CREATE TABLE kernel_events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES kernel_jobs(id),
          effect_id TEXT, kind TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX kernel_jobs_status ON kernel_jobs(status, updated_at);
        CREATE INDEX kernel_effects_recovery ON kernel_effects(state, updated_at);
        PRAGMA user_version=1;
        COMMIT;`);
    }
    if (fromVersion < 2) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE kernel_proactive_preferences(
          owner_id TEXT NOT NULL, bot_id TEXT NOT NULL,
          autonomy TEXT NOT NULL CHECK(autonomy IN ('off','suggest-only','act-with-approval')),
          quiet_hours_json TEXT, proposal_limit INTEGER NOT NULL,
          proposal_window_ms INTEGER NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(owner_id,bot_id)
        );
        CREATE TABLE kernel_proposals(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, bot_id TEXT NOT NULL,
          thread_id TEXT NOT NULL, trigger_source TEXT NOT NULL,
          trigger_key TEXT NOT NULL, trigger_kind TEXT NOT NULL,
          reason TEXT NOT NULL, objective TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL, expires_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','snoozed','dismissed','accepted','expired')),
          snoozed_until TEXT, accepted_job_id TEXT REFERENCES kernel_jobs(id),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(owner_id,bot_id,trigger_key)
        );
        CREATE INDEX kernel_proposals_inbox ON kernel_proposals(owner_id,thread_id,status,created_at);
        CREATE INDEX kernel_proposals_equivalent ON kernel_proposals(owner_id,bot_id,trigger_kind,status,updated_at);
        PRAGMA user_version=2;
        COMMIT;`);
    }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  }

  close() { this.db.close(); }

  private event(jobId: string, effectId: string | null, kind: string, detail: unknown) {
    this.db.prepare("INSERT INTO kernel_events(job_id,effect_id,kind,detail_json,created_at) VALUES(?,?,?,?,?)")
      .run(jobId, effectId, kind, encode(detail), now());
  }

  admitJob(input: AdmitJobInput) {
    const existing = this.db.prepare("SELECT * FROM kernel_jobs WHERE owner_id=? AND originating_request_id=?")
      .get(input.ownerId, input.originatingRequestId) as Row | undefined;
    if (existing) return { ...existing, id: String(existing.id), generation: Number(existing.generation), duplicate: true };
    const id = randomUUID();
    const at = now();
    this.db.prepare(`INSERT INTO kernel_jobs(
      id,owner_id,objective,originating_request_id,turn_id,status,attempt,generation,
      provider,thread_id,provider_cursor,created_at,updated_at
    ) VALUES(?,?,?,?,?,'admitted',0,1,?,?,?,?,?)`).run(
      id, input.ownerId, input.objective, input.originatingRequestId, input.turnId,
      input.provider, input.threadId, input.providerCursor ?? null, at, at,
    );
    this.event(id, null, "job.admitted", { turnId: input.turnId, provider: input.provider });
    return { ...this.job(id), id, generation: 1, duplicate: false };
  }


  setProactivePreferences(input: ProactivePreferencesInput) {
    if (!Number.isInteger(input.proposalLimit) || input.proposalLimit < 1 || input.proposalLimit > 100) throw new Error("proposal limit must be an integer from 1 to 100");
    if (!Number.isInteger(input.proposalWindowMs) || input.proposalWindowMs < 60_000) throw new Error("proposal window must be at least one minute");
    const at = now();
    this.db.prepare(`INSERT INTO kernel_proactive_preferences(owner_id,bot_id,autonomy,quiet_hours_json,proposal_limit,proposal_window_ms,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,bot_id) DO UPDATE SET autonomy=excluded.autonomy,quiet_hours_json=excluded.quiet_hours_json,
      proposal_limit=excluded.proposal_limit,proposal_window_ms=excluded.proposal_window_ms,updated_at=excluded.updated_at`).run(
      input.ownerId, input.botId, input.autonomy, input.quietHours ? encode(input.quietHours) : null,
      input.proposalLimit, input.proposalWindowMs, at,
    );
    return this.proactivePreferences(input.ownerId, input.botId);
  }

  proactivePreferences(ownerId: string, botId: string) {
    const row = this.db.prepare("SELECT * FROM kernel_proactive_preferences WHERE owner_id=? AND bot_id=?").get(ownerId, botId) as Row | undefined;
    return row ? {
      ownerId, botId, autonomy: String(row.autonomy), quietHours: row.quiet_hours_json ? JSON.parse(String(row.quiet_hours_json)) : null,
      proposalLimit: Number(row.proposal_limit), proposalWindowMs: Number(row.proposal_window_ms), updatedAt: String(row.updated_at),
    } : { ownerId, botId, autonomy: "suggest-only", quietHours: null, proposalLimit: 5, proposalWindowMs: 3_600_000, updatedAt: null };
  }

  createProactiveProposal(input: ProactiveProposalInput) {
    const reason = input.reason.trim();
    if (!reason) throw new Error("proposal reason is required");
    if (!input.triggerKey.trim() || !input.triggerKind.trim()) throw new Error("proposal trigger identity is required");
    if (Date.parse(input.expiresAt) <= Date.now()) throw new Error("proposal is already expired");
    const preferences = this.proactivePreferences(input.ownerId, input.botId);
    if (preferences.autonomy === "off") return { proposal: null, suppressed: "autonomy-off", duplicate: false } as const;
    const existing = this.db.prepare("SELECT * FROM kernel_proposals WHERE owner_id=? AND bot_id=? AND trigger_key=?")
      .get(input.ownerId, input.botId, input.triggerKey) as Row | undefined;
    if (existing) return { proposal: this.decodeProposal(existing), suppressed: null, duplicate: true } as const;
    const suppressedKind = this.db.prepare(`SELECT status FROM kernel_proposals WHERE owner_id=? AND bot_id=? AND trigger_kind=?
      AND (status='dismissed' OR (status='snoozed' AND snoozed_until>?)) LIMIT 1`)
      .get(input.ownerId, input.botId, input.triggerKind, now()) as { status: string } | undefined;
    if (suppressedKind) return { proposal: null, suppressed: `${suppressedKind.status}-kind`, duplicate: false } as const;
    const at = input.createdAt ?? now();
    const since = new Date(Date.parse(at) - Number(preferences.proposalWindowMs)).toISOString();
    const count = Number((this.db.prepare(`SELECT COUNT(*) c FROM kernel_proposals WHERE owner_id=? AND bot_id=? AND created_at>=? AND status!='expired'`)
      .get(input.ownerId, input.botId, since) as { c: number }).c);
    if (count >= Number(preferences.proposalLimit)) return { proposal: null, suppressed: "rate-limit", duplicate: false } as const;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO kernel_proposals(id,owner_id,bot_id,thread_id,trigger_source,trigger_key,trigger_kind,reason,objective,
      evidence_refs_json,expires_at,status,snoozed_until,accepted_job_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,?,?)`).run(
      id, input.ownerId, input.botId, input.threadId, input.triggerSource, input.triggerKey, input.triggerKind, reason,
      input.objective, encode(input.evidenceReferences ?? []), input.expiresAt, at, at,
    );
    return { proposal: this.proactiveProposal(id, input.ownerId), suppressed: null, duplicate: false } as const;
  }

  private decodeProposal(row: Row) {
    return {
      id: String(row.id), ownerId: String(row.owner_id), botId: String(row.bot_id), threadId: String(row.thread_id),
      triggerSource: String(row.trigger_source), triggerKey: String(row.trigger_key), triggerKind: String(row.trigger_kind),
      reason: String(row.reason), objective: String(row.objective), evidenceReferences: JSON.parse(String(row.evidence_refs_json)),
      expiresAt: String(row.expires_at), status: String(row.status), snoozedUntil: row.snoozed_until ? String(row.snoozed_until) : null,
      acceptedJobId: row.accepted_job_id ? String(row.accepted_job_id) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  proactiveProposal(id: string, ownerId: string) {
    const row = this.db.prepare("SELECT * FROM kernel_proposals WHERE id=? AND owner_id=?").get(id, ownerId) as Row | undefined;
    if (!row) throw new Error("proactive proposal not found");
    return this.decodeProposal(row);
  }

  listProactiveProposals(ownerId: string, threadId?: string) {
    const rows = (threadId
      ? this.db.prepare("SELECT * FROM kernel_proposals WHERE owner_id=? AND thread_id=? ORDER BY created_at,id").all(ownerId, threadId)
      : this.db.prepare("SELECT * FROM kernel_proposals WHERE owner_id=? ORDER BY created_at,id").all(ownerId)) as Row[];
    return rows.map(row => this.decodeProposal(row));
  }

  snoozeProactiveProposal(id: string, ownerId: string, until: string) {
    if (Date.parse(until) <= Date.now()) throw new Error("snooze must end in the future");
    const changed = this.db.prepare("UPDATE kernel_proposals SET status='snoozed',snoozed_until=?,updated_at=? WHERE id=? AND owner_id=? AND status='pending'")
      .run(until, now(), id, ownerId);
    if (changed.changes !== 1) throw new Error("proposal is not pending");
    return this.proactiveProposal(id, ownerId);
  }

  dismissProactiveProposal(id: string, ownerId: string) {
    const changed = this.db.prepare("UPDATE kernel_proposals SET status='dismissed',updated_at=? WHERE id=? AND owner_id=? AND status IN ('pending','snoozed')")
      .run(now(), id, ownerId);
    if (changed.changes !== 1) throw new Error("proposal cannot be dismissed");
    return this.proactiveProposal(id, ownerId);
  }

  releaseSnoozedProposals(at = new Date()) {
    return Number(this.db.prepare("UPDATE kernel_proposals SET status='pending',snoozed_until=NULL,updated_at=? WHERE status='snoozed' AND snoozed_until<=?")
      .run(at.toISOString(), at.toISOString()).changes);
  }

  acceptProactiveProposal(id: string, ownerId: string) {
    const proposal = this.proactiveProposal(id, ownerId);
    if (proposal.status === "accepted" && proposal.acceptedJobId) return { proposal, job: this.job(proposal.acceptedJobId), duplicate: true };
    if (proposal.status !== "pending") throw new Error(`proposal cannot be accepted from ${proposal.status}`);
    if (proposal.expiresAt <= now()) {
      this.db.prepare("UPDATE kernel_proposals SET status='expired',updated_at=? WHERE id=?").run(now(), id);
      throw new Error("proposal expired");
    }
    const preferences = this.proactivePreferences(ownerId, proposal.botId);
    if (preferences.autonomy === "off") throw new Error("proactive autonomy is off");
    const jobId = randomUUID();
    const at = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO kernel_jobs(id,owner_id,objective,originating_request_id,turn_id,status,attempt,generation,provider,thread_id,provider_cursor,created_at,updated_at)
        VALUES(?,?,?,?,?,'admitted',0,1,'hermes',?,NULL,?,?)`).run(jobId, ownerId, proposal.objective, `proposal:${id}`, `proposal:${id}`, proposal.threadId, at, at);
      const changed = this.db.prepare("UPDATE kernel_proposals SET status='accepted',accepted_job_id=?,updated_at=? WHERE id=? AND owner_id=? AND status='pending'")
        .run(jobId, at, id, ownerId);
      if (changed.changes !== 1) throw new Error("proposal acceptance raced");
      this.event(jobId, null, "job.admitted", { turnId: `proposal:${id}`, provider: "hermes", proactiveProposalId: id });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { proposal: this.proactiveProposal(id, ownerId), job: this.job(jobId), duplicate: false };
  }

  latestJobForThread(threadId: string): KernelRow | null {
    const row = this.db.prepare("SELECT * FROM kernel_jobs WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").get(threadId) as Row | undefined;
    return row ? { ...row, id: String(row.id) } : null;
  }

  job(id: string): KernelRow {
    const row = this.db.prepare("SELECT * FROM kernel_jobs WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("kernel job not found");
    return { ...row, id: String(row.id) };
  }

  effect(id: string): KernelRow {
    const row = this.db.prepare("SELECT * FROM kernel_effects WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("kernel effect not found");
    return { ...row, id: String(row.id) };
  }

  beginTurn(jobId: string, generation: number, providerCursor?: string | null) {
    const result = this.db.prepare(`UPDATE kernel_jobs SET status='running',attempt=attempt+1,
      provider_cursor=COALESCE(?,provider_cursor),updated_at=?
      WHERE id=? AND generation=? AND status IN ('admitted','running')`)
      .run(providerCursor ?? null, now(), jobId, generation);
    if (result.changes !== 1) throw new Error("stale or non-runnable job generation");
    this.event(jobId, null, "provider.call", { generation });
    return this.job(jobId);
  }

  proposeEffect(input: ProposeEffectInput) {
    const job = this.job(input.jobId);
    if (Number(job.generation) !== input.generation || !["admitted", "running"].includes(String(job.status))) {
      throw new Error("stale or non-runnable job generation");
    }
    const digest = kernelDigest(input.normalizedInput);
    const existing = this.db.prepare("SELECT * FROM kernel_effects WHERE job_id=? AND idempotency_key=?")
      .get(input.jobId, input.idempotencyKey) as Row | undefined;
    if (existing) {
      if (String(existing.input_digest) !== digest || String(existing.adapter) !== input.adapter || String(existing.resource) !== input.resource) {
        throw new Error("idempotency key conflicts with a different effect");
      }
      return { ...existing, id: String(existing.id), duplicate: true };
    }
    const id = randomUUID();
    const at = now();
    this.db.prepare(`INSERT INTO kernel_effects(
      id,job_id,generation,idempotency_key,adapter,normalized_input,input_digest,risk_class,
      resource,audience,state,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,'proposed',?,?)`).run(
      id, input.jobId, input.generation, input.idempotencyKey, input.adapter,
      encode(input.normalizedInput), digest, input.risk, input.resource, input.audience ?? null, at, at,
    );
    this.event(input.jobId, id, "effect.proposed", { adapter: input.adapter, risk: input.risk, digest });
    return { ...this.effect(id), id, duplicate: false };
  }

  recordApproval(input: ApprovalGrantInput) {
    const effect = this.effect(input.effectId);
    const job = this.job(String(effect.job_id));
    if (String(job.owner_id) !== input.userId) throw new Error("approval user does not own job");
    if (String(job.originating_request_id) !== input.originatingRequestId) throw new Error("approval is not bound to the originating request");
    if (String(effect.resource) !== input.resource || String(effect.audience ?? "") !== String(input.audience ?? "")) {
      throw new Error("approval resource or audience does not match effect");
    }
    if (Date.parse(input.expiresAt) <= Date.now()) throw new Error("approval is already expired");
    if (this.db.prepare("SELECT id FROM kernel_approvals WHERE effect_id=?").get(input.effectId)) throw new Error("approval already recorded");
    const id = randomUUID();
    const at = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO kernel_approvals(
        id,effect_id,user_id,scope,resource,audience,limits_json,expires_at,
        originating_request_id,decision,decided_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.effectId, input.userId, input.scope, input.resource, input.audience ?? null,
        encode(input.limits), input.expiresAt, input.originatingRequestId, input.decision, at, at,
      );
      const state: KernelEffectState = input.decision === "approved" ? "approved" : "denied";
      const changed = this.db.prepare("UPDATE kernel_effects SET approval_id=?,state=?,updated_at=? WHERE id=? AND state='proposed'")
        .run(id, state, at, input.effectId);
      if (changed.changes !== 1) throw new Error("effect is no longer awaiting approval");
      this.db.prepare("UPDATE kernel_jobs SET status=?,updated_at=? WHERE id=?")
        .run(input.decision === "approved" ? "running" : "failed", at, String(effect.job_id));
      this.event(String(effect.job_id), input.effectId, `approval.${input.decision}`, { approvalId: id, scope: input.scope });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, decision: input.decision };
  }

  beginDispatch(effectId: string, generation: number) {
    const effect = this.effect(effectId);
    const job = this.job(String(effect.job_id));
    if (Number(job.generation) !== generation || Number(effect.generation) !== generation) throw new Error("stale cancellation generation");
    if (TERMINAL_JOB_STATES.has(String(job.status) as KernelJobStatus)) throw new Error(`job is ${job.status}`);
    const approval = effect.approval_id
      ? this.db.prepare("SELECT * FROM kernel_approvals WHERE id=?").get(String(effect.approval_id)) as Row | undefined
      : undefined;
    if (String(effect.risk_class) !== "read") {
      if (!approval || approval.decision !== "approved" || String(approval.expires_at) <= now()) throw new Error("valid approval required before dispatch");
    }
    const at = now();
    const result = this.db.prepare(`UPDATE kernel_effects SET state='dispatching',dispatch_started_at=?,updated_at=?
      WHERE id=? AND state IN ('proposed','approved')`).run(at, at, effectId);
    if (result.changes !== 1) throw new Error(`effect cannot dispatch from ${effect.state}`);
    this.event(String(effect.job_id), effectId, "effect.dispatching", { generation });
    return this.effect(effectId);
  }

  markExternalResult(effectId: string, generation: number, externalReference: string) {
    const effect = this.effect(effectId);
    const job = this.job(String(effect.job_id));
    if (Number(job.generation) !== generation || Number(effect.generation) !== generation) throw new Error("stale cancellation generation");
    const result = this.db.prepare("UPDATE kernel_effects SET state='verifying',external_reference=?,updated_at=? WHERE id=? AND state='dispatching'")
      .run(externalReference, now(), effectId);
    if (result.changes !== 1) throw new Error("effect is not awaiting an external result");
    this.db.prepare("UPDATE kernel_jobs SET status='verifying',updated_at=? WHERE id=?").run(now(), String(effect.job_id));
    return this.effect(effectId);
  }

  markDispatchUncertain(effectId: string, generation: number, reason: string) {
    const effect = this.effect(effectId);
    const job = this.job(String(effect.job_id));
    if (Number(job.generation) !== generation || Number(effect.generation) !== generation) throw new Error("stale cancellation generation");
    const at = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare("UPDATE kernel_effects SET state='uncertain',error=?,updated_at=? WHERE id=? AND state IN ('dispatching','verifying')")
        .run(reason, at, effectId);
      if (changed.changes !== 1) throw new Error("effect is not in an uncertain dispatch window");
      this.db.prepare("UPDATE kernel_jobs SET status='uncertain',updated_at=? WHERE id=? AND status!='cancelled'").run(at, String(effect.job_id));
      this.event(String(effect.job_id), effectId, "effect.uncertain", { reason, retrySuppressed: true });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resumeUncertainForInspection(effectId: string, generation: number, externalReference: string) {
    const effect = this.effect(effectId);
    const job = this.job(String(effect.job_id));
    if (Number(job.generation) !== generation || Number(effect.generation) !== generation) throw new Error("stale cancellation generation");
    const at = now();
    const changed = this.db.prepare("UPDATE kernel_effects SET state='verifying',external_reference=?,error=NULL,updated_at=? WHERE id=? AND state='uncertain'")
      .run(externalReference, at, effectId);
    if (changed.changes !== 1) throw new Error("effect is not uncertain");
    this.db.prepare("UPDATE kernel_jobs SET status='verifying',updated_at=? WHERE id=? AND status='uncertain'").run(at, String(effect.job_id));
    this.event(String(effect.job_id), effectId, "recovery.effect_reconciled", { externalReference });
  }

  recordAdapterEvidence(input: AdapterEvidenceInput) {
    const effect = this.effect(input.effectId);
    if (String(effect.adapter) !== input.adapter) throw new Error("evidence adapter does not match effect adapter");
    if (String(effect.state) !== "verifying") throw new Error("effect is not ready for inspection evidence");
    if (!input.sourceReference.trim()) throw new Error("inspectable source reference required");
    const digest = kernelDigest({ adapter: input.adapter, sourceTimestamp: input.sourceTimestamp, sourceReference: input.sourceReference, inspection: input.inspection });
    const id = randomUUID();
    this.db.prepare(`INSERT OR IGNORE INTO kernel_evidence(
      id,effect_id,authored_by,adapter,source_timestamp,source_reference,inspection_json,digest,created_at
    ) VALUES(?,?,'adapter',?,?,?,?,?,?)`).run(
      id, input.effectId, input.adapter, input.sourceTimestamp, input.sourceReference,
      encode(input.inspection), digest, now(),
    );
    this.event(String(effect.job_id), input.effectId, "evidence.inspected", { adapter: input.adapter, sourceReference: input.sourceReference, digest });
    return { id, digest };
  }

  completeEffect(effectId: string, generation: number) {
    const effect = this.effect(effectId);
    const job = this.job(String(effect.job_id));
    if (Number(job.generation) !== generation) throw new Error("stale cancellation generation");
    const evidence = this.db.prepare("SELECT id FROM kernel_evidence WHERE effect_id=? LIMIT 1").get(effectId);
    if (!evidence) throw new Error("adapter evidence required before completion");
    const at = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare("UPDATE kernel_effects SET state='completed',completed_at=?,updated_at=? WHERE id=? AND state='verifying'")
        .run(at, at, effectId);
      if (changed.changes !== 1) throw new Error("effect is not verifiable");
      this.db.prepare("UPDATE kernel_jobs SET status='completed',updated_at=? WHERE id=? AND generation=? AND status='verifying'")
        .run(at, String(effect.job_id), generation);
      this.event(String(effect.job_id), effectId, "effect.completed", { evidenceId: (evidence as Row).id });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishProviderTurn(jobId: string, generation: number, outcome: "completed" | "failed", providerCursor?: string | null) {
    const job = this.job(jobId);
    if (Number(job.generation) !== generation) throw new Error("stale cancellation generation");
    const at = now();
    const nextStatus = outcome === "completed" ? "running" : "failed";
    const result = this.db.prepare(`UPDATE kernel_jobs SET status=?,provider_cursor=COALESCE(?,provider_cursor),updated_at=?
      WHERE id=? AND generation=? AND status='running'`).run(nextStatus, providerCursor ?? null, at, jobId, generation);
    if (result.changes === 1) this.event(jobId, null, `provider.${outcome}`, { generation });
    return this.job(jobId);
  }

  cancelJob(jobId: string, reason: string) {
    const at = now();
    const result = this.db.prepare(`UPDATE kernel_jobs SET status='cancelled',generation=generation+1,
      cancellation_reason=?,updated_at=? WHERE id=? AND status NOT IN ('completed','failed','cancelled','uncertain')`)
      .run(reason, at, jobId);
    if (result.changes) this.event(jobId, null, "job.cancelled", { reason });
    return this.job(jobId);
  }

  reconcileAfterRestart() {
    const uncertain = this.db.prepare("SELECT id,job_id FROM kernel_effects WHERE state IN ('dispatching','verifying')").all() as { id: string; job_id: string }[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const effect of uncertain) {
        const at = now();
        this.db.prepare("UPDATE kernel_effects SET state='uncertain',error='restart during or after external dispatch; inspect before retry',updated_at=? WHERE id=?")
          .run(at, effect.id);
        this.db.prepare("UPDATE kernel_jobs SET status='uncertain',updated_at=? WHERE id=? AND status!='cancelled'").run(at, effect.job_id);
        this.event(effect.job_id, effect.id, "recovery.effect_uncertain", { retrySuppressed: true });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return uncertain.length;
  }
}
