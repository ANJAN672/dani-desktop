import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { ProviderRetryMaintenanceMonitor, PROVIDER_RETRY_MAINTENANCE_THRESHOLD } from "./provider-retry-maintenance.ts";

const retry = (attempt: number): Extract<RuntimeEvent, { type: "turn.retrying" }> => ({
  eventId: `retry-${attempt}`,
  provider: "openai-compat",
  providerInstanceId: "dani-free",
  threadId: "thread-1",
  turnId: "turn-1",
  createdAt: "2026-09-21T00:00:00.000Z",
  type: "turn.retrying",
  attempt,
  delayMs: 1000,
  reason: "temporary provider failure",
});

describe("ProviderRetryMaintenanceMonitor", () => {
  it("publishes one exact-instance maintenance signal at the final retry boundary", () => {
    const monitor = new ProviderRetryMaintenanceMonitor();

    expect(monitor.observe(retry(1))).toBeNull();
    const signal = monitor.observe(retry(2));
    expect(signal).toEqual({
      instanceId: "dani-free",
      reason: "provider retry threshold crossed",
      threshold: {
        kind: "retry-attempts",
        count: PROVIDER_RETRY_MAINTENANCE_THRESHOLD,
        current: 3,
        maximum: PROVIDER_RETRY_MAINTENANCE_THRESHOLD,
        source: "turn.retrying",
        reason: "temporary provider failure",
      },
    });
    expect(monitor.observe(retry(2))).toBeNull();
  });

  it("keeps pending maintenance alive across a terminal event until acknowledged", () => {
    const monitor = new ProviderRetryMaintenanceMonitor();
    expect(monitor.observe(retry(2))).not.toBeNull();

    monitor.complete("dani-free");
    expect(monitor.observe(retry(2))).toBeNull();

    monitor.acknowledge("dani-free");
    expect(monitor.observe(retry(2))).not.toBeNull();
  });

  it("clears retry state after a completed turn that did not cross maintenance", () => {
    const monitor = new ProviderRetryMaintenanceMonitor();
    expect(monitor.observe(retry(1))).toBeNull();

    monitor.complete("dani-free");
    expect(monitor.observe(retry(2))).not.toBeNull();
  });
});
