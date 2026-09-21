/**
 * Versioned DecisionProvider contract for the Laya bounded decision service
 * (spec 100 R2). Laya scores caller-enumerated options and nothing else: it
 * can never authorize, dispatch, retry, or execute. Every invalid input or
 * output is a typed failure; the caller's fallback (Hermes) stays
 * authoritative.
 */

export const LAYA_DECISION_SCHEMA_ID = "dani.laya.decision";
export const LAYA_DECISION_SCHEMA_VERSION = 1;

/** Reserved option id. Callers never pass it; the service appends it so the
 * model always has an explicit out, per the laya-evaluation skill. */
export const NONE_OF_THE_ABOVE = "NONE_OF_THE_ABOVE";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 12;
export const MAX_OBJECTIVE_CHARS = 512;
export const MAX_STATE_SUMMARY_CHARS = 2048;
export const MAX_OPTION_LABEL_CHARS = 160;
export const MAX_OPTION_DESCRIPTION_CHARS = 280;
export const DEFAULT_DECISION_TIMEOUT_MS = 1500;
export const MAX_DECISION_TIMEOUT_MS = 10_000;

export interface LayaDecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface LayaDecisionRequest {
  schemaId: string;
  schemaVersion: number;
  /** Durable task/job the decision serves. */
  taskId: string;
  /** Correlation id for logs; never a secret. */
  traceId: string;
  /** Short statement of what is being decided. */
  objective: string;
  /** Minimized current state. No credentials, no secrets. */
  stateSummary: string;
  /** Currently valid actions, enumerated by the caller from real state. */
  options: LayaDecisionOption[];
  /** Per-call timeout; bounded by MAX_DECISION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** ISO instant after which the request is stale and must be rejected. */
  deadlineAt?: string;
}

export type LayaFailureKind =
  | "UNAVAILABLE" // service/sidecar not running or crashed
  | "NOT_INSTALLED" // checkpoint not on disk
  | "NOT_CONSENTED" // download not consented yet
  | "TIMEOUT" // decision exceeded its budget
  | "INVALID_REQUEST" // failed contract validation before inference
  | "INVALID_RESPONSE" // model output failed contract validation
  | "STALE_DEADLINE" // deadline already passed
  | "SIDECAR_ERROR"; // inference process reported an error

export interface LayaCheckpointIdentity {
  repo: string;
  subfolder: string;
  revision: string;
  weightsSha256: string;
}

export interface LayaDecision {
  schemaId: string;
  schemaVersion: number;
  checkpoint: LayaCheckpointIdentity;
  /** One entry per caller option plus NONE_OF_THE_ABOVE. */
  scores: Array<{ optionId: string; probability: number }>;
  /** Top-scoring real option, or null when abstaining. */
  selectedOptionId: string | null;
  confidence: number;
  /** The checkpoint's own act-vs-escalate head output, 0..1. */
  actProbability: number;
  abstained: boolean;
  abstainReason: string | null;
  elapsedMs: number;
}

export type LayaDecisionResult =
  | { ok: true; decision: LayaDecision }
  | { ok: false; failure: LayaFailureKind; message: string; elapsedMs: number };

/** Returns a human-readable problem, or null when the request is valid. */
export function validateDecisionRequest(req: LayaDecisionRequest, now: Date = new Date()): string | null {
  if (req.schemaId !== LAYA_DECISION_SCHEMA_ID) return `unknown schema id ${JSON.stringify(req.schemaId)}`;
  if (req.schemaVersion !== LAYA_DECISION_SCHEMA_VERSION)
    return `unsupported schema version ${JSON.stringify(req.schemaVersion)}`;
  if (!req.taskId || typeof req.taskId !== "string") return "missing taskId";
  if (!req.traceId || typeof req.traceId !== "string") return "missing traceId";
  if (typeof req.objective !== "string" || req.objective.trim().length === 0) return "missing objective";
  if (req.objective.length > MAX_OBJECTIVE_CHARS) return `objective exceeds ${MAX_OBJECTIVE_CHARS} chars`;
  if (typeof req.stateSummary !== "string") return "missing stateSummary";
  if (req.stateSummary.length > MAX_STATE_SUMMARY_CHARS)
    return `stateSummary exceeds ${MAX_STATE_SUMMARY_CHARS} chars`;
  if (!Array.isArray(req.options)) return "options must be an array";
  if (req.options.length < MIN_OPTIONS) return `need at least ${MIN_OPTIONS} options`;
  if (req.options.length > MAX_OPTIONS) return `at most ${MAX_OPTIONS} options`;
  const seen = new Set<string>();
  for (const option of req.options) {
    if (!option || typeof option.id !== "string" || option.id.length === 0) return "option missing id";
    if (option.id === NONE_OF_THE_ABOVE) return `option id ${NONE_OF_THE_ABOVE} is reserved`;
    if (seen.has(option.id)) return `duplicate option id ${JSON.stringify(option.id)}`;
    seen.add(option.id);
    if (typeof option.label !== "string" || option.label.trim().length === 0)
      return `option ${option.id} missing label`;
    if (option.label.length > MAX_OPTION_LABEL_CHARS) return `option ${option.id} label too long`;
    if (option.description !== undefined && option.description.length > MAX_OPTION_DESCRIPTION_CHARS)
      return `option ${option.id} description too long`;
  }
  if (req.timeoutMs !== undefined) {
    if (!Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0 || req.timeoutMs > MAX_DECISION_TIMEOUT_MS)
      return `timeoutMs must be in (0, ${MAX_DECISION_TIMEOUT_MS}]`;
  }
  if (req.deadlineAt !== undefined) {
    const deadline = Date.parse(req.deadlineAt);
    if (Number.isNaN(deadline)) return "deadlineAt is not a valid ISO instant";
    if (deadline <= now.getTime()) return "deadline already passed";
  }
  return null;
}

/**
 * Validate raw per-option probabilities coming back from the sidecar against
 * the request's option set plus NONE_OF_THE_ABOVE. Returns normalized scores
 * or a problem string. Any unknown option, missing option, non-finite or
 * out-of-range probability rejects the whole response.
 */
export function validateScores(
  raw: unknown,
  options: LayaDecisionOption[],
): { scores: Array<{ optionId: string; probability: number }> } | { problem: string } {
  if (raw === null || typeof raw !== "object") return { problem: "scores payload is not an object" };
  const record = raw as Record<string, unknown>;
  const expected = [...options.map((o) => o.id), NONE_OF_THE_ABOVE];
  const keys = Object.keys(record);
  for (const key of keys) {
    if (!expected.includes(key)) return { problem: `unknown option ${JSON.stringify(key)} in scores` };
  }
  const scores: Array<{ optionId: string; probability: number }> = [];
  let sum = 0;
  for (const id of expected) {
    const value = record[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
      return { problem: `probability for ${JSON.stringify(id)} is not a finite number in [0,1]` };
    scores.push({ optionId: id, probability: value });
    sum += value;
  }
  // Softmax output should sum to ~1; reject badly malformed distributions.
  if (sum < 0.5 || sum > 1.5) return { problem: `probabilities sum to ${sum}, not ~1` };
  return { scores };
}

/** Top-scoring option id among real options, or null when NONE wins. */
export function topScoringOption(scores: Array<{ optionId: string; probability: number }>): {
  optionId: string | null;
  probability: number;
} {
  let best: { optionId: string | null; probability: number } = { optionId: null, probability: -1 };
  for (const score of scores) {
    if (score.probability > best.probability) best = { optionId: score.optionId, probability: score.probability };
  }
  if (best.optionId === NONE_OF_THE_ABOVE) return { optionId: null, probability: best.probability };
  return best;
}
