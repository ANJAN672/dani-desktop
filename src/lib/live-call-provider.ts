/** Provider-neutral contracts for low-latency, two-way voice calls.
 *
 * This is deliberately transport foundation, not a promise that local duplex
 * inference is ready on every desktop target. Providers own authentication
 * and session creation; the renderer receives only short-lived session data.
 */
export type LiveCallProviderId = "local" | "openai-realtime";

export interface LiveCallProviderDescriptor {
  id: LiveCallProviderId;
  label: string;
  privacy: "on-device" | "cloud";
  available: boolean;
  unavailableReason?: string;
}

export interface LiveCallParticipant {
  id: string;
  name: string;
  instructions?: string;
  voice?: string;
}

export interface LiveCallSessionRequest {
  conversationId: string;
  participants: LiveCallParticipant[];
  inputLanguage?: string;
  outputLanguage?: string;
}

export interface LiveCallSession {
  id: string;
  provider: LiveCallProviderId;
  /** SDP exchange endpoint for WebRTC providers. */
  endpoint?: string;
  /** Short-lived token only. Long-lived provider credentials stay server-side. */
  ephemeralToken?: string;
  expiresAt?: number;
}

export type LiveCallEvent =
  | { type: "state"; state: "connecting" | "connected" | "ended" }
  | { type: "transcript"; utteranceId?: string; speakerId?: string; text: string; final: boolean }
  | { type: "error"; message: string; retryable: boolean; code?: string };

export interface LiveCallTransport {
  connect(session: LiveCallSession, microphone: MediaStream): Promise<MediaStream>;
  sendText(text: string): void;
  interrupt(): void;
  close(): void;
  subscribe(listener: (event: LiveCallEvent) => void): () => void;
}

export interface LiveCallProvider {
  readonly descriptor: LiveCallProviderDescriptor;
  createSession(request: LiveCallSessionRequest, signal?: AbortSignal): Promise<LiveCallSession>;
  createTransport(): LiveCallTransport;
}

export const LIVE_CALL_PROVIDERS: ReadonlyArray<Pick<LiveCallProviderDescriptor, "id" | "label" | "privacy">> = [
  { id: "local", label: "On-device (preview)", privacy: "on-device" },
  { id: "openai-realtime", label: "OpenAI Live (OAuth proxy)", privacy: "cloud" },
];

/** Validate session material at the trust boundary before opening media. */
export function validateLiveCallSession(value: LiveCallSession, now = Date.now()): LiveCallSession {
  if (!value.id.trim()) throw new Error("Live-call session is missing an id");
  if (!LIVE_CALL_PROVIDERS.some((provider) => provider.id === value.provider)) {
    throw new Error("Unsupported live-call provider");
  }
  if (value.expiresAt !== undefined && value.expiresAt <= now) {
    throw new Error("Live-call session has expired");
  }
  if (value.provider === "openai-realtime" && (!value.endpoint || !value.ephemeralToken)) {
    throw new Error("Cloud live-call session is missing short-lived connection data");
  }
  return value;
}

/** Renderer provider for the optional OAuth proxy. Long-lived credentials
 * stay outside the app; this call returns only one short-lived session. */
export class OpenAIRealtimeProvider implements LiveCallProvider {
  readonly descriptor: LiveCallProviderDescriptor;
  constructor(private proxyConfigured: boolean, private transportFactory: () => LiveCallTransport) {
    this.descriptor = { id: "openai-realtime", label: "OpenAI Live (OAuth proxy)", privacy: "cloud", available: proxyConfigured, ...(!proxyConfigured ? { unavailableReason: "Configure the OpenAI Realtime OAuth proxy first." } : {}) };
  }
  async createSession(request: LiveCallSessionRequest, signal?: AbortSignal): Promise<LiveCallSession> {
    if (!this.proxyConfigured) throw new Error(this.descriptor.unavailableReason);
    const response = await fetch("/api/live-call/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Live-call proxy returned ${response.status}`);
    return validateLiveCallSession(body);
  }
  createTransport() { return this.transportFactory(); }
}
