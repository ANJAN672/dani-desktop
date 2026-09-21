# Dani Bot (dani-desktop, prod branch, v0.1.55) — Code Roast

Read-only review. No dependencies installed, nothing run. Every claim below cites a file.

## The headline

This is genuinely impressive for ~51 commits by essentially one person: a working Electron app with a driver model for 17 agent providers, a real permission broker, OS-keychain secret storage, 343 test files with ~1 skipped test, and docs that mostly match reality. The roast below is about the gap between "indie hacker shipping fast" and "this is production software other people install" — because the repo is positioning itself as the latter (installers, auto-updater, App Store iOS app, enterprise/ dir).

---

## 1. The god file: `server/index.ts` is 12,277 lines

- `server/index.ts`: **12,277 lines / 580KB**, with ~168 hand-rolled `method ===` route checks inside a single `createServer` callback (`server/index.ts:7212`). This is a framework-free router reimplemented by hand — the thing Express/Hono exist to do — and it's the single biggest maintainability risk in the repo.
- `src/state/store.tsx`: 2,681 lines. `server/store.ts`: 1,662 lines. `src/components/Sidebar.tsx`: 1,809 lines. `src/components/ComputerPanel.tsx`: 1,645 lines. The codebase's own CONTRIBUTING.md says "deliberately small and direct — plain Node, no frameworks… one store" — one store is fine, one 2,681-line store plus a 12k-line server file is "we couldn't find the seams."
- Credit: the "no framework" choice is at least *consistent* and dependency-light (16 runtime deps in package.json). But `zod` is already a dependency — the validation is there, the router is not.

## 2. The rebrand is half-done: this was "Maus Bot"

The app is called "Dani Bot" but the bones say **OpenMaus Bot**:

- `electron-builder.yml:1`: `appId: com.openmausbot.app` (productName is Dani Bot — the bundle ID still belongs to the old name).
- `src/components/Avatar.tsx:2-5,81-83`: the avatar component and its public types are still literally named `MausAvatar`; comment says "in the app's historical MausAvatar API."
- `server/index.ts` still serves `/.well-known/openmausbot/environment` alongside the new one.
- `openmausbot` string survives in: localStorage keys (`ComputerPanel.tsx:983`, `src/lib/sidebar-preferences.ts`), drag MIME types (`Sidebar.tsx:1263,1530`), notification tags (`src/lib/notify.ts:29`), event names (`src/lib/transcription-status.ts`), placeholder URLs (`https://openmausbot.invalid` in `AttachmentPreview.tsx:148`, `ChatMarkdown.tsx:235`), and the voice storage key (`src/lib/local-voice.ts:11`).
- `server/browser-connection.ts:199` migrates directories `[\"OpenMausBot\", \"openmausbot\", \"Dani Bot\", \"DaniBot\"]` — the fossil record of renames, in order.
- NOTICE says "relicensed from MIT to Apache-2.0 with the consent of all contributors." 51 commits, ~1 human (Somdipto Nandy / Sodan / Dan Labs aliases). CONTRIBUTING.md claims "community PRs have already shipped in this repo" — the merge PRs (#4–#7) are all from the author's own branches. There is no community yet; the docs describe one.

## 3. "Local-first" — with an email gate, PostHog, and a Cloudflare control plane

- README's pitch: "Local first. One small harness server on 127.0.0.1… Transcripts, keys, and events live in ~/.danibot, not a cloud."
- But: first launch is an **email gate** — `src/App.tsx:314` blocks the app on `emailGateDone()` (`src/lib/analytics.ts:113`); Onboarding step 0 collects name + email to "let you know when big things ship." That's a marketing funnel in front of a "local-first" app, skippable via "Maybe later" (good) but still.
- `posthog-js` is a runtime dependency; `track("onboarding_step", …)` fires during onboarding.
- `cloudflare/` contains a `control-plane` worker and a `composio-broker` worker (808 lines combined) — i.e., there *is* a cloud half, for companion accounts and the Composio broker. "No proxy in the middle" (README) is true for the agent CLIs, not for the whole product.
- Fair note: the pairing endpoint is genuinely careful — `POST /api/auth/pair` rejects non-JSON content types to block cross-site form planting, with the reasoning written in the comment (`server/index.ts` ~line 7229). Whoever wrote this *thinks* about security.

## 4. Voice approvals: say "yes" and the bot runs your shell command

- `src/components/GroupCallView.tsx:30-31`: during voice calls, spoken approvals are matched with `const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i` against transcribed speech (`spokenApprovalPrompt`, `PendingApproval.tsx:57`).
- The permission broker — the app's flagship safety feature ("Bots ask before they act") — can therefore be driven by **any audio the mic hears**: a TV in the background, another person in the room, or audio injection. There is no speaker verification.
- Mitigation claimed in comments: calls are half-duplex (capture closes while the bot speaks) to avoid the bot approving itself. That's a real mitigation for self-approval but not for environmental audio.
- This is the single scariest line in the codebase for a "your own computer" agent app.

## 5. The proprietary-model question (important, and the answer is: not in this repo)

The task asked to look for anywhere a third-party model (ChatGPT/OpenAI) is presented as Dani's own. Findings:

- **Not present.** The model picker is honest: 17 drivers (`server/drivers/builtIn.ts`) all named after their real providers (Claude, Codex, Grok, Gemini, Kimi, Droid, Cursor, OpenCode, Qwen, Hermes, Pi, Minimax, Antigravity, OpenAI-compatible). Labels read "Claude Fable 5 · on the box", "GPT-5.4 (Codex) · on the box", "Gemini 3.8 Flash" — provider names plus honest "on the box" (local CLI) attribution. Unavailable providers are dimmed *with the reason*. Not a single "Dani-1" anywhere in the repo.
- No "I am Dani, a proprietary model" system prompt anywhere; bot identity text is user-editable (`BotInstructionsDialog`).
- The only "proprietary" hit in product code is `server/bot-package.ts:213` — "run without Dani Bot or another proprietary parser" — about *parsers*, not models.
- About dialog: "An open-source desktop home for your agents… Made by Dani." Accurate.
- **But**: there is a "Hermes" driver (`server/drivers/acp/hermes.ts`) and a `hermes-live-runtime` merge — if "Hermes" is meant to become a house model someday, the naming is currently just a driver. Nothing deceptive *today*.
- Bottom line for the meeting-transcript concern: the "ChatGPT API presented as our proprietary model" idea exists in the Suhair/Benjamin meeting transcripts, **not** in this codebase. If that plan is executed, it will have to be built — it isn't here.

## 6. Secrets handling: excellent in the packaged app, plaintext in dev mode

The packaged Electron app does this right:

- Electron `safeStorage` (OS keychain) for credentials: `electron/main.mjs:339-364`, `electron/secure-credentials.mjs`, `electron/workspace-credentials.mjs` — with explicit migration of plaintext `config.json` secrets into the encrypted store and loud failure if encryption is unavailable (not a silent `{}`).
- `server/config.ts`: env-var override layering (`COMPOSIO_API_KEY`, `OPENAI_COMPAT_API_KEY`, etc.) — standard.
- Live-call sessions: "Short-lived token only. Long-lived provider credentials stay server-side." (`src/lib/live-call-provider.ts:36`).
- Config API never echoes secrets back (`GET /api/config` returns configured-or-not booleans); log redaction scrubs token/secret substrings from the native protocol tee (`server/redact.ts`); webhook ingress uses timing-safe compare (`server/webhooks.ts:163`).
- Pairing is genuinely strong: 12-symbol rejection-sampled codes (~60 bits entropy), 5-minute TTL, brute-force lockout map (`server/sessions.ts:19-21,142`), timing-safe compare; local-harness mutations additionally need a per-launch `x-danibot-desktop-owner` token injected below renderer JS.

**The hole: dev/CLI mode writes keys in plaintext.** `?secretStorage=external` (which writes tombstone empties instead of real keys) is only set when `app.isPackaged` (`electron/main.mjs:2373`). Running `pnpm dev:server` or `danibot serve` takes the plain `saveConfig()` branch (`server/index.ts:11750-11753`), persisting `xai.key`, `composio.apiKey`, `box.token`, `opencodeGo.apiKey` as JSON literals in `~/.danibot/config.json` — with no UI or README warning. Anyone who followed the repo's own dev instructions (AGENTS.md: `pnpm dev:server`) and pasted a key into Settings now has it on disk in the clear. The packaged app migrates-and-scrubs on boot; the dev path never warns you.

**IPC: six handlers skip the `localOnly()` wrapper** (`electron/local-origin.cjs:33-39`, fail-closed local-origin gate). Of 60 `ipcMain.handle` registrations, `desktop:open-external` (`electron/main.mjs:2105`), `desktop:capabilities`, `desktop:skin`, `perm:status`, `desktop-remote:state`, and `environments:state` are unwrapped. `open-external` is protocol-gated to http/https and excluded from the remote-page preload allowlist (`electron/preload.cjs:25` `REMOTE_SAFE`) — so the safety is "allowlist by omission," and a local-renderer XSS could still invoke it. All low-blast-radius today, but the pattern means a future handler added without `localOnly` silently inherits remote reachability. Worth a lint rule, not just a comment.

## 7. Test coverage: honest, almost to a fault

- 343 test files vs 428 source files (~80% ratio) — unusually high.
- Exactly **1** `.skip(`/`.todo(` in the entire repo, **zero** `.only`, zero empty test files, zero TODO/FIXME markers. `server/index.test.ts` boots the *real* server with 202 `it()`s and 1379 `expect()`s.
- `server/index.test.ts` is 381KB — tests for the god file are proportionally god-sized.
- The honest critique: the suite is so large it risks becoming the reason refactors don't happen (splitting `server/index.ts` means rewriting a 381KB test file). Tests are an asset; here they're also a moat around the god file.
- `pnpm test` = vitest + broker tests + electron node-tests + packaged-server tests. Real pipeline, not theater.

## 8. Over-engineering and bloat

- `src/components/CursorAvatar.tsx`: **1,585 lines** for an animated mascot avatar (the old "Maus" face engine, per `Avatar.tsx` comments — "hand-built Maus body + face engine… is gone" yet 1,585 lines remain). Plus `scripts/gen-mascot-bodies.ts` and `scripts/mascot-bodies/`. A chat app with a generative mascot-body pipeline.
- `mascot-preview.html` + `src/mascot-preview.tsx` at repo root — a whole second entry point for previewing the mascot.
- Native `ios/` (with Widgets, ShareExtension, AppStore config) and `android/` apps, `enterprise/` dir, `Dockerfile`, `deploy/`, `third_party/` (cloudflared, cua-driver, hpke-js, playwright-injected, t3-code) — for a v0.1.55 desktop app whose Linux desktop is "beta" and whose iOS app needs a rebuild to pair (`danibot://pair`, per month-one-report). A dedicated audit confirmed these are all live and referenced by build scripts — not dead code — which is almost worse: it's a *maintained* 5-platform surface (macOS/Windows/Linux desktop + iOS + Android + Docker + Cloudflare workers) for a one-person team. The platform surface is 5–10x the team's ability to maintain it.
- `docs/` is **38MB** with ADRs, interview notes, per-integration docs, a spec-driven-dev kit (`dani-sdd-kit`), `plans/`, `handoff/` — and `docs/month-one-report.md` is an **unfilled template** ("Period:" / "Version tagged:" blank). The docs describe process maturity the repo doesn't have yet.
- `specs/` has exactly 2 specs (`001-runtime-control`, `002-hermes-adapter`). Spec-driven development with 2 specs.

## 9. Copy-paste and parallel implementations

- `SettingsPanel.tsx` (1,121 lines, local per-bot settings) vs `RemoteAgentSettingsPanel.tsx` (remote-client variant) — same panel, twice.
- `ComputerPanel.tsx` vs `src/components/remote-desktop-panel/` — same for computers.
- `CallView.tsx` (1:1 calls) vs `GroupCallView.tsx` (group calls) — shares `CallTargetButton` but reimplements call state.
- `server/drivers/acp/` has 8 ACP adapter drivers (grok, gemini, kimi, droid, cursor, opencode-go, qwen, hermes) — the ACP abstraction is the right call, but each adapter is a new dialect to maintain.
- Credit: the driver *interface* (`ProviderDriver` in `contracts.ts`) is clean — "Adding a driver = write drivers/<x>.ts, append" (`builtIn.ts` header). The plugin seam is good; the duplication is in the UI layer.

## 10. README vs reality: mostly honest, a few stretches

- Screenshots referenced in README exist in `docs/screenshots/` (verified present).
- "500+ apps through Composio" — that's Composio's catalog, not Dani's; the integration is real (`server/composio.ts` 51KB, `cloudflare/composio-broker`).
- "Installers are published only after a version-tag build produces and verifies the complete macOS, Windows, and Linux set" — aspirational release gating for a 0.1.x.
- Crypto disclaimer at the top of README ("Dani Bot has no token") — tells you someone already tried to scam with the name. Not a code issue, but it tells you about the project's threat model: it's popular enough to be impersonated, small enough that the defense is a README banner.
- `desktopName: com.openmausbot.app.desktop` in package.json vs `appId: com.openmausbot.app` in electron-builder.yml — even the *packaging identifiers* disagree with each other, let alone the brand.

## 11. Small things that would get flagged in review

- Node **>= 24** required (`package.json` engines) — bleeding edge; Node 24 was brand-new in 2026. Uses `node:sqlite` `DatabaseSync` (memory-sidecar.ts) which explains it, but it shrinks the contributor/tester pool.
- `server/dani-agent.ts` (the `danibot` CLI entry) is 10 lines delegating to `cli.ts` — fine, but the harness is documented as "the Dani Agent harness" while the real entry surface is `server/index.ts`.
- `Onboarding.tsx` brand logo: `brand().logo ? <img> : <MausAvatar …/>` — the fallback avatar for the *Dani* brand is still the *Maus* mascot.
- Zero `TODO`/`FIXME`/`HACK` comments in src/server/electron (grep count: 0) — either pristine or swept. Given the rebrand fossils above, "swept" is more likely; the mess is structural, not annotated.

---

## Verdict

Ship the compliment first: this is a real, working, unusually well-tested agent harness with a genuinely good driver abstraction, honest model attribution, and proper OS-level secret storage. The permission broker is the right centerpiece.

The roast: it's a **12,000-line server file** wearing a trench coat of platform targets (iOS, Android, enterprise, Docker, Cloudflare) it can't maintain, half-renamed from a previous identity, with a marketing email gate in front of a "local-first" pitch — and the genuinely dangerous design choices are (a) letting a regex on microphone audio approve shell commands, and (b) writing provider API keys in plaintext to `~/.danibot/config.json` in dev/CLI mode with no warning. Fix the voice-approval trust model, warn or encrypt the dev-mode key path, finish the rename (bundle IDs included), and split `server/index.ts` before the 381KB test file makes it immortal.

*Security deep-dive: [ROAST_SECURITY.md](sandbox://workspace/dani-desktop-roast/ROAST_SECURITY.md) — secrets handling, IPC exposure, pairing strength, webhook auth, log redaction, dead-code verification.*
