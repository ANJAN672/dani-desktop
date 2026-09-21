import { describe, expect, it, vi } from "vitest";
import { HttpVoiceTurnBridge } from "./voice-turn-bridge";

describe("HttpVoiceTurnBridge", () => {
  it("uses the ordinary idempotent message route for final speech", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }));
    const bridge = new HttpVoiceTurnBridge("bot one", "thread-1", fetchImpl as typeof fetch);
    const controller = new AbortController();
    await bridge.submit({ callId: "call-1", utteranceId: "item-1", idempotencyKey: "call-1:item-1", text: "hello", generation: 1, signal: controller.signal });
    expect(fetchImpl).toHaveBeenCalledWith("/api/bots/bot%20one/messages", expect.objectContaining({
      method: "POST", signal: controller.signal,
      body: JSON.stringify({ text: "hello", threadId: "thread-1", sendId: "call-1:item-1" }),
    }));
  });

  it("uses the ordinary kernel-backed interrupt route for barge-in", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const bridge = new HttpVoiceTurnBridge("bot-1", "thread-1", fetchImpl as typeof fetch);
    await bridge.interrupt({ callId: "call-1", generation: 4 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/bots/bot-1/interrupt", expect.objectContaining({
      method: "POST", body: JSON.stringify({ threadId: "thread-1" }),
    }));
  });

  it("surfaces server failures instead of pretending a voice turn landed", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Hermes unavailable" }), { status: 409 }));
    const bridge = new HttpVoiceTurnBridge("bot-1", "thread-1", fetchImpl as typeof fetch);
    await expect(bridge.submit({ callId: "call-1", utteranceId: "item-1", idempotencyKey: "call-1:item-1", text: "hello", generation: 1, signal: new AbortController().signal })).rejects.toThrow("Hermes unavailable");
  });
});
