export const JOB_STATES = ["ready", "running", "waiting_approval", "verifying", "succeeded", "failed", "paused", "cancelled", "unknown"] as const;
export type DaniJobState = (typeof JOB_STATES)[number];
export const EFFECT_STATES = ["planned", "authorized", "dispatched", "confirmed", "unknown", "denied"] as const;
export type DaniEffectState = (typeof EFFECT_STATES)[number];
export type DaniEventSource = "manual" | "schedule" | "webhook" | "email" | "calendar" | "app" | "system";

export interface DaniEventInput { source: DaniEventSource; sourceId: string; type: string; occurredAt: string; payload: unknown; ownerId: string }
export interface DaniJobInput { ownerId: string; objective: string; successCriteria: string[]; priority?: number; maxAttempts?: number; budget?: { turns?: number; toolCalls?: number; costUsd?: number }; quietHours?: { timezone: string; start: string; end: string } }
export interface DaniEffectPlan { jobId: string; tool: string; target: string; arguments: unknown; idempotencyKey: string; authorizationId?: string; preconditions?: unknown; approvalScope?: unknown; resourceIdentity?: string }
export interface DaniEvidenceInput { jobId: string; effectId?: string; kind: "tool_result" | "external_read" | "user_confirmation" | "runtime_event"; source: string; observedAt: string; observation: unknown; digest: string; verified?: boolean; verifier?: string }
export interface DaniGrant { id: string; ownerId: string; toolPattern: string; targetPattern: string; constraints: Record<string, unknown>; expiresAt: string | null; revokedAt: string | null }

export type ToolRisk = "read" | "write" | "representation" | "money" | "destructive";
export interface DaniToolDefinition<I = unknown, O = unknown> {
  name: string; description: string; risk: ToolRisk; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  idempotency: "native" | "reconcile" | "read-only"; timeoutMs: number;
  execute(input: I, context: { jobId: string; effectId: string; signal: AbortSignal }): Promise<{ output: O; externalReference?: string; evidence: DaniEvidenceInput[] }>;
  reconcile?(input: I, context: { jobId: string; effectId: string; signal: AbortSignal }): Promise<{ confirmed: boolean; externalReference?: string; evidence: DaniEvidenceInput[] }>;
}

export interface DaniRuntimeSession { id: string; ownerId: string; botId: string; provider: "hermes"; threadId: string; nativeCursor: unknown; state: "idle" | "running" | "interrupted" | "failed"; updatedAt: string }
export interface DaniDelegation { id: string; parentJobId: string; childJobId: string; parentSessionId: string; childSessionId: string; instruction: string; state: "requested" | "running" | "completed" | "failed" | "cancelled"; createdAt: string; updatedAt: string }
