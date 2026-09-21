import { describe, expect, it } from "vitest";

import { openPairingInputSchema, pairSessionInputSchema, parsePairingResourcePath } from "./auth-route-contracts.ts";

describe("auth route contracts", () => {
  it("normalizes a valid pairing exchange without accepting extra fields", () => {
    expect(pairSessionInputSchema.parse({ code: " ABCD-EFGH ", cookie: true })).toEqual({
      code: "ABCD-EFGH",
      cookie: true,
      label: "",
    });
    expect(() => pairSessionInputSchema.parse({ code: "ABCD", admin: true })).toThrow();
    expect(() => pairSessionInputSchema.parse({ code: "ABCD", attemptId: "short" })).toThrow();
    expect(() => pairSessionInputSchema.parse({ code: "ABCD", label: "x".repeat(81) })).toThrow();
  });

  it("rejects unknown scopes instead of silently dropping them", () => {
    expect(openPairingInputSchema.parse({ scopes: ["client"] })).toEqual({ scopes: ["client"] });
    expect(() => openPairingInputSchema.parse({ scopes: ["client", "owner"] })).toThrow();
    expect(() => openPairingInputSchema.parse({ scopes: ["client", "client"] })).toThrow();
  });

  it("uses local route parsing and never carries a stale match", () => {
    expect(parsePairingResourcePath("/api/auth/pairing/one")).toEqual({ kind: "pairing", id: "one" });
    expect(parsePairingResourcePath("/api/auth/sessions/two")).toEqual({ kind: "session", id: "two" });
    expect(parsePairingResourcePath("/api/auth/sessions/two/extra")).toBeNull();
    expect(parsePairingResourcePath("/api/auth/pairing")).toBeNull();
  });
});
