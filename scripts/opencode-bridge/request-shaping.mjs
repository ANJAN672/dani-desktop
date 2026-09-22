// The OpenCode process is a supporting model route, not Dani's tool harness.
// Hermes owns tools, permissions, and the working directory. If OpenCode tools
// stay enabled, a free model can pause its HTTP response on an OpenCode-native
// permission request that no UI is connected to answer.
export const OPENCODE_MODEL_ONLY_TOOLS = Object.freeze({
  invalid: false,
  question: false,
  bash: false,
  read: false,
  glob: false,
  grep: false,
  edit: false,
  write: false,
  task: false,
  webfetch: false,
  todowrite: false,
  websearch: false,
  skill: false,
  apply_patch: false,
});

export function buildOpenCodePrompt({ providerID, modelID, system, transcript }) {
  return {
    model: { providerID, modelID },
    ...(system ? { system } : {}),
    tools: OPENCODE_MODEL_ONLY_TOOLS,
    parts: [{ type: 'text', text: transcript }],
  };
}
