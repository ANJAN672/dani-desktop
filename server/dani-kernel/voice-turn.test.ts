import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderAdapter, RuntimeEventListener } from "../contracts.ts";
import { DaniExecutionKernel } from "./kernel.ts";
import { DaniKernelRepository } from "./repository.ts";
import { DaniKernelVoiceTurnService, type VoiceTranscriptSink } from "./voice-turn.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function setup({ complete = true }: { complete?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dani-voice-turn-")); roots.push(root);
  const listeners = new Set<RuntimeEventListener>();
  const interruptTurn = vi.fn(async () => undefined);
  const sendTurn = vi.fn(async (input: Parameters<ProviderAdapter["sendTurn"]>[0]) => {
    if (complete) queueMicrotask(() => listeners.forEach(listener => listener({
      eventId: `event-${input.text}`, provider: "hermesAgent", threadId: input.threadId,
      turnId: `provider-${input.text}`, createdAt: new Date().toISOString(), type: "turn.completed", ok: true, stopReason: "end_turn",
    })));
    return { turnId: `provider-${input.text}` };
  });
  const hermes: ProviderAdapter = {
    provider: "hermesAgent", capabilities: { sessionModelSwitch: "in-session" }, sendTurn, interruptTurn,
    respondToRequest: async () => "unavailable", hasSession: () => false, stopAll: async () => undefined,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const repository = new DaniKernelRepository(join(root, "kernel.sqlite"));
  const kernel = new DaniExecutionKernel(repository, hermes, new Map());
  const persisted = new Map<string, unknown>();
  const sink: VoiceTranscriptSink = { persistUserMessage: vi.fn(input => { persisted.set(input.messageId, input); }) };
  const service = new DaniKernelVoiceTurnService(kernel, sink);
  const input = {
    ownerId: "user-1", callId: "call-1", utteranceId: "utterance-1", idempotencyKey: "call-1:utterance-1",
    conversationId: "thread-1", text: "hello from the microphone", callGeneration: 1,
  };
  return { input, interruptTurn, kernel, persisted, repository, sendTurn, service, sink };
}

describe("DaniKernelVoiceTurnService", () => {
  it("persists one ordinary user message and plans one real Hermes kernel turn", async () => {
    const { input, kernel, persisted, sendTurn, service, sink } = setup();
    await expect(service.submit(input)).resolves.toMatchObject({ duplicate: false });
    expect(sink.persistUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "thread-1", messageId: "call-1:utterance-1", source: "voice", text: input.text,
    }));
    expect(persisted).toHaveLength(1);
    expect(sendTurn).toHaveBeenCalledOnce();
    expect(sendTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1", text: input.text }));
    await kernel.close();
  });

  it("coalesces concurrent provider replay and returns durable duplicates without replanning", async () => {
    const { input, kernel, sendTurn, service, sink } = setup();
    const [first, second] = await Promise.all([service.submit(input), service.submit(input)]);
    expect(first).toEqual(second);
    expect(sendTurn).toHaveBeenCalledOnce();
    expect(sink.persistUserMessage).toHaveBeenCalledOnce();
    await expect(service.submit(input)).resolves.toMatchObject({ duplicate: true, jobId: first.jobId });
    expect(sendTurn).toHaveBeenCalledOnce();
    expect(sink.persistUserMessage).toHaveBeenCalledTimes(2);
    await kernel.close();
  });

  it("routes matching barge-in to kernel cancellation and the exact Hermes turn", async () => {
    const { input, interruptTurn, kernel, repository, service } = setup({ complete: false });
    const pending = service.submit(input);
    await vi.waitFor(() => expect(repository.db.prepare("SELECT status FROM kernel_jobs").get()).toMatchObject({ status: "running" }));
    await expect(service.cancel("call-1", 1, "User interrupted voice")).resolves.toBe(true);
    await expect(pending).rejects.toThrow("User interrupted voice");
    expect(interruptTurn).toHaveBeenCalledWith("thread-1", "provider-hello from the microphone");
    expect(repository.db.prepare("SELECT status,generation FROM kernel_jobs").get()).toMatchObject({ status: "cancelled", generation: 2 });
    await kernel.close();
  });

  it("rejects stale-generation cancellation", async () => {
    const { input, interruptTurn, kernel, repository, service } = setup({ complete: false });
    const pending = service.submit(input);
    await vi.waitFor(() => expect(repository.db.prepare("SELECT status FROM kernel_jobs").get()).toMatchObject({ status: "running" }));
    await expect(service.cancel("call-1", 2, "stale")).resolves.toBe(false);
    expect(interruptTurn).not.toHaveBeenCalled();
    await service.cancel("call-1", 1, "cleanup");
    await expect(pending).rejects.toThrow("cleanup");
    await kernel.close();
  });

  it("does not admit a durable job when ordinary transcript persistence fails", async () => {
    const { input, kernel, repository, sendTurn, service, sink } = setup();
    vi.mocked(sink.persistUserMessage).mockRejectedValueOnce(new Error("disk full"));
    await expect(service.submit(input)).rejects.toThrow("disk full");
    expect(repository.db.prepare("SELECT count(*) AS count FROM kernel_jobs").get()).toMatchObject({ count: 0 });
    expect(sendTurn).not.toHaveBeenCalled();
    await expect(service.submit(input)).resolves.toMatchObject({ duplicate: false });
    expect(sendTurn).toHaveBeenCalledOnce();
    await kernel.close();
  });

  it("cancels an already-aborted request before Hermes dispatch", async () => {
    const { input, interruptTurn, kernel, repository, sendTurn, service } = setup();
    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(service.submit({ ...input, signal: controller.signal })).rejects.toThrow("stopped");
    expect(sendTurn).not.toHaveBeenCalled();
    expect(interruptTurn).not.toHaveBeenCalled();
    expect(repository.db.prepare("SELECT count(*) AS count FROM kernel_jobs").get()).toMatchObject({ count: 0 });
    await kernel.close();
  });

  it("binds the caller-supplied idempotency key to call and provider utterance ids", async () => {
    const { input, kernel, sendTurn, service } = setup();
    expect(() => service.submit({ ...input, idempotencyKey: "forged" })).toThrow("bind call and utterance");
    expect(sendTurn).not.toHaveBeenCalled();
    await kernel.close();
  });
});
