// Threshold-triggered provider maintenance is deliberately narrow: one live
// instance is quiesced and replaced while its siblings keep running.
import type {
  InstanceConfig,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
} from "./contracts.ts";

export interface ProviderMaintenanceThreshold {
  /** Stable metric name, when the threshold source names one. */
  readonly kind: string;
  /** Threshold value that triggered maintenance. */
  readonly count: number;
  /** Alias for name used by metric-oriented threshold producers. */
  readonly name?: string;
  /** Alias for name used by metric-oriented threshold producers. */
  readonly metric?: string;
  /** Observed value, when the producer uses value/current terminology. */
  readonly value?: number;
  readonly current?: number;
  /** Ceiling used to trigger maintenance. */
  readonly limit?: number;
  readonly maximum?: number;
  /** Additional source-specific metadata is retained verbatim. */
  readonly [key: string]: unknown;
}

export interface ProviderMaintenanceSignal {
  readonly instanceId: InstanceId;
  /** Human-readable cause supplied by the threshold owner. */
  readonly reason: string;
  readonly threshold: ProviderMaintenanceThreshold;
}

/** The registry owns provider process/session lifecycle. */
export interface ProviderRegistryLike {
  get(instanceId: InstanceId): ProviderInstance | null;
  load(config: InstanceConfigMap): Promise<void>;
}

/** The bus owns event subscriptions; maintenance only changes one instance. */
export interface ProviderBusLike {
  detach(instanceId: InstanceId): void;
  attach(instances: readonly ProviderInstance[]): void;
}

export type MaybePromise<T> = T | Promise<T>;

export interface ProviderMaintenanceSettlementHooks {
  /** Cancel only work owned by this provider instance. */
  cancelActiveWork: (
    instanceId: InstanceId,
    signal: ProviderMaintenanceSignal,
  ) => MaybePromise<void>;
  /** One callback can settle all instance-owned resources and work. */
  settleInstanceWork?: (
    instanceId: InstanceId,
    signal: ProviderMaintenanceSignal,
  ) => MaybePromise<void>;
  /** Optional fine-grained settlement hooks for an index.ts integration. */
  settleResources?: (
    instanceId: InstanceId,
    signal: ProviderMaintenanceSignal,
  ) => MaybePromise<void>;
  settleApprovals?: (
    instanceId: InstanceId,
    signal: ProviderMaintenanceSignal,
  ) => MaybePromise<void>;
  settleRoutines?: (
    instanceId: InstanceId,
    signal: ProviderMaintenanceSignal,
  ) => MaybePromise<void>;
  settleWatchdog?: (
    instanceId: InstanceId,
    signal: ProviderMaintenanceSignal,
  ) => MaybePromise<void>;
}

export interface ProviderMaintenanceCoordinatorOptions extends ProviderMaintenanceSettlementHooks {
  readonly registry: ProviderRegistryLike;
  readonly bus: ProviderBusLike;
  /** A live value or a getter; both keep the flag owned by the caller. */
  readonly providerFleetReloading: boolean | (() => boolean);
  /** The caller's exact-instance configuration guard. */
  readonly providerInstancesChanging: Set<InstanceId>;
  /** Used when maintain() is called without an explicit config argument. */
  readonly configForInstance?: (instanceId: InstanceId) => InstanceConfig | undefined;
  readonly getInstanceConfig?: (instanceId: InstanceId) => InstanceConfig | undefined;
}

export type ProviderMaintenanceOptions = ProviderMaintenanceCoordinatorOptions;

export type ProviderMaintenanceDeferredReason = "fleet-reloading" | "instance-changing";

export interface ProviderMaintenanceResult {
  readonly status: "maintained";
  readonly instanceId: InstanceId;
  readonly reason: string;
  readonly threshold: ProviderMaintenanceThreshold;
  readonly attached: boolean;
  readonly replacement: ProviderInstance | null;
}

export interface ProviderMaintenanceDeferredResult {
  readonly status: "deferred";
  readonly instanceId: InstanceId;
  readonly reason: ProviderMaintenanceDeferredReason;
  readonly signal: ProviderMaintenanceSignal;
}

export interface ProviderMaintenanceUnavailableResult {
  readonly status: "unavailable";
  readonly instanceId: InstanceId;
  readonly signal: ProviderMaintenanceSignal;
}

export type ProviderMaintenanceOutcome =
  | ProviderMaintenanceResult
  | ProviderMaintenanceDeferredResult
  | ProviderMaintenanceUnavailableResult;


export class ProviderMaintenanceDeferredError extends Error {
  readonly status = 409;
  readonly code = "provider_maintenance_deferred";
  readonly reason: ProviderMaintenanceDeferredReason;
  readonly instanceId: InstanceId;
  readonly signal: ProviderMaintenanceSignal;

  constructor(signal: ProviderMaintenanceSignal, reason: ProviderMaintenanceDeferredReason) {
    super(
      reason === "fleet-reloading"
        ? `provider maintenance for ${signal.instanceId} deferred while the provider fleet is reloading`
        : `provider maintenance for ${signal.instanceId} deferred while that instance is changing`,
    );
    this.name = "ProviderMaintenanceDeferredError";
    this.reason = reason;
    this.instanceId = signal.instanceId;
    this.signal = signal;
  }
}

export class ProviderMaintenanceUnavailableError extends Error {
  readonly status = 503;
  readonly code = "provider_unavailable";
  readonly instanceId: InstanceId;
  readonly signal: ProviderMaintenanceSignal;

  constructor(signal: ProviderMaintenanceSignal) {
    super(`cannot maintain unavailable provider instance "${signal.instanceId}"`);
    this.name = "ProviderMaintenanceUnavailableError";
    this.instanceId = signal.instanceId;
    this.signal = signal;
  }
}

export class ProviderMaintenanceConfigurationError extends Error {
  readonly status = 409;
  readonly code = "provider_maintenance_configuration";
  readonly instanceId: InstanceId;

  constructor(instanceId: InstanceId, message: string) {
    super(`${message} for provider instance "${instanceId}"`);
    this.name = "ProviderMaintenanceConfigurationError";
    this.instanceId = instanceId;
  }
}

function isInstanceConfig(value: unknown): value is InstanceConfig {
  return typeof value === "object" && value !== null && typeof (value as { driver?: unknown }).driver === "string";
}

function assertSignal(signal: ProviderMaintenanceSignal): void {
  if (typeof signal?.instanceId !== "string" || !signal.instanceId.trim()) {
    throw Object.assign(new Error("provider maintenance signal requires an instanceId"), {
      status: 400,
      code: "invalid_provider_maintenance_signal",
    });
  }
  if (typeof signal.reason !== "string" || !signal.reason.trim()) {
    throw Object.assign(new Error("provider maintenance signal requires a reason"), {
      status: 400,
      code: "invalid_provider_maintenance_signal",
    });
  }
  if (typeof signal.threshold !== "object" || signal.threshold === null) {
    throw Object.assign(new Error("provider maintenance signal requires threshold metadata"), {
      status: 400,
      code: "invalid_provider_maintenance_signal",
    });
  }
}

/**
 * Coordinates one threshold-triggered instance replacement. The coordinator
 * never constructs drivers or owns global lifecycle state: registry, bus,
 * guards and work settlement all come from the caller.
 */
export class ProviderMaintenanceCoordinator {
  private readonly options: ProviderMaintenanceCoordinatorOptions;

  constructor(options: ProviderMaintenanceCoordinatorOptions) {
    this.options = options;
  }

  async maintain(
    signal: ProviderMaintenanceSignal,
    suppliedConfig?: InstanceConfig | InstanceConfigMap,
  ): Promise<ProviderMaintenanceResult> {
    assertSignal(signal);
    const { instanceId } = signal;

    const fleetReloading = this.isFleetReloading();
    if (fleetReloading || this.options.providerInstancesChanging.has(instanceId)) {
      throw new ProviderMaintenanceDeferredError(
        signal,
        fleetReloading ? "fleet-reloading" : "instance-changing",
      );
    }

    this.options.providerInstancesChanging.add(instanceId);
    let acquiredGuard = false;
    try {
      acquiredGuard = true;
      const current = this.options.registry.get(instanceId);
      if (!current) throw new ProviderMaintenanceUnavailableError(signal);

      const config = this.resolveConfig(instanceId, suppliedConfig);
      await this.options.cancelActiveWork(instanceId, signal);
      await this.settleInstanceWork(instanceId, signal);

      // Revoke event delivery before replacing the registry entry. The old
      // instance has already been quiesced, and no sibling subscription moves.
      this.options.bus.detach(instanceId);
      await this.options.registry.load({ [instanceId]: config });

      const replacement = this.options.registry.get(instanceId);
      if (replacement) this.options.bus.attach([replacement]);

      return {
        status: "maintained",
        instanceId,
        reason: signal.reason,
        threshold: signal.threshold,
        attached: replacement !== null,
        replacement,
      };
    } finally {
      if (acquiredGuard) this.options.providerInstancesChanging.delete(instanceId);
    }
  }

  /** Non-throwing form for background threshold callbacks that need retry. */
  async tryMaintain(
    signal: ProviderMaintenanceSignal,
    suppliedConfig?: InstanceConfig | InstanceConfigMap,
  ): Promise<ProviderMaintenanceOutcome> {
    try {
      return await this.maintain(signal, suppliedConfig);
    } catch (error) {
      if (error instanceof ProviderMaintenanceDeferredError) {
        return {
          status: "deferred",
          instanceId: error.instanceId,
          reason: error.reason,
          signal: error.signal,
        };
      }
      if (error instanceof ProviderMaintenanceUnavailableError) {
        return {
          status: "unavailable",
          instanceId: error.instanceId,
          signal: error.signal,
        };
      }
      throw error;
    }
  }

  private isFleetReloading(): boolean {
    const value = this.options.providerFleetReloading;
    return typeof value === "function" ? value() : value;
  }

  private resolveConfig(
    instanceId: InstanceId,
    suppliedConfig?: InstanceConfig | InstanceConfigMap,
  ): InstanceConfig {
    const config = suppliedConfig ??
      this.options.configForInstance?.(instanceId) ??
      this.options.getInstanceConfig?.(instanceId);

    if (config === undefined) {
      throw new ProviderMaintenanceConfigurationError(instanceId, "no instance configuration was supplied");
    }
    if (isInstanceConfig(config)) return config;

    // A map is accepted for callers that already hold the full config object;
    // only the triggered instance is passed back to registry.load().
    const entry = (config as InstanceConfigMap)[instanceId];
    if (!isInstanceConfig(entry)) {
      throw new ProviderMaintenanceConfigurationError(
        instanceId,
        "supplied configuration does not contain the triggered instance",
      );
    }
    return entry;
  }

  private async settleInstanceWork(
    instanceId: InstanceId,
    signal: ProviderMaintenanceSignal,
  ): Promise<void> {
    const settleAll = this.options.settleInstanceWork;
    if (settleAll) {
      await settleAll(instanceId, signal);
      return;
    }

    const hooks = [
      this.options.settleResources,
      this.options.settleApprovals,
      this.options.settleRoutines,
      this.options.settleWatchdog,
    ].filter((hook): hook is NonNullable<typeof hook> => hook !== undefined);
    if (!hooks.length) {
      throw new ProviderMaintenanceConfigurationError(
        instanceId,
        "no exact-instance work settlement callback was supplied",
      );
    }
    for (const settle of hooks) await settle(instanceId, signal);
  }
}

export async function maintainProviderInstance(
  signal: ProviderMaintenanceSignal,
  options: ProviderMaintenanceCoordinatorOptions,
  suppliedConfig?: InstanceConfig | InstanceConfigMap,
): Promise<ProviderMaintenanceResult> {
  return new ProviderMaintenanceCoordinator(options).maintain(signal, suppliedConfig);
}

export { maintainProviderInstance as maintainProvider };
