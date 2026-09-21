export type DuplexVoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "reconnecting" | "stopped" | "error";

export interface StreamingStt {
  start(stream: MediaStream, onText: (text: string, final: boolean) => void, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}
export interface StreamingTts { speak(text: string, signal: AbortSignal): Promise<void>; stop(): void }
export interface DuplexTurn { send(text: string, signal: AbortSignal): Promise<AsyncIterable<string>>; interrupt(): Promise<void> }
export interface VoiceActivityDetector { start(stream: MediaStream, onSpeech: () => void, onSilence: () => void, signal: AbortSignal): Promise<void>; stop(): void }

export class EnergyVad implements VoiceActivityDetector {
  private context: AudioContext | null = null;
  private frame = 0;
  async start(stream: MediaStream, onSpeech: () => void, onSilence: () => void, signal: AbortSignal) {
    this.context = new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    const source = this.context.createMediaStreamSource(stream);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    const samples = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    let active = false;
    let silentSince = 0;
    const tick = () => {
      if (signal.aborted) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const n of samples) { const x = (n - 128) / 128; sum += x * x; }
      const speaking = Math.sqrt(sum / samples.length) > .025;
      if (speaking && !active) { active = true; onSpeech(); }
      if (active && !speaking) {
        silentSince ||= performance.now();
        if (performance.now() - silentSince > 650) { active = false; silentSince = 0; onSilence(); }
      } else if (speaking) silentSince = 0;
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }
  stop() { cancelAnimationFrame(this.frame); void this.context?.close(); this.context = null; }
}

/**
 * Owns one full-duplex call. Capture remains open while audio plays; browser
 * acoustic echo cancellation keeps playback out of STT, while speech detected
 * during playback atomically cancels both synthesis and the Hermes turn.
 */
export class DuplexVoiceController {
  state: DuplexVoiceState = "idle";
  private session: AbortController | null = null;
  private activeTurn: AbortController | null = null;
  private utterance = "";
  private turnSerial = 0;
  private submittedFinal = "";

  constructor(
    private stt: StreamingStt,
    private tts: StreamingTts,
    private vad: VoiceActivityDetector,
    private turn: DuplexTurn,
    private onState: (s: DuplexVoiceState) => void = () => {},
  ) {}

  private move(next: DuplexVoiceState) { this.state = next; this.onState(next); }

  async start(stream: MediaStream) {
    await this.stop();
    this.session = new AbortController();
    const signal = this.session.signal;
    this.move("connecting");
    try {
      await Promise.all([
        this.stt.start(stream, (text, final) => {
          this.utterance = text;
          const normalized = text.trim();
          if (final && normalized && normalized !== this.submittedFinal) {
            this.submittedFinal = normalized;
            void this.submit(normalized);
          }
        }, signal),
        this.vad.start(stream, () => void this.bargeIn(), () => {
          const normalized = this.utterance.trim();
          if (normalized && normalized !== this.submittedFinal) {
            this.submittedFinal = normalized;
            void this.submit(normalized);
          }
        }, signal),
      ]);
      if (!signal.aborted) this.move("listening");
    } catch (error) {
      if (!signal.aborted) { this.move("error"); throw error; }
    }
  }

  private async submit(text: string) {
    if (!this.session || this.session.signal.aborted || this.activeTurn) return;
    const serial = ++this.turnSerial;
    this.utterance = "";
    const controller = new AbortController();
    this.activeTurn = controller;
    const stopWithSession = () => controller.abort(this.session?.signal.reason);
    this.session.signal.addEventListener("abort", stopWithSession, { once: true });
    this.move("thinking");
    try {
      const chunks = await this.turn.send(text, controller.signal);
      if (controller.signal.aborted || serial !== this.turnSerial) return;
      this.move("speaking");
      // Awaiting every clip is deliberate backpressure: generated audio can
      // never outrun playback and grow an unbounded in-memory queue.
      for await (const chunk of chunks) {
        if (controller.signal.aborted || serial !== this.turnSerial) break;
        const value = chunk.trim();
        if (value) await this.tts.speak(value, controller.signal);
      }
      if (!controller.signal.aborted && serial === this.turnSerial) this.move("listening");
    } catch (error) {
      if (!controller.signal.aborted) this.move("error");
    } finally {
      this.session?.signal.removeEventListener("abort", stopWithSession);
      if (this.activeTurn === controller) this.activeTurn = null;
      this.submittedFinal = "";
    }
  }

  async bargeIn() {
    if (this.state !== "speaking" && this.state !== "thinking") return;
    ++this.turnSerial;
    this.activeTurn?.abort(new DOMException("Barged in", "AbortError"));
    this.activeTurn = null;
    this.tts.stop();
    try { await this.turn.interrupt(); } finally {
      if (this.session && !this.session.signal.aborted) this.move("listening");
    }
  }

  async stop() {
    ++this.turnSerial;
    this.activeTurn?.abort(new DOMException("Call stopped", "AbortError"));
    this.activeTurn = null;
    this.session?.abort();
    this.session = null;
    this.vad.stop();
    this.tts.stop();
    await this.stt.stop();
    this.utterance = "";
    this.submittedFinal = "";
    this.move("stopped");
  }
}

export async function openEchoCancelledMicrophone() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false,
  });
}

/** Retry only transport disconnects, never auth/permission failures. */
export async function reconnectWithBackoff(
  connect: () => Promise<void>,
  signal: AbortSignal,
  { attempts = 4, baseMs = 250 }: { attempts?: number; baseMs?: number } = {},
) {
  let last: unknown;
  for (let attempt = 0; attempt < attempts && !signal.aborted; attempt += 1) {
    try { await connect(); return; } catch (error) { last = error; }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(4_000, baseMs * 2 ** attempt));
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
  throw last ?? new Error("Voice transport disconnected");
}
