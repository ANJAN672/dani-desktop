import { describe, expect, it } from "vitest";
import { formatCuaHandoffTranscript, LayaCuaController, type CuaDriver, type CuaStateSnapshot } from "./cua-controller.ts";
import type { LayaDecisionResult } from "./contract.ts";

/** Control-loop tests: real loop logic with the provider and driver
 * boundaries scripted. No claim about real-model accuracy is made here. */

const snapshot = (over: Partial<CuaStateSnapshot> = {}): CuaStateSnapshot => ({
  summary: "browser window, Submit button visible",
  candidates: [
    { id: "a1", label: "click the Submit button", tool: { name: "click", args: { x: 10, y: 20 } } },
    { id: "a2", label: "type into the name field", tool: { name: "type_text", args: { text: "x" } } },
  ],
  stateVersion: "v1",
  ...over,
});

const choose = (optionId: string | null, over: Record<string, unknown> = {}): LayaDecisionResult => ({
  ok: true,
  decision: {
    schemaId: "dani.laya.decision",
    schemaVersion: 1,
    checkpoint: { repo: "r", subfolder: "typed-decisions", revision: "x", weightsSha256: "w" },
    scores: [],
    selectedOptionId: optionId,
    confidence: 0.5,
    actProbability: 0.9,
    abstained: optionId === null,
    abstainReason: optionId === null ? "model selected NONE_OF_THE_ABOVE" : null,
    elapsedMs: 40,
    ...over,
  } as never,
});

const driver = (over: Partial<CuaDriver> = {}): CuaDriver & { acted: unknown[] } => ({
  acted: [],
  observe: over.observe ?? (async () => snapshot()),
  act: over.act ?? (async function (this: { acted: unknown[] }, _bot: string, tool: unknown) {
    this.acted.push(tool);
    return { evidence: "frame-bytes" };
  } as CuaDriver["act"]),
});

const input = { botId: "b1", taskId: "j1", traceId: "t1", objective: "submit the form" };

describe("LayaCuaController", () => {
  it("refuses to run without a registered guarded driver", async () => {
    const c = new LayaCuaController(async () => choose("a1"), null);
    const r = await c.run(input);
    expect(r).toMatchObject({ outcome: "aborted", reason: "no_driver" });
    expect(r.steps).toHaveLength(0);
  });
  it("aborts when the state exposes no candidates", async () => {
    const d = driver({ observe: async () => snapshot({ candidates: [] }) });
    const r = await new LayaCuaController(async () => choose("a1"), d).run(input);
    expect(r).toMatchObject({ outcome: "aborted", reason: "no_candidates" });
  });
  it("aborts on abstention without acting", async () => {
    const d = driver();
    const r = await new LayaCuaController(async () => choose(null), d).run(input);
    expect(r).toMatchObject({ outcome: "aborted", reason: "abstained" });
    expect(d.acted).toHaveLength(0);
  });
  it("aborts when state moves between scoring and execution", async () => {
    let n = 0;
    const d = driver({ observe: async () => snapshot({ stateVersion: `v${++n}` }) });
    const r = await new LayaCuaController(async () => choose("a1"), d).run(input);
    expect(r).toMatchObject({ outcome: "aborted", reason: "state_changed" });
    expect(d.acted).toHaveLength(0);
  });
  it("completes only on fresh-state verification", async () => {
    const d = driver();
    let call = 0;
    const c = new LayaCuaController(async () => choose(++call % 2 === 1 ? "a1" : "objective_complete"), d, {
      settleMs: 0,
    });
    const r = await c.run(input);
    expect(r).toMatchObject({ outcome: "completed", reason: "objective_complete" });
    expect(d.acted).toEqual([{ name: "click", args: { x: 10, y: 20 } }]);
    expect(r.steps[0].evidence).toBe("frame-bytes");
  });
  it("stops at the step budget when verification never completes", async () => {
    const d = driver();
    const c = new LayaCuaController(async () => choose("a1"), d, { maxSteps: 2, settleMs: 0 });
    // decide always picks an action; verify always says continue (second
    // call picks "a1" too, which is not objective_complete -> loop continues)
    const r = await c.run(input);
    expect(r).toMatchObject({ outcome: "aborted", reason: "budget_exhausted" });
    expect(r.steps).toHaveLength(2);
    expect(d.acted).toHaveLength(2);
  });
  it("maps typed provider failures to decision_failed", async () => {
    const d = driver();
    const c = new LayaCuaController(
      async () => ({ ok: false, failure: "TIMEOUT", message: "slow", elapsedMs: 1500 }),
      d,
    );
    const r = await c.run(input);
    expect(r).toMatchObject({ outcome: "aborted", reason: "decision_failed" });
    expect(d.acted).toHaveLength(0);
  });
  it("honors the cancellation fence", async () => {
    const d = driver();
    const r = await new LayaCuaController(async () => choose("a1"), d).run({ ...input, isCancelled: () => true });
    expect(r).toMatchObject({ outcome: "aborted", reason: "cancelled" });
    expect(d.acted).toHaveLength(0);
  });
});

describe("formatCuaHandoffTranscript (spec 100 R8 handoff)", () => {
  it("carries the abort reason, detail, and every executed step", () => {
    const text = formatCuaHandoffTranscript({
      outcome: "aborted",
      reason: "lease_refused",
      detail: "the person is driving this computer right now",
      steps: [
        { step: 1, stateVersion: "v1", candidateCount: 5, selectedActionId: "a1", confidence: 0.1234, actProbability: 0.9876, evidence: "clicked ref=3" },
      ],
      handoffSummary: "bounded CUA aborted: lease_refused - the person is driving this computer right now. 1 step(s) executed.",
    });
    expect(text).toContain("lease_refused");
    expect(text).toContain("the person is driving");
    expect(text).toContain("step 1: action=a1 confidence=0.123 actProbability=0.988 evidence=clicked ref=3");
    expect(text).toContain("do not repeat steps that already succeeded");
  });

  it("omits the steps section when no step executed", () => {
    const text = formatCuaHandoffTranscript({
      outcome: "aborted",
      reason: "no_driver",
      detail: "no guarded CUA driver is registered for this bot",
      steps: [],
      handoffSummary: "bounded CUA aborted: no_driver - no guarded CUA driver is registered for this bot. 0 step(s) executed.",
    });
    expect(text).toContain("no_driver");
    expect(text).not.toContain("Steps taken:");
  });
});
