export interface ProactiveProposalCardData {
  proposalId: string;
  botId: string;
  triggerSource: "routine" | "schedule" | "in-app-event";
  triggerKind: string;
  reason: string;
  objective: string;
  evidenceReferences: string[];
  expiresAt: string;
  status: "pending" | "snoozed" | "dismissed" | "accepted" | "expired";
  acceptedJobId?: string;
  jobStatus?: "admitted" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "uncertain";
  report?: string;
}
