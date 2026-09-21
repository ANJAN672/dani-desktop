import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderAdapter, RuntimeEventListener } from "../contracts.ts";
import { DaniExecutionKernel } from "./kernel.ts";
import { DaniKernelRepository } from "./repository.ts";
import type { KernelEffectAdapter } from "./effect-service.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe("installed-profile vertical kernel", () => {
  it("completes 20 clean profiles without a duplicate external effect", async () => {
    for (let run = 0; run < 20; run += 1) {
      const root = mkdtempSync(join(tmpdir(), `dani-clean-profile-${run}-`)); roots.push(root);
      const listeners = new Set<RuntimeEventListener>();
      const hermes: ProviderAdapter = {
        provider: "hermesAgent", capabilities: { sessionModelSwitch: "in-session" },
        sendTurn: vi.fn(async input => {
          queueMicrotask(() => listeners.forEach(listener => listener({
            eventId: `event-${run}`, provider: "hermesAgent", threadId: input.threadId,
            turnId: `provider-turn-${run}`, createdAt: new Date().toISOString(),
            type: "turn.completed", ok: true, stopReason: "end_turn",
          })));
          return { turnId: `provider-turn-${run}` };
        }),
        interruptTurn: async () => undefined, respondToRequest: async () => "unavailable",
        hasSession: () => false, stopAll: async () => undefined,
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      };
      const externalWrites: string[] = [];
      const browser: KernelEffectAdapter = {
        name: "browser", idempotency: "reconcile",
        async execute(_input, context) { externalWrites.push(context.idempotencyKey); return { externalReference: `receipt-${run}` }; },
        async inspect(reference) { return { confirmed: true, sourceTimestamp: new Date().toISOString(), sourceReference: reference, inspection: { submitted: true } }; },
      };
      const repository = new DaniKernelRepository(join(root, ".danibot", "kernel.sqlite"));
      const kernel = new DaniExecutionKernel(repository, hermes, new Map([[browser.name, browser]]));
      expect(kernel.recover()).toBe(0);
      const job = kernel.admit({ ownerId: "user-1", objective: "submit one form", originatingRequestId: `request-${run}`, turnId: `turn-${run}`, provider: "hermes", threadId: `thread-${run}` });
      await kernel.plan(String(job.id), 1, { text: "submit the form" });
      const effect = kernel.propose({ jobId: String(job.id), generation: 1, idempotencyKey: `request-${run}:submit`, adapter: "browser", normalizedInput: { action: "submit" }, risk: "representation", resource: "form", audience: "vendor" });
      kernel.approve({ effectId: String(effect.id), userId: "user-1", scope: "submit once", resource: "form", audience: "vendor", limits: { count: 1 }, expiresAt: "2999-01-01T00:00:00Z", originatingRequestId: `request-${run}`, decision: "approved" });
      await expect(kernel.execute(String(effect.id), 1)).resolves.toMatchObject({ status: "completed" });
      await expect(kernel.execute(String(effect.id), 1)).rejects.toThrow();
      expect(externalWrites).toEqual([`request-${run}:submit`]);
      expect(kernel.diagnostic(String(job.id))).toMatchObject({ job: { status: "completed" }, effects: [{ state: "completed" }] });
      await kernel.close();
    }
  });
});
