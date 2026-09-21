#!/usr/bin/env node
/** Real-network OpenAI Realtime readiness probe. No fixture or fallback server exists here. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const configPath = process.env.DANI_CONFIG_PATH || join(process.env.DANI_DATA_DIR || join(homedir(), ".danibot"), "config.json");
let cfg;
try { cfg = JSON.parse(await readFile(configPath, "utf8")); }
catch (error) { throw new Error(`Cannot read Dani config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`); }
const proxyUrl = String(process.env.DANI_REALTIME_PROXY_URL || cfg.liveCall?.proxyUrl || "").trim();
if (!proxyUrl) throw new Error(`No liveCall.proxyUrl in ${configPath} and DANI_REALTIME_PROXY_URL is unset`);
const proxy = new URL(proxyUrl);
if (proxy.protocol !== "https:" || proxy.username || proxy.password || proxy.hash) throw new Error("Realtime proxy must be a credential-free HTTPS URL");
const request = {
  conversationId: `proxy-e2e-${Date.now()}`,
  participants: [{ id: "e2e", name: "Realtime network probe", instructions: "Transcribe input audio only. Do not create provider responses." }],
  inputLanguage: "en",
  outputLanguage: "en",
};
const started = Date.now();
const response = await fetch(proxy, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(request), redirect: "error", signal: AbortSignal.timeout(15_000) });
const body = await response.json().catch(() => null);
if (!response.ok) throw new Error(`Configured proxy returned HTTP ${response.status}`);
if (!body || body.provider !== "openai-realtime" || typeof body.id !== "string" || typeof body.endpoint !== "string" || typeof body.ephemeralToken !== "string") throw new Error("Configured proxy returned invalid session material");
const endpoint = new URL(body.endpoint);
if (endpoint.protocol !== "https:") throw new Error("Realtime endpoint is not HTTPS");
if (body.expiresAt !== undefined && body.expiresAt <= Date.now()) throw new Error("Configured proxy returned an expired session");
console.log(JSON.stringify({ ok: true, proxyOrigin: proxy.origin, endpointOrigin: endpoint.origin, sessionId: body.id, expiresAt: body.expiresAt ?? null, proxyRoundTripMs: Date.now() - started, webrtc: "not exercised: this runner has no browser microphone/RTCPeerConnection" }, null, 2));
