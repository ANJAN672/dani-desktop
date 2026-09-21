import { RETRY_MAX_ATTEMPTS } from "./drivers/retry.ts";
import type { InstanceId, RuntimeEvent } from "./contracts.ts";
import type { ProviderMaintenanceSignal } from "./provider-maintenance.ts";

export const PROVIDER_RETRY_MAINTENANCE_THRESHOLD = RETRY_MAX_ATTEMPTS;

interface RetryState {
  pending: boolean;
}

/** Turns the driver's final retry relaunch into one exact-instance maintenance signal. */
export class ProviderRetryMaintenanceMonitor {
  private readonly states = new Map<InstanceId, RetryState>();

  observe(event: Extract<RuntimeEvent, { type: "turn.retrying" }>): ProviderMaintenanceSignal | null {
    const instanceId = event.providerInstanceId;
    if (!instanceId) return null;

    const state = this.states.get(instanceId);
    if (state?.pending) return null;

    // attempt is 1-based over retries. Reaching the last allowed relaunch means
    // the provider has exhausted the configured three-attempt retry budget.
    if (event.attempt < PROVIDER_RETRY_MAINTENANCE_THRESHOLD - 1) return null;

    this.states.set(instanceId, { pending: true });
    return {
      instanceId,
      reason: "provider retry threshold crossed",
      threshold: {
        kind: "retry-attempts",
        count: PROVIDER_RETRY_MAINTENANCE_THRESHOLD,
        current: event.attempt + 1,
        maximum: PROVIDER_RETRY_MAINTENANCE_THRESHOLD,
        source: "turn.retrying",
        reason: event.reason,
      },
    };
  }

  complete(instanceId: InstanceId): void {
    const state = this.states.get(instanceId);
    if (!state?.pending) this.states.delete(instanceId);
  }

  acknowledge(instanceId: InstanceId): void {
    this.states.delete(instanceId);
  }

  retry(instanceId: InstanceId): void {
    const state = this.states.get(instanceId);
    if (state) state.pending = false;
  }
}
