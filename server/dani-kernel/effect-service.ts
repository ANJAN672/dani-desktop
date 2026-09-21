import type { AdapterEvidenceInput } from "./types.ts";
import { DaniKernelRepository } from "./repository.ts";

export interface KernelAdapterContext {
  jobId: string;
  effectId: string;
  generation: number;
  idempotencyKey: string;
}

export interface KernelAdapterResult {
  externalReference: string;
}

export interface KernelInspection {
  confirmed: boolean;
  sourceTimestamp: string;
  sourceReference: string;
  inspection: unknown;
}

export interface KernelEffectAdapter {
  readonly name: string;
  readonly idempotency: "native" | "reconcile" | "read-only";
  execute(input: unknown, context: KernelAdapterContext): Promise<KernelAdapterResult>;
  inspect(externalReference: string, context: KernelAdapterContext): Promise<KernelInspection>;
  reconcile?(input: unknown, context: KernelAdapterContext): Promise<KernelInspection & { externalReference?: string }>;
}

export type ExecuteEffectResult =
  | { status: "completed"; externalReference: string; evidence: AdapterEvidenceInput }
  | { status: "uncertain"; reason: string };

export class DaniKernelEffectService {
  constructor(
    private readonly repository: DaniKernelRepository,
    private readonly adapters: ReadonlyMap<string, KernelEffectAdapter>,
  ) {}

  private adapter(name: string) {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`unknown kernel adapter ${name}`);
    return adapter;
  }

  private context(effectId: string, generation: number): KernelAdapterContext {
    const effect = this.repository.effect(effectId);
    return {
      jobId: String(effect.job_id), effectId, generation,
      idempotencyKey: String(effect.idempotency_key),
    };
  }

  async execute(effectId: string, generation: number): Promise<ExecuteEffectResult> {
    const effect = this.repository.effect(effectId);
    const adapter = this.adapter(String(effect.adapter));
    const context = this.context(effectId, generation);
    this.repository.beginDispatch(effectId, generation);
    let result: KernelAdapterResult;
    try {
      result = await adapter.execute(JSON.parse(String(effect.normalized_input)), context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.repository.markDispatchUncertain(effectId, generation, `adapter returned without a durable outcome: ${reason}`);
      return { status: "uncertain", reason };
    }
    this.repository.markExternalResult(effectId, generation, result.externalReference);
    const inspection = await adapter.inspect(result.externalReference, context).catch(error => ({
      confirmed: false,
      sourceTimestamp: new Date().toISOString(),
      sourceReference: result.externalReference,
      inspection: { error: error instanceof Error ? error.message : String(error) },
    }));
    if (!inspection.confirmed) {
      this.repository.markDispatchUncertain(effectId, generation, "external result could not be confirmed by adapter inspection");
      return { status: "uncertain", reason: "adapter inspection did not confirm the effect" };
    }
    const evidence: AdapterEvidenceInput = {
      effectId, adapter: adapter.name, sourceTimestamp: inspection.sourceTimestamp,
      sourceReference: inspection.sourceReference, inspection: inspection.inspection,
    };
    this.repository.recordAdapterEvidence(evidence);
    this.repository.completeEffect(effectId, generation);
    return { status: "completed", externalReference: result.externalReference, evidence };
  }

  async reconcile(effectId: string, generation: number): Promise<ExecuteEffectResult> {
    const effect = this.repository.effect(effectId);
    if (String(effect.state) !== "uncertain") throw new Error("only uncertain effects can be reconciled");
    const adapter = this.adapter(String(effect.adapter));
    if (!adapter.reconcile) return { status: "uncertain", reason: "adapter has no safe reconciliation read" };
    const context = this.context(effectId, generation);
    const inspection = await adapter.reconcile(JSON.parse(String(effect.normalized_input)), context);
    if (!inspection.confirmed || !inspection.externalReference) {
      return { status: "uncertain", reason: "reconciliation did not prove the external effect" };
    }
    this.repository.resumeUncertainForInspection(effectId, generation, inspection.externalReference);
    const evidence: AdapterEvidenceInput = {
      effectId, adapter: adapter.name, sourceTimestamp: inspection.sourceTimestamp,
      sourceReference: inspection.sourceReference, inspection: inspection.inspection,
    };
    this.repository.recordAdapterEvidence(evidence);
    this.repository.completeEffect(effectId, generation);
    return { status: "completed", externalReference: inspection.externalReference, evidence };
  }
}
