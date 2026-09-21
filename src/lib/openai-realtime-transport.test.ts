import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIRealtimeTransport } from "./openai-realtime-transport";

class FakeStream { tracks: unknown[] = []; getAudioTracks() { return this.tracks as MediaStreamTrack[]; } addTrack(track: unknown) { this.tracks.push(track); } }
class FakeChannel {
  readyState = "open"; bufferedAmount = 0; sent: string[] = []; onmessage: ((e: { data: string }) => void) | null = null;
  send(value: string) { this.sent.push(value); } close() { this.readyState = "closed"; }
}
class FakePeer {
  static last: FakePeer; connectionState = "new"; iceGatheringState = "complete"; localDescription: RTCSessionDescriptionInit | null = null;
  channel = new FakeChannel(); ontrack: RTCPeerConnection["ontrack"] = null; onconnectionstatechange: RTCPeerConnection["onconnectionstatechange"] = null;
  constructor() { FakePeer.last = this; } addTrack() {} createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  async createOffer() { return { type: "offer" as const, sdp: "offer-sdp" }; } async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription() {} addEventListener() {} removeEventListener() {} close() { this.connectionState = "closed"; }
}

beforeEach(() => { vi.stubGlobal("MediaStream", FakeStream); vi.stubGlobal("RTCPeerConnection", FakePeer); vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp", { status: 200 }))); });
afterEach(() => vi.unstubAllGlobals());

describe("OpenAIRealtimeTransport", () => {
  it("exchanges SDP with the ephemeral token and sends text events", async () => {
    const transport = new OpenAIRealtimeTransport();
    await transport.connect({ id: "one", provider: "openai-realtime", endpoint: "https://api.openai.com/v1/realtime/calls", ephemeralToken: "ephemeral", expiresAt: Date.now() + 60_000 }, { getAudioTracks: () => [{}] } as MediaStream);
    expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer ephemeral" }), body: "offer-sdp" }));
    transport.sendText("hello");
    expect(FakePeer.last.channel.sent).toHaveLength(2);
  });
  it("emits partial/final transcripts and fail-closes on backpressure", async () => {
    const events: unknown[] = [];
    const transport = new OpenAIRealtimeTransport(); transport.subscribe((event) => events.push(event));
    await transport.connect({ id: "one", provider: "openai-realtime", endpoint: "https://api.openai.com/realtime", ephemeralToken: "ephemeral" }, { getAudioTracks: () => [] } as unknown as MediaStream);
    FakePeer.last.channel.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "hel" }) });
    FakePeer.last.channel.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello" }) });
    expect(events).toEqual(expect.arrayContaining([{ type: "transcript", text: "hel", final: false }, { type: "transcript", text: "hello", final: true }]));
    FakePeer.last.channel.bufferedAmount = 1_000_001;
    expect(() => transport.sendText("blocked")).toThrow("backpressured");
  });
});
