import { useEffect, useState } from "react";
import { Check, Mic } from "lucide-react";
import { DaniAvatar } from "./Avatar";
import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RuntimePreparation } from "./RuntimePreparation";
import { PhoneSetupFlow } from "./PhoneSetupFlow";
import { brand } from "../lib/brand";

// First-run onboarding: who you are (email), automatic runtime preparation
// ("Preparing Dani" - no harness choice, no manual install), what the app
// may use (TCC), then an optional phone setup that can always be resumed
// from Settings → Remote access. Every check is skippable or recoverable —
// onboarding must never brick the app.

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { capabilities } = useDesktopCapabilities();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  const saveProfile = async () => {
    if (savingProfile) return;
    setSavingProfile(true);
    setProfileError(null);
    // persisted server-side (~/.danibot/config.json) — the sidebar
    // footer reads it back through /api/config
    let res: Response;
    try {
      res = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
      });
    } catch {
      // The request never reached the server: the background server died or
      // is restarting. Name that — "check the app is running" sent people
      // hunting for a setting that does not exist.
      setProfileError("The app's background server isn't answering. Quit and reopen Dani Bot, then try again.");
      setSavingProfile(false);
      return;
    }
    if (!res.ok) {
      // The server answered and refused: its own message names the cause
      // (a conflict, a busy save, a validation rule), which beats a guess.
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setProfileError(
        body?.error
          ? `Could not save your profile: ${body.error}`
          : `Could not save your profile (error ${res.status}). You can also skip for now and add this later in Settings.`,
      );
      setSavingProfile(false);
      return;
    }
    identifyEmail(email.trim().toLowerCase());
    setStep(1);
  };

  useEffect(() => {
    track("onboarding_step", { step });
  }, [step]);

  useEffect(() => {
    if (step === 2 && capabilities.dictation.available) {
      const poll = () => window.dani?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      // keep polling — the user may grant in System Settings and come back
      const t = setInterval(poll, 2000);
      return () => clearInterval(t);
    }
  }, [step, capabilities.dictation.available]);

  const finish = () => {
    track("onboarding_completed", {
      mic: perms?.mic ?? "n/a",
    });
    setEmailGateDone("submitted");
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app p-8">
      <div
        className={`flex max-h-full w-full flex-col rounded-2xl border border-hairline/40 bg-panel p-8 ${step === 3 ? "max-w-[620px]" : "max-w-[460px]"}`}
      >
        {step === 0 && (
          <div className="flex flex-col items-center">
            {brand().logo ? (
              <img src={brand().logo} alt="" width={72} height={72} className="h-[72px] w-[72px] object-contain" />
            ) : (
              <DaniAvatar color="green" state="happy" size={72} />
            )}
            <h1 className="mt-4 text-[20px] font-semibold text-ink">Welcome to {brand().name}</h1>
            <p className="mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary">
              Bots that do real work on their own computer. Tell us who you are
              and we&rsquo;ll let you know when big things ship.
            </p>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="mt-5 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && valid && void saveProfile()}
              placeholder="you@example.com"
              className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              onClick={() => void saveProfile()}
              disabled={!valid || savingProfile}
              className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
            >
              {savingProfile ? "Saving..." : "Continue"}
            </button>
            {profileError && <p className="mt-2 text-center text-[12px] text-danger">{profileError}</p>}
            <button
              onClick={() => {
                track("email_skipped");
                setStep(1);
              }}
              className="mt-3 text-[12px] text-ink-secondary hover:text-ink"
            >
              Maybe later
            </button>
          </div>
        )}

        {step === 1 && (
          <RuntimePreparation
            variant="onboarding"
            onReady={() => setStep(capabilities.dictation.available ? 2 : 3)}
            onContinueLimited={() => setStep(capabilities.dictation.available ? 2 : 3)}
          />
        )}

        {step === 2 && (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">Permissions</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              Optional, and only ever used when you ask for the feature.
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-card p-3.5">
                <div className="flex items-start gap-3">
                  <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
                  <div>
                    <div className="text-[14px] font-medium text-ink">Microphone & speech</div>
                    <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                      Voice dictation into the composer, transcribed on-device.
                    </div>
                  </div>
                </div>
                {perms?.mic === "granted" ? (
                  <Check size={16} className="shrink-0 text-success" />
                ) : perms?.mic === "denied" || perms?.mic === "restricted" ? (
                  <button
                    onClick={() => window.dani?.permOpenSettings?.("mic")}
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    Open Settings
                  </button>
                ) : (
                  <button
                    onClick={() =>
                      window.dani?.permRequestMic?.().then(() => window.dani?.permStatus?.().then(setPerms))
                    }
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    Enable
                  </button>
                )}
              </div>
              {/* Screen Recording deliberately has no row here: macOS 15+
                  makes a pre-grant unreliable (per-process status caching,
                  helper misattribution, periodic re-prompts) — the OS flow
                  triggers on the first real capture in the Computer panel,
                  which is the moment the user has context for the dialog. */}
            </div>
            <button onClick={() => setStep(3)} className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">
              Continue
            </button>
            <button onClick={() => setStep(3)} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
              Skip for now
            </button>
          </div>
        )}

        {step === 3 && (
          <PhoneSetupFlow
            variant="onboarding"
            profileEmail={email}
            onSkip={() => {
              track("phone_setup_skipped");
              finish();
            }}
            onComplete={() => {
              track("phone_setup_completed");
              finish();
            }}
          />
        )}

      </div>
    </div>
  );
}
