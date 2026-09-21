import { validateLiveCallSession, type LiveCallEvent, type LiveCallSession, type LiveCallTransport } from "./live-call-provider";

type RealtimeWireEvent = { type?: string; transcript?: string; delta?: string; item_id?: string; error?: { message?: string } };

/** Browser WebRTC transport using only the ephemeral token minted for one
 * call. Long-lived OAuth material remains behind the configured proxy. */
export class OpenAIRealtimeTransport implements LiveCallTransport {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private remote = new MediaStream();
  private listeners = new Set<(event: LiveCallEvent) => void>();
  private closed = false;

  subscribe(listener: (event: LiveCallEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: LiveCallEvent) { for (const listener of this.listeners) listener(event); }

  async connect(value: LiveCallSession, microphone: MediaStream): Promise<MediaStream> {
    const session = validateLiveCallSession(value);
    if (session.provider !== "openai-realtime" || !session.endpoint || !session.ephemeralToken) throw new Error("OpenAI Realtime session material required");
    this.close();
    this.closed = false;
    this.remote = new MediaStream();
    this.emit({ type: "state", state: "connecting" });
    const peer = new RTCPeerConnection();
    this.peer = peer;
    for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
    peer.ontrack = ({ streams, track }) => {
      const stream = streams[0];
      if (stream) for (const candidate of stream.getAudioTracks()) this.remote.addTrack(candidate);
      else this.remote.addTrack(track);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") this.emit({ type: "state", state: "connected" });
      if (["failed", "disconnected"].includes(peer.connectionState) && !this.closed) {
        this.emit({ type: "error", message: "OpenAI Realtime media disconnected.", retryable: true });
      }
    };
    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.onmessage = (event) => this.onWireMessage(String(event.data));
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await this.waitForIce(peer, 4_000);
    const response = await fetch(session.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${session.ephemeralToken}`, "content-type": "application/sdp" },
      body: peer.localDescription?.sdp ?? offer.sdp,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) { this.close(); throw new Error(`OpenAI Realtime returned HTTP ${response.status}`); }
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    return this.remote;
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
      this.emit({ type: "transcript", text: event.delta, final: false });
    } else if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      this.emit({ type: "transcript", text: event.transcript, final: true });
    } else if (event.type === "error") {
      this.emit({ type: "error", message: event.error?.message || "OpenAI Realtime returned an error.", retryable: false });
    }
  }

  sendText(text: string) {
    const value = text.trim();
    if (!value) return;
    if (!this.channel || this.channel.readyState !== "open") throw new Error("OpenAI Realtime is not connected");
    if (this.channel.bufferedAmount > 1_000_000) throw new Error("OpenAI Realtime is backpressured");
    this.channel.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: value }] } }));
    this.channel.send(JSON.stringify({ type: "response.create" }));
  }

  close() {
    this.closed = true;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.emit({ type: "state", state: "ended" });
  }
}
