import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderInstance } from "./contracts.ts";
import { recordEvents } from "./testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./drivers/acp/core.ts";

const fakeCli = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const support: AcpSupport = {
  driverKind: "hermesAgent",
  displayName: "Hermes",
  models: { default: "test", options: [{ id: "test", label: "Test" }] },
  defaultCli: fakeCli,
  nativeSource: "hermes.test",
  loginNote: "not installed",
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  allowUnbrokeredUnattendedTool: () => false,
};
const Driver = createAcpDriver(support);
let instance: ProviderInstance | null = null;
afterEach(async () => { delete process.env.FAKE_ACP_MODE; await instance?.dispose(); instance = null; });

describe("Hermes native-tool bypass enforcement", () => {
  it("denies a native tool permission request in legacy unattended mode", async () => {
    process.env.FAKE_ACP_MODE = "permission";
    instance = await Driver.create({ instanceId: "hermes-test", displayName: "Hermes", environment: {}, enabled: true, config: { cli: fakeCli, fullAuto: true } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "native-bypass", text: "run" });
    const done = await events.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(events.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("native tool bypass blocked") }));
    expect(events.events.some((event) => event.type === "request.opened")).toBe(false);
  });
});
