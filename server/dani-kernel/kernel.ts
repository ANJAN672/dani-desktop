import type { ProviderAdapter } from "../contracts.ts";
import { kernelDiagnostic } from "./diagnostics.ts";
import { DaniKernelEffectService, type KernelEffectAdapter } from "./effect-service.ts";
import { HermesKernelTurnService, type HermesKernelTurnInput } from "./hermes-turn.ts";
import { DaniKernelRepository } from "./repository.ts";
import type { AdmitJobInput, ApprovalGrantInput, ProposeEffectInput } from "./types.ts";

/** One application boundary owns all writes to the execution ledgers. */
export class DaniExecutionKernel {
  readonly turns: HermesKernelTurnService;
  readonly effects: DaniKernelEffectService;

  readonly repository: DaniKernelRepository;
  constructor(
    repository: DaniKernelRepository,
    hermes: ProviderAdapter,
    adapters: ReadonlyMap<string, KernelEffectAdapter>,
  ) {
    this.repository = repository;
    this.turns = new HermesKernelTurnService(repository, hermes);
    this.effects = new DaniKernelEffectService(repository, adapters);
  }

  recover() { return this.repository.reconcileAfterRestart(); }
  admit(input: AdmitJobInput) { return this.repository.admitJob(input); }
  async plan(jobId: string, generation: number, turn: Omit<HermesKernelTurnInput, "jobId" | "generation">) {
    return this.turns.run({ ...turn, jobId, generation });
  }
  dispatchPlan(jobId: string, generation: number, turn: Omit<HermesKernelTurnInput, "jobId" | "generation">) {
    return this.turns.dispatch({ ...turn, jobId, generation });
  }
  propose(input: ProposeEffectInput) { return this.repository.proposeEffect(input); }
  approve(input: ApprovalGrantInput) { return this.repository.recordApproval(input); }
  execute(effectId: string, generation: number) { return this.effects.execute(effectId, generation); }
  reconcile(effectId: string, generation: number) { return this.effects.reconcile(effectId, generation); }
  cancel(jobId: string, reason: string) { return this.turns.cancel(jobId, reason); }
  diagnostic(jobId: string) { return kernelDiagnostic(this.repository, jobId); }
  async close() { await this.turns.dispose(); this.repository.close(); }
}
