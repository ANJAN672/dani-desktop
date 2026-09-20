import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalAutopilot, type GoalEvent, type GoalExecutor } from "./autopilot.ts";
import { GoalLedger } from "./goal-ledger.ts";

const directories: string[] = [];
const fixture = (executor: GoalExecutor) => {
  const dir = mkdtempSync(join(tmpdir(), "dani-autopilot-"));
  directories.push(dir);
  const ledger = new GoalLedger(join(dir, "goals.json"));
  const goal = ledger.create({ ownerId: "u1", title: "Release", objective: "Publish a verified artifact",
    successCriteria: ["CI passed", "Artifact exists"] });
  const event: GoalEvent = { ownerId: "u1", goalId: goal.id, triggerId: "github:delivery-42", source: "webhook", summary: "CI finished" };
  return { ledger, goal, event, autopilot: new GoalAutopilot(ledger, executor) };
};
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("GoalAutopilot", () => {
  it("runs authorized work once and preserves the goal for subsequent events", async () => {
    const execute = vi.fn(async () => ({ summary: "APK verified", evidence: ["sha256:123"], verified: true, nextWakeAt: Date.now() + 60_000 }));
    const f = fixture({ authorize: async () => true, execute });
    expect((await f.autopilot.dispatch(f.event)).status).toBe("completed");
    expect((await f.autopilot.dispatch(f.event)).status).toBe("not-run");
    expect(execute).toHaveBeenCalledOnce();
    expect(f.ledger.get("u1", f.goal.id)?.status).toBe("active");
    expect(f.ledger.get("u1", f.goal.id)?.nextWakeAt).toBeGreaterThan(Date.now());
  });

  it("rejects goal-level denial without invoking the execution engine", async () => {
    const execute = vi.fn(async () => ({ summary: "unexpected", evidence: ["x"], verified: true }));
    const f = fixture({ authorize: async () => false, execute });
    expect((await f.autopilot.dispatch(f.event)).status).toBe("blocked");
    expect(execute).not.toHaveBeenCalled();
    expect(f.ledger.wakes("u1", f.goal.id)[0]?.result).toMatch(/denied/);
  });

  it("never marks a model's unsupported success claim as verified completion", async () => {
    const f = fixture({ authorize: async () => true,
      execute: async () => ({ summary: "The model says done", evidence: [], verified: true }) });
    expect((await f.autopilot.dispatch(f.event)).status).toBe("blocked");
  });

  it("treats an exception after a possible external side effect as uncertain", async () => {
    const f = fixture({ authorize: async () => true, execute: async () => { throw new Error("network response lost"); } });
    expect((await f.autopilot.dispatch(f.event)).status).toBe("uncertain");
    expect((await f.autopilot.dispatch(f.event)).status).toBe("not-run");
    expect(f.ledger.wakes("u1", f.goal.id)).toHaveLength(1);
  });

  it("does not leak or run goals owned by another user", async () => {
    const execute = vi.fn(async () => ({ summary: "bad", evidence: ["x"], verified: true }));
    const f = fixture({ authorize: async () => true, execute });
    expect((await f.autopilot.dispatch({ ...f.event, ownerId: "attacker" })).status).toBe("not-run");
    expect(execute).not.toHaveBeenCalled();
  });

  it("retains verified completion when a follow-up timestamp is invalid", async () => {
    const f = fixture({ authorize: async () => true, execute: async () => ({
      summary: "CI passed", evidence: ["CI job 42 succeeded"], verified: true, nextWakeAt: -100,
    }) });
    const result = await f.autopilot.dispatch(f.event);
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.followUpError).toMatch(/Reschedule explicitly/);
    expect(f.ledger.wakes("u1", f.goal.id)[0]?.status).toBe("completed");
    expect(f.ledger.get("u1", f.goal.id)?.nextWakeAt).toBeNull();
  });
});
