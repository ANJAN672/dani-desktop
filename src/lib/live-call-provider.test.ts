import { describe, expect, it } from "vitest";
import { validateLiveCallSession } from "./live-call-provider";

describe("validateLiveCallSession", () => {
  it("accepts a local session without cloud connection material", () => {
    expect(validateLiveCallSession({ id: "local-1", provider: "local" }).id).toBe("local-1");
  });
  it("requires short-lived material for cloud sessions", () => {
    expect(() => validateLiveCallSession({ id: "cloud-1", provider: "openai-realtime" })).toThrow("short-lived");
  });
  it("rejects expired sessions", () => {
    expect(() => validateLiveCallSession({ id: "local-1", provider: "local", expiresAt: 9 }, 10)).toThrow("expired");
  });
});
