// Managed Hermes runtime bootstrap, contract v1 (issue #18, CTO seam).
// The renderer talks to ONE seam - GET/POST /api/runtime/bootstrap - and
// never learns instance ids, provider registry internals, commands, or
// paths. Everything below is pure mapping plus thin fetch helpers so the
// decision logic is testable without a DOM.

export type RuntimeBootstrapState = "checking" | "installing" | "ready" | "repairable-error" | "blocked-error";
export type RuntimeBootstrapPhase = "detect" | "verify-bundled" | "activate" | "probe" | null;

export interface RuntimeBootstrapStatus {
  schemaVersion: 1;
  state: RuntimeBootstrapState;
  phase: RuntimeBootstrapPhase;
  progress: { completedBytes: number; totalBytes: number } | null;
  runtime: { kind: "hermes"; version: string | null; source: "bundled" | "managed" | "external" | null };
  readiness: {
    runtime: { state: "checking" | "ready" | "error"; hermes: boolean; opencode: boolean };
    modelRoute: { state: "checking" | "ready" | "error" };
    taskReady: boolean;
    activeRuntime: "hermes" | "opencode" | null;
  };
  canRetry: boolean;
  canContinueLimited: boolean;
  error: { code: string; message: string } | null;
}

const STATES: ReadonlySet<string> = new Set(["checking", "installing", "ready", "repairable-error", "blocked-error"]);
const PHASES: ReadonlySet<string> = new Set(["detect", "verify-bundled", "activate", "probe"]);
const SOURCES: ReadonlySet<string> = new Set(["bundled", "managed", "external"]);

/** Validate the wire shape. Anything else (HTML error page, old server,
 * endpoint absent) returns null - the caller treats that as a repairable
 * "could not check" state, never as ready. */
export function parseBootstrapStatus(value: unknown): RuntimeBootstrapStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) return null;
  if (typeof candidate.state !== "string" || !STATES.has(candidate.state)) return null;
  if (candidate.phase !== null && (typeof candidate.phase !== "string" || !PHASES.has(candidate.phase))) return null;
  const runtime = candidate.runtime as Record<string, unknown> | undefined;
  if (typeof runtime !== "object" || runtime === null || runtime.kind !== "hermes") return null;
  if (runtime.version !== null && typeof runtime.version !== "string") return null;
  if (runtime.source !== null && (typeof runtime.source !== "string" || !SOURCES.has(runtime.source))) return null;
  if (typeof candidate.canRetry !== "boolean" || typeof candidate.canContinueLimited !== "boolean") return null;
  const readiness = candidate.readiness as Record<string, unknown> | undefined;
  const runtimeReadiness = readiness?.runtime as Record<string, unknown> | undefined;
  const modelRoute = readiness?.modelRoute as Record<string, unknown> | undefined;
  if (!readiness || !runtimeReadiness || !modelRoute) return null;
  if (typeof readiness.taskReady !== "boolean") return null;
  if (readiness.activeRuntime !== null && readiness.activeRuntime !== "hermes" && readiness.activeRuntime !== "opencode") return null;
  if (!["checking", "ready", "error"].includes(String(runtimeReadiness.state))) return null;
  if (typeof runtimeReadiness.hermes !== "boolean" || typeof runtimeReadiness.opencode !== "boolean") return null;
  if (!["checking", "ready", "error"].includes(String(modelRoute.state))) return null;
  if (candidate.state === "ready" && readiness.taskReady !== true) return null;
  const progress = candidate.progress as Record<string, unknown> | null | undefined;
  if (progress !== null && progress !== undefined) {
    if (typeof progress !== "object") return null;
    if (typeof progress.completedBytes !== "number" || typeof progress.totalBytes !== "number") return null;
  }
  const error = candidate.error as Record<string, unknown> | null | undefined;
  if (error !== null && error !== undefined) {
    if (typeof error !== "object" || typeof error.code !== "string" || typeof error.message !== "string") return null;
  }
  return candidate as unknown as RuntimeBootstrapStatus;
}

/** The endpoint is absent or unreachable: a repairable error per the seam
 * contract ("absent = repairable error/limited mode"), never ready. */
export const BOOTSTRAP_UNAVAILABLE: RuntimeBootstrapStatus = {
  schemaVersion: 1,
  state: "repairable-error",
  phase: null,
  progress: null,
  runtime: { kind: "hermes", version: null, source: null },
  readiness: {
    runtime: { state: "error", hermes: false, opencode: false },
    modelRoute: { state: "error" },
    taskReady: false,
    activeRuntime: null,
  },
  canRetry: true,
  canContinueLimited: true,
  error: {
    code: "bootstrap-unavailable",
    message: "Dani couldn't check its runtime. The app may still be starting - try again in a moment.",
  },
};

/** What the UI should render. Product language only: no "harness",
 * "engine", "CLI", "provider", or command words reach these strings. */
export type BootstrapView =
  | { kind: "working"; detail: string; progressRatio: number | null }
  | { kind: "ready"; version: string | null }
  | { kind: "error"; message: string; canRetry: boolean; canContinueLimited: boolean };

export function bootstrapView(status: RuntimeBootstrapStatus): BootstrapView {
  switch (status.state) {
    case "ready":
      return { kind: "ready", version: status.runtime.version };
    case "repairable-error":
    case "blocked-error":
      return {
        kind: "error",
        message: status.error?.message ?? "Dani couldn't finish setting up. You can retry or continue with limited features.",
        canRetry: status.state === "repairable-error" && status.canRetry,
        canContinueLimited: status.canContinueLimited,
      };
    case "checking":
      return { kind: "working", detail: "Checking this computer…", progressRatio: null };
    case "installing": {
      const detail =
        status.phase === "verify-bundled"
          ? "Verifying…"
          : status.phase === "activate"
            ? "Setting up…"
            : status.phase === "probe"
              ? "Running a final check…"
              : "Downloading…";
      const progress = status.progress;
      const ratio =
        progress && progress.totalBytes > 0
          ? Math.min(1, Math.max(0, progress.completedBytes / progress.totalBytes))
          : null;
      return { kind: "working", detail, progressRatio: ratio };
    }
  }
}

/** Redacted diagnostics for the copy action: the status payload itself,
 * which the contract guarantees carries no command, path, stderr, or
 * secret. */
export function bootstrapDiagnostics(status: RuntimeBootstrapStatus): string {
  return JSON.stringify(
    {
      state: status.state,
      phase: status.phase,
      runtime: status.runtime,
      error: status.error ? { code: status.error.code, message: status.error.message } : null,
    },
    null,
    2,
  );
}

export async function fetchBootstrapStatus(signal?: AbortSignal): Promise<RuntimeBootstrapStatus> {
  try {
    const res = await fetch("/api/runtime/bootstrap", { signal });
    if (!res.ok) return BOOTSTRAP_UNAVAILABLE;
    return parseBootstrapStatus(await res.json().catch(() => null)) ?? BOOTSTRAP_UNAVAILABLE;
  } catch {
    return BOOTSTRAP_UNAVAILABLE;
  }
}

/** Idempotent start/resume/repair. Concurrent calls join one in-flight
 * activation server-side, so firing this from a retry button and a mount
 * effect at once is safe. */
export async function startBootstrap(): Promise<RuntimeBootstrapStatus> {
  try {
    const res = await fetch("/api/runtime/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return BOOTSTRAP_UNAVAILABLE;
    return parseBootstrapStatus(await res.json().catch(() => null)) ?? BOOTSTRAP_UNAVAILABLE;
  } catch {
    return BOOTSTRAP_UNAVAILABLE;
  }
}
