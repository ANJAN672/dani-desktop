#!/usr/bin/env node
// Spec 110 acceptance criterion 2, enforced against the built bundle.
//
// A release build must contain no harness chooser, no raw install command, no
// Terminal action and no setup-guide link. Reviewing the source cannot prove
// that: the guards are build-time, so the only honest evidence is the shipped
// bytes. This reads dist/ after `pnpm build` and fails on any survivor.
//
// This is a bundle check. It does not replace the packaged installer and
// clean-machine evidence AC-UI-001 still requires.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Copy that may never reach a release renderer bundle. */
export const FORBIDDEN = [
  "Open install in Terminal",
  "Open sign-in in Terminal",
  "Open update in Terminal",
  "View setup guide",
  "Install Hermes",
  "Not installed",
  "Choose model",
  "Your engines",
  "No engine is ready yet",
  "Local models will appear as soon as the agent is installed",
  "hermes-agent.nousresearch.com",
  "curl -fsSL",
  "iex (irm",
];

/** Every forbidden phrase present in `text`. Exported for its own test. */
export function forbiddenIn(text) {
  return FORBIDDEN.filter((phrase) => text.includes(phrase));
}

function main() {
  const assets = join(process.cwd(), "dist", "assets");
  let files;
  try {
    files = readdirSync(assets).filter((name) => name.endsWith(".js"));
  } catch {
    console.error("check:release-ui — no dist/assets; run `pnpm build` first.");
    process.exit(2);
  }
  if (files.length === 0) {
    console.error("check:release-ui — dist/assets has no JavaScript; the build did not produce a bundle.");
    process.exit(2);
  }

  const hits = [];
  for (const name of files) {
    for (const phrase of forbiddenIn(readFileSync(join(assets, name), "utf8"))) {
      hits.push(`${name}: ${phrase}`);
    }
  }
  if (hits.length > 0) {
    console.error("check:release-ui — harness UI reached the release bundle (spec 110 R-UI-001):");
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
  }
  console.log(`check:release-ui — ${files.length} bundle file(s) clean of harness UI.`);
}

// Only run when invoked directly; the test imports the matcher.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) main();
