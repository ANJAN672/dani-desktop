import { GoalLedger, type Goal, type Wake } from "./goal-ledger.ts";

export interface GoalEvent {
  ownerId: string;
  goalId: string;
  /** Stable source-specific delivery identity, not a generated ID per HTTP retry. */
  triggerId: string;
  source: "manual" | "schedule" | "webhook" | "task-completed";
  summary: string;
}

export interface GoalOutcome {
  summary: string;
  /** Evidence must be independently checked by the execution adapter. */
  evidence: string[];
  verified: boolean;
  /** A trusted policy, rather than the model, owns the next check. */
  nextWakeAt?: number | null;
}

export interface GoalExecutor {
  authorize(goal: Goal, wake: Wake, event: GoalEvent): Promise<boolean>;
  /** Must enforce tool-specific approvals itself. This high-level check does not grant tool permissions. */
  execute(goal: Goal, wake: Wake, event: GoalEvent): Promise<GoalOutcome>;
}

export type WakeDispatch =
  | { status: "not-run"; reason: "duplicate" | "inactive" }
  | { status: "blocked" | "completed" | "uncertain"; wake: Wake; followUpError?: string };

/** Coordinates one wake without owning a second agent loop or second scheduler. */
export class GoalAutopilot {
  constructor(private readonly ledger: GoalLedger, private readonly executor: GoalExecutor) {}

  async dispatch(event: GoalEvent): Promise<WakeDispatch> {
    if (!event.summary.trim() || event.summary.length > 4_000) throw new Error("Invalid event summary");
    const goal = this.ledger.get(event.ownerId, event.goalId);
    if (!goal || goal.status !== "active") return { status: "not-run", reason: "inactive" };
    const wake = this.ledger.enqueue(event.ownerId, goal.id, event.triggerId);
    const claim = this.ledger.claim(event.ownerId, goal.id, wake.id);
    if (!claim) return { status: "not-run", reason: "duplicate" };
    let settled: Wake;
    let nextWakeAt: number | null | undefined;
    let status: "completed" | "blocked";
    try {
      if (!await this.executor.authorize(goal, claim, event)) {
        settled = this.ledger.finish(event.ownerId, goal.id, claim.id, {
          status: "blocked", result: "Goal-level authorization denied; no execution started", evidence: [],
        });
        return { status: "blocked", wake: settled };
      }
      const outcome = await this.executor.execute(goal, claim, event);
      if (!outcome || !outcome.summary.trim() || !Array.isArray(outcome.evidence)) {
        throw new Error("Executor returned an invalid result");
      }
      status = outcome.verified && outcome.evidence.length ? "completed" : "blocked";
      settled = this.ledger.finish(event.ownerId, goal.id, claim.id, {
        status, result: outcome.summary, evidence: outcome.evidence,
      });
      nextWakeAt = outcome.nextWakeAt;
    } catch {
      // External actions may have succeeded before an exception. Never retry automatically.
      const uncertain = this.ledger.finish(event.ownerId, goal.id, claim.id, {
        status: "uncertain", result: "Wake execution failed or its outcome could not be verified. Reconcile external state before retrying.",
      });
      return { status: "uncertain", wake: uncertain };
    }
    // The wake's verified result is already durable. A failed follow-up write must not rewrite it as uncertain.
    if (status === "completed" && nextWakeAt !== undefined) {
      try {
        const current = this.ledger.get(event.ownerId, goal.id);
        if (current?.status === "active") {
          this.ledger.update(event.ownerId, goal.id, current.revision, { nextWakeAt });
        }
      } catch {
        return { status, wake: settled, followUpError: "Follow-up scheduling failed; the verified wake remains completed. Reschedule explicitly." };
      }
    }
    return { status, wake: settled };
  }
}
