import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

function makeRuntime(apiKey: string) {
  return createOpenAIChatRuntime({
    input: {
      instanceId: "test-key-engine",
      displayName: "Test Engine",
      enabled: true,
      config: {},
      environment: {},
    },
    driverKind: "test-engine",
    apiKey,
    apiUrl: "https://provider.example/v1",
    models: () => ({ default: "m", options: [] }),
    requestBody: (model, messages, stream) => ({ model, messages, stream }),
    httpErrorLabel: "Test Provider",
    missingKeyError: "no key",
    unavailableReason: "no key saved",
    timeoutMs: 5_000,
    nativeLog: {
      source: "test",
      outgoing: () => ({}),
      incoming: () => ({}),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("key verification (spec 040 R2)", () => {
  it("starts unverified - a stored key alone never reads as verified", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const instance = makeRuntime("saved-key");

    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.verification?.status).toBe("unverified");
    expect(snap.verification?.checkedAt).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("marks verified only after a successful authenticated probe", async () => {
    let seenAuth = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      return new Response("{}", { status: 200 });
    }));
    const instance = makeRuntime("saved-key");

    const result = await instance.verify!();
    expect(result.status).toBe("verified");
    expect(result.checkedAt).toBeTruthy();
    expect(seenAuth).toBe("Bearer saved-key");

    const snap = await instance.snapshot();
    expect(snap.verification?.status).toBe("verified");
    await instance.dispose();
  });

  it("classifies a rejected key as an auth failure with recovery guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const instance = makeRuntime("bad-key");

    const result = await instance.verify!();
    expect(result.status).toBe("failed");
    expect(result.errorClass).toBe("auth");
    expect(result.reason).toContain("rejected the saved key");
    expect(result.reason).not.toContain("bad-key");
    await instance.dispose();
  });

  it("classifies billing rejections as quota", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 402 })));
    const instance = makeRuntime("saved-key");

    const result = await instance.verify!();
    expect(result.status).toBe("failed");
    expect(result.errorClass).toBe("quota");
    await instance.dispose();
  });

  it("classifies an unreachable host as a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    const instance = makeRuntime("saved-key");

    const result = await instance.verify!();
    expect(result.status).toBe("failed");
    expect(result.errorClass).toBe("network");
    expect(result.reason).toContain("Could not reach");
    await instance.dispose();
  });

  it("dedupes concurrent verify calls into one probe", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("{}", { status: 200 });
    }));
    const instance = makeRuntime("saved-key");

    const [a, b] = await Promise.all([instance.verify!(), instance.verify!()]);
    expect(calls).toBe(1);
    expect(a.status).toBe("verified");
    expect(b.status).toBe("verified");
    await instance.dispose();
  });

  it("reports unavailable without a key and never probes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const instance = makeRuntime("");

    const snap = await instance.snapshot();
    expect(snap).toMatchObject({ state: "unavailable", reason: "no key saved" });
    expect(snap.verification).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await instance.dispose();
  });
});
