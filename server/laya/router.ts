/**
 * DaniTaskRouter - the spec 100 R7 routing seam. Small/fast bounded work can
 * route to the Laya-scored CUA path; everything else goes to Hermes. Hermes
 * is the default and the fallback for every uncertain, unavailable, or
 * gated-off case. The router returns a decision; execution honors it only
 * when the bounded CUA controller is registered AND the routing gate is on.
 */
import { MAX_OBJECTIVE_CHARS, MAX_STATE_SUMMARY_CHARS, type LayaDecision, type LayaDecisionRequest } from "./contract.ts";
import type { LayaDecisionService } from "./service.ts";

export type DaniRoute = "bounded_cua" | "hermes_general";

export interface RouteDecision {
  route: DaniRoute;
  /** "laya" only when the real checkpoint made the call. */
  via: "laya" | "fallback";
  reason: string;
  decision?: LayaDecision;
}

export interface RouteInput {
  taskId: string;
  traceId: string;
  objective: string;
  stateSummary: string;
  /** Real serving state: does this bot currently have a computer surface? */
  cuaAvailable: boolean;
}

export interface DaniTaskRouterOptions {
  routingEnabled: () => boolean;
  /** Minimum p(bounded_cua) - p(hermes_general) margin to commit to the
   * bounded path. The 2026-09-22 probe on a clear case measured 0.318. */
  minMargin?: number;
  decisionTimeoutMs?: number;
}

const DEFAULT_MIN_MARGIN = 0.15;

export class DaniTaskRouter {
  private readonly service: Pick<LayaDecisionService, "decide" | "status">;
  private readonly routingEnabled: () => boolean;
  private readonly minMargin: number;
  private readonly decisionTimeoutMs?: number;

  constructor(service: Pick<LayaDecisionService, "decide" | "status">, options: DaniTaskRouterOptions) {
    this.service = service;
    this.routingEnabled = options.routingEnabled;
    this.minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;
    this.decisionTimeoutMs = options.decisionTimeoutMs;
  }

  async route(input: RouteInput): Promise<RouteDecision> {
    if (!this.routingEnabled()) return { route: "hermes_general", via: "fallback", reason: "routing gate off" };
    if (!input.cuaAvailable)
      return { route: "hermes_general", via: "fallback", reason: "no computer surface on this bot" };
    if (!this.service.status().installed)
      return { route: "hermes_general", via: "fallback", reason: "laya checkpoint not installed" };
    const req: LayaDecisionRequest = {
      schemaId: "dani.laya.decision",
      schemaVersion: 1,
      taskId: input.taskId,
      traceId: input.traceId,
      objective: `Which route should handle this request? ${input.objective}`.slice(0, MAX_OBJECTIVE_CHARS),
      stateSummary: input.stateSummary.slice(0, MAX_STATE_SUMMARY_CHARS),
      options: [
        {
          id: "bounded_cua",
          label: "bounded single UI action via the computer-use driver",
          description: "one small, reversible action whose target is visible in current UI state",
        },
        {
          id: "hermes_general",
          label: "general Hermes agent turn",
          description: "planning, multiple steps, judgement, or tools beyond one visible UI action",
        },
      ],
      timeoutMs: this.decisionTimeoutMs,
    };
    const result = await this.service.decide(req);
    if (!result.ok)
      return { route: "hermes_general", via: "fallback", reason: `laya ${result.failure}: ${result.message}` };
    const { decision } = result;
    if (decision.abstained)
      return { route: "hermes_general", via: "laya", reason: `abstained: ${decision.abstainReason}`, decision };
    if (decision.selectedOptionId !== "bounded_cua")
      return { route: "hermes_general", via: "laya", reason: "laya chose Hermes", decision };
    const pCua = decision.scores.find((s) => s.optionId === "bounded_cua")?.probability ?? 0;
    const pHermes = decision.scores.find((s) => s.optionId === "hermes_general")?.probability ?? 0;
    if (pCua - pHermes < this.minMargin)
      return {
        route: "hermes_general",
        via: "laya",
        reason: `margin ${(pCua - pHermes).toFixed(3)} below ${this.minMargin}`,
        decision,
      };
    return { route: "bounded_cua", via: "laya", reason: `laya committed (margin ${(pCua - pHermes).toFixed(3)})`, decision };
  }
}
