# Dani Desktop Roast — Security & Architecture Audit

**Repo:** `~/workspace/dani-desktop-roast` · branch `prod` · v0.1.55 · pnpm workspace · Electron + Vite + Node
**Method:** static, read-only. No installs, no execution. Every claim cites a file path + line number (or the grep that produced it).
**Verdict in one paragraph:** This is unusually well-hardened for an Electron app: OS-keychain secret storage with plaintext migration, loopback+origin auth on the harness, timing-safe webhook auth, 12-char pairing codes with brute-force lockout, log redaction, and near-1:1 test coverage with almost zero skips. The real findings are narrower: **plaintext API keys in `~/.danibot/config.json` in dev/CLI mode**, a handful of IPC handlers that rely on the preload allowlist instead of the `localOnly` wrapper, and the documented-but-live mobile companion surface.

---

## 1. Secrets / API key handling

### What's good

- **Packaged app: secrets live in the OS keychain.** `electron/main.mjs:328` defines `CREDENTIALS_FILE` as `<userData>/credentials.bin`, read via `safeStorage` (Electron's OS-keychain binding). The reader (`electron/secure-credentials.mjs:25-60`) retries transient keychain-unavailability 4 times (100/200/400/800ms) and — critically — distinguishes `empty` (user saved nothing) from `unavailable` (keychain unreadable), so a bad read can't nuke the store by writing `{}` over it. The copy-on-write state machine in `electron/secure-credential-state.mjs:37-60` refuses writes when the store couldn't be read on that launch.
- **Boot migration scrubbed plaintext.** `electron/main.mjs:413-431` (`secureWorkspaceConfig`) scans `~/.danibot/config.json` at boot and migrates any legacy plaintext keys into `credentials.bin`, rewriting the file with `0o600` mode; it explicitly refuses to delete plaintext unless the OS store accepted the write ("losing the only copy is the one unacceptable outcome").
- **Secrets injected into the server child via in-memory env only.** `electron/main.mjs:1038-1066` forks the harness with `COMPOSIO_API_KEY` and `...workspaceCredentialEnv(secureCredentials)` in the child env — never written to disk. The packaged server's `/api/config` PUT path (`server/index.ts:11727-11744`) accepts `?secretStorage=external` and writes **tombstone empties** over the credential fields in `config.json` ("so an older plaintext value can never survive the merge").
- **Config API never echoes secrets.** `GET /api/config` (`server/index.ts:11446`) returns `configStatus()` — configured-or-not booleans; `server/config.ts:579-580` documents "secrets never echoed back".
- **Webhook ingress uses capability-URL auth with timing-safe compare.** `server/webhook-ingress.ts:103-116`: `manager.authorize(id, secret)` → 401 before buffering/parsing attacker input. The compare is `server/webhooks.ts:163`: `actual.length === expected.length && timingSafeEqual(actual, expected)`.
- **Log redaction is real.** `server/redact.ts:7-40` scrubs token/secret/password/api_key/auth substrings from the native protocol tee (`~/.danibot/native`), because "those logs … get pasted into issues."
- **Pairing codes: 60-bit entropy, 5-min TTL, brute-force lockout.** `server/sessions.ts:19-21` (12 symbols × 32-char alphabet, rejection-sampled) and `server/sessions.ts:142` (`failures` map with `lockedUntil`).

### Findings (spicy first)

1. **Dev/CLI mode stores provider API keys in plaintext `~/.danibot/config.json`.** The `secretStorage=external` path only exists when the Electron parent sets the query param (`electron/main.mjs:2373`: `app.isPackaged ? "?secretStorage=external" : ""`). In dev (`pnpm dev:server`) or `danibot serve` (`server/cli.ts:51`), the `else` branch at `server/index.ts:11750-11753` runs plain `saveConfig(patch)` → the zod schema at `server/config.ts:234-242` persists `xai.key`, `composio.apiKey`, `box.token`, `opencodeGo.apiKey` as JSON literals. A developer or self-host user who types a key into Settings while running from source gets it on disk in the clear. The codebase knows: `electron/main.mjs:2371-2373` comment says "Keep its established local config path there" — but there is no warning in the UI or README that dev-mode keys are plaintext.
2. **Harness HTTP auth is loopback+origin only — by design, but any local process wins.** `server/index.ts:7207-7260`: binds `127.0.0.1` (`server/index.ts:12245`), rejects non-loopback Hosts (DNS-rebinding defense), requires loopback Origin for browser clients. Mutations additionally need the per-launch `x-danibot-desktop-owner` token (`electron/desktop-server-auth.cjs:1-16`) injected by Electron "below renderer JavaScript" (`server/index.ts:424-428`). Any other local process (or a malicious local page via CSRF-simple requests — mitigated by the JSON-only pairing route at `server/index.ts:7230-7241`) can read local state without auth; mutations need the boot token. Reasonable for a desktop app, but "local malware on the same box" is fully in the threat model of an agent that can run terminals — worth naming.
3. **Six IPC handlers skip the `localOnly()` wrapper.** Of 60 `ipcMain.handle` registrations in `electron/main.mjs`, these are NOT wrapped (`localOnly` defined `electron/local-origin.cjs:33-39`, "fail closed" until the local origin is known):
   - `desktop:open-external` (`electron/main.mjs:2105`) — `shell.openExternal()` on a renderer-supplied URL, protocol-gated to http/https only. **Not reachable from a remote page** (`electron/preload.cjs:149` exposes it, but the `REMOTE_SAFE` allowlist at `electron/preload.cjs:25` excludes it — only `applySkin`, `permStatus`, `platform`, `getCapabilities`, etc. cross). So the safety depends on the preload allowlist being the first wall — which the code comments admit (`electron/main.mjs` header comment: "a remote server's page gets a reduced bridge in the first place; this is the second wall"). A local-renderer XSS could still invoke it, but the blast radius is opening a URL.
   - `desktop:capabilities` (`electron/main.mjs:2319`) — passes `process.env` of the main process in, but `electron/capabilities.cjs:78-90` only reads `XDG_SESSION_TYPE`/`WAYLAND_DISPLAY`/`DISPLAY` from it; no env dump reaches the renderer. Checked: safe.
   - `desktop:skin` (`2100`, harmless ack), `perm:status` (`2165`, in REMOTE_SAFE — mic status only), `desktop-remote:state` (`2271`, pairing UI state), `environments:state` (`2304`, returns `localOrigin` + saved environment list). All low-sensitivity, but the pattern is "allowlist by omission" — a future handler added without `localOnly` would silently inherit remote reachability if also added to the preload bridge.
4. **No `shell: true` / `eval` in first-party code.** `grep -rn "shell: *true"` hits only `server/env-path.ts` (comment) and `electron/vendor/electron-updater.cjs` (vendored upstream). The `shell` variable in `server/env-path.ts:123-128` goes to `execFile(shell, ["-l","-i","-c", fixed-string])` — fixed argv, no injection. No `eval(`/`new Function(` in server/electron/src outside tests.
5. **Companion sidecar is the one listener off this machine — and it stays off until asked.** `electron-builder.yml` extraResources comment: "the companion sidecar — a separate process because it is the only part of the app that listens off this machine, and it stays off until asked." Phone secrets use HPKE (`server/phone-secret.ts:126-130`, key-id format validation at `:115`). Reasonably done; the mobile attack surface is opt-in.
6. **SQLite stores transcripts/messages, not secrets.** `server/message-db.ts:38-49` tables are `messages`, `thread_state` — no credential columns found. (Transcripts could still contain pasted secrets the user typed; redaction covers protocol logs, not user chat text — standard caveat.)

---

## 2. Model-attribution honesty

**Verdict: honest.** No "Dani-1"/proprietary-model claims anywhere. Grep for `dani-1|Dani Ultra|Dani Pro|Dani Flash`, `"powered by"`, `proprietary model`, `our own model` across `src server shared` → zero hits.

- Model labels name the real vendor model: `server/drivers/boxagent.ts:29-33` → `"Claude Fable 5 · on the box"`, `"GPT-5.4 (Codex) · on the box"`, `"Claude Sonnet · on the box"`; `server/drivers/antigravity.ts:33-37` → `"Gemini 3.8 Flash (High)"` etc.
- The model picker (`src/components/ModelPicker.tsx:36-46`) renders a per-model **provider badge** (`Provider: ${option.provider}`), grouped on a Cloud/Local rail (`src/components/EngineGroupLabel.tsx`).
- README is explicit: "Bring-your-own-agent … Claude or Codex running locally under the hood", "on the models you already have", "your existing logins and subscriptions, no new accounts, no proxy in the middle" (`README.md` Why section).
- Branding is white-label-as-config (`server/brand.ts:1-8`) — renames the product, never the model. Nothing in the system-prompt-adjacent code rebrands a third-party model as Dani's own.

---

## 3. Dead code / bloat

**Verdict: remarkably little dead code for a repo this size; the big dirs are live.**

| Dir | Size | Status |
|---|---|---|
| `android/` | 3.1M, 100 files | **Live** — Android companion app, own README, Gradle wrapper; protocol ported from iOS |
| `ios/` | 4.0M, 100 files | **Live** — iOS companion, README claims real-device verification |
| `enterprise/` | 24K, 6 files | **Live** — license/entitlement module; `server/enterprise.ts:95` exports `entitled()` consumed by brand/whitelabel |
| `third_party/` | 1.3M, 26 files | **Live** — cloudflared, cua-driver, hpke-js, playwright-injected, t3-code; cloudflared + hpke licenses shipped in `electron-builder.yml` extraResources |
| `cloudflare/` | 280K, 30 files | **Live** — Composio broker worker + control-plane; `package.json` has `broker:types/check/test/deploy` scripts |
| `deploy/` | 12K | **Live** — `docker-compose.yml` + Caddyfile backing the root `Dockerfile` (which binds 127.0.0.1 in-container, `deploy/docker-compose.yml` terminates TLS at edge) |
| `mascot-preview.html` | 4K | **Orphan** — referenced only by a docs plan (`docs/superpowers/plans/2026-08-31-04-mascot-shape-catalog.md`) and its sibling `src/mascot-preview.tsx`; not in `vite.config.ts`/`index.html`/package.json. Harmless dev artifact. |

- **TODO/FIXME/HACK: 0** across server/src/electron/shared/scripts (lint-clean culture; no suppressed markers).
- **`deprecated`: 1 hit**, and it's a status enum check in `server/drivers/acp/opencode-go.ts:96` — not a code marker.
- **No duplicated approval-card or computer-panel flows found.** Single `ApprovalCard.tsx`, single `ComputerPanel.tsx`/`BrowserPanel.tsx`; `LocalComputerSection` vs `RemoteComputerSection` are distinct surfaces, not copies. Component dirs show one-owner naming throughout.
- `scripts/gen:bodies` (`gen-mascot-bodies.ts`) pairs with the mascot preview — dev tooling, not shipped.

---

## 4. README vs reality

**Verdict: unusually honest README; the one eye-catching line is the crypto disclaimer.**

- **Crypto disclaimer** (`README.md:1`): "⚠️ **No affiliation with any cryptocurrency.** Dani Bot has no token…" — anti-scam boilerplate at the very top. Nothing odd beyond being prominent; it's a trust signal for a project whose name could be tokenized. Not a red flag, but the *first* thing a reader sees.
- **Screenshots:** `docs/screenshots/` contains **34 files** (png/jpg/gif/mp4), including before/after shots. Claim supported.
- **"500+ apps through Composio"** (`README.md:54`): Composio's catalog claim; `server/composio.ts` + the managed broker worker exist. Marketing but grounded.
- **Platform coverage:** badge says macOS · Windows · Ubuntu; `electron-builder.yml` builds mac (dmg+zip, arm64+x64), win (nsis+zip x64), linux (AppImage+deb x64). Match.
- **Honest caveats inline:** Windows installer unsigned ("SmartScreen shows unknown publisher" — `electron-builder.yml` win comment), "Ubuntu Wayland host control remains disabled while issue #345 is resolved", "Installers are published only after a version-tag build produces and verifies the complete … set."
- **"Local-first":** accurate for packaged builds — harness on 127.0.0.1, transcripts/keys in `~/.danibot` (`README.md` "Local first" section). Nuance: `DEFAULT_COMPOSIO_BROKER_URL = ""` (`electron/main.mjs:112`) — no default cloud broker, so local-first holds by default.
- **Legacy naming:** `package.json` `desktopName: "com.openmausbot.app.desktop"` and `electron-builder.yml` `appId: com.openmausbot.app` still carry the old "openmausbot" product name while everything user-facing says "Dani Bot" — cosmetic, but it's the kind of thing that shows up in keychain entries and protocol strings (`danibot://` scheme registered at `electron/main.mjs:2457` is the new name).
- Features claimed (model picker, computer panel, approval cards, connected apps, bring-your-own agents) all exist as components/drivers. No phantom features found.

---

## 5. Test coverage honesty

**Verdict: coverage is real and the skip hygiene is excellent.**

| Dir | Test files | Source files |
|---|---|---|
| `src/` | 91 | 178 |
| `server/` | 181 | 171 |
| `electron/` | 36 | 79 |
| `shared/` | 0 | 13 (small type/contract modules) |
| **Total** | **308+** (excl. companion/apps/cloudflare) | — |

- `server/index.test.ts` (376K): **202 `it()` blocks, 1379 `expect()` calls** — boots the *real* harness (`node server/index.ts`) against a throwaway home dir with fake CLI fixtures (`server/testing/fake-claude-cli.ts`) and exercises the HTTP surface. Real assertions, not tautologies.
- **Skips: effectively zero.** An initial grep counted 81, but it was inflated by helper names containing `xit` (`waitForExit`, `expectCleanWorkerExit`). Proper word-boundary count: **exactly 1** genuine skip — `server/group-goal-wait-cap.e2e.test.ts:275`: `it.todo("parks on a busy worker and leaves the room usable for chat while it waits (park-and-release)")`. The remaining skips are platform conditionals (`describe.skipIf(process.platform === "win32")`), which are legitimate.
- **`describe.only`/`it.only`: 0** — no test-isolation landmines.
- **Empty test files: 0.** Commented-out test blocks: 0.
- Electron tests run via `node --test electron/*.node-test.mjs` (`package.json` `test:electron`) — plain Node tests, honest about what they are.

---

## Top issues to act on (if any)

1. Plaintext provider keys in dev/CLI mode (`server/index.ts:11750` else-branch → `~/.danibot/config.json`). Consider warning in Settings UI when `!app.isPackaged`, or always routing through the OS store.
2. Six IPC handlers bypass `localOnly()` and rely on the preload allowlist (`desktop:open-external` at `electron/main.mjs:2105` is the sharpest). Consider a lint/test asserting every `ipcMain.handle` is either wrapped or on an explicit allowlist — `electron/local-only-hoist.node-test.mjs` exists; extend it.
3. Legacy `com.openmausbot.app` identifiers in `package.json`/`electron-builder.yml` vs the "Dani Bot" brand — rename before the identifiers bake into more keychain entries.
