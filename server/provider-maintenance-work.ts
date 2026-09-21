import type { InstanceId } from "./contracts.ts";

export interface ProviderMaintenanceBot {
  readonly id: string;
  readonly modelSelection: { readonly instanceId: InstanceId };
}

export interface ProviderMaintenanceTask {
  readonly threadId: string;
}

export interface ProviderMaintenanceTurnOwner {
  readonly threadId: string;
  readonly generation: string;
}

export interface ProviderMaintenanceGroupOperation {
  readonly id: string;
  readonly threadId: string;
  readonly cancelled: boolean;
}

export interface ProviderMaintenanceSpeaker {
  readonly botId: string;
  readonly name: string;
  readonly color: string;
}

export interface ProviderMaintenanceGroup {
  readonly id: string;
}

export interface ProviderMaintenanceWorkSource<Bot extends ProviderMaintenanceBot> {
  readonly bots: readonly Bot[];
  readonly tasks: (botId: string) => readonly ProviderMaintenanceTask[];
  readonly isBusy: (botId: string, threadId: string) => boolean;
  readonly ownerForThread: (botId: string, threadId: string) => Bot | null | undefined;
  readonly directGeneration: (threadId: string) => string | undefined;
  readonly groupOperations: ReadonlyMap<string, Iterable<ProviderMaintenanceGroupOperation>>;
  readonly groupSpeakers: ReadonlyMap<string, ProviderMaintenanceSpeaker>;
  readonly groupForThread: (threadId: string) => ProviderMaintenanceGroup | null | undefined;
  readonly botById: (botId: string) => Bot | null | undefined;
  readonly turnResourceOwners: ReadonlyMap<string, ProviderMaintenanceTurnOwner>;
  readonly randomGeneration: () => string;
}

export interface CapturedProviderMaintenanceWork<Bot extends ProviderMaintenanceBot = ProviderMaintenanceBot> {
  readonly threadId: string;
  readonly bot: Bot;
  readonly owner: ProviderMaintenanceTurnOwner;
  readonly group?: {
    readonly id: string;
    readonly speaker: ProviderMaintenanceSpeaker;
  };
}

/** Capture only live direct and room turns owned by one exact provider instance. */
export function captureProviderMaintenanceWork<Bot extends ProviderMaintenanceBot>(
  instanceId: InstanceId,
  source: ProviderMaintenanceWorkSource<Bot>,
): CapturedProviderMaintenanceWork<Bot>[] {
  const captured = new Map<string, CapturedProviderMaintenanceWork<Bot>>();

  for (const bot of source.bots) {
    for (const task of source.tasks(bot.id)) {
      if (!source.isBusy(bot.id, task.threadId)) continue;
      const owner = source.ownerForThread(bot.id, task.threadId);
      if (owner?.modelSelection.instanceId !== instanceId) continue;
      const generation = source.directGeneration(task.threadId) ?? source.randomGeneration();
      captured.set(task.threadId, {
        threadId: task.threadId,
        bot: owner,
        owner: { threadId: task.threadId, generation },
      });
    }
  }

  for (const operations of source.groupOperations.values()) {
    for (const operation of operations) {
      if (operation.cancelled) continue;
      const speaker = source.groupSpeakers.get(operation.threadId);
      const group = speaker ? source.groupForThread(operation.threadId) : undefined;
      const bot = speaker ? source.botById(speaker.botId) : undefined;
      if (!speaker || !group || !bot || bot.modelSelection.instanceId !== instanceId) continue;
      captured.set(operation.threadId, {
        threadId: operation.threadId,
        bot,
        owner: source.turnResourceOwners.get(operation.threadId) ?? {
          threadId: operation.threadId,
          generation: operation.id,
        },
        group: { id: group.id, speaker },
      });
    }
  }

  return [...captured.values()];
}
