import { describe, expect, it } from "vitest";
import { migrateSelection, migrateSelections, type MigrationFleet } from "./harness-migration.ts";

const hermesReady: MigrationFleet = {
  instanceId: "hermes",
  driverKind: "hermesAgent",
  snapshot: { state: "available" },
  models: { default: "hermes-default", options: [{ id: "hermes-default" }, { id: "openrouter:qwen" }] },
};
const otherHarness: MigrationFleet = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  snapshot: { state: "available" },
  models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5" }] },
};

describe("stale harness selection migration", () => {
  it("moves a bot off another harness onto the ready runtime", () => {
    const outcome = migrateSelection({ instanceId: "claude", model: "claude-sonnet-5" }, [hermesReady, otherHarness], true);
    expect(outcome).toMatchObject({ action: "migrate", keptModel: false });
    expect(outcome).toMatchObject({ selection: { instanceId: "hermes", model: "hermes-default" } });
  });

  it("preserves a user-chosen model the ready runtime still offers", () => {
    const outcome = migrateSelection({ instanceId: "claude", model: "openrouter:qwen" }, [hermesReady, otherHarness], true);
    expect(outcome).toMatchObject({ action: "migrate", keptModel: true });
    expect(outcome).toMatchObject({ selection: { instanceId: "hermes", model: "openrouter:qwen" } });
  });

  it("carries the configured effort across the move", () => {
    const outcome = migrateSelection({ instanceId: "claude", model: "x", effort: "high" }, [hermesReady, otherHarness], true);
    expect(outcome).toMatchObject({ selection: { effort: "high" } });
  });

  it("leaves a bot already on the runtime alone", () => {
    expect(migrateSelection({ instanceId: "hermes", model: "anything" }, [hermesReady], true)).toEqual({ action: "keep" });
  });

  it("blocks instead of repointing when the runtime is not ready", () => {
    const unavailable = { ...hermesReady, snapshot: { state: "unavailable" as const }, models: { default: "", options: [] } };
    expect(migrateSelection({ instanceId: "claude", model: "m" }, [unavailable, otherHarness], true))
      .toEqual({ action: "blocked", code: "runtime.absent" });
  });

  it("blocks when the runtime is up but has no model to offer", () => {
    const noModel = { ...hermesReady, models: { default: "", options: [] } };
    expect(migrateSelection({ instanceId: "claude", model: "m" }, [noModel], true))
      .toEqual({ action: "blocked", code: "runtime.no-model" });
  });

  it("blocks when the runtime is not registered at all", () => {
    expect(migrateSelection({ instanceId: "claude", model: "m" }, [otherHarness], true))
      .toEqual({ action: "blocked", code: "runtime.not-configured" });
  });

  it("changes nothing outside a product build", () => {
    expect(migrateSelection({ instanceId: "claude", model: "m" }, [hermesReady, otherHarness], false))
      .toEqual({ action: "keep" });
  });

  it("is deterministic: the same fleet always yields the same selection", () => {
    const run = () => migrateSelection({ instanceId: "claude", model: "m" }, [hermesReady, otherHarness], true);
    expect(run()).toEqual(run());
  });

  it("treats an unknown saved instance as stale rather than crashing", () => {
    expect(migrateSelection({ instanceId: "deleted-long-ago", model: "m" }, [hermesReady], true))
      .toMatchObject({ action: "migrate" });
  });

  it("reports migrated and blocked bots separately across a fleet", () => {
    const bots = [
      { id: "a", modelSelection: { instanceId: "claude", model: "openrouter:qwen" } },
      { id: "b", modelSelection: { instanceId: "hermes", model: "hermes-default" } },
    ];
    const result = migrateSelections(bots, [hermesReady, otherHarness], true);
    expect(result.migrated.map((entry) => entry.id)).toEqual(["a"]);
    expect(result.blocked).toEqual([]);

    const stuck = migrateSelections(bots, [otherHarness], true);
    expect(stuck.migrated).toEqual([]);
    expect(stuck.blocked).toEqual([{ id: "a", code: "runtime.not-configured" }, { id: "b", code: "runtime.not-configured" }]);
  });
});
