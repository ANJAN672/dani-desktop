import { DaniKernelRepository } from "./repository.ts";

const parse = (value: unknown) => {
  try { return JSON.parse(String(value)); } catch { return null; }
};

const REDACTED_KEYS = /secret|token|password|credential|authorization|cookie|audio|prompt|objective|text|body/i;
export function redactKernelDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactKernelDetail);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    REDACTED_KEYS.test(key) ? "[redacted]" : redactKernelDetail(item),
  ]));
}

export interface KernelDiagnostic {
  job: {
    id: string;
    status: string;
    attempt: number;
    generation: number;
    provider: string;
    threadId: string;
    turnId: string;
    providerCursor: string | null;
    cancellationReason: string | null;
    createdAt: string;
    updatedAt: string;
  };
  effects: Array<{
    id: string;
    adapter: string;
    riskClass: string;
    resource: string;
    audience: string | null;
    state: string;
    idempotencyKey: string;
    inputDigest: string;
    approvalId: string | null;
    externalReference: string | null;
    error: string | null;
    evidence: Array<{
      adapter: string;
      sourceTimestamp: string;
      sourceReference: string;
      digest: string;
      inspection: unknown;
    }>;
  }>;
  events: Array<{ sequence: number; kind: string; effectId: string | null; createdAt: string; detail: unknown }>;
}

export function kernelDiagnostic(repository: DaniKernelRepository, jobId: string): KernelDiagnostic {
  const job = repository.job(jobId);
  const effects = repository.db.prepare("SELECT * FROM kernel_effects WHERE job_id=? ORDER BY created_at,id").all(jobId) as Record<string, unknown>[];
  const events = repository.db.prepare("SELECT seq,effect_id,kind,detail_json,created_at FROM kernel_events WHERE job_id=? ORDER BY seq").all(jobId) as Record<string, unknown>[];
  return {
    job: {
      id: String(job.id), status: String(job.status), attempt: Number(job.attempt), generation: Number(job.generation),
      provider: String(job.provider), threadId: String(job.thread_id), turnId: String(job.turn_id),
      providerCursor: job.provider_cursor ? String(job.provider_cursor) : null,
      cancellationReason: job.cancellation_reason ? String(job.cancellation_reason) : null,
      createdAt: String(job.created_at), updatedAt: String(job.updated_at),
    },
    effects: effects.map(effect => ({
      id: String(effect.id), adapter: String(effect.adapter), riskClass: String(effect.risk_class),
      resource: String(effect.resource), audience: effect.audience ? String(effect.audience) : null,
      state: String(effect.state), idempotencyKey: String(effect.idempotency_key), inputDigest: String(effect.input_digest),
      approvalId: effect.approval_id ? String(effect.approval_id) : null,
      externalReference: effect.external_reference ? String(effect.external_reference) : null,
      error: effect.error ? String(effect.error) : null,
      evidence: (repository.db.prepare("SELECT * FROM kernel_evidence WHERE effect_id=? ORDER BY created_at,id").all(String(effect.id)) as Record<string, unknown>[]).map(row => ({
        adapter: String(row.adapter), sourceTimestamp: String(row.source_timestamp), sourceReference: String(row.source_reference),
        digest: String(row.digest), inspection: redactKernelDetail(parse(row.inspection_json)),
      })),
    })),
    events: events.map(event => ({
      sequence: Number(event.seq), kind: String(event.kind), effectId: event.effect_id ? String(event.effect_id) : null,
      createdAt: String(event.created_at), detail: redactKernelDetail(parse(event.detail_json)),
    })),
  };
}
