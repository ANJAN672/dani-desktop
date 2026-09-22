#!/usr/bin/env node
// Stage the bundled Hermes runtime payload for packaging (issue #18
// acceptance criteria 1 and 3).
//
// The payload archives are build outputs, not repository content: they are
// produced by scripts/build-hermes-payload.sh per target and staged here by
// the release process. This script only guarantees the staging directory
// exists and reports, truthfully, what is in it.
//
// An empty staging directory is a supported outcome, not a failure. The app
// then reports at runtime that this installation carries no runtime for this
// system, which is the honest state. Packaging must not pretend otherwise by
// failing here, and must not silently succeed while claiming the runtime ships.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TARGETS = ["linux-x64", "mac-arm64", "mac-x64", "win-x64"];
export const STAGING_DIR = join("dist-native", "hermes");

/**
 * Check one staged target.
 *
 * Verifies the archive against its own manifest, because a payload that is
 * already wrong on the build machine must never reach an installer: the app
 * would reject it at first run, on a user's computer, for no reason.
 */
export function inspectTarget(dir, target) {
  const manifestPath = join(dir, `${target}.manifest.json`);
  const archivePath = join(dir, `${target}.tar.gz`);
  if (!existsSync(manifestPath) && !existsSync(archivePath)) return { target, state: "absent" };
  if (!existsSync(manifestPath)) return { target, state: "invalid", reason: "archive without a manifest" };
  if (!existsSync(archivePath)) return { target, state: "invalid", reason: "manifest without an archive" };

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { target, state: "invalid", reason: "manifest is not valid JSON" };
  }
  if (manifest.manifestVersion !== 1) return { target, state: "invalid", reason: "unsupported manifest version" };
  if (manifest.target !== target) return { target, state: "invalid", reason: "manifest names a different target" };

  const size = statSync(archivePath).size;
  if (size !== manifest.archiveSize) return { target, state: "invalid", reason: "archive size does not match the manifest" };
  const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (digest !== manifest.archiveSha256) return { target, state: "invalid", reason: "archive digest does not match the manifest" };

  return { target, state: "staged", version: manifest.version, bytes: size };
}

export function inspectStaging(dir) {
  return TARGETS.map((target) => inspectTarget(dir, target));
}

function main() {
  const dir = join(process.cwd(), STAGING_DIR);
  mkdirSync(dir, { recursive: true });
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        "# Bundled Hermes runtime payloads",
        "",
        "Staging directory for per-target runtime payloads, copied into a packaged",
        "app at `resources/runtimes/hermes`. Each target contributes two files:",
        "",
        "    <target>.tar.gz",
        "    <target>.manifest.json",
        "",
        `Targets: ${TARGETS.join(", ")}.`,
        "",
        "Build them with `scripts/build-hermes-payload.sh` and verify with",
        "`node scripts/prepare-hermes-payload.mjs`. An empty directory is valid:",
        "the app then reports that this installation carries no runtime for the",
        "system it is running on, rather than claiming a runtime it does not have.",
        "",
      ].join("\n"),
    );
  }

  const report = inspectStaging(dir);
  const invalid = report.filter((entry) => entry.state === "invalid");
  for (const entry of report) {
    if (entry.state === "staged") console.log(`hermes payload ${entry.target}: staged ${entry.version} (${entry.bytes} bytes, digest verified)`);
    else if (entry.state === "invalid") console.error(`hermes payload ${entry.target}: INVALID - ${entry.reason}`);
    else console.log(`hermes payload ${entry.target}: not staged`);
  }
  if (invalid.length > 0) {
    console.error("A staged payload does not match its manifest. Refusing to package bytes the app would reject at first run.");
    process.exit(1);
  }
  const staged = report.filter((entry) => entry.state === "staged").length;
  if (staged === 0) {
    console.log(`No runtime payload staged in ${STAGING_DIR}. The packaged app will report that it carries no runtime for this system.`);
  }
  // Nothing else is read from this directory, so an unexpected file is worth
  // naming rather than shipping unnoticed.
  const expected = new Set(["README.md", ...TARGETS.flatMap((t) => [`${t}.tar.gz`, `${t}.manifest.json`])]);
  for (const name of readdirSync(dir)) {
    if (!expected.has(name)) console.warn(`hermes payload staging: unexpected file ${name} will be packaged as-is`);
  }
}

// Run only when invoked directly; the test imports the inspection helpers.
const invoked = process.argv[1]?.replaceAll("\\", "/");
if (invoked && import.meta.url.endsWith(invoked.split("/").pop())) main();
