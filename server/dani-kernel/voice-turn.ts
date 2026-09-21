import { DaniExecutionKernel } from "./kernel.ts";
import type { HermesKernelTurnResult } from "./hermes-turn.ts";

export interface VoiceFinalTurnInput {
  ownerId: string;
  callId: string;
  utteranceId: string;
  idempotencyKey: string;
  conversationId: string;
  text: string;
  callGeneration: number;
  model?: string;
  signal?: AbortSignal;
}

export interface VoiceTranscriptSink {
  /** Persist through the ordinary conversation/message repository. This must
   * be idempotent by messageId so retry/reconnect cannot duplicate speech. */
  persistUserMessage(input: {
    conversationId: string;
    messageId: string;
    text: string;
    source: "voice";
    callId: string;
    utteranceId: string;
  }): Promise<void> | void;
}

export interface VoiceFinalTurnResult {
  duplicate: boolean;
  jobId: string;
  result?: HermesKernelTurnResult;
}

type ActiveCall = { callGeneration: number; jobId: string; idempotencyKey: string };

/**
 * Voice ingress into the real execution kernel. It owns no parallel provider
 * or transcript path: admission/dedupe, Hermes planning and cancellation are
 * all delegated to DaniExecutionKernel, while the supplied sink is the same
 * ordinary message repository used by text chat.
 */
export class DaniKernelVoiceTurnService {
  private readonly active = new Map<string, ActiveCall>();
  private readonly inFlight = new Map<string, Promise<VoiceFinalTurnResult>>();

  constructor(private readonly kernel: DaniExecutionKernel, private readonly transcript: VoiceTranscriptSink) {}

  submit(input: VoiceFinalTurnInput): Promise<VoiceFinalTurnResult> {
    this.validate(input);
    const existing = this.inFlight.get(input.idempotencyKey);
    if (existing) return existing;
    const operation = this.submitOnce(input).finally(() => {
      if (this.inFlight.get(input.idempotencyKey) === operation) this.inFlight.delete(input.idempotencyKey);
    });
    this.inFlight.set(input.idempotencyKey, operation);
    return operation;
  }

  private async submitOnce(input: VoiceFinalTurnInput): Promise<VoiceFinalTurnResult> {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Voice turn cancelled", "AbortError");
    // The ordinary transcript sink is idempotent by messageId. Persist first:
    // a crash here is safe to replay, while admitting first could leave a
    // durable job whose user message never landed after a sink failure.
    await this.transcript.persistUserMessage({
      conversationId: input.conversationId,
      messageId: input.idempotencyKey,
      text: input.text,
      source: "voice",
      callId: input.callId,
      utteranceId: input.utteranceId,
    });
    const job = this.kernel.admit({
      ownerId: input.ownerId,
      objective: input.text,
      originatingRequestId: input.idempotencyKey,
      turnId: input.utteranceId,
      provider: "hermes",
      threadId: input.conversationId,
    });
    const jobId = String(job.id);
    if (job.duplicate) return { duplicate: true, jobId };
    const admitted = this.kernel.repository.job(jobId);
    this.active.set(input.callId, { callGeneration: input.callGeneration, jobId, idempotencyKey: input.idempotencyKey });

    const abort = () => { void this.cancel(input.callId, input.callGeneration, "Voice turn aborted"); };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) {
      await this.cancel(input.callId, input.callGeneration, "Voice turn aborted before dispatch");
      throw input.signal.reason ?? new DOMException("Voice turn cancelled", "AbortError");
    }
    try {
      const result = await this.kernel.plan(jobId, Number(admitted.generation), { text: input.text, model: input.model });
      return { duplicate: false, jobId, result };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      const active = this.active.get(input.callId);
      if (active?.jobId === jobId) this.active.delete(input.callId);
    }
  }

  async cancel(callId: string, callGeneration: number, reason: string): Promise<boolean> {
    const active = this.active.get(callId);
    if (!active || active.callGeneration !== callGeneration) return false;
    this.active.delete(callId);
    await this.kernel.cancel(active.jobId, reason);
    return true;
  }

  private validate(input: VoiceFinalTurnInput) {
    if (!input.ownerId.trim() || !input.callId.trim() || !input.utteranceId.trim() || !input.conversationId.trim()) {
      throw new Error("Voice turn identity is incomplete");
    }
    if (!input.text.trim()) throw new Error("Voice turn text is empty");
    if (input.idempotencyKey !== `${input.callId}:${input.utteranceId}`) {
      throw new Error("Voice turn idempotency key must bind call and utterance");
    }
    if (!Number.isSafeInteger(input.callGeneration) || input.callGeneration < 1) {
      throw new Error("Voice call generation is invalid");
    }
  }
}
