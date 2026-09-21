# Dani Bot (dani-desktop v0.1.55, prod branch) — Feature Inventory

Derived from the actual source: `src/` (React renderer), `electron/` (main process, IPC), `server/` (Node harness on 127.0.0.1), `shared/`, `docs/`. Ordered the way a user meets them on first launch. Nothing here was run — this is read-only source analysis.

## 1. First launch: onboarding gate

- `src/App.tsx` renders an `<Onboarding>` overlay until `emailGateDone()` passes (`src/lib/analytics.ts:113`).
- Step 0 — profile capture (`src/components/Onboarding.tsx:196`): name + email, "Bots that do real work on their own computer. Tell us who you are and we'll let you know when big things ship." Has a "Maybe later" skip.
- Step 1 — "Your engines": auto-detects AI CLIs installed on the machine (`claude`, `codex`, `grok`, …), shown as Ready tiles two-across (`Onboarding.tsx:243`).
- Step 2 — dictation setup, only if the platform reports dictation capability (`Onboarding.tsx:156`).
- If no engine CLI is found anywhere, the main view degrades to a `<NoEngines>` empty state (`src/components/NoEngines.tsx`).

## 2. Main shell

- Telegram-style three-pane layout: sidebar (left), chat/room (center), slide-over panels (right).
- `window.dani` preload API bridges renderer ↔ main process; unread badge count syncs to the OS dock (`src/App.tsx`).
- Update banner (`UpdateBanner`) for the auto-updater (`scripts/bundle-updater.mjs`).
- About dialog (`AboutDialog.tsx`): version, platform, "Made by Dani", GitHub/Docs/Releases/License links.
- 9 locales (`src/locales`: de, en, es, fr, hi, ja, pt-br, zh) with a locale-hash check script (`i18n:check`).
- Skin/theme picker (`SkinPicker`) + a contrast-check script (`check:contrast`).

## 3. Sidebar

- `src/components/Sidebar.tsx` (1809 lines): bot list with animated mascot avatars (`MausAvatar`/`Avatar.tsx` — hand-drawn face engine with moods like "happy"), per-bot unread counts, section headers, search, profile menu, phone button (companion pairing), "more" menu, popover menus.
- Command palette (Ctrl/Cmd+K, `CommandPalette.tsx`): quick-switcher over bots, group rooms, and debounced full-text message search (`/api/search`) — not a command runner.

## 4. Bots (per-bot chat rooms)

- `ChatView.tsx` (1438 lines): message thread, markdown rendering (`ChatMarkdown`), reply quotes (`ReplyQuote`), message editing, find-in-chat bar (`ChatFindBar`), working indicator, turn-narration run view, activity runs (`ActivityRun`).
- `Composer.tsx` (1032 lines): text input with attachments (images/files, `ComposerAttachments`/`AttachmentPreview`), queued messages sent while the bot is busy (`ComposerQueuedMessages`), message drafts persisted per thread (`src/lib/drafts.ts`), slash/composer commands (`composer-commands.ts`), dictation input.
- Bot management: create, duplicate, delete (with deletion-pending state), rename thread titles, `BotPickerList`, per-bot avatar card (`BotProfileAvatarCard`), custom bot instructions dialog (`BotInstructionsDialog` — user-editable system prompt).

## 5. Model picker (the honest part)

- `ModelPicker.tsx` + engine rail: switch a bot's model mid-conversation. Providers shown side by side — Claude, Codex, Grok, Gemini, Kimi, Droid, Cursor, OpenCode, Qwen, Hermes, Pi, Minimax, Antigravity, OpenAI-compatible (OpenRouter/Groq) — with defaults marked and unavailable providers dimmed *with the reason* (`server/drivers/builtIn.ts`, catalog `*-catalog.ts` files).
- Custom CLI binaries / wrapper CLIs per engine in Settings → Engines (`EngineSetup.tsx`, `EnginesSettings.tsx`).

## 6. Approvals: bots ask before they act

- Inline approval cards in chat (`ApprovalCard.tsx`): Allow / Deny for shell commands, file edits; question cards with option buttons (`OptionCard`); secret-request cards (`SecretRequestCard` — "Stored securely by Dani Bot and never added to chat").
- `ApprovalModeSelector.tsx`: per-bot approval mode (Ask etc.), `FullAccessWarning`, trusted-mode handling (`electron/approval-trusted-mode.cjs`).

## 7. Every bot gets a computer

- `ComputerPanel.tsx` (1645 lines): per-bot computer backends —
  - **Cloud Linux desktop** (VPS: `server/vps-computer.ts`, container: `server/container-computer.ts`) with live screen preview (`CloudScreenPreview`, `LocalScreenPreview`), "Open desktop" in a sandboxed viewer window (`desktop-viewer`), screenshot streaming (`screen:frame` IPC).
  - **Local VM workspace** (`LocalVmWorkspace` full-screen view).
  - **This computer**: host control on macOS and Ubuntu Xorg after explicit opt-in (`MacLocalControl`, `LinuxLocalControl`, `LocalComputerSection`); Ubuntu Wayland host control disabled (README cites issue #345).
  - **Browser workspace** (`BrowserWorkspace`, `BrowserPanel`): per-bot Chromium surface with profiles, navigation controls, human-control handoff toggle (`browser:set-human-control`), profile deletion with block reasons.
- Computer-use backends include CUA (`electron/cua*.cjs`, `scripts/prepare-cua.mjs`) and browser "webcmd" eval (`docs/browser-webcmd.md`).

## 8. Voice

- **Voice calls with a bot**: `CallView.tsx` (1:1) and `GroupCallView.tsx` (group rooms). Full-duplex voice path (`src/lib/duplex-voice.ts`); half-duplex fallback closes capture to avoid feedback.
- **Live-call providers** (`src/lib/live-call-provider.ts`): `"local"` or `"openai-realtime"` (WebRTC/SDP exchange).
- **Dictation**: AssemblyAI transcription (`src/lib/assemblyai-transcription.ts`, `electron/assemblyai.mjs`).
- **Spoken replies**: `SpeakButton`, TTS via ElevenLabs (needs key) or macOS system voices (`server/tts/`: `elevenlabs.ts`, `system-voices.ts`); per-bot voice profile + autoplay toggle (`VoiceSettings.tsx`); `/api/tts/*` routes; `TranscriptionSettings.tsx`; `speech:start/stop/finish` IPC.

## 9. Memory

- `server/memory-sidecar.ts`: per-owner SQLite memory store (WAL mode) with FTS5 full-text search, memory kinds (profile, project, person, recap, fact, procedure), categories (user/workflow), lifecycle statuses (active, superseded, retracted, expired), confidence scores, provenance records, version history.
- Deterministic memory reconciliation pass (`5d2a09d` "test: deterministic memory reconciliation and Windows-safe cleanup", `server/testing/`).
- `InspectorPanel.tsx`: peek at a bot's internals (tools, context, runs).

## 10. Routines (scheduled work)

- `RoutinesPage` / `RoutineCalendarPage.tsx` (1596 lines): calendar view of scheduled routines, routine run cards, run/seen/interrupt/delete actions (`server/routines.ts`, 51KB).

## 11. Groups (multi-bot rooms)

- `GroupView.tsx`: rooms with multiple bots, group tasks (`newGroupTask`, task switching), group goal runs (`GoalRunCard`, `server/group-goal-run.e2e.test.ts`), group calls, member management (`ManageMembersPanel`), room turn timeouts (`RoomTurnTimeoutSettings`).

## 12. Team map & team library

- `TeamMapPage.tsx`: visual map of the bot team.
- `TeamLibraryPanel`: export/import bot teams (`/api/teams/export`, `/api/teams/import`), team scout directory, GitHub team catalog (`/api/team-library/github`).

## 13. Skill recorder (experimental)

- `SkillRecorderPage.tsx`: record screen + mic (`skill-recorder:start/stop/save` IPC, `electron/build-recorder-helper.mjs`) to author new agent skills; skills live in `skills/` (`create-verification-skill`, `dani-engineering`, `dani-goal-audit`, `phone-harness`) and `server/skills.ts` (54KB).

## 14. Connected apps & MCP

- `PluginsPanel.tsx` (810 lines): one-click marketplace over Composio Sessions — Gmail, Slack, GitHub, Notion, Linear and "hundreds more"; OAuth once, every bot gets them as tools. Account alias handling, disconnect confirmations.
- `McpServersPanel.tsx`: custom MCP servers, registry with reserved-name protection (`server/mcp-registry.ts`).

## 15. Webhooks

- `WebhooksPanel.tsx` (398 lines): inbound webhooks per bot (`server/webhooks.ts`), attempt history.

## 16. App settings modal (`SettingsModal.tsx`)

- **General**: profile name/email, skin/theme, analytics opt-out, update channel.
- **Experimental**: skill recorder, browser profiles, feature flags (`src/lib/feature-flags.ts`).
- **Connections**: API keys (`ApiKeys.tsx` — rows for box, opencodeGo, composio, xai, VPS…), connectors.
- **Engines**: provider CLIs, custom engine binaries.
- **Remote access (companion)**: `CompanionSection.tsx` — pair a phone (`src/pair/PairPage.tsx`, `companion-pairing.ts`), Tailscale refresh, allow cloud desktop from device, revoke devices; companion account with email-code sign-in (`companion-account-service.mjs`).
- **Local VM**: container/VM management (`LocalComputerSection`, Docker/Podman inventory).
- **Usage**: token/cost tracking per bot (`UsageSection`, `Coins` icon).

## 17. Per-bot settings panel (`SettingsPanel.tsx`, 1121 lines)

Persona/instructions, model, computer backend, voice profile, approval mode, room turn timeouts, transcription — plus a remote-client variant (`RemoteAgentSettingsPanel`).

## 18. Remote access / companion apps

- `companion/` (Node service, mDNS discovery, Tailscale) + native `ios/` and `android/` apps: view/control the desktop remotely, cloud-desktop viewing, keep-awake. Pairing via short code (`/api/auth/pair`, `POST` JSON-only to block CSRF-style form planting — see `server/index.ts` comment).

## 19. Harness server surface (for completeness)

- Raw `node:http` server (`server/index.ts`, ~580KB, hand-rolled routing via ~168 `method ===` checks): `/api/bots`, `/api/groups`, `/api/routines`, `/api/internal/*` (agent-to-agent: ask-bot, delegate-bot, post-to-room, routine-requests, skills, session-search), `/api/computers/*`, `/api/local-computer/*`, `/api/live-call/session`, `/api/tts/*`, `/api/events` (SSE stream), `/api/auth/*`, `/api/connectors/*`, `/api/mcp/servers`, `/api/team-*`, `/api/testing/internal-capability`. Auth: loopback owner or paired session with scopes (`server/request-auth.ts`); `.well-known/danibot/environment` descriptor.
- 60 `ipcMain.handle` channels in `electron/main.mjs`, most wrapped in `localOnly(...)` (local-origin gate).

## 20. Docs & extras

- `docs/` (38MB): architecture ADRs, per-integration docs (composio, computer-use, cursor, custom-engines, custom-mcp, mcp-server, byo-vps, linux-desktop, self-hosting, packaging, ci-cd, releasing), `month-one-report.md`, `dani-sdd-kit` (spec-driven dev), `plans/`, `handoff/`, screenshots.
- `cloudflare/`: `control-plane` (remote account/managed endpoints) and `composio-broker` workers — the cloud half of the "local-first" story.
- `enterprise/`, `deploy/`, `Dockerfile`: packaging/enterprise surface.
