import { describe, expect, it } from "vitest";
import {
  LAYA_DECISION_SCHEMA_ID,
  LAYA_DECISION_SCHEMA_VERSION,
  NONE_OF_THE_ABOVE,
  topScoringOption,
  validateDecisionRequest,
  validateScores,
  type LayaDecisionRequest,
} from "./contract.ts";

const base = (): LayaDecisionRequest => ({
  schemaId: LAYA_DECISION_SCHEMA_ID,
  schemaVersion: LAYA_DECISION_SCHEMA_VERSION,
  taskId: "job-1",
  traceId: "trace-1",
  objective: "Which route should handle this request?",
  stateSummary: "one browser window, visible Submit button",
  options: [
    { id: "cua", label: "bounded single UI action via the computer-use driver" },
    { id: "hermes", label: "general Hermes agent turn", description: "planning or multi-step work" },
  ],
});

describe("DecisionProvider request validation", () => {
  it("accepts a well-formed request", () => {
    expect(validateDecisionRequest(base())).toBeNull();
  });
  it("rejects an unknown schema id", () => {
    expect(validateDecisionRequest({ ...base(), schemaId: "other" })).toMatch(/unknown schema id/);
  });
  it("rejects a newer schema version", () => {
    expect(validateDecisionRequest({ ...base(), schemaVersion: 999 })).toMatch(/unsupported schema version/);
  });
  it("rejects duplicate option ids", () => {
    const req = base();
    req.options.push({ id: "cua", label: "another" });
    expect(validateDecisionRequest(req)).toMatch(/duplicate option id/);
  });
  it("reserves NONE_OF_THE_ABOVE to the service", () => {
    const req = base();
    req.options.push({ id: NONE_OF_THE_ABOVE, label: "none" });
    expect(validateDecisionRequest(req)).toMatch(/reserved/);
  });
  it("rejects fewer than two options", () => {
    const req = base();
    req.options = [{ id: "only", label: "only" }];
    expect(validateDecisionRequest(req)).toMatch(/at least/);
  });
  it("rejects an expired deadline", () => {
    const req = { ...base(), deadlineAt: "2026-09-22T00:00:00Z" };
    expect(validateDecisionRequest(req, new Date("2026-09-22T00:00:01Z"))).toBe("deadline already passed");
  });
  it("accepts a future deadline", () => {
    const req = { ...base(), deadlineAt: "2026-09-22T00:00:02Z" };
    expect(validateDecisionRequest(req, new Date("2026-09-22T00:00:01Z"))).toBeNull();
  });
  it("rejects an out-of-range timeout", () => {
    expect(validateDecisionRequest({ ...base(), timeoutMs: 60_000 })).toMatch(/timeoutMs/);
  });
});

describe("DecisionProvider response validation", () => {
  const options = base().options;
  it("accepts a complete distribution including NONE", () => {
    const r = validateScores({ cua: 0.6, hermes: 0.3, [NONE_OF_THE_ABOVE]: 0.1 }, options);
    expect("scores" in r && r.scores).toHaveLength(3);
  });
  it("rejects an unknown option", () => {
    const r = validateScores({ cua: 0.6, hermes: 0.3, [NONE_OF_THE_ABOVE]: 0.05, mystery: 0.05 }, options);
    expect("problem" in r && r.problem).toMatch(/unknown option/);
  });
  it("rejects a missing option", () => {
    const r = validateScores({ cua: 1, [NONE_OF_THE_ABOVE]: 0 }, options);
    expect("problem" in r && r.problem).toMatch(/hermes/);
  });
  it("rejects non-probabilities", () => {
    expect(validateScores({ cua: 1.4, hermes: 0, [NONE_OF_THE_ABOVE]: 0 }, options)).toHaveProperty("problem");
    expect(validateScores({ cua: Number.NaN, hermes: 0.5, [NONE_OF_THE_ABOVE]: 0.5 }, options)).toHaveProperty("problem");
  });
  it("rejects a distribution that does not sum to ~1", () => {
    const r = validateScores({ cua: 0.01, hermes: 0.01, [NONE_OF_THE_ABOVE]: 0.01 }, options);
    expect("problem" in r && r.problem).toMatch(/sum/);
  });
});

describe("top scoring option", () => {
  it("picks the highest real option", () => {
    expect(topScoringOption([
      { optionId: "cua", probability: 0.5 },
      { optionId: "hermes", probability: 0.4 },
      { optionId: NONE_OF_THE_ABOVE, probability: 0.1 },
    ]).optionId).toBe("cua");
  });
  it("returns null when NONE_OF_THE_ABOVE wins", () => {
    expect(topScoringOption([
      { optionId: "cua", probability: 0.2 },
      { optionId: NONE_OF_THE_ABOVE, probability: 0.8 },
    ]).optionId).toBeNull();
  });
});
