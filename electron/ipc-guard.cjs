// IPC guard — schema validation, origin enforcement, and capability
// classification for every channel a sandboxed renderer can reach through
// the preload bridge (electron/preload.cjs).
//
// Threat model: the renderer is untrusted. contextIsolation + sandbox keep
// raw Electron/Node APIs out of its hands, but the bridge still exposes
// ~75 invoke channels whose arguments arrive as structured-clone data from
// a potentially hostile page (XSS in the chat UI, a compromised remote
// server UI, a malicious data: URL). Every exposed handler therefore gets:
//
//   1. schema validation — malformed arguments are rejected before the
//      handler body runs;
//   2. origin checks — localOnly() semantics: anything that touches this
//      computer answers only the local server's UI (see local-origin.cjs);
//   3. a documented capability classification — the CHANNEL_POLICY table
//      below is the single registry of what each channel may do.
//
// Window-ownership checks (main-window-only, viewer-context ownership) stay
// in the handlers themselves, next to the state they protect; the policy
// table records which channels require them.
//
// Pure module: no Electron import, so it is unit-tested with node --test.
"use strict";

const { localOnly, localOnlySync } = require("./local-origin.cjs");

// ── tiny schema DSL ────────────────────────────────────────────────────
// Schemas are plain objects: { kind, ... }. validateValue throws on mismatch.
function string({ min = 0, max = Infinity, pattern = null } = {}) {
  return { kind: "string", min, max, pattern };
}
function number({ min = -Infinity, max = Infinity, integer = false } = {}) {
  return { kind: "number", min, max, integer };
}
function boolean() {
  return { kind: "boolean" };
}
function enumeration(...values) {
  return { kind: "enum", values };
}
function optional(inner) {
  return { kind: "optional", inner };
}
function nullable(inner) {
  return { kind: "nullable", inner };
}
function arrayOf(inner, { min = 0, max = Infinity } = {}) {
  return { kind: "array", inner, min, max };
}
function object(shape, { allowUnknown = false } = {}) {
  return { kind: "object", shape, allowUnknown };
}
function any() {
  return { kind: "any" };
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateValue(value, schema, path) {
  switch (schema.kind) {
    case "any":
      return;
    case "optional":
      if (value === undefined) return;
      validateValue(value, schema.inner, path);
      return;
    case "nullable":
      if (value === null || value === undefined) return;
      validateValue(value, schema.inner, path);
      return;
    case "string": {
      if (typeof value !== "string") throw new Error(`${path}: expected string, got ${typeName(value)}`);
      if (value.length < schema.min || value.length > schema.max) {
        throw new Error(`${path}: string length ${value.length} outside [${schema.min}, ${schema.max}]`);
      }
      if (schema.pattern && !schema.pattern.test(value)) {
        throw new Error(`${path}: string does not match ${schema.pattern}`);
      }
      return;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${path}: expected finite number, got ${typeName(value)}`);
      }
      if (schema.integer && !Number.isInteger(value)) throw new Error(`${path}: expected integer`);
      if (value < schema.min || value > schema.max) {
        throw new Error(`${path}: number ${value} outside [${schema.min}, ${schema.max}]`);
      }
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${path}: expected boolean, got ${typeName(value)}`);
      return;
    case "enum":
      if (!schema.values.includes(value)) {
        throw new Error(`${path}: expected one of ${JSON.stringify(schema.values)}, got ${JSON.stringify(value)}`);
      }
      return;
    case "array": {
      if (!Array.isArray(value)) throw new Error(`${path}: expected array, got ${typeName(value)}`);
      if (value.length < schema.min || value.length > schema.max) {
        throw new Error(`${path}: array length ${value.length} outside [${schema.min}, ${schema.max}]`);
      }
      value.forEach((item, index) => validateValue(item, schema.inner, `${path}[${index}]`));
      return;
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path}: expected object, got ${typeName(value)}`);
      }
      for (const key of Object.keys(schema.shape)) {
        validateValue(value[key], schema.shape[key], `${path}.${key}`);
      }
      if (!schema.allowUnknown) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(schema.shape, key)) throw new Error(`${path}: unexpected key "${key}"`);
        }
      }
      return;
    }
    default:
      throw new Error(`${path}: unknown schema kind ${(schema && schema.kind) ?? schema}`);
  }
}

// ── shared argument shapes ─────────────────────────────────────────────
const BOT_ID = string({ min: 1, max: 120, pattern: /^[A-Za-z0-9_-]+$/ });
const PROFILE = optional(string({ max: 128 }));
const CONTEXT_ID = nullable(string({ max: 256 }));
const WEB_URL = string({ min: 1, max: 8192 });
const DEVICE_ID = string({ min: 1, max: 128 });
const EMAIL = string({ min: 1, max: 320 });
const BOUNDS = nullable(object(
  {
    x: number({ integer: true }),
    y: number({ integer: true }),
    width: number({ integer: true, min: 1 }),
    height: number({ integer: true, min: 1 }),
  },
  { allowUnknown: true },
));

// ── capability classification ──────────────────────────────────────────
// origin: "local-only" — the local server's UI only (localOnly semantics).
//         "public"     — any page in the window may call it; the handler
//                        itself must stay side-effect-free for strangers.
// window: "main"       — the sender must be the main app window.
//         null         — no extra ownership requirement.
const CHANNEL_POLICY = {
  // ── embedded browser (WebContentsView per bot; agent-driven web content)
  "browser:available": { capability: "embedded-browser", origin: "local-only", window: "main", args: [] },
  "browser:state": { capability: "embedded-browser", origin: "local-only", window: "main", args: [BOT_ID] },
  "browser:layout": {
    capability: "embedded-browser", origin: "local-only", window: "main",
    args: [BOT_ID, BOUNDS, PROFILE, optional(string({ max: 32 })), optional(string({ max: 128 }))],
  },
  "browser:forward": { capability: "embedded-browser", origin: "local-only", window: "main", args: [BOT_ID, PROFILE] },
  "browser:reload": { capability: "embedded-browser", origin: "local-only", window: "main", args: [BOT_ID, PROFILE] },
  "browser:navigate": { capability: "embedded-browser", origin: "local-only", window: "main", args: [BOT_ID, WEB_URL, PROFILE] },
  "browser:back": { capability: "embedded-browser", origin: "local-only", window: "main", args: [BOT_ID, PROFILE] },
  "browser:set-human-control": {
    capability: "embedded-browser", origin: "local-only", window: "main",
    args: [BOT_ID, boolean(), PROFILE],
  },
  "browser:close": { capability: "embedded-browser", origin: "local-only", window: "main", args: [BOT_ID] },
  "browser:forget-profile": {
    capability: "embedded-browser", origin: "local-only", window: "main",
    args: [string({ min: 1, max: 40, pattern: /^[A-Za-z0-9_-]+$/ })],
  },
  // ── screen capture
  "screen:preview-intent": { capability: "screen-capture", origin: "local-only", window: "main", args: [] },
  "screen:frame": { capability: "screen-capture", origin: "local-only", window: null, args: [] },
  // ── misc local actions
  "desktop:unread-count": {
    capability: "ui-chrome", origin: "public", window: "main", args: [any()],
    note: "ipcMain.on (fire-and-forget badge update); value coerced by normalizeUnreadCount.",
  },
  "engine:open-terminal": {
    capability: "host-terminal", origin: "local-only", window: null,
    args: [string({ min: 1, max: 4096 })],
    note: "Renderer text is copied to the clipboard; never becomes a process argument.",
  },
  "desktop:pick-folder": { capability: "device-files", origin: "local-only", window: null, args: [optional(string({ max: 4096 }))] },
  "desktop:export-diagnostics": { capability: "device-files", origin: "local-only", window: null, args: [] },
  // App logs (spec 080 R5 "where logs are"): reveal the log directory or the
  // live server.log in the OS file manager. Local-only desktop repair.
  "logs:path": { capability: "device-files", origin: "local-only", window: null, args: [] },
  "logs:open": { capability: "device-files", origin: "local-only", window: null, args: [] },
  "desktop:save-file": { capability: "device-files", origin: "local-only", window: null, args: [string({ min: 1, max: 4096 })] },
  "desktop:skin": { capability: "ui-chrome", origin: "public", window: null, args: [string({ min: 1, max: 64 })] },
  "desktop:open-external": { capability: "external-navigation", origin: "public", window: null, args: [WEB_URL] },
  // ── desktop viewer (Box VNC) and Local VM workspace
  "desktop-viewer:open": {
    capability: "remote-desktop-viewer", origin: "local-only", window: null,
    args: [WEB_URL, optional(string({ max: 256 })), CONTEXT_ID],
  },
  "desktop-viewer:close": {
    capability: "remote-desktop-viewer", origin: "local-only", window: null, args: [CONTEXT_ID],
    note: "Closes only when the caller owns the current viewer context.",
  },
  "desktop-viewer:state-now": { capability: "remote-desktop-viewer", origin: "local-only", window: null, args: [] },
  "desktop-workspace:open": {
    capability: "local-vm", origin: "local-only", window: null,
    args: [object({ contextId: string({ min: 1, max: 256 }), url: WEB_URL, bounds: optional(object({}, { allowUnknown: true })) })],
  },
  "desktop-workspace:layout": {
    capability: "local-vm", origin: "local-only", window: null,
    args: [arrayOf(object({
      contextId: string({ min: 1, max: 256 }),
      bounds: object({}, { allowUnknown: true }),
      visible: optional(boolean()),
    }, { allowUnknown: true }), { max: 2 })],
  },
  "desktop-workspace:set-interactive": { capability: "local-vm", origin: "local-only", window: null, args: [CONTEXT_ID] },
  "desktop-workspace:close": { capability: "local-vm", origin: "local-only", window: null, args: [CONTEXT_ID] },
  // ── permissions / speech
  "perm:status": { capability: "read-only-status", origin: "public", window: null, args: [] },
  "perm:request-mic": { capability: "media-devices", origin: "local-only", window: null, args: [] },
  "perm:open-settings": { capability: "media-devices", origin: "local-only", window: null, args: [string({ min: 1, max: 32 })] },
  "speech:start": {
    capability: "media-devices", origin: "local-only", window: "main",
    args: [optional(nullable(object({}, { allowUnknown: true })))],
  },
  "speech:stop": { capability: "media-devices", origin: "local-only", window: null, args: [] },
  "speech:finish": { capability: "media-devices", origin: "local-only", window: null, args: [] },
  // ── skill recorder
  "skill-recorder:permissions": { capability: "skill-recording", origin: "local-only", window: null, args: [] },
  "skill-recorder:start": {
    capability: "skill-recording", origin: "local-only", window: null, args: [],
    note: "Requires a live sender window; the recorder attaches to that window.",
  },
  "skill-recorder:stop": { capability: "skill-recording", origin: "local-only", window: null, args: [] },
  "skill-recorder:save": {
    capability: "skill-recording", origin: "local-only", window: null,
    args: [object({}, { allowUnknown: true })],
    note: "Payload shape validated deeply by saveSkillRecording.",
  },
  // ── companion sidecar (listens off-machine; renderer gets state + switches only)
  "companion:state": { capability: "device-pairing", origin: "local-only", window: null, args: [] },
  "companion:start": { capability: "device-pairing", origin: "local-only", window: null, args: [] },
  "companion:stop": { capability: "device-pairing", origin: "local-only", window: null, args: [] },
  "companion:keep-awake": { capability: "device-pairing", origin: "local-only", window: null, args: [any()] },
  "companion:refresh-tailscale": { capability: "device-pairing", origin: "local-only", window: null, args: [] },
  "companion:pairing": {
    capability: "device-pairing", origin: "local-only", window: null,
    args: [any(), optional(nullable(string({ max: 512 })))],
  },
  "companion:cloud-desktop": { capability: "device-pairing", origin: "local-only", window: null, args: [DEVICE_ID, any()] },
  "companion:revoke": { capability: "device-pairing", origin: "local-only", window: null, args: [DEVICE_ID] },
  // ── desktop remote-client mode
  "desktop-remote:state": { capability: "read-only-status", origin: "public", window: null, args: [] },
  "desktop-remote:pair": {
    capability: "device-pairing", origin: "local-only", window: "main",
    args: [string({ min: 1, max: 2048 }), string({ min: 1, max: 128 })],
  },
  "desktop-remote:disconnect": { capability: "device-pairing", origin: "local-only", window: "main", args: [] },
  // ── companion account (secrets never cross; tiny public state only)
  "companion-account:state": { capability: "device-pairing", origin: "local-only", window: null, args: [] },
  "companion-account:request-code": { capability: "device-pairing", origin: "local-only", window: null, args: [EMAIL] },
  "companion-account:verify-code": {
    capability: "device-pairing", origin: "local-only", window: null,
    args: [EMAIL, string({ min: 1, max: 128 })],
  },
  "companion-account:retry": { capability: "device-pairing", origin: "local-only", window: null, args: [] },
  "companion-account:sign-out": { capability: "device-pairing", origin: "local-only", window: null, args: [] },
  // ── environments (local vs remote server)
  "environments:state": { capability: "read-only-status", origin: "public", window: null, args: [] },
  "environments:switch": { capability: "environments", origin: "local-only", window: null, args: [optional(string({ max: 256 }))] },
  "environments:add-from-link": { capability: "environments", origin: "local-only", window: null, args: [string({ min: 1, max: 4096 })] },
  "environments:forget": { capability: "environments", origin: "local-only", window: null, args: [optional(string({ max: 256 }))] },
  // ── capabilities / transcription / credentials / approvals
  "desktop:capabilities": { capability: "read-only-status", origin: "public", window: null, args: [] },
  "assemblyai:status": { capability: "transcription", origin: "local-only", window: null, args: [] },
  "assemblyai:set-key": { capability: "account-secrets", origin: "local-only", window: null, args: [string({ max: 16384 })] },
  "assemblyai:streaming-token": { capability: "transcription", origin: "local-only", window: null, args: [] },
  "credential:set": {
    capability: "account-secrets", origin: "local-only", window: null,
    args: [string({ min: 1, max: 64 }), string({ max: 16384 })],
    note: "Name allow-list enforced by saveWorkspaceCredential.",
  },
  "approvals:set-trusted-mode": {
    capability: "approval-escalation", origin: "local-only", window: null,
    args: [string({ min: 1, max: 120 }), string({ min: 1, max: 32 }), optional(any())],
    note: "Mode allow-list enforced by trustedApprovalMode.request.",
  },
  // ── updater (changes this app)
  "update:get-state": { capability: "app-update", origin: "local-only", window: null, args: [] },
  "update:check": { capability: "app-update", origin: "local-only", window: null, args: [] },
  "update:download": { capability: "app-update", origin: "local-only", window: null, args: [] },
  "update:install": { capability: "app-update", origin: "local-only", window: null, args: [] },
  // ── computer-use host (cua.mjs)
  "cua:connection": { capability: "computer-control", origin: "local-only", window: null, args: [] },
  "cua:permissions": { capability: "computer-control", origin: "local-only", window: null, args: [] },
  "cua:linux-status": { capability: "computer-control", origin: "local-only", window: null, args: [] },
  "cua:linux-enable": { capability: "computer-control", origin: "local-only", window: null, args: [] },
  "cua:linux-disable": { capability: "computer-control", origin: "local-only", window: null, args: [] },
  "cua:linux-retry": { capability: "computer-control", origin: "local-only", window: null, args: [] },
  // ── physical Android devices (android-device.mjs; origin + main-frame
  // ownership enforced by its protect() wrapper, schemas here as the second wall)
  "android-device:status": { capability: "android-device", origin: "local-only", window: "main", args: [] },
  "android-device:frame": { capability: "android-device", origin: "local-only", window: "main", args: [string({ min: 1, max: 128 })] },
  "android-device:input": {
    capability: "android-device", origin: "local-only", window: "main",
    args: [string({ min: 1, max: 128 }), object({}, { allowUnknown: true })],
    note: "Payload coordinates/key/text validated deeply by the input handler.",
  },
};

function policyFor(channel) {
  const policy = CHANNEL_POLICY[channel];
  if (!policy) throw new Error(`ipc-guard: no policy registered for channel "${channel}"`);
  return policy;
}

/** Validate positional invoke args against the channel's policy. Throws. */
function checkArgs(channel, args) {
  const policy = policyFor(channel);
  const expected = policy.args;
  if (args.length > expected.length) {
    throw new Error(`ipc-guard: "${channel}" takes at most ${expected.length} argument(s), got ${args.length}`);
  }
  expected.forEach((schema, index) => {
    validateValue(args[index], schema, `"${channel}" arg ${index + 1}`);
  });
}

/**
 * Wrap an ipcMain.handle listener: schema-validate the arguments, then
 * enforce the channel's origin policy (localOnly for local-only channels).
 * Registration-time fail-closed: unknown channels throw here, not at call time.
 */
function guard(channel, handler) {
  policyFor(channel);
  const policy = CHANNEL_POLICY[channel];
  const originChecked = policy.origin === "local-only" ? localOnly(channel, handler) : handler;
  return (event, ...args) => {
    checkArgs(channel, args);
    return originChecked(event, ...args);
  };
}

/** Same as guard(), for ipcMain.on / sendSync handlers. */
function guardSync(channel, handler, denied) {
  policyFor(channel);
  const policy = CHANNEL_POLICY[channel];
  const originChecked = policy.origin === "local-only" ? localOnlySync(channel, handler, denied) : handler;
  return (event, ...args) => {
    checkArgs(channel, args);
    return originChecked(event, ...args);
  };
}

module.exports = {
  CHANNEL_POLICY,
  arrayOf,
  boolean,
  checkArgs,
  enumeration,
  guard,
  guardSync,
  nullable,
  number,
  object,
  optional,
  policyFor,
  string,
  any,
  validateValue,
};
