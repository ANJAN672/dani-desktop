import { randomUUID } from "node:crypto";
import { nextQuietEnd, validateQuietHours, withinQuietHours } from "../dani-policy.ts";
import { DaniKernelRepository } from "./repository.ts";
import type { ProactiveTriggerInput } from "./types.ts";

type QueueRow = { id: string; owner_id: string; bot_id: string; trigger_key: string; proposal_json: string; not_before: string; state: string; suppression_reason: string | null; proposal_id: string | null };
export type TriggerEvaluation =
  | { state: "proposed"; proposalId: string; duplicate: boolean }
  | { state: "queued"; queueId: string; duplicate: boolean; notBefore: string }
  | { state: "suppressed"; reason: string; duplicate: boolean };

/** Serving-path trigger boundary. It normalizes all sources into the kernel's
 * proposal ledger and durably parks quiet-hour work in that same database. */
export class ProactiveTriggerEvaluator {
  private readonly repository: DaniKernelRepository;
  constructor(repository: DaniKernelRepository) { this.repository = repository; }

  fireSchedule(input: Omit<ProactiveTriggerInput, "triggerSource">, at = new Date()) {
    return this.evaluate({ ...input, triggerSource: "schedule" }, at);
  }
  fireRoutine(input: Omit<ProactiveTriggerInput, "triggerSource">, at = new Date()) {
    return this.evaluate({ ...input, triggerSource: "routine" }, at);
  }
  fireInAppEvent(input: Omit<ProactiveTriggerInput, "triggerSource">, at = new Date()) {
    return this.evaluate({ ...input, triggerSource: "in-app-event" }, at);
  }

  evaluate(input: ProactiveTriggerInput, at = new Date()): TriggerEvaluation {
    if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error("trigger occurredAt is invalid");
    if (Date.parse(input.expiresAt) <= at.getTime()) return { state: "suppressed", reason: "expired", duplicate: false };
    const existingProposal = this.repository.db.prepare("SELECT id FROM kernel_proposals WHERE owner_id=? AND bot_id=? AND trigger_key=?")
      .get(input.ownerId, input.botId, input.triggerKey) as { id: string } | undefined;
    if (existingProposal) return { state: "proposed", proposalId: existingProposal.id, duplicate: true };
    const existingQueue = this.repository.db.prepare("SELECT * FROM kernel_proactive_queue WHERE owner_id=? AND bot_id=? AND trigger_key=?")
      .get(input.ownerId, input.botId, input.triggerKey) as QueueRow | undefined;
    if (existingQueue) {
      if (existingQueue.proposal_id) return { state: "proposed", proposalId: existingQueue.proposal_id, duplicate: true };
      if (existingQueue.state === "queued") return { state: "queued", queueId: existingQueue.id, duplicate: true, notBefore: existingQueue.not_before };
      return { state: "suppressed", reason: existingQueue.suppression_reason ?? "suppressed", duplicate: true };
    }
    const preferences = this.repository.proactivePreferences(input.ownerId, input.botId);
    if (preferences.autonomy === "off") return this.rememberSuppression(input, "autonomy-off", at);
    const quiet = preferences.quietHours;
    if (quiet) {
      const valid = validateQuietHours(quiet);
      if (!valid.ok) return this.rememberSuppression(input, `invalid-quiet-hours:${valid.reason}`, at);
      if (withinQuietHours(at, quiet)) return this.queue(input, nextQuietEnd(at, quiet), at);
    }
    return this.propose(input, at);
  }

  releaseDue(at = new Date()): TriggerEvaluation[] {
    this.repository.releaseSnoozedProposals(at);
    const rows = this.repository.db.prepare("SELECT * FROM kernel_proactive_queue WHERE state='queued' AND not_before<=? ORDER BY created_at,id")
      .all(at.toISOString()) as QueueRow[];
    return rows.map(row => {
      const input = JSON.parse(row.proposal_json) as ProactiveTriggerInput;
      if (Date.parse(input.expiresAt) <= at.getTime()) {
        this.repository.db.prepare("UPDATE kernel_proactive_queue SET state='suppressed',suppression_reason='expired',updated_at=? WHERE id=? AND state='queued'")
          .run(at.toISOString(), row.id);
        return { state: "suppressed", reason: "expired", duplicate: false };
      }
      const result = this.propose(input, at);
      if (result.state === "proposed") {
        this.repository.db.prepare("UPDATE kernel_proactive_queue SET state='released',proposal_id=?,updated_at=? WHERE id=? AND state='queued'")
          .run(result.proposalId, at.toISOString(), row.id);
      } else if (result.state === "suppressed") {
        this.repository.db.prepare("UPDATE kernel_proactive_queue SET state='suppressed',suppression_reason=?,updated_at=? WHERE id=? AND state='queued'")
          .run(result.reason, at.toISOString(), row.id);
      }
      return result;
    });
  }

  nextReleaseAt(): string | null {
    const row = this.repository.db.prepare("SELECT MIN(not_before) at FROM kernel_proactive_queue WHERE state='queued'").get() as { at: string | null };
    return row.at;
  }

  private propose(input: ProactiveTriggerInput, at: Date): TriggerEvaluation {
    const created = this.repository.createProactiveProposal({ ...input, createdAt: at.toISOString() });
    if (!created.proposal) return this.rememberSuppression(input, created.suppressed ?? "suppressed", at);
    return { state: "proposed", proposalId: created.proposal.id, duplicate: created.duplicate };
  }

  private queue(input: ProactiveTriggerInput, notBefore: Date, at: Date): TriggerEvaluation {
    const id = randomUUID();
    this.repository.db.prepare(`INSERT OR IGNORE INTO kernel_proactive_queue(
      id,owner_id,bot_id,trigger_key,proposal_json,not_before,state,suppression_reason,proposal_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'queued',NULL,NULL,?,?)`).run(
      id, input.ownerId, input.botId, input.triggerKey, JSON.stringify(input), notBefore.toISOString(), at.toISOString(), at.toISOString(),
    );
    const row = this.repository.db.prepare("SELECT * FROM kernel_proactive_queue WHERE owner_id=? AND bot_id=? AND trigger_key=?")
      .get(input.ownerId, input.botId, input.triggerKey) as QueueRow;
    return { state: "queued", queueId: row.id, duplicate: row.id !== id, notBefore: row.not_before };
  }

  private rememberSuppression(input: ProactiveTriggerInput, reason: string, at: Date): TriggerEvaluation {
    this.repository.db.prepare(`INSERT OR IGNORE INTO kernel_proactive_queue(
      id,owner_id,bot_id,trigger_key,proposal_json,not_before,state,suppression_reason,proposal_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'suppressed',?,NULL,?,?)`).run(
      randomUUID(), input.ownerId, input.botId, input.triggerKey, JSON.stringify(input), at.toISOString(), reason, at.toISOString(), at.toISOString(),
    );
    return { state: "suppressed", reason, duplicate: false };
  }
}
