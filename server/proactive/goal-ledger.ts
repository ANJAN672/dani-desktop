import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic.ts";

export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "cancelled";
export type WakeStatus = "pending" | "running" | "completed" | "blocked" | "uncertain";

export interface Goal {
  id: string;
  ownerId: string;
  title: string;
  objective: string;
  successCriteria: string[];
  status: GoalStatus;
  nextWakeAt: number | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface Wake {
  id: string;
  goalId: string;
  triggerId: string;
  status: WakeStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  leaseUntil?: number;
  result?: string;
  evidence?: string[];
}

interface LedgerFile { version: 1; goals: Goal[]; wakes: Wake[] }

const MAX_TITLE = 160;
const MAX_OBJECTIVE = 8_000;
const MAX_CRITERIA = 25;
const MAX_EVIDENCE = 30;
const MAX_WAKES = 20_000;
const EMPTY = (): LedgerFile => ({ version: 1, goals: [], wakes: [] });

function required(value: string, name: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`${name} must contain 1-${max} characters`);
  return text;
}

function validateLoaded(raw: unknown): LedgerFile {
  if (!raw || typeof raw !== "object") throw new Error("Invalid goal ledger");
  const file = raw as Partial<LedgerFile>;
  if (file.version !== 1 || !Array.isArray(file.goals) || !Array.isArray(file.wakes)) {
    throw new Error("Unsupported or corrupt goal ledger; refusing to overwrite it");
  }
  const goalIds = new Set<string>();
  for (const goal of file.goals) {
    if (!goal || typeof goal.id !== "string" || typeof goal.ownerId !== "string" ||
      typeof goal.objective !== "string" || !Array.isArray(goal.successCriteria) ||
      !["active", "paused", "blocked", "completed", "cancelled"].includes(goal.status) ||
      !Number.isSafeInteger(goal.revision) || goalIds.has(goal.id)) {
      throw new Error("Corrupt goal ledger; refusing to discard stored goals");
    }
    goalIds.add(goal.id);
  }
  const triggerIds = new Set<string>();
  for (const wake of file.wakes) {
    const key = `${wake?.goalId}\0${wake?.triggerId}`;
    if (!wake || !goalIds.has(wake.goalId) || !wake.id || !wake.triggerId ||
      !["pending", "running", "completed", "blocked", "uncertain"].includes(wake.status) || triggerIds.has(key)) {
      throw new Error("Corrupt wake ledger; refusing to discard stored history");
    }
    triggerIds.add(key);
  }
  return file as LedgerFile;
}

/** A single-process durable ledger. Cloud multi-worker deployments must use a transactional DB. */
export class GoalLedger {
  private state: LedgerFile;
  private readonly clock: () => number;

  constructor(private readonly path: string, options: { now?: () => number } = {}) {
    this.clock = options.now ?? Date.now;
    this.state = existsSync(path) ? validateLoaded(JSON.parse(readFileSync(path, "utf8"))) : EMPTY();
  }

  private persist(next: LedgerFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.state = next;
  }

  list(ownerId: string): Goal[] {
    return this.state.goals.filter((goal) => goal.ownerId === ownerId).map((goal) => structuredClone(goal));
  }

  get(ownerId: string, goalId: string): Goal | null {
    return structuredClone(this.state.goals.find((goal) => goal.ownerId === ownerId && goal.id === goalId) ?? null);
  }

  create(input: { ownerId: string; title: string; objective: string; successCriteria: string[]; nextWakeAt?: number | null }): Goal {
    const ownerId = required(input.ownerId, "Owner", 256);
    const title = required(input.title, "Title", MAX_TITLE);
    const objective = required(input.objective, "Objective", MAX_OBJECTIVE);
    if (!Array.isArray(input.successCriteria) || !input.successCriteria.length || input.successCriteria.length > MAX_CRITERIA) {
      throw new Error("A goal needs 1-25 explicit success criteria");
    }
    const successCriteria = input.successCriteria.map((item) => required(item, "Success criterion", 1_000));
    const nextWakeAt = input.nextWakeAt ?? null;
    if (nextWakeAt !== null && (!Number.isSafeInteger(nextWakeAt) || nextWakeAt < 0)) throw new Error("Invalid next wake");
    const now = this.clock();
    const goal: Goal = { id: randomUUID(), ownerId, title, objective, successCriteria, status: "active", nextWakeAt,
      createdAt: now, updatedAt: now, revision: 1 };
    this.persist({ ...this.state, goals: [...this.state.goals, goal] });
    return structuredClone(goal);
  }

  update(ownerId: string, goalId: string, revision: number, change: { status?: GoalStatus; nextWakeAt?: number | null }): Goal {
    const goal = this.get(ownerId, goalId);
    if (!goal) throw new Error("Goal not found");
    if (goal.revision !== revision) throw new Error("Goal was modified; reload before updating");
    if (change.status && !["active", "paused", "blocked", "completed", "cancelled"].includes(change.status)) throw new Error("Invalid goal state");
    if (goal.status === "completed" || goal.status === "cancelled") throw new Error("Terminal goals cannot be reopened implicitly");
    const nextWakeAt = change.nextWakeAt === undefined ? goal.nextWakeAt : change.nextWakeAt;
    if (nextWakeAt !== null && (!Number.isSafeInteger(nextWakeAt) || nextWakeAt < 0)) throw new Error("Invalid next wake");
    const next: Goal = { ...goal, ...change, nextWakeAt, revision: revision + 1, updatedAt: this.clock() };
    if (next.status !== "active") next.nextWakeAt = null;
    this.persist({ ...this.state, goals: this.state.goals.map((record) => record.id === goalId ? next : record) });
    return structuredClone(next);
  }

  /** `(goalId, triggerId)` is a durable idempotency key, including after restart. */
  enqueue(ownerId: string, goalId: string, triggerId: string): Wake {
    const goal = this.get(ownerId, goalId);
    if (!goal) throw new Error("Goal not found");
    if (goal.status !== "active") throw new Error("Goal is not active");
    const key = required(triggerId, "Trigger", 256);
    const existing = this.state.wakes.find((wake) => wake.goalId === goalId && wake.triggerId === key);
    if (existing) return structuredClone(existing);
    if (this.state.wakes.length >= MAX_WAKES) throw new Error("Wake history is full; archive before proceeding");
    const wake: Wake = { id: randomUUID(), goalId, triggerId: key, status: "pending", createdAt: this.clock() };
    this.persist({ ...this.state, wakes: [...this.state.wakes, wake] });
    return structuredClone(wake);
  }

  claim(ownerId: string, goalId: string, wakeId: string, leaseMs = 60_000): Wake | null {
    const goal = this.get(ownerId, goalId);
    if (!goal || goal.status !== "active") return null;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) throw new Error("Invalid lease");
    const wake = this.state.wakes.find((item) => item.goalId === goalId && item.id === wakeId);
    if (!wake || wake.status !== "pending") return null;
    const now = this.clock();
    const next: Wake = { ...wake, status: "running", startedAt: now, leaseUntil: now + leaseMs };
    this.persist({ ...this.state, wakes: this.state.wakes.map((item) => item.id === wakeId ? next : item) });
    return structuredClone(next);
  }

  /** An expired in-flight wake is UNCERTAIN, not automatically re-run: external actions may have succeeded. */
  reconcile(): number {
    const now = this.clock();
    const expired = this.state.wakes.filter((wake) => wake.status === "running" && wake.leaseUntil !== undefined && wake.leaseUntil <= now);
    if (!expired.length) return 0;
    const ids = new Set(expired.map((wake) => wake.id));
    this.persist({ ...this.state, wakes: this.state.wakes.map((wake) => ids.has(wake.id) ? { ...wake, status: "uncertain" as const, result: "Execution lease expired; reconcile external actions before retrying" } : wake) });
    return expired.length;
  }

  finish(ownerId: string, goalId: string, wakeId: string, input: { status: "completed" | "blocked" | "uncertain"; result: string; evidence?: string[] }): Wake {
    const goal = this.get(ownerId, goalId);
    if (!goal) throw new Error("Goal not found");
    const wake = this.state.wakes.find((item) => item.goalId === goalId && item.id === wakeId);
    if (!wake) throw new Error("Wake not found");
    if (wake.status === input.status && wake.finishedAt !== undefined) return structuredClone(wake);
    if (wake.status !== "running" && wake.status !== "uncertain") throw new Error("Wake is not running; cannot record a new result");
    if (wake.status === "uncertain" && input.status === "completed" && !input.evidence?.length) {
      throw new Error("An uncertain action requires evidence before completion");
    }
    const evidence = input.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) throw new Error("Invalid evidence");
    const next: Wake = { ...wake, status: input.status, result: required(input.result, "Result", 4_000),
      evidence: evidence.map((item) => required(item, "Evidence", 2_000)), finishedAt: this.clock(), leaseUntil: undefined };
    this.persist({ ...this.state, wakes: this.state.wakes.map((item) => item.id === wakeId ? next : item) });
    return structuredClone(next);
  }

  wakes(ownerId: string, goalId: string): Wake[] {
    if (!this.get(ownerId, goalId)) return [];
    return this.state.wakes.filter((wake) => wake.goalId === goalId).map((wake) => structuredClone(wake));
  }
}
