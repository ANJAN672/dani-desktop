// "Preparing Dani" - the single managed-runtime status surface (issue #18).
// The renderer never sees a command, an install script, a Terminal button,
// or a setup guide: it polls GET /api/runtime/bootstrap, starts/resumes
// with POST, and renders the contract states in product language.
import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy, Loader2, RefreshCw } from "lucide-react";

import {
  bootstrapDiagnostics,
  bootstrapView,
  fetchBootstrapStatus,
  startBootstrap,
  type RuntimeBootstrapStatus,
} from "@/lib/runtime-bootstrap";

const POLL_MS = 1500;

export function RuntimePreparation({
  variant,
  onReady,
  onContinueLimited,
}: {
  /** onboarding: centered first-run panel content. screen: full-page stand-in
   * when no bot can run. compact: inline status inside another surface. */
  variant: "onboarding" | "screen" | "compact";
  onReady?: () => void;
  onContinueLimited?: () => void;
}) {
  const [status, setStatus] = useState<RuntimeBootstrapStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const startedRef = useRef(false);
  const readyFiredRef = useRef(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      let next = await fetchBootstrapStatus();
      // First sight of a not-ready runtime: join (or start) the managed
      // install. POST is idempotent and concurrent calls coalesce, so this
      // is safe even if onboarding and a chat surface mount together.
      if (!startedRef.current && next.state !== "ready") {
        startedRef.current = true;
        next = await startBootstrap();
      }
      if (!active) return;
      setStatus(next);
      if (next.state === "ready") {
        if (!readyFiredRef.current) {
          readyFiredRef.current = true;
          onReady?.();
        }
        return; // nothing left to poll
      }
      // Poll only while work is in flight; error states wait for the user
      // (Retry re-enters the loop), ready returns above.
      if (next.state === "checking" || next.state === "installing") {
        timer = setTimeout(tick, POLL_MS);
      }
    };

    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [onReady]);

  const retry = async () => {
    const next = await startBootstrap();
    setStatus(next);
    // Re-enter the poll loop for the fresh attempt.
    if (next.state === "checking" || next.state === "installing") {
      const t0 = Date.now();
      const poll = async () => {
        const current = await fetchBootstrapStatus();
        setStatus(current);
        if (current.state === "ready") {
          if (!readyFiredRef.current) {
            readyFiredRef.current = true;
            onReady?.();
          }
          return;
        }
        if ((current.state === "checking" || current.state === "installing") && Date.now() - t0 < 10 * 60_000) {
          setTimeout(poll, POLL_MS);
        }
      };
      setTimeout(poll, POLL_MS);
    } else if (next.state === "ready" && !readyFiredRef.current) {
      readyFiredRef.current = true;
      onReady?.();
    }
  };

  const copyDiagnostics = async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(bootstrapDiagnostics(status));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permission denied): nothing false to show.
    }
  };

  const view = status ? bootstrapView(status) : { kind: "working" as const, detail: "Checking this computer…", progressRatio: null };

  const body =
    view.kind === "working" ? (
      <div className={variant === "compact" ? "flex items-center gap-2" : "flex flex-col items-center py-2"}>
        <Loader2 size={variant === "compact" ? 14 : 18} className="animate-spin text-ink-secondary" />
        <div className={variant === "compact" ? "text-[12.5px] text-ink-secondary" : "mt-2.5 text-[13.5px] text-ink-secondary"}>
          {view.detail}
        </div>
        {view.progressRatio !== null && (
          <div className="mt-3 h-1.5 w-full max-w-[280px] overflow-hidden rounded-full bg-inset" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.progressRatio * 100)}>
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(view.progressRatio * 100)}%` }} />
          </div>
        )}
      </div>
    ) : view.kind === "ready" ? (
      <div className="flex items-center gap-2 text-[13px] text-success">
        <Check size={15} /> Ready{view.version ? ` · ${view.version}` : ""}
      </div>
    ) : (
      <div className="flex flex-col">
        <div className="text-[13.5px] leading-relaxed text-ink">{view.message}</div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {view.canRetry && (
            <button
              type="button"
              onClick={() => void retry()}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110"
            >
              <RefreshCw size={12} /> Retry
            </button>
          )}
          <button
            type="button"
            onClick={() => void copyDiagnostics()}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover"
          >
            <ClipboardCopy size={12} /> {copied ? "Copied" : "Copy diagnostics"}
          </button>
          {view.canContinueLimited && onContinueLimited && (
            <button
              type="button"
              onClick={onContinueLimited}
              className="text-[12.5px] text-ink-secondary hover:text-ink"
            >
              Continue with limited features
            </button>
          )}
        </div>
      </div>
    );

  if (variant === "compact") return <div className="mt-1">{body}</div>;

  return (
    <div className={variant === "screen" ? "mx-auto w-full max-w-[460px] px-6" : "flex min-h-0 flex-col"}>
      <h1 className={variant === "screen" ? "text-[20px] font-semibold text-ink" : "text-[18px] font-semibold text-ink"}>
        Preparing Dani
      </h1>
      <p className="mt-1 text-[13.5px] text-ink-secondary">
        {view.kind === "error"
          ? "Something interrupted setup. Nothing was installed halfway that can't be repaired."
          : "One-time setup, automatic. This usually takes a moment."}
      </p>
      <div className="mt-4">{body}</div>
    </div>
  );
}
