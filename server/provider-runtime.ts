import type {
  ProviderAdapter,
  ProviderInstance,
  SendTurnInput,
  TurnStartResult,
} from "./contracts.ts";

/** A stateless execution facade over a registry-owned provider instance. */
export interface ProviderRuntime {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly driverKind: ProviderInstance["driverKind"];
  readonly displayName: ProviderInstance["displayName"];
  readonly enabled: ProviderInstance["enabled"];
  readonly models: ProviderInstance["models"];
  readonly capabilities: ProviderAdapter["capabilities"];
  readonly snapshot: ProviderInstance["snapshot"];
  readonly sendTurn: (input: SendTurnInput) => Promise<TurnStartResult>;
  readonly interruptTurn: ProviderAdapter["interruptTurn"];
  readonly respondToRequest: ProviderAdapter["respondToRequest"];
  readonly steer: ProviderAdapter["steer"];
}

/**
 * Projects adapter execution without taking over instance lifecycle, event
 * subscriptions, or authentication. Callers must obtain a fresh projection
 * whenever the registry can replace the underlying instance.
 */
export function providerRuntime(instance: ProviderInstance): ProviderRuntime;
export function providerRuntime(instance: ProviderInstance | null | undefined): ProviderRuntime | undefined;
export function providerRuntime(instance: ProviderInstance | null | undefined): ProviderRuntime | undefined {
  if (!instance) return undefined;

  const adapter = instance.adapter;
  return {
    instanceId: instance.instanceId,
    driverKind: instance.driverKind,
    displayName: instance.displayName,
    enabled: instance.enabled,
    models: instance.models,
    capabilities: adapter.capabilities,
    snapshot: instance.snapshot.bind(instance),
    sendTurn: adapter.sendTurn.bind(adapter),
    interruptTurn: adapter.interruptTurn.bind(adapter),
    respondToRequest: adapter.respondToRequest.bind(adapter),
    steer: adapter.steer?.bind(adapter),
  };
}
