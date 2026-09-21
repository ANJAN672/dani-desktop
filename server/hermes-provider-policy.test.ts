import { describe, expect, it } from "vitest";
import { classifyHermesError, hermesProviderCapability } from "./hermes-provider-policy.ts";

describe("Hermes provider capability and error policy", () => {
  it("reports known quota and billing ownership without inventing model features", () => {
    expect(hermesProviderCapability("openrouter:qwen/model")).toEqual({
      provider: "openrouter", vision: "unknown", quota: "provider-managed", billing: "metered",
    });
    expect(hermesProviderCapability("ollama:llama3").quota).toBe("local");
  });
  it("classifies quota, auth, timeout and unknown failures", () => {
    expect(classifyHermesError(new Error("429 quota exceeded"))).toBe("quota_or_region_restriction");
    expect(classifyHermesError(new Error("401 Unauthorized"))).toBe("invalid_credentials");
    expect(classifyHermesError(new Error("deadline exceeded"))).toBe("upstream_outage");
    expect(classifyHermesError(new Error("bad response"))).toBeUndefined();
  });
});
