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
