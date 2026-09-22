// Keeping what someone typed during first run (issue #18: "user input survives
// retries and app restarts", acceptance criterion 7).
//
// Onboarding can fail for reasons that have nothing to do with the person
// using it: the background service is restarting, a save is refused, the app is
// quit mid-setup. Making them retype their name and email each time turns a
// recoverable hiccup into a worse first impression than the failure itself.
//
// This is a per-machine convenience, so browser storage is the right home for
// it. It is also the reason every access is defensive: storage throws in a
// private window, returns null with site data cleared, and can hold whatever a
// previous version or another tab left behind.
export interface OnboardingDraft {
  name: string;
  email: string;
}

const KEY = "danibot.onboarding-draft";

/** Longer than any real name or address, short enough to bound a bad value. */
const MAX_FIELD = 320;

export const EMPTY_DRAFT: OnboardingDraft = { name: "", email: "" };

function storageOr(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Accessing localStorage itself can throw when site data is blocked.
    return null;
  }
}

/** Accept only the shape this module writes, and never more than it should. */
function sanitize(value: unknown): OnboardingDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_DRAFT;
  const raw = value as Record<string, unknown>;
  const field = (input: unknown): string => (typeof input === "string" ? input.slice(0, MAX_FIELD) : "");
  return { name: field(raw.name), email: field(raw.email) };
}

/** What was typed last time, or empty. Never throws. */
export function readDraft(storage?: Storage): OnboardingDraft {
  const store = storageOr(storage);
  if (!store) return EMPTY_DRAFT;
  try {
    const raw = store.getItem(KEY);
    return raw ? sanitize(JSON.parse(raw)) : EMPTY_DRAFT;
  } catch {
    // Unreadable or corrupt: an empty form is a fine outcome, an exception
    // during first-run render is not.
    return EMPTY_DRAFT;
  }
}

/** Remember what has been typed. Never throws; losing a draft is not an error. */
export function writeDraft(draft: OnboardingDraft, storage?: Storage): void {
  const store = storageOr(storage);
  if (!store) return;
  try {
    // An empty draft is the same as no draft, and leaving a blank record behind
    // would resurrect nothing while looking like saved state.
    if (!draft.name && !draft.email) {
      store.removeItem(KEY);
      return;
    }
    store.setItem(KEY, JSON.stringify(sanitize(draft)));
  } catch {
    /* it will not survive a restart; the session still holds it */
  }
}

/** Forget the draft once it has been saved or onboarding is over. */
export function clearDraft(storage?: Storage): void {
  const store = storageOr(storage);
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch {
    /* nothing to do, and nothing worth failing over */
  }
}
