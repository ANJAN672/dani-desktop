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

describe("OpenAI Realtime BYOK", () => {
  it("mints a short-lived token without returning or serializing the long-lived key", async () => {
    const longLived = "sk-realtime-fixture-never-return";
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${longLived}` }));
      expect(String(init?.body)).not.toContain(longLived);
      return new Response(JSON.stringify({ value: "ek-short-lived", expires_at: 2_000_000_000, session: { id: "sess-byok" } }), { status: 200 });
    });
    const { createOpenAIRealtimeByokSession } = await import("./live-call-proxy.ts");
    const session = await createOpenAIRealtimeByokSession(longLived, request, fetchImpl as typeof fetch, 1_000);
    expect(session).toEqual({ id: "sess-byok", provider: "openai-realtime", endpoint: "https://api.openai.com/v1/realtime/calls", ephemeralToken: "ek-short-lived", expiresAt: 2_000_000_000_000 });
    expect(JSON.stringify(session)).not.toContain(longLived);
  });

  it("never includes provider error bodies or the long-lived key in errors", async () => {
    const longLived = "sk-realtime-fixture-error";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: `bad ${longLived}` } }), { status: 401 }));
    const { createOpenAIRealtimeByokSession } = await import("./live-call-proxy.ts");
    await expect(createOpenAIRealtimeByokSession(longLived, request, fetchImpl as typeof fetch)).rejects.toThrow("HTTP 401");
    try { await createOpenAIRealtimeByokSession(longLived, request, fetchImpl as typeof fetch); } catch (error) { expect(String(error)).not.toContain(longLived); }
  });
});
