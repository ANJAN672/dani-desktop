export interface PriceEvidence {
  source: string;
  observedAt: string;
  expiresAt: string;
  quote: string;
}

/** `open` models may receive private user content. */
export type PrivacyClass = "open" | "may-train" | "trial-only";
export type FreeUpstream = "zen" | "kilo" | "mimo";

export interface FreeModel {
  /** Stable, Dani-owned ID. */
  id: string;
  label: string;
  upstream: FreeUpstream;
  /** The upstream's model identifier. */
  wireId: string;
  contextWindow: number;
  privacy: PrivacyClass;
  evidence: PriceEvidence;
}

export interface FreeCatalog {
  version: number;
  generatedAt: string;
  /** The entire catalog fails closed after this date. */
  expiresAt: string;
  models: readonly FreeModel[];
}

export const UPSTREAM_BASE: Readonly<Record<FreeUpstream, string>> = {
  zen: "https://opencode.ai/zen/v1",
  kilo: "https://api.kilo.ai/api/gateway",
  mimo: "https://api.mimo.ai/v1",
};
export const CHAT_PATH = "/chat/completions";

const OBSERVED = "2026-09-18";
const EXPIRES = "2026-10-18";
const zenEvidence = (quote: string): PriceEvidence => ({
  source: "https://opencode.ai/docs/zen/",
  observedAt: OBSERVED,
  expiresAt: EXPIRES,
  quote,
});

/**
 * Entries require provider-owned pricing and privacy evidence. Kilo and MiMo
 * stay absent until equivalent evidence exists: a route that cannot prove a
 * zero price must never be made available.
 */
export const FREE_CATALOG: FreeCatalog = {
  version: 1,
  generatedAt: OBSERVED,
  expiresAt: EXPIRES,
  models: [
    {
      id: "dani-free/union-alpha",
      label: "Union Alpha",
      upstream: "zen",
      wireId: "union-alpha",
      contextWindow: 200_000,
      privacy: "open",
      evidence: zenEvidence("Free. Zero retention; inputs are not used for training."),
    },
    {
      id: "dani-free/mimo-v2.5-free",
      label: "MiMo v2.5",
      upstream: "zen",
      wireId: "mimo-v2.5-free",
      contextWindow: 256_000,
      privacy: "may-train",
      evidence: zenEvidence("Free for a limited time. Data may be used to improve the model."),
    },
    {
      id: "dani-free/ling-3.0-flash-fin-free",
      label: "Ling 3.0 Flash",
      upstream: "zen",
      wireId: "ling-3.0-flash-fin-free",
      contextWindow: 128_000,
      privacy: "may-train",
      evidence: zenEvidence("Free for a limited time. Data may be used to improve the model."),
    },
    {
      id: "dani-free/big-pickle",
      label: "Big Pickle",
      upstream: "zen",
      wireId: "big-pickle",
      contextWindow: 200_000,
      privacy: "may-train",
      evidence: zenEvidence("Free for a limited time. Data may be used to improve the model."),
    },
    {
      id: "dani-free/nemotron-3-ultra-free",
      label: "Nemotron 3 Ultra",
      upstream: "zen",
      wireId: "nemotron-3-ultra-free",
      contextWindow: 128_000,
      privacy: "trial-only",
      evidence: zenEvidence("Free. Trial use only — do not submit personal or confidential data."),
    },
    {
      id: "dani-free/nemotron-3.5-lightning-free",
      label: "Nemotron 3.5 Lightning",
      upstream: "zen",
      wireId: "nemotron-3.5-lightning-free",
      contextWindow: 128_000,
      privacy: "trial-only",
      evidence: zenEvidence("Free. Trial use only — do not submit personal or confidential data."),
    },
    {
      id: "dani-free/muse-spark-1.3-contributor-free",
      label: "Muse Spark 1.3",
      upstream: "zen",
      wireId: "muse-spark-1.3-contributor-free",
      contextWindow: 128_000,
      privacy: "may-train",
      evidence: zenEvidence("Free. Prompts and completions may be used to train Meta models."),
    },
  ],
};

export function liveUpstreams(catalog: FreeCatalog): readonly FreeUpstream[] {
  const seen = new Set(catalog.models.map((model) => model.upstream));
  return (["zen", "kilo", "mimo"] as const).filter((upstream) => seen.has(upstream));
}
