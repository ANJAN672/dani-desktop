import { validateLiveCallSession, type LiveCallEvent, type LiveCallSession, type LiveCallTransport } from "./live-call-provider";

type RealtimeWireEvent = {
  type?: string;
  transcript?: string;
  delta?: string;
  item_id?: string;
  response_id?: string;
  error?: { message?: string; code?: string };
};

export interface OpenAIRealtimeTransportOptions {
  peerFactory?: () => RTCPeerConnection;
  fetchImpl?: typeof fetch;
  connectionTimeoutMs?: number;
}

/** Browser WebRTC transport using only the ephemeral token minted for one
 * call. Long-lived OAuth material remains behind the configured proxy. */
export class OpenAIRealtimeTransport implements LiveCallTransport {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private remote = new MediaStream();
  private listeners = new Set<(event: LiveCallEvent) => void>();
  private closed = false;
  private generation = 0;
  private activeResponseId: string | undefined;
  private readonly peerFactory: () => RTCPeerConnection;
  private readonly fetchImpl: typeof fetch;
  private readonly connectionTimeoutMs: number;

  constructor(options: OpenAIRealtimeTransportOptions = {}) {
    this.peerFactory = options.peerFactory ?? (() => new RTCPeerConnection());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000;
  }

  subscribe(listener: (event: LiveCallEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: LiveCallEvent) { for (const listener of this.listeners) listener(event); }

  async connect(value: LiveCallSession, microphone: MediaStream): Promise<MediaStream> {
    const session = validateLiveCallSession(value);
    if (session.provider !== "openai-realtime" || !session.endpoint || !session.ephemeralToken) {
      throw new Error("OpenAI Realtime session material required");
    }
    this.close(false);
    this.closed = false;
    const generation = ++this.generation;
    this.remote = new MediaStream();
    this.activeResponseId = undefined;
    this.emit({ type: "state", state: "connecting" });
    const peer = this.peerFactory();
    this.peer = peer;
    for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
    peer.ontrack = ({ streams, track }) => {
      if (!this.isCurrent(peer, generation)) return;
      const stream = streams[0];
      if (stream) for (const candidate of stream.getAudioTracks()) this.addRemoteTrack(candidate);
      else this.addRemoteTrack(track);
    };
    peer.onconnectionstatechange = () => {
      if (!this.isCurrent(peer, generation)) return;
      if (["failed", "disconnected"].includes(peer.connectionState)) {
        this.emit({ type: "error", message: "OpenAI Realtime media disconnected.", retryable: true, code: "network-disconnected" });
      } else if (peer.connectionState === "closed" && !this.closed) {
        this.emit({ type: "state", state: "ended" });
      }
    };
    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.onmessage = (event) => {
      if (this.isCurrent(peer, generation)) this.onWireMessage(String(event.data));
    };
    const channelReady = this.waitForDataChannel(channel, peer, generation);
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await this.waitForIce(peer, this.connectionTimeoutMs);
      const response = await this.fetchImpl(session.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${session.ephemeralToken}`, "content-type": "application/sdp" },
        body: peer.localDescription?.sdp ?? offer.sdp,
        signal: AbortSignal.timeout(this.connectionTimeoutMs),
      });
      if (!response.ok) throw new Error(`OpenAI Realtime returned HTTP ${response.status}`);
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
      await channelReady;
      if (!this.isCurrent(peer, generation)) throw new DOMException("Stale Realtime connection", "AbortError");
      this.send({ type: "session.update", session: { audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad", create_response: false, interrupt_response: false } } } } });
      this.emit({ type: "state", state: "connected" });
      return this.remote;
    } catch (error) {
      if (this.isCurrent(peer, generation)) this.close();
      throw error;
    }
  }

  private isCurrent(peer: RTCPeerConnection, generation: number) {
    return !this.closed && this.peer === peer && this.generation === generation;
  }

  private addRemoteTrack(track: MediaStreamTrack) {
    if (!this.remote.getAudioTracks().some((candidate) => candidate.id === track.id)) this.remote.addTrack(track);
  }

  private waitForDataChannel(channel: RTCDataChannel, peer: RTCPeerConnection, generation: number) {
    if (channel.readyState === "open") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => finish(new Error("OpenAI Realtime data channel timed out")), this.connectionTimeoutMs);
      const opened = () => finish();
      const failed = () => finish(new Error("OpenAI Realtime data channel failed"));
      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        channel.removeEventListener("open", opened);
        channel.removeEventListener("close", failed);
        channel.removeEventListener("error", failed);
        if (!this.isCurrent(peer, generation)) reject(new DOMException("Stale Realtime connection", "AbortError"));
        else if (error) reject(error);
        else resolve();
      };
      channel.addEventListener("open", opened, { once: true });
      channel.addEventListener("close", failed, { once: true });
      channel.addEventListener("error", failed, { once: true });
    });
  }

  private waitForIce(peer: RTCPeerConnection, timeoutMs: number) {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(done, timeoutMs);
      function done() { window.clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); resolve(); }
      function changed() { if (peer.iceGatheringState === "complete") done(); }
      peer.addEventListener("icegatheringstatechange", changed);
    });
  }

  private onWireMessage(raw: string) {
    let event: RealtimeWireEvent;
    try { event = JSON.parse(raw) as RealtimeWireEvent; } catch { return; }
    if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
      this.emit({ type: "transcript", utteranceId: event.item_id, text: event.delta, final: false });
    } else if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript && event.item_id) {
      this.emit({ type: "transcript", utteranceId: event.item_id, text: event.transcript, final: true });
    } else if (event.type === "input_audio_buffer.speech_started") {
      this.emit({ type: "speech", active: true });
    } else if (event.type === "input_audio_buffer.speech_stopped") {
      this.emit({ type: "speech", active: false });
    } else if (event.type === "response.created") {
      this.activeResponseId = event.response_id;
    } else if (event.type === "response.done") {
      this.activeResponseId = undefined;
    } else if (event.type === "error") {
      this.emit({ type: "error", message: event.error?.message || "OpenAI Realtime returned an error.", retryable: false, code: event.error?.code });
    }
  }

  sendText(text: string) {
    const value = text.trim();
    if (!value) return;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: value }] } });
    this.send({ type: "response.create" });
  }

  /** Stop provider output immediately during barge-in. Durable turn cancellation
   * is a separate required operation owned by the call state machine. */
  interrupt() {
    if (!this.channel || this.channel.readyState !== "open") return;
    this.send({ type: "response.cancel", ...(this.activeResponseId ? { response_id: this.activeResponseId } : {}) });
    this.send({ type: "output_audio_buffer.clear" });
    this.activeResponseId = undefined;
  }

  private send(event: object) {
    if (!this.channel || this.channel.readyState !== "open") throw new Error("OpenAI Realtime is not connected");
    if (this.channel.bufferedAmount > 1_000_000) throw new Error("OpenAI Realtime is backpressured");
    this.channel.send(JSON.stringify(event));
  }

  close(emitEnded = true) {
    const wasActive = !this.closed;
    this.closed = true;
    ++this.generation;
    this.activeResponseId = undefined;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    for (const track of this.remote.getTracks()) track.stop();
    this.remote = new MediaStream();
    if (wasActive && emitEnded) this.emit({ type: "state", state: "ended" });
  }
}
