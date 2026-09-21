import { describe, expect, it } from "vitest";
import type { LayaDecisionResult } from "./contract.ts";
import { DaniTaskRouter, type RouteInput } from "./router.ts";

/** Policy tests: the router's routing logic, with the provider boundary
 * scripted. Provider inference itself is covered only by real-checkpoint
 * runs (see spec 100 slice 2 addendum); no mocked-model claims are made. */
const decision = (over: Partial<Extract<LayaDecisionResult, { ok: true }>["decision"]> = {}): LayaDecisionResult => ({
  ok: true,
  decision: {
    schemaId: "dani.laya.decision",
    schemaVersion: 1,
    checkpoint: { repo: "convaiinnovations/laya", subfolder: "typed-decisions", revision: "r", weightsSha256: "w" },
    scores: [
      { optionId: "bounded_cua", probability: 0.6 },
      { optionId: "hermes_general", probability: 0.3 },
      { optionId: "NONE_OF_THE_ABOVE", probability: 0.1 },
    ],
    selectedOptionId: "bounded_cua",
    confidence: 0.5,
    actProbability: 0.9,
    abstained: false,
    abstainReason: null,
    elapsedMs: 40,
    ...over,
  },
});

const service = (result: LayaDecisionResult, installed = true) => ({
  decide: async () => result,
  status: () => ({ installed, install: null, requiredDownloadBytes: 0, sidecar: "ready" as const, loadedIdentity: null }),
});

const input: RouteInput = {
  taskId: "job-1",
  traceId: "trace-1",
  objective: "click the submit button",
  stateSummary: "one browser window, visible Submit button",
  cuaAvailable: true,
};

describe("DaniTaskRouter", () => {
  it("defaults every request to Hermes while the gate is off", async () => {
    const r = new DaniTaskRouter(service(decision()), { routingEnabled: () => false });
    expect(await r.route(input)).toMatchObject({ route: "hermes_general", via: "fallback" });
  });
  it("routes to Hermes when the bot has no computer surface", async () => {
    const r = new DaniTaskRouter(service(decision()), { routingEnabled: () => true });
    expect(await r.route({ ...input, cuaAvailable: false })).toMatchObject({ route: "hermes_general" });
  });
  it("routes to Hermes when the checkpoint is not installed", async () => {
    const r = new DaniTaskRouter(service(decision(), false), { routingEnabled: () => true });
    expect(await r.route(input)).toMatchObject({ route: "hermes_general", reason: "laya checkpoint not installed" });
  });
  it("commits to bounded_cua on a clear Laya decision", async () => {
    const r = new DaniTaskRouter(service(decision()), { routingEnabled: () => true });
    expect(await r.route(input)).toMatchObject({ route: "bounded_cua", via: "laya" });
  });
  it("returns abstentions to Hermes", async () => {
    const r = new DaniTaskRouter(
      service(decision({ abstained: true, abstainReason: "model selected NONE_OF_THE_ABOVE", selectedOptionId: null })),
      { routingEnabled: () => true },
    );
    expect(await r.route(input)).toMatchObject({ route: "hermes_general", via: "laya" });
  });
  it("returns thin margins to Hermes", async () => {
    const r = new DaniTaskRouter(
      service(decision({
        scores: [
          { optionId: "bounded_cua", probability: 0.4 },
          { optionId: "hermes_general", probability: 0.35 },
          { optionId: "NONE_OF_THE_ABOVE", probability: 0.25 },
        ],
      })),
      { routingEnabled: () => true },
    );
    const out = await r.route(input);
    expect(out.route).toBe("hermes_general");
    expect(out.reason).toMatch(/margin/);
  });
  it("returns provider failures to Hermes with the typed failure", async () => {
    const r = new DaniTaskRouter(
      service({ ok: false, failure: "TIMEOUT", message: "decision exceeded 1500ms", elapsedMs: 1500 }),
      { routingEnabled: () => true },
    );
    expect(await r.route(input)).toMatchObject({ route: "hermes_general", reason: "laya TIMEOUT: decision exceeded 1500ms" });
  });
});
