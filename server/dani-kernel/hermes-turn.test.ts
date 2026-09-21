import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderAdapter, RuntimeEvent, RuntimeEventListener } from "../contracts.ts";
import { DaniKernelRepository } from "./repository.ts";
import { HermesKernelTurnService } from "./hermes-turn.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function harness() {
  const root = mkdtempSync(join(tmpdir(), "dani-hermes-kernel-"));
  roots.push(root);
  const repo = new DaniKernelRepository(join(root, "kernel.sqlite"));
  const listeners = new Set<RuntimeEventListener>();
  const interruptTurn = vi.fn(async () => undefined);
  const sendTurn = vi.fn(async (_input: Parameters<ProviderAdapter["sendTurn"]>[0]) => ({ turnId: "provider-turn-1" }));
  const adapter: ProviderAdapter = {
    provider: "hermesAgent",
    capabilities: { sessionModelSwitch: "in-session" },
    sendTurn,
    interruptTurn,
    respondToRequest: async () => "unavailable",
    hasSession: () => false,
    stopAll: async () => undefined,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const emit = (event: RuntimeEvent) => listeners.forEach(listener => listener(event));
  const job = repo.admitJob({
    ownerId: "user-1", objective: "browse", originatingRequestId: "request-1",
    turnId: "turn-1", provider: "hermes", threadId: "thread-1", providerCursor: "session-old",
  });
  return { repo, adapter, emit, job, sendTurn, interruptTurn };
}

const base = { eventId: "event-1", provider: "hermesAgent", threadId: "thread-1", createdAt: new Date().toISOString(), turnId: "provider-turn-1" };

describe("HermesKernelTurnService", () => {
  it("runs the real provider adapter with the durable resume cursor", async () => {
    const h = harness();
    const service = new HermesKernelTurnService(h.repo, h.adapter);
    const running = service.run({ jobId: String(h.job.id), generation: 1, text: "do it" });
    await vi.waitFor(() => expect(h.sendTurn).toHaveBeenCalledOnce());
    expect(h.sendTurn.mock.calls[0]?.[0]).toMatchObject({ threadId: "thread-1", resumeCursor: "session-old", text: "do it" });
    h.emit({ ...base, type: "session.started", sessionId: "session-new" });
    h.emit({ ...base, type: "turn.completed", ok: true, stopReason: "end_turn" });
    await expect(running).resolves.toMatchObject({ turnId: "provider-turn-1", providerCursor: "session-new" });
    await service.dispose(); h.repo.close();
  });

  it("does not lose provider events emitted during the sendTurn handshake", async () => {
    const h = harness();
    h.sendTurn.mockImplementationOnce(async () => {
      h.emit({ ...base, type: "session.started", sessionId: "session-during-handshake" });
      queueMicrotask(() => h.emit({ ...base, type: "turn.completed", ok: true, stopReason: "end_turn" }));
      return { turnId: "provider-turn-1" };
    });
    const service = new HermesKernelTurnService(h.repo, h.adapter);
    await expect(service.run({ jobId: String(h.job.id), generation: 1, text: "race" }))
      .resolves.toMatchObject({ providerCursor: "session-during-handshake" });
    await service.dispose(); h.repo.close();
  });

  it("cleans up a synchronous provider handshake failure", async () => {
    const h = harness();
    h.sendTurn.mockRejectedValueOnce(new Error("provider unavailable"));
    const service = new HermesKernelTurnService(h.repo, h.adapter);
    await expect(service.run({ jobId: String(h.job.id), generation: 1, text: "fail" })).rejects.toThrow("provider unavailable");
    await service.dispose(); h.repo.close();
  });

  it("surfaces provider failure instead of treating model output as completion", async () => {
    const h = harness();
    const service = new HermesKernelTurnService(h.repo, h.adapter);
    const running = service.run({ jobId: String(h.job.id), generation: 1, text: "do it" });
    await vi.waitFor(() => expect(h.sendTurn).toHaveBeenCalledOnce());
    h.emit({ ...base, type: "turn.completed", ok: false, stopReason: "provider_error" });
    await expect(running).rejects.toThrow("Hermes turn failed: provider_error");
    await service.dispose(); h.repo.close();
  });

  it("interrupts a timed-out provider turn", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const service = new HermesKernelTurnService(h.repo, h.adapter);
      const running = service.run({ jobId: String(h.job.id), generation: 1, text: "hang", timeoutMs: 50 });
      const rejected = expect(running).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(51);
      await rejected;
      expect(h.interruptTurn).toHaveBeenCalledWith("thread-1", "provider-turn-1");
      await service.dispose(); h.repo.close();
    } finally { vi.useRealTimers(); }
  });

  it("cancellation increments the generation and rejects stale callbacks", async () => {
    const h = harness();
    const service = new HermesKernelTurnService(h.repo, h.adapter);
    const running = service.run({ jobId: String(h.job.id), generation: 1, text: "stop me" });
    await vi.waitFor(() => expect(h.sendTurn).toHaveBeenCalledOnce());
    await service.cancel(String(h.job.id), "user interrupted");
    await expect(running).rejects.toThrow("user interrupted");
    h.emit({ ...base, type: "turn.completed", ok: true });
    expect(h.repo.job(String(h.job.id))).toMatchObject({ status: "cancelled", generation: 2 });
    await service.dispose(); h.repo.close();
  });

  it("fails closed when restarted work is already uncertain", async () => {
    const h = harness();
    h.repo.db.prepare("UPDATE kernel_jobs SET status='uncertain' WHERE id=?").run(String(h.job.id));
    const service = new HermesKernelTurnService(h.repo, h.adapter);
    await expect(service.run({ jobId: String(h.job.id), generation: 1, text: "retry" })).rejects.toThrow("non-runnable");
    expect(h.sendTurn).not.toHaveBeenCalled();
    await service.dispose(); h.repo.close();
  });
});
