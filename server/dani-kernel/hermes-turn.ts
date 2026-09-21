import type { ProviderAdapter, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { DaniKernelRepository } from "./repository.ts";

export interface HermesKernelTurnInput {
  jobId: string;
  generation: number;
  text: string;
  system?: string;
  model?: string;
  effort?: SendTurnInput["effort"];
  timeoutMs?: number;
  turn?: Omit<SendTurnInput, "threadId" | "text" | "system" | "model" | "effort" | "resumeCursor">;
}

export interface HermesKernelTurnResult {
  turnId: string;
  sessionId: string | null;
  providerCursor: string | null;
  terminal: Extract<RuntimeEvent, { type: "turn.completed" }>;
}

type Pending = {
  jobId: string;
  generation: number;
  threadId: string;
  turnId: string | null;
  sessionId: string | null;
  resolve: (event: Extract<RuntimeEvent, { type: "turn.completed" }>) => void;
  reject: (error: Error) => void;
  detached?: boolean;
};

const asError = (value: unknown, fallback: string) => value instanceof Error ? value : new Error(fallback);

/**
 * A deliberately small Hermes boundary. Hermes receives a turn and emits
 * provider events; only the kernel repository owns durable job state.
 * Tool/effect admission stays in the effect service, never in this adapter.
 */
export class HermesKernelTurnService {
  private readonly pending = new Map<string, Pending>();
  private readonly unsubscribe: () => void;

  private readonly repository: DaniKernelRepository;
  private readonly adapter: ProviderAdapter;
  constructor(repository: DaniKernelRepository, adapter: ProviderAdapter) {
    this.repository = repository;
    this.adapter = adapter;
    if (adapter.provider !== "hermesAgent") throw new Error(`expected hermesAgent, received ${adapter.provider}`);
    this.unsubscribe = adapter.onEvent(event => this.onEvent(event));
  }

  private onEvent(event: RuntimeEvent) {
    const pending = this.pending.get(event.threadId);
    if (!pending) return;
    const job = this.repository.job(pending.jobId);
    if (Number(job.generation) !== pending.generation || String(job.status) === "cancelled") {
      this.pending.delete(event.threadId);
      pending.reject(new Error("stale Hermes callback after cancellation"));
      return;
    }
    if (event.type === "session.started") pending.sessionId = event.sessionId;
    if (event.type === "runtime.error") {
      this.pending.delete(event.threadId);
      pending.reject(new Error(event.message));
      return;
    }
    if (event.type === "turn.completed") {
      if (pending.turnId && event.turnId && pending.turnId !== event.turnId) return;
      this.pending.delete(event.threadId);
      this.repository.finishProviderTurn(
        pending.jobId,
        pending.generation,
        event.ok ? "completed" : "failed",
        pending.sessionId,
      );
      if (!event.ok) pending.reject(new Error(`Hermes turn failed: ${event.stopReason ?? "unknown"}`));
      else pending.resolve(event);
    }
  }

  async dispatch(input: HermesKernelTurnInput): Promise<{ turnId: string }> {
    const job = this.repository.beginTurn(input.jobId, input.generation);
    const threadId = String(job.thread_id);
    if (this.pending.has(threadId)) throw new Error("Hermes thread already has a running turn");
    let pending!: Pending;
    const terminal = new Promise<Extract<RuntimeEvent, { type: "turn.completed" }>>((resolve, reject) => {
      pending = { jobId: input.jobId, generation: input.generation, threadId, turnId: null, sessionId: null, resolve, reject, detached: true };
      this.pending.set(threadId, pending);
    });
    // Detached server dispatch is folded by server/index.ts. Keep this local
    // promise observed so a provider failure cannot become an unhandled rejection.
    void terminal.catch(() => undefined);
    try {
      const started = await this.adapter.sendTurn({
        threadId,
        text: input.text,
        system: input.system,
        model: input.model,
        effort: input.effort,
        resumeCursor: job.provider_cursor ?? undefined,
        ...input.turn,
      });
      pending.turnId = started.turnId;
      return started;
    } catch (error) {
      this.pending.delete(threadId);
      this.repository.finishProviderTurn(input.jobId, input.generation, "failed");
      throw asError(error, "Hermes turn failed");
    }
  }

  async run(input: HermesKernelTurnInput): Promise<HermesKernelTurnResult> {
    const job = this.repository.beginTurn(input.jobId, input.generation);
    const threadId = String(job.thread_id);
    if (this.pending.has(threadId)) throw new Error("Hermes thread already has a running turn");
    const timeoutMs = input.timeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending!: Pending;
    const terminal = new Promise<Extract<RuntimeEvent, { type: "turn.completed" }>>((resolve, reject) => {
      pending = {
        jobId: input.jobId,
        generation: input.generation,
        threadId,
        turnId: null,
        sessionId: null,
        resolve,
        reject,
      };
      this.pending.set(threadId, pending);
      timer = setTimeout(() => {
        if (this.pending.get(threadId) !== pending) return;
        this.pending.delete(threadId);
        void this.adapter.interruptTurn(threadId, pending.turnId ?? undefined).catch(() => undefined);
        reject(new Error(`Hermes turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const started = await this.adapter.sendTurn({
        threadId,
        text: input.text,
        system: input.system,
        model: input.model,
        effort: input.effort,
        resumeCursor: job.provider_cursor ?? undefined,
      });
      pending.turnId = started.turnId;
      const completed = await terminal;
      return {
        turnId: started.turnId,
        sessionId: pending.sessionId,
        providerCursor: pending.sessionId,
        terminal: completed,
      };
    } catch (error) {
      this.pending.delete(threadId);
      throw asError(error, "Hermes turn failed");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cancel(jobId: string, reason: string) {
    const job = this.repository.cancelJob(jobId, reason);
    const threadId = String(job.thread_id);
    const pending = this.pending.get(threadId);
    if (pending) {
      this.pending.delete(threadId);
      pending.reject(new Error(reason));
    }
    await this.adapter.interruptTurn(threadId, pending?.turnId ?? undefined).catch(() => undefined);
    return job;
  }

  async dispose() {
    this.unsubscribe();
    for (const pending of this.pending.values()) pending.reject(new Error("Hermes kernel service disposed"));
    this.pending.clear();
  }
}
