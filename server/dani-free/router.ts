import type { FreeCatalog, FreeModel, PrivacyClass } from "./catalog.ts";

export type PrivacyNeed = "public" | "private";
export interface RouteInput {
  catalog: FreeCatalog;
  now: Date;
  need: PrivacyNeed;
  preferred?: string | null;
  requireContextWindow?: number;
}
export type RejectionReason = "unknown-model" | "catalog-expired" | "evidence-expired" | "privacy-not-permitted" | "context-window-too-small";
export interface RouteRejection { id: string; reason: RejectionReason }
export interface RouteDecision {
  model: FreeModel | null;
  catalogVersion: number;
  rejections: readonly RouteRejection[];
  honouredPreference: boolean;
}

const PERMITTED: Readonly<Record<PrivacyNeed, readonly PrivacyClass[]>> = {
  public: ["open", "may-train", "trial-only"],
  private: ["open"],
};

function expired(iso: string, now: Date): boolean {
  const at = Date.parse(iso);
  return Number.isNaN(at) || now.getTime() > at;
}
function rank(model: FreeModel): number {
  const privacy = model.privacy === "open" ? 2 : model.privacy === "may-train" ? 1 : 0;
  return privacy * 1_000_000 + Math.min(model.contextWindow, 999_999);
}

/** Selects only catalogued, currently-evidenced, privacy-eligible routes. */
export function routeFreeModel({ catalog, now, need, preferred, requireContextWindow }: RouteInput): RouteDecision {
  const rejections: RouteRejection[] = [];
  if (expired(catalog.expiresAt, now)) {
    return {
      model: null,
      catalogVersion: catalog.version,
      rejections: catalog.models.map((model) => ({ id: model.id, reason: "catalog-expired" as const })),
      honouredPreference: false,
    };
  }
  const eligible: FreeModel[] = [];
  for (const model of catalog.models) {
    if (expired(model.evidence.expiresAt, now)) rejections.push({ id: model.id, reason: "evidence-expired" });
    else if (!PERMITTED[need].includes(model.privacy)) rejections.push({ id: model.id, reason: "privacy-not-permitted" });
    else if (requireContextWindow !== undefined && model.contextWindow < requireContextWindow) rejections.push({ id: model.id, reason: "context-window-too-small" });
    else eligible.push(model);
  }
  if (preferred) {
    const match = eligible.find((model) => model.id === preferred);
    if (match) return { model: match, catalogVersion: catalog.version, rejections, honouredPreference: true };
    if (!catalog.models.some((model) => model.id === preferred)) rejections.push({ id: preferred, reason: "unknown-model" });
    return { model: null, catalogVersion: catalog.version, rejections, honouredPreference: false };
  }
  return {
    model: eligible.reduce<FreeModel | null>((best, model) => !best || rank(model) > rank(best) ? model : best, null),
    catalogVersion: catalog.version,
    rejections,
    honouredPreference: false,
  };
}

export function eligibleModels(catalog: FreeCatalog, now: Date, need: PrivacyNeed): readonly FreeModel[] {
  const decision = routeFreeModel({ catalog, now, need });
  const rejected = new Set(decision.rejections.map((entry) => entry.id));
  return catalog.models.filter((model) => !rejected.has(model.id));
}
