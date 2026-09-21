// Provider spend gate — security/epic-9-D.
//
// A fresh install cannot make a metered (or unknown-cost) provider request
// until the user has EXPLICITLY chosen the provider/model AND acknowledged
// the cost class. Credential presence (an authenticated snapshot, a key in
// the environment) is never consent to spend and never satisfies this gate.
//
// The acknowledgement is a durable record in the app data dir
// (spend-acknowledgements.json), keyed by (instanceId, model): choosing a
// different model needs a new acknowledgement. A missing store file means a
// fresh install — the gate fails closed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BillingClass } from "./contracts.ts";
import { BILLING_LABELS, type ProviderBilling } from "./provider-billing.ts";

export interface SpendAcknowledgement {
  instanceId: string;
  model: string;
  /** The billing class the user acknowledged — always the server-resolved
   * class, never a client-supplied claim. */
  billingClass: BillingClass;
  rateSource?: string;
  acknowledgedAt: string;
}

export type SpendGateVerdict = { ok: true } | { ok: false; error: string };

/** File-backed acknowledgement store. `dataDir` keeps tests on isolated
 * fixtures (AGENTS.md: never the live user data dir). */
export class SpendAckStore {
  private readonly file: string;
  private cache: Record<string, SpendAcknowledgement> | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, "spend-acknowledgements.json");
  }

  private key(instanceId: string, model: string): string {
    return `${instanceId}\n${model}`;
  }

  private load(): Record<string, SpendAcknowledgement> {
    if (this.cache) return this.cache;
    let parsed: Record<string, SpendAcknowledgement> = {};
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          parsed = raw as Record<string, SpendAcknowledgement>;
        }
      }
    } catch {
      // A corrupt ack file must not brick the gate — treat as no acks
      // (fail closed) rather than crash or fail open.
      parsed = {};
    }
    this.cache = parsed;
    return parsed;
  }

  private save(all: Record<string, SpendAcknowledgement>): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(all, null, 2), "utf8");
    this.cache = all;
  }

  find(instanceId: string, model: string): SpendAcknowledgement | undefined {
    return this.load()[this.key(instanceId, model)];
  }

  all(): SpendAcknowledgement[] {
    return Object.values(this.load()).sort((a, b) =>
      a.acknowledgedAt < b.acknowledgedAt ? -1 : a.acknowledgedAt > b.acknowledgedAt ? 1 : 0,
    );
  }

  record(ack: SpendAcknowledgement): SpendAcknowledgement {
    if (!ack.instanceId || !ack.model) throw new Error("instanceId and model are required");
    const all = this.load();
    const entry: SpendAcknowledgement = { ...ack, acknowledgedAt: new Date().toISOString() };
    all[this.key(ack.instanceId, ack.model)] = entry;
    this.save(all);
    return entry;
  }
}

/** The spend gate itself. `free` providers always pass; anything else needs a
 * matching acknowledgement for this exact (instanceId, model). An ack for a
 * different model, or a merely-authenticated provider, does NOT pass. */
export function checkSpendGate(input: {
  billing: ProviderBilling;
  ack: SpendAcknowledgement | undefined;
  instanceId: string;
  model: string;
  displayName?: string;
}): SpendGateVerdict {
  const { billing, ack, instanceId, model, displayName } = input;
  if (!billing.requiresExplicitSelection) return { ok: true };
  const who = displayName ? `${displayName} (${instanceId})` : `provider "${instanceId}"`;
  if (!ack) {
    return {
      ok: false,
      error:
        `${who} is ${BILLING_LABELS[billing.billingClass].toLowerCase()} — ` +
        `pick the model "${model}" in the model picker and acknowledge the cost before the first request. ` +
        `A stored credential alone never authorizes spend.`,
    };
  }
  if (ack.billingClass !== billing.billingClass) {
    return {
      ok: false,
      error:
        `${who} is now classified ${BILLING_LABELS[billing.billingClass].toLowerCase()} ` +
        `(acknowledged as ${BILLING_LABELS[ack.billingClass].toLowerCase()}) — ` +
        `re-acknowledge the current cost class in the model picker before the next request.`,
    };
  }
  return { ok: true };
}
