"use strict";

const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const PROFILE_PARTITION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The server child and this shell carry both product generations on the
// private channel: receivers accept the legacy (openmausbot:) and current
// (danibot:) type prefixes. Pinned cross-side by
// scripts/desktop-channel-contract.test.mjs.
const BROWSER_CONTROL_TYPES = new Set(["danibot:browser-control", "openmausbot:browser-control"]);
const BROWSER_BOT_DELETED_TYPES = new Set(["danibot:browser-bot-deleted", "openmausbot:browser-bot-deleted"]);
const BROWSER_PROFILE_DELETED_TYPES = new Set(["danibot:browser-profile-deleted", "openmausbot:browser-profile-deleted"]);

function lifecycleRequestId(message) {
  if (message.requestId === undefined) return undefined;
  const requestId = String(message.requestId ?? "");
  if (!REQUEST_ID.test(requestId)) throw new Error("invalid browser lifecycle request id");
  return requestId;
}

/** Accept only a positive hold assertion from the private server child.
 * A server-side `held:false` may be caused by a loopback release request, so
 * it must never clear Electron's local gate. Only the trusted Browser panel
 * release IPC can do that, after its server-first release succeeds. */
function applyBrowserControlHold(message, take) {
  if (!message || Object.prototype.toString.call(message) !== "[object Object]") return false;
  if (!BROWSER_CONTROL_TYPES.has(message.type)) return false;
  if (message.held !== true || !BOT_ID.test(String(message.botId ?? ""))) {
    throw new Error("invalid browser-control hold message");
  }
  if (!(take instanceof Function)) throw new Error("browser-control receiver is unavailable");
  take(String(message.botId));
  return true;
}

/** Decode server-authoritative lifecycle cleanup messages carried on the
 * same private utilityProcess port as the browser descriptor. They are never
 * accepted from the renderer or loopback HTTP. */
function decodeBrowserLifecycleMessage(message) {
  if (!message || Object.prototype.toString.call(message) !== "[object Object]") return null;
  if (BROWSER_BOT_DELETED_TYPES.has(message.type)) {
    const botId = String(message.botId ?? "");
    if (!BOT_ID.test(botId)) throw new Error("invalid browser bot-deleted message");
    const requestId = lifecycleRequestId(message);
    const lifecycle = { type: "bot-deleted", botId };
    if (requestId) lifecycle.requestId = requestId;
    return lifecycle;
  }
  if (BROWSER_PROFILE_DELETED_TYPES.has(message.type)) {
    const partitionId = String(message.partitionId ?? "");
    if (!PROFILE_PARTITION_ID.test(partitionId) || partitionId === "guest") {
      throw new Error("invalid browser profile-deleted message");
    }
    const requestId = lifecycleRequestId(message);
    const lifecycle = { type: "profile-deleted", partitionId };
    if (requestId) lifecycle.requestId = requestId;
    return lifecycle;
  }
  return null;
}

function browserLifecycleResult(requestId, ok) {
  const id = String(requestId ?? "");
  if (!REQUEST_ID.test(id)) throw new Error("invalid browser lifecycle result id");
  return { type: "danibot:browser-lifecycle-result", requestId: id, ok: ok === true };
}

module.exports = { applyBrowserControlHold, browserLifecycleResult, decodeBrowserLifecycleMessage };
