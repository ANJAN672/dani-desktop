import { describe, expect, it, vi } from "vitest";
import { classifyMicrophoneError, VoiceCallStateMachine, type DurableVoiceTurnBridge } from "./voice-call-state-machine";

function setup() {
  const bridge: DurableVoiceTurnBridge = { submit: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) };
  const call = new VoiceCallStateMachine("call-1", bridge);
  const generation = call.start();
  call.connected(generation);
  return { bridge, call, generation };
}

describe("VoiceCallStateMachine", () => {
  it("dispatches a final utterance once with a reconnect-stable idempotency key", async () => {
    const { bridge, call, generation } = setup();
    await expect(call.submitFinal(generation, { utteranceId: "item-7", text: "  hello  " })).resolves.toBe(true);
    await expect(call.submitFinal(generation, { utteranceId: "item-7", text: "hello" })).resolves.toBe(false);
    expect(bridge.submit).toHaveBeenCalledOnce();
    expect(bridge.submit).toHaveBeenCalledWith(expect.objectContaining({
      callId: "call-1", utteranceId: "item-7", idempotencyKey: "call-1:item-7", text: "hello", generation,
    }));
  });

  it("rejects stale callbacks after reconnect", async () => {
    const { bridge, call, generation } = setup();
    const next = call.reconnecting(generation);
    expect(next).toBe(generation + 1);
    expect(call.reconnect(next!)).toBe(true);
    expect(call.connected(next!)).toBe(true);
    await expect(call.submitFinal(generation, { utteranceId: "stale", text: "must not run" })).resolves.toBe(false);
    expect(call.markSpeaking(generation)).toBe(false);
    expect(bridge.submit).not.toHaveBeenCalled();
  });

  it("barge-in aborts the active request, advances generation and interrupts the durable path once", async () => {
    let requestSignal: AbortSignal | undefined;
    const bridge: DurableVoiceTurnBridge = {
      submit: vi.fn(async (request) => { requestSignal = request.signal; await new Promise<void>(() => {}); }),
      interrupt: vi.fn(async () => {}),
    };
    const call = new VoiceCallStateMachine("call-2", bridge);
    const generation = call.start();
    call.connected(generation);
    void call.submitFinal(generation, { utteranceId: "item-1", text: "do it" });
    await Promise.resolve();
    const next = await call.bargeIn(generation);
    expect(next).toBe(generation + 1);
    expect(requestSignal?.aborted).toBe(true);
    expect(bridge.interrupt).toHaveBeenCalledWith({ callId: "call-2", generation });
    expect(call.snapshot.state).toBe("listening");
    expect(await call.bargeIn(generation)).toBeNull();
    expect(bridge.interrupt).toHaveBeenCalledOnce();
  });

  it("a stale failed submission cannot move a reconnected call to error", async () => {
    let reject!: (error: Error) => void;
    const bridge: DurableVoiceTurnBridge = {
      submit: vi.fn(() => new Promise<void>((_resolve, failure) => { reject = failure; })),
      interrupt: vi.fn(async () => {}),
    };
    const call = new VoiceCallStateMachine("call-stale", bridge);
    const generation = call.start();
    call.connected(generation);
    const pending = call.submitFinal(generation, { utteranceId: "item-stale", text: "old" });
    await Promise.resolve();
    const next = call.reconnecting(generation)!;
    call.reconnect(next);
    call.connected(next);
    reject(new Error("late provider failure"));
    await expect(pending).resolves.toBe(false);
    expect(call.snapshot.state).toBe("listening");
    expect(call.snapshot.generation).toBe(next);
  });

  it("ending fences every later callback", async () => {
    const { bridge, call, generation } = setup();
    call.end();
    expect(call.connected(generation)).toBe(false);
    expect(call.markSpeaking(generation)).toBe(false);
    await expect(call.submitFinal(generation, { utteranceId: "late", text: "late" })).resolves.toBe(false);
    expect(bridge.submit).not.toHaveBeenCalled();
    expect(call.snapshot.state).toBe("ended");
  });

  it("surfaces actionable microphone failures", () => {
    const denied = classifyMicrophoneError(new DOMException("no", "NotAllowedError"));
    expect(denied.code).toBe("microphone-permission-denied");
    expect(denied.retryable).toBe(false);
    expect(denied.action).toContain("system settings");
    const busy = classifyMicrophoneError(new DOMException("busy", "NotReadableError"));
    expect(busy.code).toBe("microphone-busy");
    expect(busy.retryable).toBe(true);
  });

  it("fails closed on an impossible lifecycle transition", () => {
    const bridge: DurableVoiceTurnBridge = { submit: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) };
    const call = new VoiceCallStateMachine("call-3", bridge);
    expect(() => call.markSpeaking(0)).toThrow("cannot move");
    expect(call.snapshot.state).toBe("error");
    expect(call.snapshot.error?.code).toBe("invalid-transition");
  });
});
