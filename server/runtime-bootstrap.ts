// Product-facing runtime readiness for first run (spec 110 R-UI-002, R-RUNTIME-003).
//
// The renderer receives structured status, never commands. Everything here is
// derived from the live provider snapshot: this module cannot report `ready`
// on its own, which is what keeps "no fake green" true at the UI boundary.
//
// Safe copy rule: driver reasons carry binary names, paths and stderr
// ("`hermes` CLI not found"). None of that crosses this boundary. The cause is
// classified from structured snapshot fields and re-worded in product language.

export type BootstrapState = "checking" | "installing" | "ready" | "repairable-error" | "blocked-error";
export type BootstrapPhase = "detect" | "verify-bundled" | "activate" | "probe";

/** The live facts this decision is allowed to read. */
export interface BootstrapCandidate {
  driverKind: string;
  snapshot: { state: "available" | "unavailable"; version?: string | null };
  models: { default: string };
  /** The driver can repair itself without a terminal. */
  managedInstall: boolean;
}

export interface BootstrapStatus {
  state: BootstrapState;
  phase: BootstrapPhase;
  /** Stable machine-readable cause. Safe to log and to branch on. */
  code: string;
  /** Product copy. No harness, engine, CLI, curl, PowerShell or path. */
  message: string;
  canRetry: boolean;
  /** A failed runtime must never be a dead end (spec 110 R-RUNTIME-003). */
  canContinueLimited: boolean;
}

const READY: BootstrapStatus = {
  state: "ready",
  phase: "probe",
  code: "runtime.ready",
  message: "Dani is ready.",
  canRetry: false,
  canContinueLimited: false,
};

function failure(
  code: string,
  message: string,
  repairable: boolean,
  phase: BootstrapPhase = "detect",
): BootstrapStatus {
  return {
    state: repairable ? "repairable-error" : "blocked-error",
    phase,
    code,
    message,
    canRetry: true,
    canContinueLimited: true,
  };
}

/**
 * Why activating the bundled payload failed, in product language.
 *
 * `repairable` false means no amount of retrying on this machine will help:
 * the installer carries nothing for this system. Offering a retry there would
 * be a lie dressed as a button.
 */
const ACTIVATION_CAUSES: Record<string, { message: string; repairable: boolean }> = {
  "runtime.unsupported-platform": { message: "Dani doesn’t support this type of computer yet.", repairable: false },
  "runtime.payload-missing": { message: "This installation is missing the files Dani needs. Reinstall Dani Bot to repair it.", repairable: false },
  "runtime.manifest-invalid": { message: "This installation is damaged. Reinstall Dani Bot to repair it.", repairable: false },
  "runtime.digest-mismatch": { message: "Dani’s files failed their safety check and were not used.", repairable: true },
  "runtime.archive-unsafe": { message: "Dani’s files failed their safety check and were not used.", repairable: true },
  "runtime.archive-invalid": { message: "Dani’s files failed their safety check and were not used.", repairable: true },
  "runtime.archive-oversize": { message: "Dani’s files failed their safety check and were not used.", repairable: true },
  "runtime.executable-missing": { message: "Dani couldn’t finish setting itself up.", repairable: true },
  "runtime.activation-failed": { message: "Dani couldn’t finish setting itself up.", repairable: true },
};

/**
 * Map the live Hermes candidate to the product bootstrap state.
 *
 * `candidates === null` means the probe has not answered yet — deliberately
 * distinct from "answered with nothing", which is a real failure.
 * `repairInFlight` reports an idempotent repair started by POST.
 * `activationCode` is the last bundled-payload activation failure, if any: it
 * explains *why* the runtime is missing, which the provider snapshot alone
 * cannot say.
 */
export function bootstrapStatus(
  candidates: readonly BootstrapCandidate[] | null,
  repairInFlight = false,
  activationCode: string | null = null,
): BootstrapStatus {
  if (candidates === null) {
    return {
      state: "checking",
      phase: "detect",
      code: "runtime.checking",
      message: "Preparing Dani…",
      canRetry: false,
      canContinueLimited: false,
    };
  }

  const hermes = candidates.find((candidate) => candidate.driverKind === "hermesAgent");

  if (repairInFlight && hermes?.snapshot.state !== "available") {
    return {
      state: "installing",
      phase: "activate",
      code: "runtime.installing",
      message: "Preparing Dani…",
      canRetry: false,
      canContinueLimited: true,
    };
  }

  // Hermes is the sole product runtime. Its absence from the registry is a
  // build/config fault, not something a retry on this machine can repair.
  if (!hermes) {
    return failure("runtime.not-configured", "This installation is missing its Dani runtime. Reinstall Dani Bot to repair it.", false);
  }

  if (hermes.snapshot.state === "available") {
    // Runtime-ready is not model-ready (spec 110 non-goals). Advancing here
    // would be exactly the false success the acceptance criteria forbid.
    if (!hermes.models.default) {
      return failure("runtime.no-model", "Dani is installed but has no model to run yet.", true, "probe");
    }
    return READY;
  }

  // A failed activation is the more specific truth: the runtime is missing
  // because preparing it failed, and saying which failure beats "not ready".
  const cause = activationCode ? ACTIVATION_CAUSES[activationCode] : undefined;
  if (cause) return failure(activationCode!, cause.message, cause.repairable, "activate");

  // A version string means the runtime ran and answered — it is present but
  // the wrong build. No version means nothing answered at all. This is the
  // structured signal that replaces parsing the driver's reason text.
  const present = Boolean(hermes.snapshot.version);
  const code = present ? "runtime.version-mismatch" : "runtime.absent";
  const message = present
    ? "Dani's runtime needs an update before it can run."
    : "Dani's runtime isn't ready on this computer yet.";
  return failure(code, message, hermes.managedInstall, present ? "verify-bundled" : "detect");
}

/** Redacted diagnostics the user can copy from a failure state. */
export function bootstrapDiagnostics(status: BootstrapStatus, appVersion: string, platform: string): string {
  return [
    `dani-bot ${appVersion} (${platform})`,
    `runtime.state=${status.state}`,
    `runtime.phase=${status.phase}`,
    `runtime.code=${status.code}`,
  ].join("\n");
}
