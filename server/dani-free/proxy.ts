import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FREE_CATALOG, UPSTREAM_BASE, CHAT_PATH, type FreeCatalog, type FreeUpstream } from "./catalog.ts";
import { eligibleModels, routeFreeModel, type PrivacyNeed } from "./router.ts";

export const DEFAULT_FREE_PROXY_HOST = "127.0.0.1";
export const DEFAULT_FREE_PROXY_PORT = 8085;
export const PRIVACY_HEADER = "x-dani-privacy";
export function upstreamApiKey(upstream: FreeUpstream, env: NodeJS.ProcessEnv): string {
  return upstream === "zen" ? env.DANI_FREE_ZEN_API_KEY || env.ZEN_API_KEY || ""
    : upstream === "kilo" ? env.DANI_FREE_KILO_API_KEY || env.KILO_API_KEY || ""
      : env.DANI_FREE_MIMO_API_KEY || env.MIMO_API_KEY || "";
}
export interface FreeProxyOptions { host?: string; port?: number; catalog?: FreeCatalog; now?: () => Date; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }
export interface StartedFreeProxy { host: string; port: number; baseUrl: string; close: () => Promise<void> }
const json = (res: ServerResponse, status: number, payload: unknown) => { const body = JSON.stringify(payload); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); };
const readBody = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };
const needOf = (req: IncomingMessage): PrivacyNeed => req.headers[PRIVACY_HEADER] === "public" ? "public" : "private";
function listing(catalog: FreeCatalog, now: Date, need: PrivacyNeed) { return { object: "list", data: eligibleModels(catalog, now, need).map((model) => ({ id: model.id, object: "model", owned_by: `dani-free:${model.upstream}`, dani_free: { label: model.label, upstream: model.upstream, privacy: model.privacy, context_window: model.contextWindow } })) }; }
function refusal(code: string, requested: string | null) { return { error: { type: "dani_free_no_route", code, message: code === "unknown-model" ? `${requested} is not in the Dani-free catalog. Only verified free models are routable.` : code === "privacy-not-permitted" ? "That model is not permitted for private input." : "No verified free model was eligible for this request." } }; }
export function createFreeProxyHandler(options: FreeProxyOptions = {}) {
  const catalog = options.catalog ?? FREE_CATALOG, now = options.now ?? (() => new Date()), env = options.env ?? process.env, fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost"), need = needOf(req);
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) { const at = now(); return json(res, 200, { ok: true, daniFreeProxy: true, catalog_version: catalog.version, catalog_expires_at: catalog.expiresAt, catalog_expired: at.getTime() > Date.parse(catalog.expiresAt), eligible_private: eligibleModels(catalog, at, "private").map((m) => m.id), eligible_public: eligibleModels(catalog, at, "public").map((m) => m.id) }); }
    if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, listing(catalog, now(), need));
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return json(res, 404, { error: { type: "invalid_request_error", message: "Dani-free serves GET /v1/models, POST /v1/chat/completions and GET /health only." } });
    let parsed: Record<string, unknown>; try { parsed = JSON.parse((await readBody(req)).toString("utf8")); } catch { return json(res, 400, { error: { type: "invalid_request_error", message: "body is not JSON" } }); }
    const requested = typeof parsed.model === "string" ? parsed.model : null, decision = routeFreeModel({ catalog, now: now(), need, preferred: requested });
    if (!decision.model) return json(res, 400, refusal(decision.rejections.find((r) => r.id === requested)?.reason ?? (requested ? "unknown-model" : "no-eligible-model"), requested));
    const model = decision.model, key = upstreamApiKey(model.upstream, env); if (!key) return json(res, 401, { error: { type: "dani_free_not_signed_in", code: `no-credential:${model.upstream}`, message: `No credential is configured for ${model.upstream}.` } });
    let upstream: Response; try { upstream = await fetchImpl(`${UPSTREAM_BASE[model.upstream]}${CHAT_PATH}`, { method: "POST", headers: { "content-type": "application/json", accept: String(req.headers.accept ?? "application/json"), authorization: `Bearer ${key}` }, body: JSON.stringify({ ...parsed, model: model.wireId }) }); } catch (error) { return json(res, 502, { error: { type: "dani_free_upstream_unreachable", code: model.upstream, message: String(error) } }); }
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }); if (!upstream.body) return res.end(); const reader = upstream.body.getReader(); for (;;) { const next = await reader.read(); if (next.done) break; res.write(next.value); } res.end();
  };
}
export async function startFreeProxy(options: FreeProxyOptions = {}): Promise<StartedFreeProxy> { const host = options.host ?? DEFAULT_FREE_PROXY_HOST, port = options.port ?? DEFAULT_FREE_PROXY_PORT, server: Server = createServer((req, res) => void createFreeProxyHandler(options)(req, res).catch((error) => !res.headersSent ? json(res, 500, { error: { type: "dani_free_internal", message: String(error) } }) : res.end())); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.removeListener("error", reject); resolve(); }); }); const address = server.address(), boundPort = typeof address === "object" && address ? address.port : port, baseUrl = `http://${host}:${boundPort}/v1`; return { host, port: boundPort, baseUrl, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }; }
