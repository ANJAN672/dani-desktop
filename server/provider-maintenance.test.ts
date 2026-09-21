import { expect, it } from "vitest";
import type { InstanceConfig, ProviderInstance } from "./contracts.ts";
import {
  ProviderMaintenanceCoordinator,
  ProviderMaintenanceDeferredError,
  ProviderMaintenanceSignal,
  ProviderMaintenanceUnavailableError,
} from "./provider-maintenance.ts";

const config = (driver = "fake"): InstanceConfig => ({
  driver,
  displayName: `${driver}-instance`,
  config: { marker: driver },
});

const signal = (instanceId: string): ProviderMaintenanceSignal => ({
  instanceId,
  reason: "usage threshold crossed",
  threshold: { kind: "requests", count: 101, name: "requests", value: 101, limit: 100, source: "test" },
});

function adapter() {
  return {
    provider: "fake",
    capabilities: { sessionModelSwitch: "unsupported" as const },
    sendTurn: async () => ({ turnId: "turn" }),
    interruptTurn: async () => {},
    respondToRequest: async () => "unavailable" as const,
    hasSession: () => false,
    stopAll: async () => {},
    onEvent: () => () => {},
  };
}

function provider(instanceId: string): ProviderInstance {
  return {
    instanceId,
    driverKind: "fake",
    displayName: instanceId,
    enabled: true,
    models: { default: "test", options: [] },
    adapter: adapter(),
    snapshot: async () => ({ state: "available" as const }),
    dispose: async () => {},
  };
}

class FakeRegistry {
  readonly instances = new Map<string, ProviderInstance>();
  readonly loads: InstanceConfig[] = [];

  constructor(...ids: string[]) {
    for (const instanceId of ids) this.instances.set(instanceId, provider(instanceId));
  }

  get(instanceId: string): ProviderInstance | null {
    return this.instances.get(instanceId) ?? null;
  }

  async load(configs: Record<string, InstanceConfig>): Promise<void> {
    for (const [instanceId, entry] of Object.entries(configs)) {
      this.loads.push(entry);
      this.instances.delete(instanceId);
      if (entry.enabled !== false) this.instances.set(instanceId, provider(instanceId));
    }
  }
}

class FakeBus {
  readonly detached: string[] = [];
  readonly attached: ProviderInstance[][] = [];

  detach(instanceId: string): void {
    this.detached.push(instanceId);
  }

  attach(instances: readonly ProviderInstance[]): void {
    this.attached.push([...instances]);
  }
}

it("reloads and reattaches only the triggering instance", async () => {
  const registry = new FakeRegistry("triggered", "sibling");
  const bus = new FakeBus();
  const changing = new Set<string>();
  const calls: string[] = [];
  const coordinator = new ProviderMaintenanceCoordinator({
    registry,
    bus,
    providerFleetReloading: false,
    providerInstancesChanging: changing,
    configForInstance: (instanceId) => instanceId === "triggered" ? config("replacement") : undefined,
    cancelActiveWork: async (instanceId, receivedSignal) => {
      calls.push(`cancel:${instanceId}:${receivedSignal.instanceId}`);
    },
    settleInstanceWork: async (instanceId, receivedSignal) => {
      calls.push(`settle:${instanceId}:${receivedSignal.reason}`);
    },
  });

  const result = await coordinator.maintain(signal("triggered"));

  expect(result).toMatchObject({
    status: "maintained",
    instanceId: "triggered",
    reason: "usage threshold crossed",
    attached: true,
  });
  expect(result.replacement?.instanceId).toBe("triggered");
  expect(registry.loads).toEqual([config("replacement")]);
  expect(bus.detached).toEqual(["triggered"]);
  expect(bus.attached).toEqual([[expect.objectContaining({ instanceId: "triggered" })]]);
  expect(calls).toEqual([
    "cancel:triggered:triggered",
    "settle:triggered:usage threshold crossed",
  ]);
  expect(registry.get("sibling")).toEqual(expect.objectContaining({ instanceId: "sibling" }));
  expect(bus.detached).not.toContain("sibling");
  expect(changing).toEqual(new Set());
});

it("defers when the fleet is reloading", async () => {
  const registry = new FakeRegistry("triggered");
  const bus = new FakeBus();
  let fleetReloading = true;
  let cancelCalls = 0;
  const coordinator = new ProviderMaintenanceCoordinator({
    registry,
    bus,
    providerFleetReloading: () => fleetReloading,
    providerInstancesChanging: new Set(),
    configForInstance: () => config(),
    cancelActiveWork: async () => { cancelCalls++; },
    settleInstanceWork: async () => {},
  });

  await expect(coordinator.maintain(signal("triggered"))).rejects.toMatchObject({
    status: 409,
    reason: "fleet-reloading",
  });
  expect(cancelCalls).toBe(0);
  expect(registry.loads).toEqual([]);
  expect(bus.detached).toEqual([]);
  expect(await coordinator.tryMaintain(signal("triggered"))).toMatchObject({ status: "deferred" });
});

it("defers same-instance maintenance while a replacement is in flight", async () => {
  const registry = new FakeRegistry("triggered");
  const bus = new FakeBus();
  const changing = new Set<string>();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new ProviderMaintenanceCoordinator({
    registry,
    bus,
    providerFleetReloading: false,
    providerInstancesChanging: changing,
    configForInstance: () => config(),
    cancelActiveWork: async () => { await gate; },
    settleInstanceWork: async () => {},
  });

  const first = coordinator.maintain(signal("triggered"));
  await Promise.resolve();
  await expect(coordinator.maintain(signal("triggered"))).rejects.toBeInstanceOf(ProviderMaintenanceDeferredError);
  expect(changing).toEqual(new Set(["triggered"]));
  release();
  await first;
  expect(changing).toEqual(new Set());
});

it("rejects when another caller already owns the instance guard", async () => {
  const registry = new FakeRegistry("triggered");
  const bus = new FakeBus();
  const changing = new Set(["triggered"]);
  let cancelCalls = 0;
  const coordinator = new ProviderMaintenanceCoordinator({
    registry,
    bus,
    providerFleetReloading: false,
    providerInstancesChanging: changing,
    configForInstance: () => config(),
    cancelActiveWork: async () => { cancelCalls++; },
    settleInstanceWork: async () => {},
  });

  await expect(coordinator.tryMaintain(signal("triggered"))).resolves.toEqual({
    status: "deferred",
    instanceId: "triggered",
    reason: "instance-changing",
    signal: signal("triggered"),
  });
  expect(cancelCalls).toBe(0);
  expect(changing).toEqual(new Set(["triggered"]));
});

it("fails closed when the current instance is unavailable", async () => {
  const registry = new FakeRegistry();
  const bus = new FakeBus();
  const changing = new Set<string>();
  let cancelCalls = 0;
  const coordinator = new ProviderMaintenanceCoordinator({
    registry,
    bus,
    providerFleetReloading: false,
    providerInstancesChanging: changing,
    configForInstance: () => config(),
    cancelActiveWork: async () => { cancelCalls++; },
    settleInstanceWork: async () => {},
  });

  await expect(coordinator.maintain(signal("missing"))).rejects.toBeInstanceOf(ProviderMaintenanceUnavailableError);
  expect(cancelCalls).toBe(0);
  expect(registry.loads).toEqual([]);
  expect(bus.detached).toEqual([]);
  expect(changing).toEqual(new Set());
});

it("does not attach when registry.load leaves the instance unavailable", async () => {
  const registry = new FakeRegistry("triggered");
  const bus = new FakeBus();
  const coordinator = new ProviderMaintenanceCoordinator({
    registry,
    bus,
    providerFleetReloading: false,
    providerInstancesChanging: new Set(),
    configForInstance: () => ({ ...config(), enabled: false }),
    cancelActiveWork: async () => {},
    settleInstanceWork: async () => {},
  });

  await expect(coordinator.maintain(signal("triggered"))).resolves.toMatchObject({
    status: "maintained",
    attached: false,
    replacement: null,
  });
  expect(bus.detached).toEqual(["triggered"]);
  expect(bus.attached).toEqual([]);
});

it("clears the instance guard after settlement or load failure", async () => {
  const registry = new FakeRegistry("triggered");
  const bus = new FakeBus();
  const changing = new Set<string>();
  const coordinator = new ProviderMaintenanceCoordinator({
    registry,
    bus,
    providerFleetReloading: false,
    providerInstancesChanging: changing,
    configForInstance: () => config(),
    cancelActiveWork: async () => {},
    settleInstanceWork: async () => { throw new Error("settlement failed"); },
  });

  await expect(coordinator.maintain(signal("triggered"))).rejects.toThrow("settlement failed");
  expect(changing).toEqual(new Set());
  expect(bus.detached).toEqual([]);

  const loadCoordinator = new ProviderMaintenanceCoordinator({
    registry,
    bus,
    providerFleetReloading: false,
    providerInstancesChanging: changing,
    configForInstance: () => config(),
    cancelActiveWork: async () => {},
    settleInstanceWork: async () => {},
  });
  const originalLoad = registry.load.bind(registry);
  registry.load = async (configs) => { await originalLoad(configs); throw new Error("load failed"); };

  await expect(loadCoordinator.maintain(signal("triggered"))).rejects.toThrow("load failed");
  expect(changing).toEqual(new Set());
});

it("passes threshold metadata through to work settlement hooks", async () => {
  const registry = new FakeRegistry("triggered");
  const bus = new FakeBus();
  const changing = new Set<string>();
  let receivedSignal: ProviderMaintenanceSignal | undefined;
  const coordinator = new ProviderMaintenanceCoordinator({
    registry,
    bus,
    providerFleetReloading: false,
    providerInstancesChanging: changing,
    configForInstance: () => config(),
    cancelActiveWork: async () => {},
    settleResources: async (_instanceId, received) => { receivedSignal = received; },
    settleApprovals: async () => {},
    settleRoutines: async () => {},
    settleWatchdog: async () => {},
  });

  const threshold = { kind: "requests", count: 101, metric: "requests", current: 101, maximum: 100, source: "ledger" };
  await coordinator.maintain({ ...signal("triggered"), threshold });
  expect(receivedSignal).toMatchObject({ instanceId: "triggered", threshold });
  expect(bus.attached).toHaveLength(1);
});
