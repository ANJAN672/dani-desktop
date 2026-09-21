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
