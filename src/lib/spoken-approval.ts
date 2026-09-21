const YES = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "go ahead", "do it", "allow", "approve", "approved", "fine", "please do"]);
const NO = new Set(["no", "nope", "don't", "dont", "do not", "stop", "deny", "denied", "cancel", "never", "skip it"]);

/** Whole-utterance only. A phrase such as "yes, but first..." is ambiguous
 * and cannot grant authority to an open approval. */
export function spokenApprovalDecision(text: string): "allow" | "deny" | null {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
  if (YES.has(normalized)) return "allow";
  if (NO.has(normalized)) return "deny";
  return null;
}
