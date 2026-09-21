// Unit tests for electron/ipc-guard.cjs: the schema DSL, the channel policy
// table, and the guard()/guardSync() wrappers. No Electron needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const lo = require("./local-origin.cjs");
const ipcGuard = require("./ipc-guard.cjs");
const here = dirname(fileURLToPath(import.meta.url));

const localEvent = () => ({ senderFrame: { url: "http://127.0.0.1:8799/" } });
const remoteEvent = () => ({ senderFrame: { url: "https://mini.example/" } });

test("schema DSL accepts good values and rejects bad ones", () => {
  const { string, number, boolean, enumeration, optional, nullable, arrayOf, object, any, validateValue } = ipcGuard;
  validateValue("ok", string({ min: 1, max: 8 }));
  assert.throws(() => validateValue("", string({ min: 1 })), /outside/);
  assert.throws(() => validateValue("toolong", string({ max: 3 })), /outside/);
  assert.throws(() => validateValue(42, string()), /expected string/);
  assert.throws(() => validateValue("no!", string({ pattern: /^[a-z]+$/ })), /does not match/);
  validateValue(3, number({ integer: true, min: 1, max: 5 }));
  assert.throws(() => validateValue(3.5, number({ integer: true })), /expected integer/);
  assert.throws(() => validateValue(Number.NaN, number()), /finite/);
  validateValue(true, boolean());
  assert.throws(() => validateValue(1, boolean()), /expected boolean/);
  validateValue("a", enumeration("a", "b"));
  assert.throws(() => validateValue("c", enumeration("a", "b")), /one of/);
  validateValue(undefined, optional(string()));
  assert.throws(() => validateValue(null, optional(string())), /expected string/);
  validateValue(null, nullable(string()));
  validateValue(["x"], arrayOf(string(), { max: 2 }));
  assert.throws(() => validateValue(["x", "y", "z"], arrayOf(string(), { max: 2 })), /array length/);
  assert.throws(() => validateValue("x", arrayOf(string())), /expected array/);
  validateValue({ a: "1" }, object({ a: string() }));
  assert.throws(() => validateValue({ a: "1", b: "2" }, object({ a: string() })), /unexpected key/);
  validateValue({ a: "1", b: "2" }, object({ a: string() }, { allowUnknown: true }));
  assert.throws(() => validateValue(null, object({})), /expected object/);
  validateValue(Symbol("anything"), any());
});

test("every bridge channel has a policy with capability, origin and args", () => {
  const { CHANNEL_POLICY } = ipcGuard;
  const channels = Object.keys(CHANNEL_POLICY);
  assert.ok(channels.length >= 70, `expected a full channel table, got ${channels.length}`);
  for (const channel of channels) {
    const policy = CHANNEL_POLICY[channel];
    assert.ok(typeof policy.capability === "string" && policy.capability.length > 0, `${channel}: capability`);
    assert.ok(policy.origin === "local-only" || policy.origin === "public", `${channel}: origin`);
    assert.ok(Array.isArray(policy.args), `${channel}: args`);
    assert.ok(policy.window === null || policy.window === "main", `${channel}: window`);
  }
});

test("policy covers every channel the preload bridge can invoke", () => {
  // The bridge only invokes renderer->main channels with literal strings;
  // collect them straight from the preload source so a new bridge method
  // without a policy entry fails this test. Main->renderer push channels
  // (ipcRenderer.on) need no policy: the renderer cannot invoke through them.
  const preload = readFileSync(join(here, "preload.cjs"), "utf8");
  const channels = new Set();
  for (const match of preload.matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\("([^"]+)"/g)) {
    channels.add(match[1]);
  }
  assert.ok(channels.size > 40, `expected many bridge channels, got ${channels.size}`);
  const missing = [...channels].filter((channel) => !ipcGuard.CHANNEL_POLICY[channel]);
  assert.deepEqual(missing, [], `bridge channels without a policy: ${missing.join(", ")}`);
});

test("guard validates args before the handler runs", () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  let ran = 0;
  const handler = ipcGuard.guard("desktop:open-external", async () => { ran += 1; return true; });
  assert.throws(() => handler(localEvent(), 42), /"desktop:open-external" arg 1: expected string/);
  assert.equal(ran, 0);
  assert.throws(() => handler(localEvent(), "x".repeat(9000)), /outside/);
  assert.equal(ran, 0);
});

test("guard enforces local-only origin and leaves public channels open", async () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  const local = ipcGuard.guard("screen:frame", async () => "frame");
  assert.equal(await local(localEvent()), "frame");
  assert.throws(() => local(remoteEvent()), /screen:frame is only available while using the local server/);
  const open = ipcGuard.guard("desktop:open-external", async (_event, rawUrl) => new URL(rawUrl).protocol);
  assert.equal(await open(remoteEvent(), "https://example.com/"), "https:");
});

test("guard fails closed at registration for unknown channels", () => {
  assert.throws(() => ipcGuard.guard("definitely:not-a-channel", () => {}), /no policy registered/);
  assert.throws(() => ipcGuard.guardSync("definitely:not-a-channel", () => {}), /no policy registered/);
});

test("guardSync enforces origin for sendSync handlers", () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  const handler = ipcGuard.guardSync("screen:preview-intent", (event) => { event.returnValue = "begun"; });
  const event = localEvent();
  handler(event);
  assert.equal(event.returnValue, "begun");
  const denied = remoteEvent();
  handler(denied);
  assert.equal(denied.returnValue, false);
});

test("guard rejects surplus arguments", () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  const handler = ipcGuard.guard("screen:frame", async () => "frame");
  assert.throws(() => handler(localEvent(), "extra"), /at most 0 argument/);
});

test("main.mjs registers every policy channel it handles", () => {
  // Cross-check: each ipcMain.handle/on channel in main.mjs must resolve to a
  // policy, so a handler can never be added without classification. The
  // desktop:unread-count fire-and-forget listener is intentionally unwrapped
  // (it coerces inline and checks main-window ownership itself) but still
  // classified in the table.
  const main = readFileSync(join(here, "main.mjs"), "utf8");
  const handled = new Set([...main.matchAll(/ipcMain\.(?:handle|on)\("([^"]+)"/g)].map((m) => m[1]));
  const missing = [...handled].filter((channel) => !ipcGuard.CHANNEL_POLICY[channel]);
  assert.deepEqual(missing, [], `handled channels without a policy: ${missing.join(", ")}`);
  const unguarded = [...main.matchAll(/ipcMain\.handle\("([^"]+)", (?!guard\()/g)].map((m) => m[1]);
  assert.deepEqual(
    unguarded.filter((channel) => channel !== "screen:preview-intent"),
    [],
    `ipcMain.handle registrations bypassing guard(): ${unguarded.join(", ")}`,
  );
});

test("every app webPreferences block declares the secure triad", () => {
  // Static regression guard: sandbox:true + contextIsolation:true +
  // nodeIntegration:false on every app window/view prefs block (main window,
  // desktop viewer, embedded browser views, Local VM views).
  const extractBlocks = (source) => {
    const blocks = [];
    for (const match of source.matchAll(/webPreferences:\s*\{/g)) {
      let depth = 0;
      let index = match.index + match[0].length - 1;
      for (; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      blocks.push(source.slice(match.index, index + 1));
    }
    return blocks;
  };
  for (const file of ["main.mjs", "browser-surface.cjs", "desktop-workspace.cjs"]) {
    const source = readFileSync(join(here, file), "utf8");
    const blocks = extractBlocks(source);
    assert.ok(blocks.length > 0, `${file}: no webPreferences blocks found`);
    for (const prefs of blocks) {
      for (const required of ["sandbox: true", "contextIsolation: true", "nodeIntegration: false"]) {
        assert.ok(prefs.includes(required), `${file}: webPreferences block missing "${required}"`);
      }
    }
  }
});
