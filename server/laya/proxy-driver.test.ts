import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BoxProxyCuaDriver, CuaLeaseRefused } from "./proxy-driver.ts";

/**
 * Drives the REAL computer proxy process against a stub box API + control
 * endpoint. Nothing about the proxy or the lease is mocked; only the
 * network edge (ascii.dev box REST + the harness control loopback) is
 * stubbed locally. No real box is driven.
 */

let servers: Server[] = [];
let drivers: BoxProxyCuaDriver[] = [];
afterEach(async () => {
  for (const d of drivers.splice(0)) await d.close();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  delete process.env.DANI_BOX_API;
});

async function stub(handler: (_body: string, url: string) => { status: number; body: unknown }): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(body, req.url ?? "");
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const SNAPSHOT = JSON.stringify({
  url: "https://example.com/form",
  title: "Form",
  elements: [
    { ref: "e1", role: "button", name: "Submit" },
    { ref: "e2", role: "link", name: "Help center" },
    { ref: "e3", role: "button", name: "Delete everything", disabled: true },
  ],
});

const computer = (controlUrl: string) => ({
  kind: "box" as const,
  boxId: "box-1",
  token: "tok",
  control: { url: controlUrl, token: "ctok" },
});

describe("BoxProxyCuaDriver against the real computer proxy", () => {
  it("parses candidate actions from a real semantic snapshot round trip", async () => {
    process.env.DANI_BOX_API = await stub((_body, url) => {
      if (url.endsWith("/commands")) return { status: 200, body: { exitCode: 0, stdout: SNAPSHOT, stderr: "" } };
      return { status: 404, body: {} };
    });
    const control = await stub(() => ({ status: 200, body: { held: false, helpOpen: false } }));
    const driver = new BoxProxyCuaDriver(computer(control));
    drivers.push(driver);
    const snap = await driver.observe("bot-1");
    expect(snap.candidates.map((c) => c.id)).toEqual(["e1", "e2"]);
    expect(snap.candidates[0].tool).toEqual({ name: "browser_click", args: { ref: "e1" } });
    expect(snap.summary).toContain("https://example.com/form");
    // disabled elements are not actionable
    expect(snap.candidates.map((c) => c.label).join()).not.toContain("Delete everything");
    // identical state -> identical version
    const again = await driver.observe("bot-1");
    expect(again.stateVersion).toBe(snap.stateVersion);
  });

  it("refuses every action while the person is driving (real lease path)", async () => {
    process.env.DANI_BOX_API = await stub(() => ({ status: 200, body: { exitCode: 0, stdout: SNAPSHOT, stderr: "" } }));
    const control = await stub(() => ({ status: 200, body: { held: true, helpOpen: false } }));
    const driver = new BoxProxyCuaDriver(computer(control));
    drivers.push(driver);
    await expect(driver.observe("bot-1")).rejects.toBeInstanceOf(CuaLeaseRefused);
    await expect(driver.act("bot-1", { name: "browser_click", args: { ref: "e1" } })).rejects.toBeInstanceOf(
      CuaLeaseRefused,
    );
  });

  it("surfaces a tool failure as an honest error, not a fake success", async () => {
    process.env.DANI_BOX_API = await stub(() => ({
      status: 200,
      body: { exitCode: 1, stdout: "", stderr: "xdotool blew up" },
    }));
    const control = await stub(() => ({ status: 200, body: { held: false, helpOpen: false } }));
    const driver = new BoxProxyCuaDriver(computer(control));
    drivers.push(driver);
    await expect(driver.act("bot-1", { name: "browser_click", args: { ref: "e9" } })).rejects.toThrow();
  });
});
