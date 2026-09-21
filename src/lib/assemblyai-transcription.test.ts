import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mergeAssemblyAITurn,
  pcm16FromFloat32,
  startAssemblyAITranscription,
  type AssemblyAITranscript,
} from "./assemblyai-transcription";

const empty = (): AssemblyAITranscript => ({ turns: new Map(), finalText: "", partialText: "" });
const microphone = () => ({}) as unknown as MediaStream;

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSING || this.readyState === FakeWebSocket.CLOSED) return;
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSING;
    this.dispatch("close", {});
    this.readyState = FakeWebSocket.CLOSED;
  }

  dispatch(type: string, event: unknown = {}) {
    if (type === "open") this.readyState = FakeWebSocket.OPEN;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    if (type === "close") this.readyState = FakeWebSocket.CLOSED;
  }
}

class FakeAudioContext {
  state = "running";
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createScriptProcessor = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }));
  createGain = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }));
}
function installStreamingGlobals(audioContext?: FakeAudioContext) {
  if (audioContext) vi.stubGlobal("AudioContext", class { constructor() { if (!audioContext) throw new Error("Missing fake AudioContext"); return audioContext as unknown as this; } });
  vi.stubGlobal("window", {
    setTimeout: (handler: () => void, timeout?: number) => setTimeout(handler, timeout),
    clearTimeout: (id: number) => clearTimeout(id),
  });
}

function socketFactory(socket: FakeWebSocket) {
  return () => socket as unknown as WebSocket;
}
async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AssemblyAI streaming transcription", () => {
  it("replaces a partial with the formatted final turn instead of duplicating it", () => {
    const partial = mergeAssemblyAITurn(empty(), { order: 0, text: "open settings", final: false });
    const final = mergeAssemblyAITurn(partial, { order: 0, text: "Open Settings.", final: true });
    expect(final.finalText).toBe("Open Settings.");
    expect(final.partialText).toBe("");
  });

  it("keeps finalized turns ordered when updates arrive out of order", () => {
    const second = mergeAssemblyAITurn(empty(), { order: 1, text: "Then save.", final: true });
    const first = mergeAssemblyAITurn(second, { order: 0, text: "Choose the file.", final: true });
    expect(first.finalText).toBe("Choose the file. Then save.");
  });

  it("resamples and clamps browser floats as signed little-endian PCM16", () => {
    const bytes = pcm16FromFloat32(new Float32Array([-2, 0, 2, 0]), 32_000, 16_000);
    const samples = new Int16Array(bytes);
    expect([...samples]).toEqual([-32768, 32767]);
  });

  it.each([
    ["missing session id", { type: "Begin", expires_at: Date.now() + 60_000, configuration: { model: "universal-3-5-pro" } }, /invalid transcription session handshake/],
    ["nonpositive expiry", { type: "Begin", id: "session-1", expires_at: 0, configuration: { model: "universal-3-5-pro" } }, /invalid transcription session handshake/],
    ["nonnumeric expiry", { type: "Begin", id: "session-1", expires_at: "later", configuration: { model: "universal-3-5-pro" } }, /invalid transcription session handshake/],
    ["unexpected model", { type: "Begin", id: "session-1", expires_at: Date.now() + 60_000, configuration: { model: "other-model" } }, /unexpected transcription model/],
  ])("rejects a Begin message with %s", async (_label, message, expectedError) => {
    installStreamingGlobals();
    const socket = new FakeWebSocket();
    const onError = vi.fn();
    const pending = startAssemblyAITranscription({
      stream: microphone(),
      getToken: async () => ({ token: "test-token" }),
      onTurn: vi.fn(),
      onError,
      webSocketFactory: socketFactory(socket),
    });
    await settle();
    socket.dispatch("open", {});
    socket.dispatch("message", { data: JSON.stringify(message) });

    await expect(pending).rejects.toThrow(expectedError);
    expect(onError).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
  });

  it("cleans up audio and reports a terminal AssemblyAI Error", async () => {
    const audioContext = new FakeAudioContext();
    installStreamingGlobals(audioContext);
    const socket = new FakeWebSocket();
    const onError = vi.fn();
    const pendingSession = startAssemblyAITranscription({
      stream: microphone(),
      getToken: async () => ({ token: "test-token" }),
      onTurn: vi.fn(),
      onError,
      webSocketFactory: socketFactory(socket),
    });
    await settle();
    socket.dispatch("open", {});
    socket.dispatch("message", { data: JSON.stringify({ type: "Begin", id: "session-1", expires_at: Date.now() + 60_000, configuration: { model: "universal-3-5-pro" } }) });
    const session = await pendingSession;

    socket.dispatch("message", { data: JSON.stringify({ type: "Error", error: "transient failure" }) });

    expect(onError).toHaveBeenCalledWith("transient failure");
    expect(socket.closed).toBe(true);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    await session.stop();
  });

  it("cleans up audio without reporting a graceful Termination as an error", async () => {
    const audioContext = new FakeAudioContext();
    installStreamingGlobals(audioContext);
    const socket = new FakeWebSocket();
    const onError = vi.fn();
    const pendingSession = startAssemblyAITranscription({
      stream: microphone(),
      getToken: async () => ({ token: "test-token" }),
      onTurn: vi.fn(),
      onError,
      webSocketFactory: socketFactory(socket),
    });
    await settle();
    socket.dispatch("open", {});
    socket.dispatch("message", { data: JSON.stringify({ type: "Begin", id: "session-1", expires_at: Date.now() + 60_000, configuration: { model: "universal-3-5-pro" } }) });
    const session = await pendingSession;

    socket.dispatch("message", { data: JSON.stringify({ type: "Termination" }) });

    expect(onError).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    await session.stop();
  });

  it("sends a graceful Terminate message when the caller stops", async () => {
    const audioContext = new FakeAudioContext();
    installStreamingGlobals(audioContext);
    const socket = new FakeWebSocket();
    const pendingSession = startAssemblyAITranscription({
      stream: microphone(),
      getToken: async () => ({ token: "test-token" }),
      onTurn: vi.fn(),
      onError: vi.fn(),
      webSocketFactory: socketFactory(socket),
    });
    await settle();
    socket.dispatch("open", {});
    socket.dispatch("message", { data: JSON.stringify({ type: "Begin", id: "session-1", expires_at: Date.now() + 60_000, configuration: { model: "universal-3-5-pro" } }) });
    const session = await pendingSession;

    await session.stop();

    expect(socket.sent).toContain('{"type":"Terminate"}');
    expect(socket.closed).toBe(true);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
  });
});
