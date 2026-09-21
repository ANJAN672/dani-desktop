/**
 * LayaCuaController - the bounded executor behind the router's bounded_cua
 * route (spec 100 R7). The loop is deliberately small:
 *
 *   observe real state -> enumerate candidates FROM that state -> Laya
 *   scores -> re-check state did not move -> act through the SAME guarded
 *   driver Hermes' computer tools use -> verify from fresh evidence.
 *
 * Laya scores; it never authorizes or executes. Every abort hands a truthful
 * transcript back so Hermes can take over. UNVERIFIED on hardware: no real
 * driver is bound yet (the computer proxy's execution path is an MCP stdio
 * surface, not importable functions), so the controller refuses to run until
 * a driver is registered.
 */
import {
  MAX_OBJECTIVE_CHARS,
  MAX_STATE_SUMMARY_CHARS,
  type LayaDecisionRequest,
  type LayaDecisionResult,
} from "./contract.ts";

export interface CuaToolCall {
  /** Guarded computer-proxy tool names only. */
  name: "click" | "type_text" | "press_key" | "scroll" | "wait" | "browser_click" | "browser_fill" | "open_url";
  args: Record<string, unknown>;
}

export interface CuaCandidateAction {
  id: string;
  /** Human-readable, model-facing label. */
  label: string;
  description?: string;
  /** The exact guarded tool call that performs this action. */
  tool: CuaToolCall;
}

export interface CuaStateSnapshot {
  /** Short textual state summary for the decision contract. */
  summary: string;
  /** Candidate actions derived from the CURRENT accessibility/DOM state. */
  candidates: CuaCandidateAction[];
  /** Opaque state version. Decision validity expires when it changes. */
  stateVersion: string;
}

/**
 * The guarded execution boundary. Implementations must route through the
 * same computer-control lease ("who is driving") and adapter evidence rules
 * as Hermes' computer tools. No implementation ships in this slice.
 */
export interface CuaDriver {
  observe(botId: string): Promise<CuaStateSnapshot>;
  act(botId: string, tool: CuaToolCall): Promise<{ evidence: string }>;
}

export interface CuaControllerBudgets {
  maxSteps?: number;
  maxDurationMs?: number;
  decisionTimeoutMs?: number;
  /** Pause between act and verify-observe, ms. */
  settleMs?: number;
}

export interface CuaStepRecord {
  step: number;
  stateVersion: string;
  candidateCount: number;
  selectedActionId: string | null;
  confidence: number;
  actProbability: number;
  evidence?: string;
}

export type CuaTerminalReason =
  | "objective_complete"
  | "no_driver" // no guarded driver registered: refuse to run
  | "no_candidates" // state exposed nothing actionable
  | "abstained" // Laya would not commit
  | "state_changed" // state moved between scoring and acting
  | "decision_failed" // typed provider failure
  | "driver_error" // guarded driver threw (includes lease refusal)
  | "lease_refused" // the person is driving the computer
  | "budget_exhausted"
  | "cancelled";

export interface CuaRunResult {
  outcome: "completed" | "aborted";
  reason: CuaTerminalReason;
  detail: string;
  steps: CuaStepRecord[];
  /** Everything Hermes needs to take over truthfully. */
  handoffSummary: string;
}

const DEFAULT_MAX_STEPS = 4;
const DEFAULT_MAX_DURATION_MS = 60_000;
const DEFAULT_SETTLE_MS = 400;

type DecisionFn = (req: LayaDecisionRequest) => Promise<LayaDecisionResult>;

export class LayaCuaController {
  private readonly budgets: Required<CuaControllerBudgets>;

  constructor(
    private readonly decide: DecisionFn,
    private readonly driver: CuaDriver | null,
    budgets: CuaControllerBudgets = {},
  ) {
    this.budgets = {
      maxSteps: budgets.maxSteps ?? DEFAULT_MAX_STEPS,
      maxDurationMs: budgets.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      decisionTimeoutMs: budgets.decisionTimeoutMs ?? 1500,
      settleMs: budgets.settleMs ?? DEFAULT_SETTLE_MS,
    };
  }

  driverAvailable(): boolean {
    return this.driver !== null;
  }

  /** One bounded attempt at the objective. Never throws. */
  async run(input: {
    botId: string;
    taskId: string;
    traceId: string;
    objective: string;
    isCancelled?: () => boolean;
  }): Promise<CuaRunResult> {
    const steps: CuaStepRecord[] = [];
    const finish = (outcome: CuaRunResult["outcome"], reason: CuaTerminalReason, detail: string): CuaRunResult => ({
      outcome,
      reason,
      detail,
      steps,
      handoffSummary: `bounded CUA ${outcome}: ${reason} - ${detail}. ${steps.length} step(s) executed.`,
    });
    if (!this.driver) return finish("aborted", "no_driver", "no guarded CUA driver is registered for this bot");
    const driver = this.driver;
    const isLeaseRefusal = (e: unknown) => e instanceof Error && e.name === "CuaLeaseRefused";
    const deadline = Date.now() + this.budgets.maxDurationMs;
    const objective = input.objective.slice(0, MAX_OBJECTIVE_CHARS);

    for (let step = 1; step <= this.budgets.maxSteps; step++) {
      if (input.isCancelled?.()) return finish("aborted", "cancelled", "cancelled by the user/kernel fence");
      if (Date.now() > deadline) return finish("aborted", "budget_exhausted", "wall-clock budget exhausted");

      let before: CuaStateSnapshot;
      try {
        before = await driver.observe(input.botId);
      } catch (error) {
        return finish(
          "aborted",
          isLeaseRefusal(error) ? "lease_refused" : "driver_error",
          `state observation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (before.candidates.length === 0)
        return finish("aborted", "no_candidates", "current UI state exposes no bounded actions");
      if (before.candidates.length > 11)
        return finish("aborted", "no_candidates", `${before.candidates.length} candidates exceed the decision contract`);

      const decision = await this.decide({
        schemaId: "dani.laya.decision",
        schemaVersion: 1,
        taskId: input.taskId,
        traceId: `${input.traceId}:step${step}`,
        objective,
        stateSummary: before.summary.slice(0, MAX_STATE_SUMMARY_CHARS),
        options: before.candidates.map((c) => ({ id: c.id, label: c.label, description: c.description })),
        timeoutMs: this.budgets.decisionTimeoutMs,
        deadlineAt: new Date(deadline).toISOString(),
      });
      if (!decision.ok)
        return finish("aborted", "decision_failed", `${decision.failure}: ${decision.message}`);
      if (decision.decision.abstained || decision.decision.selectedOptionId === null) {
        steps.push({
          step,
          stateVersion: before.stateVersion,
          candidateCount: before.candidates.length,
          selectedActionId: null,
          confidence: decision.decision.confidence,
          actProbability: decision.decision.actProbability,
        });
        return finish("aborted", "abstained", decision.decision.abstainReason ?? "no commit");
      }
      const action = before.candidates.find((c) => c.id === decision.decision.selectedOptionId);
      if (!action) return finish("aborted", "decision_failed", "selected option is not a current candidate");

      // Decision validity expires if state changed while we scored.
      let recheck: CuaStateSnapshot;
      try {
        recheck = await driver.observe(input.botId);
      } catch (error) {
        return finish(
          "aborted",
          isLeaseRefusal(error) ? "lease_refused" : "driver_error",
          `state re-check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (recheck.stateVersion !== before.stateVersion)
        return finish("aborted", "state_changed", "UI state changed between scoring and execution");

      let evidence: string;
      try {
        evidence = (await driver.act(input.botId, action.tool)).evidence;
      } catch (error) {
        return finish(
          "aborted",
          isLeaseRefusal(error) ? "lease_refused" : "driver_error",
          `guarded action failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      steps.push({
        step,
        stateVersion: before.stateVersion,
        candidateCount: before.candidates.length,
        selectedActionId: action.id,
        confidence: decision.decision.confidence,
        actProbability: decision.decision.actProbability,
        evidence,
      });

      await new Promise((r) => setTimeout(r, this.budgets.settleMs));

      // Verify from fresh state, not from the action's own report.
      let after: CuaStateSnapshot;
      try {
        after = await driver.observe(input.botId);
      } catch (error) {
        return finish(
          "aborted",
          isLeaseRefusal(error) ? "lease_refused" : "driver_error",
          `verification observation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const done = await this.decide({
        schemaId: "dani.laya.decision",
        schemaVersion: 1,
        taskId: input.taskId,
        traceId: `${input.traceId}:verify${step}`,
        objective: `Did the action complete this objective? ${objective}`.slice(0, MAX_OBJECTIVE_CHARS),
        stateSummary: after.summary.slice(0, MAX_STATE_SUMMARY_CHARS),
        options: [
          { id: "objective_complete", label: "the objective is visibly complete in the current state" },
          { id: "continue_working", label: "the objective is not complete; more actions are needed" },
        ],
        timeoutMs: this.budgets.decisionTimeoutMs,
        deadlineAt: new Date(deadline).toISOString(),
      });
      if (done.ok && !done.decision.abstained && done.decision.selectedOptionId === "objective_complete")
        return finish("completed", "objective_complete", `verified from fresh state after ${step} step(s)`);
      // Anything else (continue, abstain, typed failure) keeps the loop
      // within budget; the step record above is the truthful evidence.
    }
    return finish("aborted", "budget_exhausted", `${this.budgets.maxSteps} step budget exhausted`);
  }
}
