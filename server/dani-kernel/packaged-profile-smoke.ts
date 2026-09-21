import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProviderAdapter, RuntimeEventListener } from "../contracts.ts";
import { DaniExecutionKernel } from "./kernel.ts";
import { DaniKernelRepository } from "./repository.ts";
import type { KernelEffectAdapter } from "./effect-service.ts";

export interface PackagedKernelSmokeReport {
  profileId: string;
  phase: "executed" | "recovered";
  jobStatus: string;
  effectStatus: string;
  externalWrites: number;
  evidenceCount: number;
  duplicatePrevented: boolean;
  databasePath: string;
  proactivePhase: "proposed" | "recovered";
  proactiveProposalCount: number;
  proactiveCancelGeneration: number;
}

/**
 * Deterministic release-only probe for #11. The caller must gate this behind
 * DANI_KERNEL_PROFILE_SMOKE=1. It uses the same bundled kernel classes and
 * SQLite/WAL path shape as the installed server, but a synthetic Hermes
 * provider and file adapter keep CI offline and make duplicate writes visible.
 */
export async function runPackagedKernelProfileSmoke(
  dataDir: string,
  profileId: string,
): Promise<PackagedKernelSmokeReport> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(profileId))
    throw new Error("invalid packaged kernel smoke profile id");
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, "execution-kernel.sqlite");
  const writesPath = join(dataDir, "kernel-smoke-writes.json");
  const listeners = new Set<RuntimeEventListener>();
  const hermes: ProviderAdapter = {
    provider: "hermesAgent",
    capabilities: { sessionModelSwitch: "in-session" },
    async sendTurn(input) {
      const turnId = `packaged-${profileId}`;
      queueMicrotask(() =>
        listeners.forEach((listener) =>
          listener({
            eventId: randomUUID(),
            provider: "hermesAgent",
            threadId: input.threadId,
            turnId,
            createdAt: new Date().toISOString(),
            type: "turn.completed",
            ok: true,
            stopReason: "end_turn",
          }),
        ),
      );
      return { turnId };
    },
    async interruptTurn() {},
    async respondToRequest() {
      return "unavailable";
    },
    hasSession() {
      return false;
    },
    async stopAll() {},
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const readWrites = (): string[] => {
    if (!existsSync(writesPath)) return [];
    const parsed = JSON.parse(readFileSync(writesPath, "utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.some((value) => typeof value !== "string")
    )
      throw new Error("invalid packaged smoke write ledger");
    return parsed;
  };
  const adapter: KernelEffectAdapter = {
    name: "packaged-file",
    idempotency: "native",
    async execute(_input, context) {
      const writes = readWrites();
      if (!writes.includes(context.idempotencyKey)) {
        writes.push(context.idempotencyKey);
        const temporary = `${writesPath}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(writes)}\n`, {
          mode: 0o600,
        });
        renameSync(temporary, writesPath);
      }
      return {
        externalReference: `file://${writesPath}#${context.idempotencyKey}`,
      };
    },
    async inspect(reference, context) {
      const confirmed = readWrites().includes(context.idempotencyKey);
      return {
        confirmed,
        sourceTimestamp: new Date().toISOString(),
        sourceReference: reference,
        inspection: { persistedIdempotencyKey: confirmed },
      };
    },
  };
  const repository = new DaniKernelRepository(databasePath);
  const kernel = new DaniExecutionKernel(
    repository,
    hermes,
    new Map([[adapter.name, adapter]]),
  );
  try {
    kernel.recover();
    const proactiveKey = `packaged-proactive:${profileId}`;
    const proactive = kernel.proactive.fireInAppEvent({
      ownerId: "packaged-smoke-user",
      botId: "packaged-smoke-bot",
      threadId: `proactive-thread:${profileId}`,
      triggerKey: proactiveKey,
      triggerKind: "packaged-smoke",
      reason: "A packaged smoke trigger fired",
      objective: "Verify packaged proactive recovery",
      occurredAt: new Date().toISOString(),
      expiresAt: "2999-01-01T00:00:00Z",
    });
    if (proactive.state !== "proposed") throw new Error(`packaged proactive trigger ended ${proactive.state}`);
    const proactiveProposal = repository.proactiveProposal(proactive.proposalId, "packaged-smoke-user");
    let proactiveCancelGeneration = 0;
    if (!proactive.duplicate) {
      const accepted = repository.acceptProactiveProposal(proactiveProposal.id, "packaged-smoke-user");
      proactiveCancelGeneration = Number((await kernel.cancel(String(accepted.job.id), "packaged cancellation smoke")).generation);
      if (proactiveCancelGeneration !== 2) throw new Error("packaged proactive cancellation did not fence the generation");
    } else {
      proactiveCancelGeneration = Number(repository.job(String(proactiveProposal.acceptedJobId)).generation);
    }
    const proactiveProposalCount = repository.listProactiveProposals("packaged-smoke-user").filter(item => item.triggerKey === proactiveKey).length;
    if (proactiveProposalCount !== 1 || proactiveCancelGeneration !== 2) {
      throw new Error(`packaged proactive invariant failed: ${JSON.stringify({ proactiveProposalCount, proactiveCancelGeneration })}`);
    }

    const requestId = `packaged-profile:${profileId}`;
    const job = kernel.admit({
      ownerId: "packaged-smoke-user",
      objective: "persist one deterministic external effect",
      originatingRequestId: requestId,
      turnId: `turn:${profileId}`,
      provider: "hermes",
      threadId: `thread:${profileId}`,
    });
    const duplicate = Boolean(job.duplicate);
    if (!duplicate) {
      await kernel.plan(String(job.id), Number(job.generation), {
        text: "persist the packaged smoke marker",
      });
      const effect = kernel.propose({
        jobId: String(job.id),
        generation: Number(job.generation),
        idempotencyKey: `${requestId}:write-once`,
        adapter: adapter.name,
        normalizedInput: { action: "persist-marker", profileId },
        risk: "representation",
        resource: "packaged-smoke-marker",
        audience: "local-test",
      });
      kernel.approve({
        effectId: String(effect.id),
        userId: "packaged-smoke-user",
        scope: "one local CI marker",
        resource: "packaged-smoke-marker",
        audience: "local-test",
        limits: { count: 1 },
        expiresAt: "2999-01-01T00:00:00Z",
        originatingRequestId: requestId,
        decision: "approved",
      });
      const result = await kernel.execute(
        String(effect.id),
        Number(job.generation),
      );
      if (result.status !== "completed")
        throw new Error(`packaged kernel effect ended ${result.status}`);
    }
    const diagnostic = kernel.diagnostic(String(job.id));
    const effect = diagnostic.effects[0];
    const externalWrites = readWrites().filter(
      (value) => value === `${requestId}:write-once`,
    ).length;
    if (
      !effect ||
      diagnostic.job.status !== "completed" ||
      effect.state !== "completed" ||
      effect.evidence.length !== 1 ||
      externalWrites !== 1
    ) {
      throw new Error(
        `packaged kernel invariant failed: ${JSON.stringify({ job: diagnostic.job.status, effect: effect?.state, evidence: effect?.evidence.length, externalWrites })}`,
      );
    }
    return {
      profileId,
      phase: duplicate ? "recovered" : "executed",
      jobStatus: diagnostic.job.status,
      effectStatus: effect.state,
      externalWrites,
      evidenceCount: effect.evidence.length,
      duplicatePrevented: duplicate,
      databasePath,
      proactivePhase: proactive.duplicate ? "recovered" : "proposed",
      proactiveProposalCount,
      proactiveCancelGeneration,
    };
  } finally {
    await kernel.close();
  }
}
