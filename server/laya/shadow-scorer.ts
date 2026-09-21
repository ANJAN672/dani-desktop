/**
 * Bridge from the DecisionProvider (server/laya/service.ts) to the existing
 * SQLite shadow ledger (server/laya-shadow.ts). Real decisions by the real
 * checkpoint, recorded against what Hermes actually did. Hermes remains
 * authoritative regardless of the scores (spec 100 R6).
 */
import { MAX_OBJECTIVE_CHARS, type LayaDecisionRequest } from "./contract.ts";
import type { LayaDecisionService } from "./service.ts";
import type { LayaShadowScorer, ShadowCandidate, ShadowScore } from "../laya-shadow.ts";

export interface ShadowScoreInput {
  objective: string;
  candidates: ShadowCandidate[];
}

export class LayaDecisionShadowScorer implements LayaShadowScorer {
  private readonly service: LayaDecisionService;
  private readonly contextFor: (objective: string) => string;

  constructor(service: LayaDecisionService, contextFor: (objective: string) => string = () => "") {
    this.service = service;
    this.contextFor = contextFor;
  }

  async score(input: ShadowScoreInput): Promise<ShadowScore[]> {
    const req: LayaDecisionRequest = {
      schemaId: "dani.laya.decision",
      schemaVersion: 1,
      taskId: `shadow:${Date.now()}`,
      traceId: `shadow:${Date.now()}`,
      objective: input.objective.slice(0, MAX_OBJECTIVE_CHARS),
      stateSummary: this.contextFor(input.objective),
      options: input.candidates.map((c) => ({
        id: c.id,
        label: c.label,
        description: typeof c.features.description === "string" ? c.features.description : undefined,
      })),
    };
    const result = await this.service.decide(req);
    if (!result.ok) throw new Error(`laya shadow decision failed: ${result.failure}: ${result.message}`);
    return result.decision.scores
      .filter((s) => s.optionId !== "NONE_OF_THE_ABOVE")
      .map((s) => ({
        candidateId: s.optionId,
        score: s.probability,
        reason: `confidence ${result.decision.confidence}, act ${result.decision.actProbability}${
          result.decision.abstained ? `, abstained: ${result.decision.abstainReason}` : ""
        }`,
      }));
  }
}

/** Route candidates for the admission-time shadow decision, built from real
 * serving state: Hermes is always a route; the bounded CUA route exists only
 * when this bot actually has a computer surface. */
export function routeShadowCandidates(cuaAvailable: boolean): ShadowCandidate[] {
  const candidates: ShadowCandidate[] = [
    {
      id: "hermes_general",
      label: "general Hermes agent turn",
      features: { description: "planning, multiple steps, judgement, or tools beyond one visible UI action" },
    },
  ];
  if (cuaAvailable)
    candidates.unshift({
      id: "bounded_cua",
      label: "bounded single UI action via the computer-use driver",
      features: { description: "one small, reversible action whose target is visible in current UI state" },
    });
  return candidates;
}
