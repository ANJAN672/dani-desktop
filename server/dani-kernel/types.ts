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


export type ProactiveAutonomyLevel = "off" | "suggest-only" | "act-with-approval";
export type ProactiveProposalStatus = "pending" | "snoozed" | "dismissed" | "accepted" | "expired";

export interface ProactiveProposalInput {
  ownerId: string;
  botId: string;
  threadId: string;
  triggerSource: "routine" | "schedule" | "in-app-event";
  triggerKey: string;
  triggerKind: string;
  reason: string;
  objective: string;
  evidenceReferences?: string[];
  expiresAt: string;
  createdAt?: string;
}

export interface ProactivePreferencesInput {
  ownerId: string;
  botId: string;
  autonomy: ProactiveAutonomyLevel;
  quietHours?: { timezone: string; start: string; end: string } | null;
  proposalLimit: number;
  proposalWindowMs: number;
}


export interface ProactiveTriggerInput extends ProactiveProposalInput {
  occurredAt: string;
}
