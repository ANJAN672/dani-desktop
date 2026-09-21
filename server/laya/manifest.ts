/**
 * Pinned Laya checkpoint manifest (spec 100 slice 1 / R1). Every value here
 * was fetched live from the Hugging Face API on 2026-09-22 and is recorded
 * with its evidence in specs/100-laya-decision-service.md. Update only by
 * re-pinning against the live API and amending the spec.
 */

export interface LayaManifestFile {
  /** Path inside the hub repo. */
  path: string;
  bytes: number;
  /** LFS sha256 for large payloads; git blob sha for small files. */
  sha256?: string;
  gitBlob?: string;
}

export interface LayaCheckpointPin {
  repo: string;
  revision: string;
  subfolder: string;
  encoder: string;
  params: string;
  contextTokens: number;
  files: LayaManifestFile[];
  /** Sum of weights + tokenizer bytes the host must download. */
  downloadBytes: number;
}

export const LAYA_HUB_REPO = "convaiinnovations/laya";
export const LAYA_PINNED_REVISION = "1c5edc17a7acd8701df6fc341c0d179f1c62c982";
export const LAYA_LICENSE = "apache-2.0";

export const LAYA_SDK = {
  package: "laya",
  version: "0.3.5",
  wheelSha256: "4c57f64cbaf893bb5c7b4affddc2bf21a819f55df51941689f11868583be2903",
  requires: ["torch>=2.0.0", "transformers>=4.48.0", "safetensors>=0.4.0", "huggingface_hub>=0.20.0", "numpy>=1.20.0"],
} as const;

/** Default DANI checkpoint: typed-decisions (1024-token context, trained for
 * the typed-decision workflows the DecisionProvider contract issues). */
export const LAYA_TYPED_DECISIONS: LayaCheckpointPin = {
  repo: LAYA_HUB_REPO,
  revision: LAYA_PINNED_REVISION,
  subfolder: "typed-decisions",
  encoder: "answerdotai/ModernBERT-large",
  params: "421M",
  contextTokens: 1024,
  files: [
    { path: "typed-decisions/model.safetensors", bytes: 842_609_220, sha256: "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e" },
    { path: "typed-decisions/tokenizer/tokenizer.json", bytes: 3_583_228, gitBlob: "2f4d8583e507b7466d2490e2d6c045647a822698" },
    { path: "typed-decisions/tokenizer/tokenizer_config.json", bytes: 337, gitBlob: "ed1ffabc2ce11120754705709569e365e46da71a" },
    { path: "typed-decisions/encoder/config.json", bytes: 2_084, gitBlob: "d4be4829750fb04c0aa8b9897c3ea827f76c0109" },
    { path: "typed-decisions/rl_agent_config.json", bytes: 847, gitBlob: "5f0e1d5f2366fe8ba2ff330dffaeed53b469e97e" },
  ],
  downloadBytes: 842_609_220 + 3_583_228 + 337 + 2_084 + 847,
};

/** English root checkpoint (512-token context). Pinned, not the default. */
export const LAYA_ENGLISH: LayaCheckpointPin = {
  repo: LAYA_HUB_REPO,
  revision: LAYA_PINNED_REVISION,
  subfolder: "",
  encoder: "answerdotai/ModernBERT-large",
  params: "421M",
  contextTokens: 512,
  files: [
    { path: "model.safetensors", bytes: 842_609_210, sha256: "891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c" },
    { path: "tokenizer/tokenizer.json", bytes: 3_583_228, gitBlob: "2f4d8583e507b7466d2490e2d6c045647a822698" },
    { path: "tokenizer/tokenizer_config.json", bytes: 308, gitBlob: "9fd800115c5c92353220aa66addfce67a9135f32" },
    { path: "encoder/config.json", bytes: 2_083, gitBlob: "5881ba831f2db5ce0f606bbaa1f2668e1e6cb706" },
    { path: "rl_agent_config.json", bytes: 745, gitBlob: "3e4fcbf12cf36164ce18a1398aa9f35f58375ae0" },
  ],
  downloadBytes: 842_609_210 + 3_583_228 + 308 + 2_083 + 745,
};

/** Multilingual checkpoint (mmBERT-base, 100+ languages). Pinned, not default. */
export const LAYA_MULTILINGUAL: LayaCheckpointPin = {
  repo: LAYA_HUB_REPO,
  revision: LAYA_PINNED_REVISION,
  subfolder: "multilingual",
  encoder: "mmBERT-base",
  params: "322M",
  contextTokens: 1024,
  files: [
    { path: "multilingual/model.safetensors", bytes: 643_835_514, sha256: "9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204" },
    { path: "multilingual/tokenizer/tokenizer.json", bytes: 34_363_188, sha256: "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f" },
    { path: "multilingual/tokenizer/tokenizer_config.json", bytes: 524, gitBlob: "c255ac0c8cb34a37d066cd0dafe313fd769d27ae" },
    { path: "multilingual/encoder/config.json", bytes: 1_938, gitBlob: "0de0e2d30638873790cf962def52e2acf4db3eef" },
    { path: "multilingual/rl_agent_config.json", bytes: 472, gitBlob: "00e35f88bb731bb9126a914666ab1cdac8a204c8" },
  ],
  downloadBytes: 643_835_514 + 34_363_188 + 524 + 1_938 + 472,
};

export const LAYA_CHECKPOINTS: LayaCheckpointPin[] = [LAYA_TYPED_DECISIONS, LAYA_ENGLISH, LAYA_MULTILINGUAL];

export function layaCheckpointBySubfolder(subfolder: string): LayaCheckpointPin | null {
  return LAYA_CHECKPOINTS.find((c) => c.subfolder === subfolder) ?? null;
}
