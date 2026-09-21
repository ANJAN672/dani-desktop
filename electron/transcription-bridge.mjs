import { assemblyAICredential, mintAssemblyAIStreamingToken } from "./assemblyai.mjs";

export function transcriptionStatus(credentials, env = process.env) {
  return { configured: Boolean(assemblyAICredential(credentials, env)) };
}

export function withTranscriptionKey(credentials, value) {
  if (typeof value !== "string") throw new Error("AssemblyAI key must be text");
  const secret = value.trim();
  const next = { ...credentials };
  if (secret) next.assemblyAiApiKey = secret;
  else delete next.assemblyAiApiKey;
  return next;
}

export async function transcriptionStreamingToken(credentials, env = process.env, options = {}) {
  return mintAssemblyAIStreamingToken(assemblyAICredential(credentials, env), options);
}
