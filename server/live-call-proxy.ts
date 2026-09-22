import { z } from "zod";

const requestSchema = z.object({
  conversationId: z.string().min(1).max(200),
  participants: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200), instructions: z.string().max(8_000).optional(), voice: z.string().max(200).optional() })).min(1).max(16),
  inputLanguage: z.string().max(32).optional(),
  outputLanguage: z.string().max(32).optional(),
}).strict();
const responseSchema = z.object({
  id: z.string().min(1),
  provider: z.literal("openai-realtime"),
  endpoint: z.string().url(),
  ephemeralToken: z.string().min(1),
  expiresAt: z.number().int().positive().optional(),
}).strict();

export function validateLiveCallProxyUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Live-call proxy must use HTTPS");
  if (url.username || url.password || url.hash) throw new Error("Live-call proxy URL cannot contain credentials or a fragment");
  return url;
}

/** Ask the configured OAuth proxy for short-lived Realtime session material.
 * The desktop stores no OpenAI access token and never receives refresh tokens.
 */
export async function createOpenAIRealtimeSession(proxyUrl: string, input: unknown, fetchImpl: typeof fetch = fetch) {
  const request = requestSchema.parse(input);
  const url = validateLiveCallProxyUrl(proxyUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Live-call proxy returned HTTP ${response.status}`);
  const session = responseSchema.parse(body);
  const endpoint = new URL(session.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("Realtime session endpoint must use HTTPS");
  if (session.expiresAt !== undefined && session.expiresAt <= Date.now()) throw new Error("Realtime session already expired");
  return session;
}

const openAIClientSecretSchema = z.object({
  value: z.string().min(1),
  expires_at: z.number().int().positive(),
  session: z.object({ id: z.string().min(1).optional() }).passthrough().optional(),
}).passthrough();

/** Mint one short-lived Realtime client secret in the trusted harness process.
 * The long-lived BYOK key is used only in the Authorization header and is
 * never included in the return value, response errors, or renderer state. */
export async function createOpenAIRealtimeByokSession(
  apiKey: string,
  input: unknown,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
) {
  const request = requestSchema.parse(input);
  const key = apiKey.trim();
  if (!key) throw new Error("OpenAI Realtime API key is not configured");
  const response = await fetchImpl("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: "gpt-realtime",
        output_modalities: ["audio"],
        instructions: request.participants.map((participant) => participant.instructions).filter(Boolean).join("\n\n") || undefined,
        audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad", create_response: false, interrupt_response: false } } },
      },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`OpenAI Realtime credential service returned HTTP ${response.status}`);
  const secret = openAIClientSecretSchema.parse(body);
  const expiresAt = secret.expires_at * 1_000;
  if (expiresAt <= now) throw new Error("OpenAI Realtime credential service returned an expired client secret");
  return {
    id: secret.session?.id ?? `realtime-${secret.expires_at}`,
    provider: "openai-realtime" as const,
    endpoint: "https://api.openai.com/v1/realtime/calls",
    ephemeralToken: secret.value,
    expiresAt,
  };
}
