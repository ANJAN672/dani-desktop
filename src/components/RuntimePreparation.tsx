import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { brand } from "../lib/brand";

// The one first-run step that replaces the engine matrix (spec 110 R-UI-001,
// R-UI-002). It shows what the server's live probe reports and nothing else:
// no engine names, no commands, no Terminal, no setup guide.
//
// It must never become a dead end. Every failure keeps a retry, a copyable
// redacted diagnostic, and a way into the app with reduced function — an
// unreachable runtime is a reason to limit Dani, not to lock the user out.

type BootstrapState = "checking" | "installing" | "ready" | "repairable-error" | "blocked-error";

interface BootstrapStatus {
  state: BootstrapState;
  phase: string;
  code: string;
  message: string;
  canRetry: boolean;
  canContinueLimited: boolean;
}

const UNREACHABLE: BootstrapStatus = {
  state: "blocked-error",
  phase: "detect",
  code: "runtime.unreachable",
  // The background server, not the runtime. Saying "check the app is running"
  // sent people hunting for a setting that does not exist.
  message: "Dani's background service isn't answering. Quit and reopen Dani Bot, then try again.",
  canRetry: true,
  canContinueLimited: true,
};

function isSettled(state: BootstrapState): boolean {
  return state === "ready" || state === "repairable-error" || state === "blocked-error";
}

export function RuntimePreparation({
  onReady,
  onContinueLimited,
}: {
  /** Called once, only after the server reports a passed readiness probe. */
  onReady: () => void;
  onContinueLimited: () => void;
}) {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const announced = useRef(false);

  const read = useCallback(async () => {
    try {
      const res = await fetch("/api/runtime/bootstrap");
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as BootstrapStatus);
    } catch {
      setStatus(UNREACHABLE);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void read();
    // Poll only while work is still in flight; a settled state changes when
    // the user acts on it, not on a timer.
    const timer = window.setInterval(() => {
      if (!active) return;
      setStatus((current) => {
        if (current && isSettled(current.state)) return current;
        void read();
        return current;
      });
    }, 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [read]);

  // Advance only on a real readiness probe, never on a timeout or a guess.
  useEffect(() => {
    if (status?.state !== "ready" || announced.current) return;
    announced.current = true;
    onReady();
  }, [status?.state, onReady]);

  const retry = async () => {
    setRetrying(true);
    try {
      await fetch("/api/runtime/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } catch {
      /* the poll below reports the real state either way */
    } finally {
      setRetrying(false);
      await read();
    }
  };

  const copyDiagnostics = async () => {
    if (!status) return;
    const text = [`dani-bot runtime ${status.state}`, `phase=${status.phase}`, `code=${status.code}`].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* clipboard access can be denied; the codes are on screen regardless */
    }
  };

  const working = !status || status.state === "checking" || status.state === "installing";
  const failed = status !== null && (status.state === "repairable-error" || status.state === "blocked-error");

  return (
    <div className="flex flex-col">
      <h1 className="text-[18px] font-semibold text-ink">Preparing {brand().name}</h1>
      <p className="mt-1 text-[13.5px] text-ink-secondary">
        Setting up everything {brand().name} needs to work. This happens once.
      </p>

      <div className="mt-4 flex items-start gap-3 rounded-xl bg-card p-3.5" aria-live="polite">
        <span
          className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
            status?.state === "ready"
              ? "bg-success/15 text-success"
              : failed
                ? "bg-warning/15 text-warning"
                : "bg-raised text-ink-secondary"
          }`}
        >
          {status?.state === "ready" ? <Check size={14} /> : failed ? <AlertTriangle size={13} /> : <Loader2 size={13} className="animate-spin" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">
            {working ? `Preparing ${brand().name}…` : status?.message}
          </div>
          {failed && (
            <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              You can try again, or continue with limited features and finish this later.
            </div>
          )}
        </div>
      </div>

      {failed && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status.canRetry && (
            <button
              onClick={() => void retry()}
              disabled={retrying}
              className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60"
            >
              {retrying ? "Trying again…" : "Try again"}
            </button>
          )}
          <button
            onClick={() => void copyDiagnostics()}
            className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
          >
            {copied ? "Copied" : "Copy diagnostics"}
          </button>
          <span className="text-[11.5px] text-ink-secondary/70">{status.code}</span>
        </div>
      )}

      <button
        onClick={failed ? onContinueLimited : onReady}
        disabled={working}
        className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
      >
        {failed ? "Continue anyway" : "Continue"}
      </button>
    </div>
  );
}
