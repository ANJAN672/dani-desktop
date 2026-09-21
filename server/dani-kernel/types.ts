export type KernelJobStatus =
  | "admitted" | "running" | "waiting_approval" | "verifying"
  | "completed" | "failed" | "cancelled" | "uncertain";

export type KernelEffectState =
  | "proposed" | "approved" | "dispatching" | "verifying"
  | "completed" | "failed" | "denied" | "uncertain";

export type KernelRisk = "read" | "write" | "representation" | "money" | "destructive";

export interface AdmitJobInput {
  ownerId: string;
  objective: string;
  originatingRequestId: string;
  turnId: string;
  provider: string;
  threadId: string;
  providerCursor?: string | null;
}

export interface ProposeEffectInput {
  jobId: string;
  generation: number;
  idempotencyKey: string;
  adapter: string;
  normalizedInput: unknown;
  risk: KernelRisk;
  resource: string;
  audience?: string | null;
}

export interface ApprovalGrantInput {
  effectId: string;
  userId: string;
  scope: string;
  resource: string;
  audience?: string | null;
  limits: unknown;
  expiresAt: string;
  originatingRequestId: string;
  decision: "approved" | "denied";
}

export interface AdapterEvidenceInput {
  effectId: string;
  adapter: string;
  sourceTimestamp: string;
  sourceReference: string;
  inspection: unknown;
}
