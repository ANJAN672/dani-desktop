import type { DaniControlPlane } from "./dani-control-plane.ts";
import type { DaniEvidenceInput } from "../shared/dani-runtime.ts";

export type CriterionStatus = "verified" | "missing" | "stale" | "contradictory" | "uncertain" | "negative" | "blocked";
export interface CriterionResult { criterion: string; status: CriterionStatus; evidenceId: string | null; reason: string | null }
export interface VerifyOptions {
  now?: Date;
  /** Evidence older than this never satisfies a criterion. Default 5 minutes. */
  maxEvidenceAgeMs?: number;
  /** Honest source health: unreachable sources block instead of silently passing or failing. */
  sourceHealth?: Record<string, "ok" | "unreachable">;
  /** Cloud-sourced evidence requires this explicit opt-in. */
  cloudOptIn?: boolean;
}
export interface VerifyResult { status: "verified" | "unverified"; criteria: CriterionResult[] }

const DEFAULT_MAX_AGE_MS = 300_000;

/**
 * Truthful success evaluation: a job may only be reported verified when every
 * success criterion has fresh, source-linked, non-contradictory evidence.
 * Evidence presence alone is never sufficient.
 */
export class DaniVerifier {
  constructor(private plane: DaniControlPlane) {}

  /** Duplicate-aware evidence recording: the same digest converges on the canonical row. */
  recordEvidence(input: DaniEvidenceInput) {
    const existing = this.plane.db.prepare("SELECT id FROM dani_evidence WHERE job_id=? AND digest=?").get(input.jobId, input.digest) as { id: string } | undefined;
    if (existing) return { id: existing.id, duplicate: true, canonicalId: existing.id };
    const id = this.plane.addEvidence(input);
    return { id, duplicate: false, canonicalId: id };
  }

  private evidenceFor(jobId: string, criterion: string) {
    return (this.plane.db.prepare("SELECT id,kind,source,observed_at,observation,digest FROM dani_evidence WHERE job_id=? AND json_extract(observation,'$.criterion')=? ORDER BY observed_at DESC").all(jobId, criterion) as Record<string, unknown>[]).map(r => ({ id: String(r.id), kind: String(r.kind), source: String(r.source), observedAt: String(r.observed_at), observation: JSON.parse(String(r.observation)) as Record<string, unknown>, digest: String(r.digest) }));
  }

  verifyCriterion(jobCreatedAt: string, criterion: string, rows: ReturnType<DaniVerifier["evidenceFor"]>, opts: Required<Pick<VerifyOptions, "maxEvidenceAgeMs">> & VerifyOptions & { now: Date }): CriterionResult {
    const none = (status: CriterionStatus, reason: string): CriterionResult => ({ criterion, status, evidenceId: rows[0]?.id ?? null, reason });
    if (rows.length === 0) return none("missing", "no evidence linked to this criterion");
    const usable = rows.filter(r => {
      if (opts.sourceHealth?.[r.source] === "unreachable") return false;
      if (r.source.startsWith("cloud:") && !opts.cloudOptIn) return false;
      return true;
    });
    if (usable.length === 0) {
      const allUnreachable = rows.every(r => opts.sourceHealth?.[r.source] === "unreachable");
      const allCloudBlocked = rows.every(r => r.source.startsWith("cloud:") && !opts.cloudOptIn);
      return none("blocked", allUnreachable ? "evidence source unreachable (offline or sleeping target)" : allCloudBlocked ? "cloud evidence requires explicit opt-in" : "no usable evidence source");
    }
    const fresh = usable.filter(r => r.observedAt >= jobCreatedAt && opts.now.getTime() - Date.parse(r.observedAt) <= opts.maxEvidenceAgeMs);
    if (fresh.length === 0) return none("stale", "evidence predates the job or exceeds freshness window");
    const verdicts = fresh.map(r => r.observation.ok);
    if (verdicts.some(v => v === true) && verdicts.some(v => v === false)) return none("contradictory", "fresh evidence rows disagree");
    if (verdicts.every(v => v === true)) return { criterion, status: "verified", evidenceId: fresh[0]!.id, reason: null };
    if (verdicts.every(v => v === false)) return none("negative", "fresh evidence reports the criterion is not met");
    return none("uncertain", "fresh evidence has no definitive verdict");
  }

  verifyJob(jobId: string, options: VerifyOptions = {}): VerifyResult {
    const job = this.plane.job(jobId);
    const opts = { ...options, now: options.now ?? new Date(), maxEvidenceAgeMs: options.maxEvidenceAgeMs ?? DEFAULT_MAX_AGE_MS };
    const criteria = (job.criteria as string[]).map(c => this.verifyCriterion(String((job as Record<string, unknown>).created_at), c, this.evidenceFor(jobId, c), opts));
    return { status: criteria.every(c => c.status === "verified") ? "verified" : "unverified", criteria };
  }

  /** Gate for the succeeded transition. Phase 1 wires this into the control plane. */
  assertSucceedable(jobId: string, options: VerifyOptions = {}) {
    const result = this.verifyJob(jobId, options);
    if (result.status === "verified") return { ok: true as const };
    const worst = result.criteria.find(c => c.status !== "verified")!;
    return { ok: false as const, reason: `${worst.criterion}: ${worst.status}${worst.reason ? ` (${worst.reason})` : ""}`, criteria: result.criteria };
  }
}
