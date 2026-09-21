import { z } from "zod";

import type { Scope } from "./sessions.ts";

const scopeSchema = z.enum(["admin", "client"]);

export const pairSessionInputSchema = z.object({
  code: z.string().trim().min(1).max(128),
  cookie: z.boolean().optional().default(false),
  label: z.string().trim().max(80).optional().default(""),
  attemptId: z.string().trim().regex(/^[\w-]{8,64}$/).optional(),
}).strict();

export const openPairingInputSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  scopes: z.array(scopeSchema).min(1).max(2).refine((scopes) => new Set(scopes).size === scopes.length, "scopes must be unique").optional(),
}).strict();

export type PairSessionInput = z.output<typeof pairSessionInputSchema>;
export type OpenPairingInput = Omit<z.output<typeof openPairingInputSchema>, "scopes"> & { scopes?: Scope[] };

export function parsePairingResourcePath(path: string): { kind: "pairing" | "session"; id: string } | null {
  const pairing = /^\/api\/auth\/pairing\/([\w-]+)$/.exec(path);
  if (pairing) return { kind: "pairing", id: pairing[1]! };
  const session = /^\/api\/auth\/sessions\/([\w-]+)$/.exec(path);
  return session ? { kind: "session", id: session[1]! } : null;
}
