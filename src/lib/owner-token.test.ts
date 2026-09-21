import { beforeEach, expect, it, vi } from "vitest";

import {
  OWNER_HEADER,
  OWNER_TOKEN_STORAGE_KEY,
  installOwnerTokenFetch,
  ownerFetch,
  readOwnerToken,
  type OwnerFetchDeps,
} from "./owner-token";

const TOKEN = "a".repeat(43);

function deps(overrides: Partial<OwnerFetchDeps> = {}): OwnerFetchDeps & { seen: Array<{ input: unknown; init: unknown }> } {
  const seen: Array<{ input: unknown; init: unknown }> = [];
  const nativeFetch = (async (input: unknown, init: unknown) => {
    seen.push({ input, init });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  return {
    seen,
    nativeFetch,
    getToken: () => TOKEN,
    sameOrigin: (url) => url.startsWith("http://127.0.0.1:5199"),
    isApiRequest: (url) => new URL(url, "http://127.0.0.1:5199").pathname.startsWith("/api/"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

it("reads a well-formed token from storage and rejects junk", () => {
  const getItem = vi.fn((key: string) => (key === OWNER_TOKEN_STORAGE_KEY ? TOKEN : null));
  expect(readOwnerToken({ getItem } as Pick<Storage, "getItem">)).toBe(TOKEN);
  expect(readOwnerToken({ getItem: () => "too-short" } as Pick<Storage, "getItem">)).toBeNull();
  expect(readOwnerToken({ getItem: () => null } as Pick<Storage, "getItem">)).toBeNull();
  const throwing = { getItem: () => { throw new Error("denied"); } } as Pick<Storage, "getItem">;
  expect(readOwnerToken(throwing)).toBeNull();
});

it("attaches the owner header to same-origin /api mutations", async () => {
  const d = deps();
  await ownerFetch("http://127.0.0.1:5199/api/bots", { method: "POST" }, d);
  const headers = (d.seen[0].init as RequestInit).headers as Headers;
  expect(headers.get(OWNER_HEADER)).toBe(TOKEN);
});

it("leaves cross-origin, non-api, and token-less requests alone", async () => {
  const d = deps();
  await ownerFetch("https://example.com/api/bots", { method: "POST" }, d);
  expect(d.seen[0].init).toEqual({ method: "POST" });
  await ownerFetch("http://127.0.0.1:5199/index.html", { method: "GET" }, d);
  expect(d.seen[1].init).toEqual({ method: "GET" });
  const noToken = deps({ getToken: () => null });
  await ownerFetch("http://127.0.0.1:5199/api/bots", { method: "POST" }, noToken);
  expect(noToken.seen[0].init).toEqual({ method: "POST" });
});

it("never overrides an explicitly set header", async () => {
  const d = deps();
  const headers = new Headers({ [OWNER_HEADER]: "b".repeat(43) });
  await ownerFetch("http://127.0.0.1:5199/api/bots", { method: "POST", headers }, d);
  expect((d.seen[0].init as RequestInit).headers).toBe(headers);
  expect(headers.get(OWNER_HEADER)).toBe("b".repeat(43));
});

it("installs once on window.fetch and is idempotent", () => {
  const calls: Array<{ input: unknown; init: unknown }> = [];
  const nativeFetch = (async (input: unknown, init: unknown) => {
    calls.push({ input, init });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  const store = new Map<string, string>([[OWNER_TOKEN_STORAGE_KEY, TOKEN]]);
  vi.stubGlobal("window", {
    fetch: nativeFetch,
    localStorage: { getItem: (k: string) => store.get(k) ?? null },
    location: { origin: "http://127.0.0.1:5199" },
  });
  installOwnerTokenFetch();
  installOwnerTokenFetch();
  const w = window as unknown as { fetch: typeof fetch };
  expect(w.fetch).not.toBe(nativeFetch);
  return w.fetch("http://127.0.0.1:5199/api/config", { method: "PATCH" }).then(() => {
    const headers = (calls[0].init as RequestInit).headers as Headers;
    expect(headers.get(OWNER_HEADER)).toBe(TOKEN);
  });
});
