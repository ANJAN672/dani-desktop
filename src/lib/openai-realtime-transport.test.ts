import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIRealtimeTransport } from "./openai-realtime-transport";

let trackSerial = 0;
class FakeTrack { id = `track-${++trackSerial}`; stop = vi.fn(); }
class FakeStream {
  tracks: FakeTrack[] = [];
  getTracks() { return this.tracks as unknown as MediaStreamTrack[]; }
  getAudioTracks() { return this.tracks as unknown as MediaStreamTrack[]; }
  addTrack(track: MediaStreamTrack) { this.tracks.push(track as unknown as FakeTrack); }
}
class FakeChannel {
  readyState: RTCDataChannelState = "open"; bufferedAmount = 0; sent: string[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = "closed"; }
  addEventListener() {}
  removeEventListener() {}
}
class FakePeer {
  static instances: FakePeer[] = [];
  connectionState: RTCPeerConnectionState = "new"; iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null; channel = new FakeChannel();
  ontrack: RTCPeerConnection["ontrack"] = null; onconnectionstatechange: RTCPeerConnection["onconnectionstatechange"] = null;
  constructor() { FakePeer.instances.push(this); }
  addTrack() {}
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  async createOffer() { return { type: "offer" as const, sdp: "offer-sdp" }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription() {}
  addEventListener() {}
  removeEventListener() {}
  close() { this.connectionState = "closed"; }
}

const session = () => ({ id: "one", provider: "openai-realtime" as const, endpoint: "https://api.openai.com/v1/realtime/calls", ephemeralToken: "ephemeral", expiresAt: Date.now() + 60_000 });
const peer = () => FakePeer.instances.at(-1)!;

beforeEach(() => {
  FakePeer.instances = [];
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp", { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("OpenAIRealtimeTransport", () => {
  it("exchanges SDP with only the ephemeral token and sends text events", async () => {
    const transport = new OpenAIRealtimeTransport();
    await transport.connect(session(), { getAudioTracks: () => [{}] } as MediaStream);
    expect(fetch).toHaveBeenCalledWith(session().endpoint, expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer ephemeral" }), body: "offer-sdp" }));
    transport.sendText("hello");
    expect(peer().channel.sent.map((value) => JSON.parse(value).type)).toEqual(["session.update", "conversation.item.create", "response.create"]);
  });

  it("emits provider item ids with final transcripts for durable dedupe", async () => {
    const events: unknown[] = [];
    const transport = new OpenAIRealtimeTransport();
    transport.subscribe((event) => events.push(event));
    await transport.connect(session(), { getAudioTracks: () => [] } as unknown as MediaStream);
    peer().channel.onmessage?.({ data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) });
    peer().channel.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "item-1", delta: "hel" }) });
    peer().channel.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1", transcript: "hello" }) });
    expect(events).toEqual(expect.arrayContaining([
      { type: "speech", active: true },
      { type: "transcript", utteranceId: "item-1", text: "hel", final: false },
      { type: "transcript", utteranceId: "item-1", text: "hello", final: true },
    ]));
  });

  it("does not emit a final transcript without a stable provider item id", async () => {
    const events: unknown[] = [];
    const transport = new OpenAIRealtimeTransport();
    transport.subscribe((event) => events.push(event));
    await transport.connect(session(), { getAudioTracks: () => [] } as unknown as MediaStream);
    peer().channel.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "unidentified" }) });
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "transcript", final: true })]));
  });

  it("sends provider cancellation and clears buffered output on barge-in", async () => {
    const transport = new OpenAIRealtimeTransport();
    await transport.connect(session(), { getAudioTracks: () => [] } as unknown as MediaStream);
    peer().channel.onmessage?.({ data: JSON.stringify({ type: "response.created", response_id: "response-4" }) });
    transport.interrupt();
    expect(peer().channel.sent.map((value) => JSON.parse(value)).slice(1)).toEqual([
      { type: "response.cancel", response_id: "response-4" },
      { type: "output_audio_buffer.clear" },
    ]);
  });

  it("ignores events from a stale peer after reconnect", async () => {
    const events: unknown[] = [];
    const transport = new OpenAIRealtimeTransport();
    transport.subscribe((event) => events.push(event));
    await transport.connect(session(), { getAudioTracks: () => [] } as unknown as MediaStream);
    const stale = peer();
    await transport.connect(session(), { getAudioTracks: () => [] } as unknown as MediaStream);
    stale.channel.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "old", transcript: "stale" }) });
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ utteranceId: "old" })]));
  });

  it("an older failed connect cannot close a newer connection", async () => {
    let failOld!: (error: Error) => void;
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { failOld = reject; }))
      .mockResolvedValueOnce(new Response("answer-sdp", { status: 200 }));
    const transport = new OpenAIRealtimeTransport({ fetchImpl });
    const oldConnect = transport.connect(session(), { getAudioTracks: () => [] } as unknown as MediaStream);
    await Promise.resolve();
    await transport.connect(session(), { getAudioTracks: () => [] } as unknown as MediaStream);
    const current = peer();
    failOld(new Error("old network failure"));
    await expect(oldConnect).rejects.toThrow("old network failure");
    expect(current.connectionState).not.toBe("closed");
    transport.sendText("still live");
    expect(current.channel.sent).toHaveLength(3);
  });

  it("tears down every resource through 50 connect and close cycles", async () => {
    const transport = new OpenAIRealtimeTransport();
    const outputs: FakeTrack[] = [];
    for (let cycle = 0; cycle < 50; cycle += 1) {
      await transport.connect(session(), { getAudioTracks: () => [] } as unknown as MediaStream);
      const output = new FakeTrack();
      outputs.push(output);
      const ontrack = peer().ontrack as unknown as ((event: RTCTrackEvent) => void) | null;
      ontrack?.({ streams: [{ getAudioTracks: () => [output] }] } as unknown as RTCTrackEvent);
      transport.close();
      expect(peer().connectionState).toBe("closed");
      expect(peer().channel.readyState).toBe("closed");
    }
    expect(outputs.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(FakePeer.instances).toHaveLength(50);
  });

  it("fail-closes on backpressure and tears down remote tracks", async () => {
    const transport = new OpenAIRealtimeTransport();
    const remote = await transport.connect(session(), { getAudioTracks: () => [] } as unknown as MediaStream);
    const output = new FakeTrack();
    const ontrack = peer().ontrack as unknown as ((event: RTCTrackEvent) => void) | null;
    ontrack?.({ streams: [{ getAudioTracks: () => [output] }] } as unknown as RTCTrackEvent);
    peer().channel.bufferedAmount = 1_000_001;
    expect(() => transport.sendText("blocked")).toThrow("backpressured");
    transport.close();
    expect(output.stop).toHaveBeenCalledOnce();
    expect(remote.getAudioTracks()).toContain(output);
  });
});
