// Spend-safety cost badge (security/epic-9-D). Honest labels straight from
// the server-resolved billing class — "Unknown cost" is fail-closed, not a
// guess, and the tooltip names the rate source + review date.
import type { InstanceBilling } from "@/state/store";
import { cn } from "@/lib/cn";

type BillingClass = InstanceBilling["billingClass"];

export const BILLING_LABEL: Record<BillingClass, string> = {
  free: "Free",
  metered: "Metered",
  subscription: "Subscription",
  unknown: "Unknown cost",
};

const BADGE_STYLE: Record<BillingClass, string> = {
  free: "bg-success/10 text-success",
  metered: "bg-warning/10 text-warning",
  subscription: "bg-accent/10 text-accent",
  unknown: "bg-warning/10 text-warning",
};

export function billingTitle(billing: InstanceBilling | undefined): string {
  const cls = billing?.billingClass ?? "unknown";
  const parts = [`Cost: ${BILLING_LABEL[cls]}`];
  if (billing?.rateSource) parts.push(`source: ${billing.rateSource}`);
  if (billing?.rateCheckedAt) parts.push(`reviewed ${billing.rateCheckedAt}`);
  if (billing?.requiresExplicitSelection) parts.push("needs explicit cost acknowledgement before first use");
  return parts.join(" · ");
}

export function BillingBadge({ billing, className }: { billing: InstanceBilling | undefined; className?: string }) {
  const cls = billing?.billingClass ?? "unknown";
  return (
    <span
      title={billingTitle(billing)}
      className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium", BADGE_STYLE[cls], className)}
    >
      {BILLING_LABEL[cls]}
    </span>
  );
}

/** Fail-closed UI predicate: does selecting this (instance, model) need a
 * recorded cost acknowledgement first? Mirrors the server spend gate —
 * unknown billing fails closed, so an absent billing block still gates. */
export function needsSpendAck(
  billing: InstanceBilling | undefined,
  modelBillingClass: BillingClass | undefined,
): boolean {
  const cls = modelBillingClass ?? billing?.billingClass ?? "unknown";
  const requires = billing?.requiresExplicitSelection ?? true;
  return requires || cls !== "free";
}
