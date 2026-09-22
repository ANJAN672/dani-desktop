export const OPENCODE_MODEL_ONLY_TOOLS: Readonly<Record<string, false>>;
export function buildOpenCodePrompt(input: {
  providerID: string;
  modelID: string;
  system: string;
  transcript: string;
}): {
  model: { providerID: string; modelID: string };
  system?: string;
  tools: typeof OPENCODE_MODEL_ONLY_TOOLS;
  parts: Array<{ type: "text"; text: string }>;
};
