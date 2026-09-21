import { describe, expect, it } from "vitest";
import {
  captureProviderMaintenanceWork,
  type ProviderMaintenanceBot,
  type ProviderMaintenanceGroupOperation,
  type ProviderMaintenanceSpeaker,
  type ProviderMaintenanceTask,
} from "./provider-maintenance-work.ts";

interface Bot extends ProviderMaintenanceBot {
  readonly modelSelection: { readonly instanceId: string };
}

const bot = (id: string, instanceId: string): Bot => ({
  id,
  modelSelection: { instanceId },
});

const task = (threadId: string): ProviderMaintenanceTask => ({ threadId });

const operation = (id: string, threadId: string, cancelled = false): ProviderMaintenanceGroupOperation => ({
  id,
  threadId,
  cancelled,
});

const speaker = (botId: string): ProviderMaintenanceSpeaker => ({
  botId,
  name: botId,
  color: "blue",
});

describe("captureProviderMaintenanceWork", () => {
  it("captures only active direct and room work owned by the triggering instance", () => {
    const target = bot("target-bot", "target");
    const sibling = bot("sibling-bot", "sibling");
    const busy = new Set([
      "target-bot:direct-target",
      "sibling-bot:direct-sibling",
    ]);
    const source = {
      bots: [target, sibling],
      tasks: (botId: string) => ({
        "target-bot": [task("direct-target"), task("idle-target")],
        "sibling-bot": [task("direct-sibling")],
      })[botId] ?? [],
      isBusy: (botId: string, threadId: string) => busy.has(`${botId}:${threadId}`),
      ownerForThread: (botId: string) => botId === target.id ? target : sibling,
      directGeneration: (threadId: string) => threadId === "direct-target" ? "direct-generation" : undefined,
      groupOperations: new Map<string, ProviderMaintenanceGroupOperation[]>([
        ["room", [operation("room-target", "room-target"), operation("room-cancelled", "room-cancelled", true)]],
        ["sibling-room", [operation("room-sibling", "room-sibling")]],
      ]),
      groupSpeakers: new Map([
        ["room-target", speaker(target.id)],
        ["room-cancelled", speaker(target.id)],
        ["room-sibling", speaker(sibling.id)],
      ]),
      groupForThread: (threadId: string) => threadId.startsWith("room") ? { id: "group" } : undefined,
      botById: (botId: string) => botId === target.id ? target : sibling,
      turnResourceOwners: new Map([
        ["room-target", { threadId: "room-target", generation: "room-generation" }],
      ]),
      randomGeneration: () => "random-generation",
    };

    const work = captureProviderMaintenanceWork("target", source);

    expect(work.map(({ threadId }) => threadId).sort()).toEqual(["direct-target", "room-target"]);
    expect(work.find(({ threadId }) => threadId === "direct-target")?.owner).toEqual({
      threadId: "direct-target",
      generation: "direct-generation",
    });
    expect(work.find(({ threadId }) => threadId === "room-target")?.group).toEqual({
      id: "group",
      speaker: speaker(target.id),
    });
    expect(work.find(({ threadId }) => threadId === "room-target")?.owner).toEqual({
      threadId: "room-target",
      generation: "room-generation",
    });
  });

  it("deduplicates a thread when direct and room state overlap", () => {
    const target = bot("target-bot", "target");
    const source = {
      bots: [target],
      tasks: () => [task("shared-thread")],
      isBusy: () => true,
      ownerForThread: () => target,
      directGeneration: () => "direct-generation",
      groupOperations: new Map([["group", [operation("room-operation", "shared-thread")]]]),
      groupSpeakers: new Map([["shared-thread", speaker(target.id)]]),
      groupForThread: () => ({ id: "group" }),
      botById: () => target,
      turnResourceOwners: new Map([
        ["shared-thread", { threadId: "shared-thread", generation: "room-generation" }],
      ]),
      randomGeneration: () => "random-generation",
    };

    const work = captureProviderMaintenanceWork("target", source);

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      threadId: "shared-thread",
      group: { id: "group" },
      owner: { generation: "room-generation" },
    });
  });
});
