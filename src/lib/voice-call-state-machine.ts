export type VoiceCallState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "reconnecting"
  | "ended"
  | "error";

export type VoiceCallErrorCode =
  | "microphone-permission-denied"
  | "microphone-not-found"
  | "microphone-busy"
  | "credential-expired"
  | "network-disconnected"
  | "provider-failed"
  | "unsupported-mode"
  | "invalid-transition";

const ERROR_DETAILS: Record<VoiceCallErrorCode, { retryable: boolean; action: string }> = {
  "microphone-permission-denied": { retryable: false, action: "Allow microphone access in system settings, then try again." },
  "microphone-not-found": { retryable: false, action: "Connect or enable a microphone, then try again." },
  "microphone-busy": { retryable: true, action: "Close the other app using the microphone, then retry." },
  "credential-expired": { retryable: true, action: "Reconnect to create a fresh call credential." },
  "network-disconnected": { retryable: true, action: "Check the network connection while Dani reconnects." },
  "provider-failed": { retryable: true, action: "Retry the call. If it fails again, check the voice provider status." },
  "unsupported-mode": { retryable: false, action: "Choose an available voice mode." },
  "invalid-transition": { retryable: false, action: "End this call and start a new one." },
};

export class VoiceCallError extends Error {
  readonly retryable: boolean;
  readonly action: string;

  constructor(readonly code: VoiceCallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceCallError";
    this.retryable = ERROR_DETAILS[code].retryable;
    this.action = ERROR_DETAILS[code].action;
  }
}

export interface FinalVoiceUtterance {
  /** Provider item id. It must remain stable when an event is replayed after reconnect. */
  utteranceId: string;
  text: string;
}

export interface DurableVoiceTurnRequest {
  callId: string;
  utteranceId: string;
  /** Stable across reconnect and provider-event replay. */
  idempotencyKey: string;
  text: string;
  generation: number;
  signal: AbortSignal;
}

export interface DurableVoiceTurnBridge {
  submit(request: DurableVoiceTurnRequest): Promise<void>;
  /** Must cancel the same durable turn generation used by text interrupt. */
  interrupt(input: { callId: string; generation: number }): Promise<void>;
}

export type VoiceCallSnapshot = Readonly<{
  callId: string;
  state: VoiceCallState;
  generation: number;
  error?: VoiceCallError;
}>;

type Listener = (snapshot: VoiceCallSnapshot) => void;

const ALLOWED: Record<VoiceCallState, ReadonlySet<VoiceCallState>> = {
  idle: new Set(["connecting", "ended"]),
  connecting: new Set(["listening", "reconnecting", "error", "ended"]),
  listening: new Set(["thinking", "speaking", "reconnecting", "error", "ended"]),
  thinking: new Set(["listening", "speaking", "reconnecting", "error", "ended"]),
  speaking: new Set(["listening", "thinking", "reconnecting", "error", "ended"]),
  reconnecting: new Set(["connecting", "listening", "error", "ended"]),
  error: new Set(["reconnecting", "ended"]),
  ended: new Set(),
};

/**
 * The single lifecycle and replay boundary for a voice call. Media adapters may
 * report state and final utterances, but they cannot dispatch turns directly.
 */
export class VoiceCallStateMachine {
  private state: VoiceCallState = "idle";
  private generation = 0;
  private error: VoiceCallError | undefined;
  private listeners = new Set<Listener>();
  private submitted = new Set<string>();
  private activeTurn: AbortController | null = null;

  constructor(readonly callId: string, private bridge: DurableVoiceTurnBridge) {
    if (!callId.trim()) throw new Error("A voice call requires a call id");
  }

  get snapshot(): VoiceCallSnapshot {
    return { callId: this.callId, state: this.state, generation: this.generation, ...(this.error ? { error: this.error } : {}) };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  /** A captured generation is required on asynchronous media/provider callbacks. */
  isCurrent(generation: number): boolean {
    return generation === this.generation && this.state !== "ended";
  }

  start(): number {
    this.transition("connecting");
    return ++this.generation;
  }

  connected(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.transition("listening");
    return true;
  }

  reconnecting(generation: number): number | null {
    if (!this.isCurrent(generation)) return null;
    this.transition("reconnecting");
    this.activeTurn?.abort(new DOMException("Voice transport reconnecting", "AbortError"));
    this.activeTurn = null;
    return ++this.generation;
  }

  reconnect(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.transition("connecting");
    return true;
  }

  markSpeaking(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.transition("speaking");
    return true;
  }

  markListening(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.transition("listening");
    return true;
  }

  async submitFinal(generation: number, utterance: FinalVoiceUtterance): Promise<boolean> {
    if (!this.isCurrent(generation)) return false;
    const utteranceId = utterance.utteranceId.trim();
    const text = utterance.text.trim();
    if (!utteranceId || !text) return false;
    const idempotencyKey = `${this.callId}:${utteranceId}`;
    if (this.submitted.has(idempotencyKey)) return false;
    this.submitted.add(idempotencyKey);
    const controller = new AbortController();
    this.activeTurn?.abort(new DOMException("Superseded by the next final utterance", "AbortError"));
    this.activeTurn = controller;
    this.transition("thinking");
    try {
      await this.bridge.submit({ callId: this.callId, utteranceId, idempotencyKey, text, generation, signal: controller.signal });
      if (this.activeTurn === controller) this.activeTurn = null;
      return true;
    } catch (error) {
      if (this.activeTurn === controller) this.activeTurn = null;
      if (controller.signal.aborted || !this.isCurrent(generation)) return false;
      this.fail("provider-failed", "The voice turn failed before completion.", error);
      return false;
    }
  }

  async bargeIn(generation: number): Promise<number | null> {
    if (!this.isCurrent(generation) || (this.state !== "thinking" && this.state !== "speaking")) return null;
    const interruptedGeneration = this.generation;
    this.activeTurn?.abort(new DOMException("Voice turn interrupted", "AbortError"));
    this.activeTurn = null;
    const nextGeneration = ++this.generation;
    this.transition("listening");
    await this.bridge.interrupt({ callId: this.callId, generation: interruptedGeneration });
    return nextGeneration;
  }

  fail(code: VoiceCallErrorCode, message: string, cause?: unknown): void {
    if (this.state === "ended") return;
    this.error = new VoiceCallError(code, message, cause === undefined ? undefined : { cause });
    this.transition("error");
  }

  end(): void {
    if (this.state === "ended") return;
    ++this.generation;
    this.activeTurn?.abort(new DOMException("Voice call ended", "AbortError"));
    this.activeTurn = null;
    this.transition("ended");
    this.listeners.clear();
  }

  private transition(next: VoiceCallState): void {
    if (next === this.state) return;
    if (!ALLOWED[this.state].has(next)) {
      const error = new VoiceCallError("invalid-transition", `Voice call cannot move from ${this.state} to ${next}.`);
      this.error = error;
      if (this.state !== "ended") this.state = "error";
      this.emit();
      throw error;
    }
    this.state = next;
    if (next !== "error") this.error = undefined;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function classifyMicrophoneError(error: unknown): VoiceCallError {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new VoiceCallError("microphone-permission-denied", "Microphone access was denied.", { cause: error });
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return new VoiceCallError("microphone-not-found", "No microphone is available.", { cause: error });
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return new VoiceCallError("microphone-busy", "The microphone is already in use or unavailable.", { cause: error });
  }
  return new VoiceCallError("provider-failed", "The microphone could not start.", { cause: error });
}
