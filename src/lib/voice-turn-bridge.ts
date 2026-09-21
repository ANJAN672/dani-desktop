import type { DurableVoiceTurnBridge, DurableVoiceTurnRequest } from "./voice-call-state-machine";

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  return new Error(typeof body.error === "string" ? body.error : `Voice request returned HTTP ${response.status}`);
}

/** Uses the same product message and interrupt routes as typed chat. Those
 * routes own ordinary transcript persistence and DaniExecutionKernel dispatch. */
export class HttpVoiceTurnBridge implements DurableVoiceTurnBridge {
  constructor(private botId: string, private threadId: string, private fetchImpl: typeof fetch = fetch) {}

  async submit(request: DurableVoiceTurnRequest): Promise<void> {
    const response = await this.fetchImpl(`/api/bots/${encodeURIComponent(this.botId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: request.text, threadId: this.threadId, sendId: request.idempotencyKey }),
      signal: request.signal,
    });
    if (!response.ok) throw await responseError(response);
  }

  async interrupt(_input: { callId: string; generation: number }): Promise<void> {
    const response = await this.fetchImpl(`/api/bots/${encodeURIComponent(this.botId)}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: this.threadId }),
    });
    if (!response.ok) throw await responseError(response);
  }
}
