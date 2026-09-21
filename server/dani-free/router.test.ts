import { describe, expect, it } from "vitest";
import { FREE_CATALOG, liveUpstreams, type FreeCatalog, type FreeModel } from "./catalog.ts";
import { eligibleModels, routeFreeModel } from "./router.ts";

const NOW = new Date("2026-09-20T00:00:00Z");

function model(overrides: Partial<FreeModel> & Pick<FreeModel, "id">): FreeModel {
  return {
    label: overrides.id,
    upstream: "zen",
    wireId: overrides.id,
    contextWindow: 128_000,
    privacy: "open",
    evidence: {
      source: "test",
      observedAt: "2026-09-01",
      expiresAt: "2026-12-01",
      quote: "free",
    },
    ...overrides,
  };
}

function catalog(models: FreeModel[], expiresAt = "2026-12-01"): FreeCatalog {
  return { version: 7, generatedAt: "2026-09-01", expiresAt, models };
}

describe("free-only enforcement", () => {
  it("never returns a model that is not in the catalog", () => {
    const decision = routeFreeModel({
      catalog: catalog([model({ id: "dani-free/a" })]),
      now: NOW,
      need: "public",
      preferred: "gpt-4o",
    });
    expect(decision.model).toBeNull();
    expect(decision.rejections).toContainEqual({ id: "gpt-4o", reason: "unknown-model" });
  });

  it("does not treat a name containing 'free' as proof", () => {
    // An id that *looks* free is still just an id. The catalog decides.
    const decision = routeFreeModel({
      catalog: catalog([model({ id: "dani-free/real" })]),
      now: NOW,
      need: "public",
      preferred: "some-vendor/thing-free",
    });
    expect(decision.model).toBeNull();
    expect(decision.rejections).toContainEqual({ id: "some-vendor/thing-free", reason: "unknown-model" });
  });

  it("refuses rather than substituting when an explicit request is ineligible", () => {
    const decision = routeFreeModel({
      catalog: catalog([
        model({ id: "dani-free/wanted", privacy: "may-train" }),
        model({ id: "dani-free/other" }),
      ]),
      now: NOW,
      need: "private",
      preferred: "dani-free/wanted",
    });
    // It does NOT quietly fall back to dani-free/other.
    expect(decision.model).toBeNull();
    expect(decision.rejections).toContainEqual({ id: "dani-free/wanted", reason: "privacy-not-permitted" });
  });

  it("still picks the best eligible model when no preference is expressed", () => {
    const decision = routeFreeModel({
      catalog: catalog([model({ id: "dani-free/a" }), model({ id: "dani-free/b" })]),
      now: NOW,
      need: "public",
    });
    expect(decision.model).not.toBeNull();
    expect(decision.honouredPreference).toBe(false);
  });
});

describe("expiry fails closed", () => {
  it("drops a model whose price evidence has expired", () => {
    const stale = model({
      id: "dani-free/stale",
      evidence: { source: "s", observedAt: "2026-01-01", expiresAt: "2026-02-01", quote: "free" },
    });
    const decision = routeFreeModel({ catalog: catalog([stale]), now: NOW, need: "public" });
    expect(decision.model).toBeNull();
    expect(decision.rejections).toContainEqual({ id: "dani-free/stale", reason: "evidence-expired" });
  });

  it("refuses everything when the catalog itself has expired", () => {
    const decision = routeFreeModel({
      catalog: catalog([model({ id: "dani-free/a" })], "2026-09-01"),
      now: NOW,
      need: "public",
    });
    expect(decision.model).toBeNull();
    expect(decision.rejections.every((entry) => entry.reason === "catalog-expired")).toBe(true);
  });

  it("treats an unparseable expiry date as expired rather than trusting it", () => {
    const broken = model({
      id: "dani-free/broken",
      evidence: { source: "s", observedAt: "?", expiresAt: "not-a-date", quote: "free" },
    });
    expect(routeFreeModel({ catalog: catalog([broken]), now: NOW, need: "public" }).model).toBeNull();
  });
});

describe("privacy filter runs before ranking", () => {
  it("allows only 'open' models for a private request", () => {
    const decision = routeFreeModel({
      catalog: catalog([
        model({ id: "dani-free/trainer", privacy: "may-train" }),
        model({ id: "dani-free/trial", privacy: "trial-only" }),
        model({ id: "dani-free/safe", privacy: "open" }),
      ]),
      now: NOW,
      need: "private",
    });
    expect(decision.model?.id).toBe("dani-free/safe");
    expect(decision.rejections).toContainEqual({ id: "dani-free/trainer", reason: "privacy-not-permitted" });
    expect(decision.rejections).toContainEqual({ id: "dani-free/trial", reason: "privacy-not-permitted" });
  });

  it("returns no model at all when nothing is private-safe, rather than falling back", () => {
    const decision = routeFreeModel({
      catalog: catalog([model({ id: "dani-free/trainer", privacy: "may-train" })]),
      now: NOW,
      need: "private",
    });
    expect(decision.model).toBeNull();
  });

  it("does not honour a preferred model that the privacy filter excluded", () => {
    const decision = routeFreeModel({
      catalog: catalog([model({ id: "dani-free/trainer", privacy: "may-train" })]),
      now: NOW,
      need: "private",
      preferred: "dani-free/trainer",
    });
    expect(decision.model).toBeNull();
    expect(decision.honouredPreference).toBe(false);
  });

  it("permits every class for a public request", () => {
    const decision = routeFreeModel({
      catalog: catalog([
        model({ id: "dani-free/trial", privacy: "trial-only" }),
        model({ id: "dani-free/trainer", privacy: "may-train" }),
      ]),
      now: NOW,
      need: "public",
    });
    expect(decision.model).not.toBeNull();
  });
});

describe("ranking", () => {
  it("prefers the more private model when both are eligible", () => {
    const decision = routeFreeModel({
      catalog: catalog([
        model({ id: "dani-free/trainer", privacy: "may-train", contextWindow: 900_000 }),
        model({ id: "dani-free/safe", privacy: "open", contextWindow: 8_000 }),
      ]),
      now: NOW,
      need: "public",
    });
    expect(decision.model?.id).toBe("dani-free/safe");
  });

  it("prefers the larger window within the same privacy class", () => {
    const decision = routeFreeModel({
      catalog: catalog([
        model({ id: "dani-free/small", contextWindow: 8_000 }),
        model({ id: "dani-free/large", contextWindow: 200_000 }),
      ]),
      now: NOW,
      need: "public",
    });
    expect(decision.model?.id).toBe("dani-free/large");
  });

  it("honours a preference that is eligible", () => {
    const decision = routeFreeModel({
      catalog: catalog([model({ id: "dani-free/a" }), model({ id: "dani-free/b" })]),
      now: NOW,
      need: "public",
      preferred: "dani-free/b",
    });
    expect(decision.model?.id).toBe("dani-free/b");
    expect(decision.honouredPreference).toBe(true);
  });

  it("respects a required context window", () => {
    const decision = routeFreeModel({
      catalog: catalog([model({ id: "dani-free/small", contextWindow: 8_000 })]),
      now: NOW,
      need: "public",
      requireContextWindow: 100_000,
    });
    expect(decision.model).toBeNull();
    expect(decision.rejections).toContainEqual({
      id: "dani-free/small",
      reason: "context-window-too-small",
    });
  });
});

describe("eligibleModels agrees with the router", () => {
  it("lists exactly what the router would accept", () => {
    const c = catalog([
      model({ id: "dani-free/open", privacy: "open" }),
      model({ id: "dani-free/trainer", privacy: "may-train" }),
      model({ id: "dani-free/stale", evidence: { source: "s", observedAt: "x", expiresAt: "2026-01-01", quote: "free" } }),
    ]);
    const ids = eligibleModels(c, NOW, "private").map((m) => m.id);
    expect(ids).toEqual(["dani-free/open"]);

    const publicIds = eligibleModels(c, NOW, "public").map((m) => m.id);
    expect(publicIds).toEqual(["dani-free/open", "dani-free/trainer"]);

    // Anything the router refuses must not be listed.
    for (const id of publicIds) {
      expect(routeFreeModel({ catalog: c, now: NOW, need: "public", preferred: id }).model?.id).toBe(id);
    }
  });
});

describe("the shipped catalog", () => {
  it("is versioned and carries an expiry", () => {
    expect(FREE_CATALOG.version).toBeGreaterThan(0);
    expect(Date.parse(FREE_CATALOG.expiresAt)).not.toBeNaN();
  });

  it("gives every model a source, a quote and an expiry", () => {
    for (const m of FREE_CATALOG.models) {
      expect(m.evidence.source).toMatch(/^https:\/\//);
      expect(m.evidence.quote.length).toBeGreaterThan(0);
      expect(Date.parse(m.evidence.observedAt)).not.toBeNaN();
      expect(Date.parse(m.evidence.expiresAt)).not.toBeNaN();
    }
  });

  it("uses unique ids and wire ids per upstream", () => {
    const ids = FREE_CATALOG.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const wire = FREE_CATALOG.models.map((m) => `${m.upstream}:${m.wireId}`);
    expect(new Set(wire).size).toBe(wire.length);
  });

  it("offers a private-safe route today", () => {
    const decision = routeFreeModel({
      catalog: FREE_CATALOG,
      now: new Date(FREE_CATALOG.generatedAt),
      need: "private",
    });
    expect(decision.model).not.toBeNull();
    expect(decision.model?.privacy).toBe("open");
  });

  it("does not claim upstreams it has no verified models for", () => {
    // Kilo and MiMo are deliberately empty until someone reads their pages.
    expect(liveUpstreams(FREE_CATALOG)).toEqual(["zen"]);
  });
});
