import type { VoiceCallState } from "./voice-call-state-machine";

export interface VoiceDuplexContext {
  state: VoiceCallState;
  botBusy: boolean;
  approvalOpen: boolean;
}

/** Speech during a pending approval is the answer to that approval, never an
 * interruption. Otherwise speech while Hermes works or audio plays is barge-in. */
export function shouldBargeIn(context: VoiceDuplexContext): boolean {
  if (context.approvalOpen) return false;
  return context.botBusy || context.state === "thinking" || context.state === "speaking";
}

/** Commentary ending does not mean the turn ended. Keep the call in thinking
 * while Hermes remains busy so the next speech is treated as barge-in. */
export function stateAfterPlayback(botBusy: boolean): "thinking" | "listening" {
  return botBusy ? "thinking" : "listening";
}
