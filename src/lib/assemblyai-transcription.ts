import { z } from "zod";

export type AssemblyAITurn = {
  order: number;
  text: string;
  final: boolean;
};

export type AssemblyAITranscript = {
  turns: Map<number, { text: string; final: boolean }>;
  finalText: string;
  partialText: string;
};

export type AssemblyAITranscriptionSession = {
  stop(): Promise<void>;
};

const SAMPLE_RATE = 16_000;
const STREAMING_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;
const streamingMessageSchema = z.object({
  type: z.string(),
  id: z.unknown().optional(),
  expires_at: z.unknown().optional(),
  transcript: z.string().optional(),
  turn_order: z.coerce.number().optional(),
  end_of_turn: z.boolean().optional(),
  configuration: z.object({ model: z.unknown().optional() }).optional(),
  error: z.string().optional(),
});

export function mergeAssemblyAITurn(
  current: AssemblyAITranscript,
  turn: AssemblyAITurn,
): AssemblyAITranscript {
  if (!turn.text.trim() || !Number.isFinite(turn.order)) return current;
  const turns = new Map(current.turns);
  turns.set(turn.order, { text: turn.text.trim(), final: turn.final });
  const ordered = [...turns.entries()].sort(([left], [right]) => left - right);
  return {
    turns,
    finalText: ordered.filter(([, value]) => value.final).map(([, value]) => value.text).join(" "),
    partialText: ordered.filter(([, value]) => !value.final).map(([, value]) => value.text).join(" "),
  };
}

/** Resample one browser microphone frame to AssemblyAI's PCM16 LE contract. */
export function pcm16FromFloat32(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = SAMPLE_RATE,
): ArrayBuffer {
  if (!input.length || inputSampleRate <= 0 || outputSampleRate <= 0) return new ArrayBuffer(0);
  const outputLength = Math.max(1, Math.round(input.length * outputSampleRate / inputSampleRate));
  const buffer = new ArrayBuffer(outputLength * 2);
  const view = new DataView(buffer);
  const scale = input.length / outputLength;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * scale;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const amount = position - left;
    const sample = Math.max(-1, Math.min(1, input[left]! * (1 - amount) + input[right]! * amount));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}
export async function startAssemblyAITranscription({
  stream,
  getToken,
  onTurn,
  onError,
  webSocketFactory = (url) => new globalThis.WebSocket(url),
}: {
  stream: MediaStream;
  getToken: () => Promise<{ token: string }>;
  onTurn: (turn: AssemblyAITurn) => void;
  onError: (message: string) => void;
  webSocketFactory?: (url: string) => WebSocket;
}): Promise<AssemblyAITranscriptionSession> {
  const { token } = await getToken();
  const requestedModel = "universal-3-5-pro";
  const query = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    speech_model: requestedModel,
    format_turns: "true",
    token,
  });
  let stopping = false;
  let terminated = false;
  const socket = webSocketFactory(`${STREAMING_ENDPOINT}?${query}`);
  const closeSocket = () => {
    if (socket.readyState === WEBSOCKET_CLOSING || socket.readyState === WEBSOCKET_CLOSED) return;
    try {
      socket.close();
    } catch {
      // The browser may reject close() while a connection is still opening.
    }
  };
  const reportError = (message: string) => {
    try {
      onError(message);
    } catch {
      // Error reporting must not prevent socket and audio cleanup.
    }
  };

  const connected = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("AssemblyAI took too long to connect.")), 10_000);
    socket.addEventListener("open", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("close", () => {
      window.clearTimeout(timer);
      reject(new Error("AssemblyAI closed before confirming the transcription session."));
    }, { once: true });
    socket.addEventListener("error", () => {
      window.clearTimeout(timer);
      reject(new Error("Could not open the AssemblyAI transcription stream."));
    }, { once: true });
  });
  const sessionReady = new Promise<void>((resolve, reject) => {
    let timer: number | undefined;
    const onMessage = (event: MessageEvent) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const parsed = streamingMessageSchema.safeParse(decoded);
      if (!parsed.success || parsed.data === undefined) return;
      const message = parsed.data;
      if (message.type === "Error") {
        if (timer !== undefined) window.clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        closeSocket();
        reject(new Error(message.error ?? "Cloud transcription failed."));
        return;
      }
      if (message.type !== "Begin") return;
      const expiresAt = Number(message.expires_at);
      if (!message.id || !Number.isFinite(expiresAt) || expiresAt <= 0) {
        if (timer !== undefined) window.clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        closeSocket();
        reject(new Error("AssemblyAI returned an invalid transcription session handshake."));
        return;
      }
      if (message.configuration?.model !== requestedModel) {
        if (timer !== undefined) window.clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        closeSocket();
        reject(new Error(`AssemblyAI started with an unexpected transcription model: ${message.configuration?.model ?? "unknown"}`));
        return;
      }
      if (timer !== undefined) window.clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      resolve();
    };
    const onClose = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      reject(new Error("AssemblyAI closed before confirming the transcription session."));
    };
    timer = window.setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      reject(new Error("AssemblyAI took too long to confirm the transcription session."));
    }, 10_000);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
  });
  try {
    await Promise.all([connected, sessionReady]);
  } catch (error) {
    closeSocket();
    throw error;
  }

  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let silentOutput: GainNode | null = null;
  const cleanupAudio = () => {
    if (processor) processor.onaudioprocess = null;
    for (const node of [source, processor, silentOutput]) {
      try {
        node?.disconnect();
      } catch {
        // A node may already be disconnected during terminal cleanup.
      }
    }
    source = null;
    processor = null;
    silentOutput = null;
    if (audioContext) {
      void audioContext.close().catch(() => {});
      audioContext = null;
    }
  };
  const cleanup = () => {
    cleanupAudio();
    closeSocket();
  };
  socket.addEventListener("message", (event) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const parsed = streamingMessageSchema.safeParse(decoded);
    if (!parsed.success || parsed.data === undefined) return;
    const message = parsed.data;
    if (message.type === "Error") {
      terminated = true;
      if (!stopping) reportError(message.error ?? "Cloud transcription failed.");
      cleanup();
      return;
    }
    if (message.type === "Turn" && message.transcript !== undefined) {
      try {
        onTurn({
          order: message.turn_order ?? Number.NaN,
          text: message.transcript,
          final: message.end_of_turn === true,
        });
      } catch {
        // A renderer observer must not break the transcription stream.
      }
    } else if (message.type === "Termination") {
      terminated = true;
      cleanup();
    }
  });
  socket.addEventListener("close", () => {
    if (!stopping && !terminated) {
      terminated = true;
      cleanupAudio();
      reportError("Cloud transcription disconnected; the original audio is still being saved.");
    }
  });
  socket.addEventListener("error", () => {
    if (!stopping && !terminated) {
      terminated = true;
      cleanupAudio();
      reportError("Cloud transcription disconnected; the original audio is still being saved.");
    }
    cleanup();
  });

  try {
    audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    silentOutput = audioContext.createGain();
  } catch (error) {
    cleanup();
    throw error;
  }
  silentOutput.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const context = audioContext;
    if (stopping || !context || !source || !processor || socket.readyState !== WEBSOCKET_OPEN) return;
    const payload = pcm16FromFloat32(event.inputBuffer.getChannelData(0), context.sampleRate);
    if (!payload.byteLength) return;
    try {
      socket.send(payload);
    } catch {
      terminated = true;
      cleanup();
      reportError("Cloud transcription disconnected; the original audio is still being saved.");
    }
  };
  if (source && processor && silentOutput) {
    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(audioContext!.destination);
  }

  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      cleanupAudio();
      if (socket.readyState === WEBSOCKET_CLOSED) return;
      const finished = new Promise<void>((resolve) => {
        let timer: number | undefined;
        const done = () => {
          if (timer !== undefined) window.clearTimeout(timer);
          resolve();
        };
        socket.addEventListener("close", done, { once: true });
        timer = window.setTimeout(done, 2_500);
      });
      try {
        if (socket.readyState === WEBSOCKET_OPEN) {
          socket.send(JSON.stringify({ type: "Terminate" }));
        } else {
          closeSocket();
        }
      } catch {
        closeSocket();
      }
      await finished;
      closeSocket();
    },
  };
}
