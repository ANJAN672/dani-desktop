// The IPC gate (guard/guardSync from electron/ipc-guard.cjs) is bound with a
// `const` while ipcMain handlers are registered at module top level. If that
// binding ever sits below the first `guard(...)` again (the localOnly version
// did once, #802), the packaged app dies at boot with "Cannot access 'guard'
// before initialization" — which only the Linux package smoke sees, long
// after the unit legs are green. This pins the order statically so the
// failure is a red test, not a red release.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8").split("\n");
const code = (line) => !/^\s*(?:\/\/|\/?\*)/.test(line);
const declaration = main.findIndex((line) => /^const \{[^}]*\bguard\b[^}]*\} = require\("\.\/ipc-guard\.cjs"\);/.test(line));
const firstUse = main.findIndex((line) => code(line) && /\bguardSync?\("/.test(line) && !line.startsWith("const {"));

test("guard is bound before the first top-level handler that calls it", () => {
  assert.ok(declaration >= 0, "the ipc-guard require is missing from main.mjs");
  assert.ok(firstUse >= 0, "no top-level guard(...) use found");
  assert.ok(
    declaration < firstUse,
    `guard is bound on line ${declaration + 1} but first called on line ${firstUse + 1}: the packaged app will crash at boot`,
  );
});
