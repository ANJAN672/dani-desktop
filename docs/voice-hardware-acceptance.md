# Production voice hardware acceptance

This gate must pass on the same packaged build and production API path shipped to users. Unit tests, virtual audio devices, prerecorded clips and a successful SDP exchange do not prove these checks.

## Before testing

- Select OpenAI Live and configure its credential proxy. Confirm the renderer never receives a long-lived OpenAI key.
- Use a real Dani bot backed by Hermes. Keep the conversation visible beside the call so transcript and approval behavior can be checked.
- Record OS, machine, input/output device, headset or speaker mode, app version, call ID, start/end time and any failure. Never record transcript text in diagnostics.
- Run once with built-in speakers and microphone, then with a wired or Bluetooth headset.

## Per-platform matrix

Run every check on macOS Apple Silicon, macOS Intel, Windows x64 and Linux x64 before claiming that platform.

1. **Permission and devices**: deny microphone once, allow it once, start with no input, and start while another app owns the input. Each result must be actionable. No track or permission indicator may remain after hangup.
2. **Real two-way media**: speak an unscripted sentence into the physical microphone. It must appear once in the ordinary chat transcript and produce one Hermes turn. Hear the streamed response on the selected physical output.
3. **Sustained conversation**: complete 10 alternating turns without touching the UI. Verify no duplicated transcript, delegation or response after silence/VAD boundaries.
4. **Barge-in**: interrupt while assistant audio is playing and while Hermes is working. Audio must stop immediately; the durable kernel job must become cancelled; stale provider callbacks must not speak or append a reply.
5. **Approvals**: cause a real approval. Say an exact “yes” and “no” against separate approval IDs. Say “yes, but use another account” and confirm it stays pending. Skill approval must require opening chat for full review.
6. **Echo**: with speakers, place the microphone normally and let a long response play. Provider output must not return as a user transcript. Repeat near maximum usable volume.
7. **Network and credentials**: drop and restore network; expire a call credential; fail the provider. The call must show an actionable state, never duplicate a final utterance, and leave ordinary text chat working.
8. **Cleanup soak**: repeat open, speak, interrupt and hang up 50 times. After each cycle verify zero live local/remote MediaStreamTracks, peer connections, data channels, audio elements with `srcObject`, timers, provider turns, kernel jobs and queued sends owned by the ended call.
9. **Text regression**: after failed and successful calls, send and interrupt ordinary text turns. They must keep their existing idempotency, transcript and approval behavior.

## Pass evidence

Attach the build version and a result row for every matrix item. For acoustic behavior, include a short screen recording showing the physical device and the production call UI. For cleanup, include OS media indicators plus application diagnostics. Mark untested platforms unavailable. Voice is not investor-demo-ready until every advertised platform passes.

## Local runtime preflight

`GET /api/live-call/local/status` reports STT and TTS separately. A model file alone never counts as ready. The preview stays off unless `features.localSpeech` is explicitly true, and still reports unavailable until executable runtime files and all pinned payloads are present. The server accepts 16-bit WAV for `/api/live-call/local/transcribe` and returns WAV from `/api/live-call/local/speak`; physical microphone, speaker, latency, and echo behavior still require this checklist on each target.

Runtime provenance and redistribution notes live in `third_party/local-speech/README.md`. Upstream references: https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.3 and https://github.com/nazdridoy/kokoro-tts/tree/v2.3.2.
