import { describe, expect, it, vi } from "vitest";
import { createOpenAIRealtimeSession, validateLiveCallProxyUrl } from "./live-call-proxy.ts";

const request = { conversationId: "thread-1", participants: [{ id: "dani", name: "Dani" }] };

describe("OpenAI Realtime OAuth proxy", () => {
  it("requires a credential-free HTTPS proxy URL", () => {
    expect(() => validateLiveCallProxyUrl("http://proxy.example/session")).toThrow("HTTPS");
    expect(() => validateLiveCallProxyUrl("https://user:secret@proxy.example/session")).toThrow("credentials");
  });
  it("returns only validated, short-lived session material", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "rt-1", provider: "openai-realtime", endpoint: "https://api.openai.com/v1/realtime/calls", ephemeralToken: "ephemeral", expiresAt: Date.now() + 60_000,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const session = await createOpenAIRealtimeSession("https://proxy.example/realtime/session", request, fetchImpl as typeof fetch);
    expect(session.id).toBe("rt-1");
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "error" }));
  });
  it("rejects malformed or already-expired proxy responses", async () => {
    const expired = vi.fn(async () => new Response(JSON.stringify({ id: "rt-1", provider: "openai-realtime", endpoint: "https://api.openai.com/realtime", ephemeralToken: "e", expiresAt: 1 }), { status: 200 }));
    await expect(createOpenAIRealtimeSession("https://proxy.example/session", request, expired as typeof fetch)).rejects.toThrow("expired");
  });
});
