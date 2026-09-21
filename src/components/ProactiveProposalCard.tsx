import { useState } from "react";
import { BellRing, Check, Clock3, X } from "lucide-react";
import type { Message } from "@/state/store";
import { api } from "@/state/store";

export function ProactiveProposalCard({ message }: { message: Message }) {
  const proposal = message.proactiveProposal;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!proposal) return null;
  const decide = async (action: "accept" | "dismiss" | "snooze") => {
    const init: RequestInit = { method: "POST" };
    if (action === "snooze") {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify({ until: new Date(Date.now() + 60 * 60_000).toISOString() });
    }
    setPending(true);
    setError(null);
    try { await api(`/api/proactive/proposals/${proposal.proposalId}/${action}`, init); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const settled = proposal.status !== "pending";
  return <div className="w-full max-w-[840px] rounded-2xl border border-accent/40 bg-card p-4" aria-label={`Proactive suggestion: ${proposal.objective}`}>
    <div className="flex items-center gap-2 text-[15px] font-semibold text-ink"><BellRing size={16} className="text-accent" />Dani noticed something</div>
    <div className="mt-2 text-[13px] text-ink">{proposal.objective}</div>
    <div className="mt-2 rounded-lg bg-inset px-3 py-2 text-[12.5px] text-ink-secondary"><span className="font-medium text-ink">Why you're seeing this:</span> {proposal.reason}</div>
    <div className="mt-2 text-[11px] uppercase tracking-wide text-ink-secondary">Source: {proposal.triggerSource.replaceAll("-", " ")}</div>
    {!settled && <div className="mt-3 flex flex-wrap gap-2">
      <button disabled={pending} className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50" onClick={() => void decide("accept")}>Accept</button>
      <button disabled={pending} className="rounded-lg bg-raised px-3 py-2 text-[12px] text-ink disabled:opacity-50" onClick={() => void decide("snooze")}>Snooze 1 hour</button>
      <button disabled={pending} className="rounded-lg px-3 py-2 text-[12px] text-ink-secondary disabled:opacity-50" onClick={() => void decide("dismiss")}>Dismiss</button>
    </div>}
    {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    <div className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-secondary">
      {proposal.status === "accepted" ? <><Check size={14} className="text-success" />Accepted</> : proposal.status === "snoozed" ? <><Clock3 size={14} />Snoozed</> : proposal.status === "dismissed" || proposal.status === "expired" ? <><X size={14} />{proposal.status === "expired" ? "Expired" : "Dismissed"}</> : <>Nothing runs until you accept. Consequential actions still require approval.</>}
    </div>
  </div>;
}
