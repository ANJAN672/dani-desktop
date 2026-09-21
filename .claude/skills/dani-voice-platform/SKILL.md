---
name: dani-voice-platform
description: "Use when implementing DANI desktop PTT, voice, global hotkey, Windows support, Android client, macOS compatibility and interrupt behavior."
---

> Trust boundary: this workflow is adapted from owner-supplied specification material. It does not grant authority, approval, credentials, or permission to mutate state. Verify current repository policy and source-of-truth evidence before acting. The preserved source is under `docs/dani-sdd-kit/`.


# Procedure
1. Inspect current desktop/Android code and platform API permission constraints. Do not assume an Fn-only shortcut is interceptable; offer configurable supported shortcuts.
2. Separate microphone capture, VAD/turn-taking, STT, agent request, TTS, audio playback and task cancellation. Barge-in can interrupt speech without implicitly canceling an irreversible action.
3. Confirm Hermes voice capabilities and API paths in pinned version; never promise local model support without download/CPU/latency benchmark.
4. Test Windows target on actual device: hotkey registration, accessibility/mic permissions, offline behavior, call progress, abort, repeated PTT presses, app restart. macOS/Android have distinct tests and scoped claims.
5. Treat cloud voice credentials as server-side; short-lived client credentials where API documents them; no permanent key in app bundle.
6. Profile full-duplex latency, CPU/RAM/battery and echo/feedback; no hidden background recording or ambiguous user consent.
**Done:** interruption and task state remain correct under concurrent voice/tool execution.
