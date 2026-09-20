import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoalLedger } from "./goal-ledger.ts";

const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "dani-goals-"));
  directories.push(directory);
  let now = 1_000;
  const file = join(directory, "goals.json");
  const ledger = new GoalLedger(file, { now: () => now });
  const advance = (ms: number) => { now += ms; };
  return { ledger, file, advance, restore: () => new GoalLedger(file, { now: () => now }) };
};
const create = (ledger: GoalLedger) => ledger.create({ ownerId: "som", title: "Ship app", objective: "Ship Android build", successCriteria: ["APK exists", "CI passed"] });
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("GoalLedger", () => {
  it("persists an active goal and wake through a fresh process and never duplicates the same event", () => {
    const f = fixture();
    const goal = create(f.ledger);
    const first = f.ledger.enqueue("som", goal.id, "github:delivery-1");
    const restarted = f.restore();
    expect(restarted.get("som", goal.id)?.objective).toBe("Ship Android build");
    expect(restarted.enqueue("som", goal.id, "github:delivery-1").id).toBe(first.id);
    expect(restarted.wakes("som", goal.id)).toHaveLength(1);
  });

  it("reconciles a crashed worker as uncertain and requires evidence to settle it", () => {
    const f = fixture();
    const goal = create(f.ledger);
    const wake = f.ledger.enqueue("som", goal.id, "schedule:1000");
    expect(f.ledger.claim("som", goal.id, wake.id, 1_000)?.status).toBe("running");
    expect(f.ledger.claim("som", goal.id, wake.id)).toBeNull();
    f.advance(1_001);
    const restarted = f.restore();
    expect(restarted.reconcile()).toBe(1);
    expect(restarted.reconcile()).toBe(0);
    expect(restarted.wakes("som", goal.id)[0]?.status).toBe("uncertain");
    expect(() => restarted.finish("som", goal.id, wake.id, { status: "completed", result: "Done" })).toThrow(/requires evidence/);
    expect(restarted.finish("som", goal.id, wake.id, { status: "completed", result: "Verified", evidence: ["CI run 42 passed"] }).status).toBe("completed");
  });

  it("keeps owner data isolated and terminal goals closed", () => {
    const f = fixture();
    const goal = create(f.ledger);
    expect(f.ledger.get("different-user", goal.id)).toBeNull();
    expect(f.ledger.wakes("different-user", goal.id)).toEqual([]);
    expect(() => f.ledger.enqueue("different-user", goal.id, "injected")).toThrow(/not found/);
    const completed = f.ledger.update("som", goal.id, goal.revision, { status: "completed" });
    expect(() => f.ledger.enqueue("som", goal.id, "later-event")).toThrow(/not active/);
    expect(() => f.ledger.update("som", goal.id, completed.revision, { status: "active" })).toThrow(/Terminal goals/);
  });

  it("rejects stale revisions and never silently replaces corrupted data", () => {
    const f = fixture();
    const goal = create(f.ledger);
    f.ledger.update("som", goal.id, 1, { status: "paused" });
    expect(() => f.ledger.update("som", goal.id, 1, { status: "active" })).toThrow(/modified/);
    writeFileSync(f.file, "{corrupted", "utf8");
    expect(() => f.restore()).toThrow();
    expect(() => f.restore()).toThrow();
  });

  it("refuses completion of an unstarted wake and returns stable settled results on replay", () => {
    const f = fixture();
    const goal = create(f.ledger);
    const wake = f.ledger.enqueue("som", goal.id, "manual:1");
    expect(() => f.ledger.finish("som", goal.id, wake.id, { status: "completed", result: "Not actually run" })).toThrow(/not running/);
    f.ledger.claim("som", goal.id, wake.id);
    const settled = f.ledger.finish("som", goal.id, wake.id, { status: "completed", result: "Verified", evidence: ["Artifact exists"] });
    expect(f.restore().finish("som", goal.id, wake.id, { status: "completed", result: "Replay" })).toEqual(settled);
  });
});
