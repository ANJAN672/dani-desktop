// Guard for POST /api/cli-test: constrain request-supplied executable probing.
//
// Threat: loopback + a JSON content type are not authentication against
// another local process, so any local caller could previously ask the
// server to spawn an arbitrary executable (`<cli> --version`) as a
// detection/execution oracle. The owner-token requirement for mutations
// comes from the request-auth guard (server/request-auth.ts); this module
// adds the executable-side constraints:
//
//   1. A FIXED ALLOWLIST of discovered adapters: every built-in driver's
//      default CLI name, plus the canonical path of every copy found on the
//      augmented PATH (the same enumeration the Engines "detected" dropdown
//      uses via findCliCandidates). Probing one of those needs no extra
//      ceremony.
//   2. Anything else is a CUSTOM path and additionally requires:
//        - explicitCustomPath === true — the client asserts the user typed
//          or pasted the path themselves (the Engines panel only sets it
//          for its manual-path field), and
//        - canonicalization of the executable: bare names are resolved
//          through PATH, symlinks are resolved with realpath, and a literal
//          `..` segment in the executable is rejected outright so a
//          traversal string can never confuse the allowlist comparison.
//   3. Execution itself stays no-shell fixed-argv: the probe goes through
//      execCli → execFile with ["--version"] (server/procs.ts), never
//      shell:true, and with a credential-redacted environment.
import { realpathSync } from "node:fs";

import type { AnyProviderDriver } from "./contracts.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { findCliCandidates, splitCliString } from "./env-path.ts";

/** The `cli` field off a driver's default config, when it has one — the
 * bare name a turn would spawn (e.g. "claude"). */
function driverCliDefault(driver: AnyProviderDriver): string | undefined {
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" && cfg.cli ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

/** The executable word of a `cli` string; fixed leading wrapper args (if
 * any) stay out of the security decision — only the file that will actually
 * be spawned is classified. */
export function cliProbeHead(cli: string): string {
  return splitCliString(cli)[0] ?? "";
}

function isPathish(head: string): boolean {
  return /[/\\]/.test(head) || /^[a-zA-Z]:/.test(head);
}

/** Best-effort canonical path of the executable the probe would run: bare
 * names resolve through the augmented PATH (first hit, i.e. what a spawn
 * would execute), then symlinks and `.`/`..` are folded away with realpath.
 * Returns null when the target cannot be resolved to an existing file. */
export function canonicalCliTarget(head: string): string | null {
  const trimmed = head.trim();
  if (!trimmed) return null;
  const absolute = isPathish(trimmed) ? trimmed : findCliCandidates(trimmed)[0];
  if (!absolute) return null;
  try {
    return realpathSync(absolute);
  } catch {
    return null;
  }
}

/** Fixed allowlist of discovered adapters: every built-in driver's default
 * CLI name (bare names probe through PATH exactly like a real turn does),
 * plus the canonical path of every copy found on the augmented PATH. */
export function buildCliProbeAllowlist(): Set<string> {
  const allow = new Set<string>();
  for (const driver of BUILT_IN_DRIVERS) {
    const name = driverCliDefault(driver);
    if (!name) continue;
    allow.add(name);
    for (const candidate of findCliCandidates(name)) {
      allow.add(canonicalCliTarget(candidate) ?? candidate);
    }
  }
  return allow;
}

export type CliProbeVerdict =
  | { kind: "allowlisted" }
  | { kind: "custom"; canonical: string | null }
  | { kind: "rejected"; status: 400 | 403; reason: string };

const CUSTOM_NEEDS_SELECTION =
  "custom CLI paths need explicit user selection: set explicitCustomPath only when the user typed or picked this path";

/** Classify a probe request. Pure apart from the PATH/filesystem reads the
 * allowlist needs; never spawns. */
export function classifyCliProbe(cli: string, explicitCustomPath: boolean): CliProbeVerdict {
  const trimmed = cli.trim();
  if (!trimmed || /[\n\r\0]/.test(trimmed)) {
    return { kind: "rejected", status: 400, reason: "cli must be a non-empty path" };
  }
  const head = cliProbeHead(trimmed);
  if (!head) return { kind: "rejected", status: 400, reason: "cli must be a non-empty path" };
  // A literal `..` in the executable is never legitimate — real CLI paths
  // don't contain it, and canonicalization would fold it away before the
  // allowlist comparison, so reject it instead of guessing intent.
  if (/(^|[/\\])\.\.([/\\]|$)/.test(head)) {
    return { kind: "rejected", status: 400, reason: 'cli must not contain ".."' };
  }
  const allow = buildCliProbeAllowlist();
  const canonical = canonicalCliTarget(head);
  if (allow.has(head) || (canonical !== null && allow.has(canonical))) {
    return { kind: "allowlisted" };
  }
  if (explicitCustomPath !== true) {
    return { kind: "rejected", status: 403, reason: CUSTOM_NEEDS_SELECTION };
  }
  return { kind: "custom", canonical };
}
