// Owner capability for browser/dev UI sessions.
//
// The packaged desktop app injects the per-launch owner capability below
// renderer JavaScript (Electron's webRequest hook), so a separate local
// process using curl cannot impersonate the person operating the app. A
// browser tab has no such layer, so the operator provisions the token the
// server prints on boot into this tab's localStorage once per launch:
//   localStorage.setItem("danibot.ownerToken", "<token from the server log>")
// A separate local process cannot read this tab's storage, which is exactly
// the property the x-danibot-desktop-owner header enforces server-side.

export const OWNER_TOKEN_STORAGE_KEY = "danibot.ownerToken";
export const OWNER_HEADER = "x-danibot-desktop-owner";
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function readOwnerToken(storage: Pick<Storage, "getItem">): string | null {
  let value: string | null = null;
  try {
    value = storage.getItem(OWNER_TOKEN_STORAGE_KEY)?.trim() ?? null;
  } catch {
    return null;
  }
  return value && OWNER_TOKEN_PATTERN.test(value) ? value : null;
}

export interface OwnerFetchDeps {
  nativeFetch: typeof fetch;
  getToken: () => string | null;
  sameOrigin: (url: string) => boolean;
  isApiRequest: (url: string) => boolean;
}

/** Wrap fetch so same-origin /api calls carry the owner capability when the
 * operator provisioned one. Never overrides a header the caller set
 * explicitly. Pure function of its deps so unit tests can drive it. */
export function ownerFetch(input: RequestInfo | URL, init: RequestInit | undefined, deps: OwnerFetchDeps): Promise<Response> {
  const token = deps.getToken();
  if (token) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (deps.sameOrigin(url) && deps.isApiRequest(url)) {
      const headers = new Headers(init?.headers);
      if (!headers.has(OWNER_HEADER)) {
        headers.set(OWNER_HEADER, token);
        return deps.nativeFetch(input, { ...init, headers });
      }
    }
  }
  return deps.nativeFetch(input, init);
}

/** Install the wrapper on window.fetch. Safe to call in the packaged app
 * too: Electron's webRequest hook overwrites this header with the genuine
 * token below JavaScript, so a stale localStorage value never reaches the
 * server there. Idempotent. */
export function installOwnerTokenFetch(): void {
  const w = window as Window & { fetch: typeof fetch; __danibotOwnerFetchInstalled?: boolean };
  if (w.__danibotOwnerFetchInstalled) return;
  w.__danibotOwnerFetchInstalled = true;
  const nativeFetch = w.fetch.bind(w);
  const origin = window.location.origin;
  w.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    ownerFetch(input, init, {
      nativeFetch,
      getToken: () => readOwnerToken(window.localStorage),
      sameOrigin: (url: string) => {
        try {
          return new URL(url, origin).origin === origin;
        } catch {
          return false;
        }
      },
      isApiRequest: (url: string) => {
        try {
          return new URL(url, origin).pathname.startsWith("/api/");
        } catch {
          return false;
        }
      },
    })) as typeof fetch;
}
