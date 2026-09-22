import type { ProviderErrorCode } from "./contracts.ts";

export type HermesProviderCapability = {
  provider: string;
  contextWindow?: number;
  vision: "supported" | "unsupported" | "unknown";
  quota: "provider-managed" | "local" | "unknown";
  billing: "metered" | "subscription" | "local" | "unknown";
};

const CAPABILITIES: Readonly<Record<string, HermesProviderCapability>> = Object.freeze({
  openrouter: { provider: "openrouter", vision: "unknown", quota: "provider-managed", billing: "metered" },
  nous: { provider: "nous", vision: "unknown", quota: "provider-managed", billing: "subscription" },
  ollama: { provider: "ollama", vision: "unknown", quota: "local", billing: "local" },
  lmstudio: { provider: "lmstudio", vision: "unknown", quota: "local", billing: "local" },
  vllm: { provider: "vllm", vision: "unknown", quota: "local", billing: "local" },
});

export function hermesProviderCapability(modelId: string | undefined): HermesProviderCapability {
  // The managed runtime owns this reserved alias and only reports task-ready
  // after probing the exact zero-cost OpenCode route. It is therefore local
  // for spend gating even though the user-facing Hermes session keeps the
  // configured-model alias rather than exposing the supporting route.
  if (modelId === "hermes-default" && Boolean(process.env.DANI_MANAGED_HERMES_EXECUTABLE && process.env.DANI_MANAGED_OPENCODE_EXECUTABLE)) {
    return { provider: "managed-opencode", vision: "unknown", quota: "local", billing: "local" };
  }
  const provider = modelId?.split(":", 1)[0]?.toLowerCase() || "unknown";
  return CAPABILITIES[provider] ?? { provider, vision: "unknown", quota: "unknown", billing: "unknown" };
}

export function classifyHermesError(error: unknown): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(401|invalid api key|unauthori[sz]ed)\b/i.test(message)) return "invalid_credentials";
  if (/\b(402|subscription inactive|payment required)\b/i.test(message)) return "inactive_subscription";
  if (/\b(429|rate.?limit|quota exceeded)\b/i.test(message)) return "quota_or_region_restriction";
  if (/\b(timeout|timed out|deadline exceeded)\b/i.test(message)) return "upstream_outage";
  return undefined;
}
