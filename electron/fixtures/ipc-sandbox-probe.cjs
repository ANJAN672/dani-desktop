"use strict";

// Malicious-renderer probe for Security Epic #9 (workstream A).
//
// Spins up a window with the production main window's exact sandbox policy
// (sandbox:true, contextIsolation:true, nodeIntegration:false) loading the
// real preload bridge, then runs a hostile page against it. The page must
// NOT reach raw Electron/Node APIs or any IPC channel the bridge does not
// expose, while the legitimate bridge surface must keep working
// (invoke round-trips through the sandboxed preload).
//
// Markers on stdout are asserted by electron/ipc-sandbox.electron.test.mjs.
process.stdout.write("fixture-entered\n");
const { strict: assert } = require("node:assert");
const { once } = require("node:events");
const { join } = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
process.stdout.write("fixture-modules-loaded\n");

// Linux CI runs under Xvfb as root; same approach as the other Electron
// fixtures. The window below still gets sandbox:true, so the renderer stays
// cut off from Node/Electron — only the OS-level sandbox is relaxed.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox");
}

let canaryHit = false;

async function run() {
  // Canary: a real handler the bridge never exposes. If any renderer trick
  // finds an invoke path, this flips and the fixture fails.
  ipcMain.handle("security-probe:canary", () => {
    canaryHit = true;
    return "canary";
  });
  // Handlers the bridge DOES expose, so the smoke test can prove the invoke
  // path still works through the sandboxed preload.
  ipcMain.handle("desktop:capabilities", async () => ({ probe: "capabilities-ok" }));
  ipcMain.handle("desktop:skin", async () => "skin-ok");

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      // Mirrors createWindow() in electron/main.mjs exactly.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "..", "preload.cjs"),
    },
  });
  try {
    await win.loadURL("data:text/html,<title>malicious renderer</title><h1>probe</h1>");

    // Every hostile attempt runs in the page's own world — the attacker's view.
    const results = await win.webContents.executeJavaScript(`(() => {
      const out = {};
      out.requireType = typeof require;
      out.processType = typeof process;
      out.moduleType = typeof module;
      out.globalRequire = typeof globalThis.require;
      out.windowRequire = typeof window.require;
      out.ipcRendererGlobal = typeof window.ipcRenderer;
      out.electronGlobal = typeof window.electron;
      try {
        out.functionConstructor = new Function("return typeof process")();
      } catch (error) {
        out.functionConstructor = "threw:" + error.name;
      }
      try {
        out.evalResult = eval("typeof require");
      } catch (error) {
        out.evalResult = "threw:" + error.name;
      }
      out.ogbType = typeof window.ogb;
      out.ogbPlatform = window.ogb && window.ogb.platform;
      out.ogbKeys = window.ogb ? Object.getOwnPropertyNames(window.ogb).sort() : [];
      out.genericInvoke = window.ogb ? typeof window.ogb.invoke : "n/a";
      out.exposedIpcRenderer = window.ogb ? typeof window.ogb.ipcRenderer : "n/a";
      out.exposedSendSync = window.ogb ? typeof window.ogb.sendSync : "n/a";
      // Hunt for ANY property path on the bridge that reaches an invoke-like
      // capability (two levels deep, through functions and objects).
      out.invokePathFound = (() => {
        const seen = new Set();
        const hunt = (value, depth) => {
          if (value === null || value === undefined || depth > 2 || seen.has(value)) return false;
          if (typeof value !== "object" && typeof value !== "function") return false;
          seen.add(value);
          try {
            if (typeof value.invoke === "function") return true;
            if (typeof value.ipcRenderer !== "undefined") return true;
          } catch { return false; }
          let names = [];
          try { names = Object.getOwnPropertyNames(value); } catch { return false; }
          for (const name of names) {
            if (name === "ogb") continue;
            let child;
            try { child = value[name]; } catch { continue; }
            if (hunt(child, depth + 1)) return true;
          }
          return false;
        };
        try { return hunt(window.ogb, 0); } catch { return "hunt-threw"; }
      })();
      // Representative legitimate surface the app actually calls.
      const expectFn = (path) => {
        const parts = path.split(".");
        let node = window.ogb;
        for (const part of parts) node = node ? node[part] : undefined;
        return typeof node === "function";
      };
      out.bridgeMethods = {
        "getCapabilities": expectFn("getCapabilities"),
        "applySkin": expectFn("applySkin"),
        "setUnreadCount": expectFn("setUnreadCount"),
        "permStatus": expectFn("permStatus"),
        "openExternal": expectFn("openExternal"),
        "pickFolder": expectFn("pickFolder"),
        "remoteClient.state": expectFn("remoteClient.state"),
        "companion.start": expectFn("companion.start"),
        "desktopViewer.open": expectFn("desktopViewer.open"),
        "desktopWorkspace.open": expectFn("desktopWorkspace.open"),
        "updater.check": expectFn("updater.check"),
        "environments.state": expectFn("environments.state"),
      };
      out.browserPresent = typeof (window.ogb && window.ogb.browser);
      return out;
    })()`);

    // 1. Raw Electron/Node APIs are unreachable from the hostile page.
    for (const key of ["requireType", "processType", "moduleType", "globalRequire", "windowRequire", "ipcRendererGlobal", "electronGlobal"]) {
      assert.equal(results[key], "undefined", `hostile page saw ${key} = ${results[key]}`);
    }
    assert.ok(
      results.functionConstructor === "undefined" || String(results.functionConstructor).startsWith("threw:"),
      `Function constructor escape: ${results.functionConstructor}`,
    );
    assert.ok(
      results.evalResult === "undefined" || String(results.evalResult).startsWith("threw:"),
      `eval escape: ${results.evalResult}`,
    );
    process.stdout.write("malicious-raw-apis-unreachable\n");

    // 2. No generic invoke path exists on the bridge; unexposed channels
    // cannot be reached even by hunting the exposed object graph.
    assert.equal(results.genericInvoke, "undefined");
    assert.equal(results.exposedIpcRenderer, "undefined");
    assert.equal(results.exposedSendSync, "undefined");
    assert.equal(results.invokePathFound, false, "found an invoke path on window.ogb");
    process.stdout.write("malicious-no-invoke-path\n");

    // 3. The legitimate bridge surface is intact (smoke test).
    assert.equal(results.ogbType, "object");
    assert.equal(results.ogbPlatform, process.platform);
    for (const [path, present] of Object.entries(results.bridgeMethods)) {
      assert.equal(present, true, `bridge method missing: window.ogb.${path}`);
    }
    if (process.platform !== "win32") {
      assert.equal(results.browserPresent, "object", "window.ogb.browser missing on darwin/linux");
    }
    assert.ok(!results.ogbKeys.includes("invoke"), "bridge exposes a generic invoke");
    process.stdout.write("bridge-surface-intact\n");

    // 4. Invoke round-trips still work through the sandboxed preload.
    const capabilities = await win.webContents.executeJavaScript(`window.ogb.getCapabilities()`);
    assert.deepEqual(capabilities, { probe: "capabilities-ok" });
    const skin = await win.webContents.executeJavaScript(`window.ogb.applySkin("midnight")`);
    assert.equal(skin, "skin-ok");
    process.stdout.write("bridge-invoke-roundtrip-ok\n");

    // 5. The canary channel was never invoked from the renderer.
    assert.equal(canaryHit, false, "unexposed IPC channel was reached from the renderer");
    process.stdout.write("malicious-canary-unreached\n");
  } finally {
    if (!win.isDestroyed()) {
      const closed = once(win, "closed");
      win.destroy();
      await closed;
    }
  }
}

app.whenReady()
  .then(() => {
    process.stdout.write("fixture-ready\n");
    return run();
  })
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    app.exit(1);
  });
