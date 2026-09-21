# Duplex voice verification status

This page records what is implemented and what still needs platform proof. It is not a completion claim.

## Implemented and covered by portable tests

- Browser microphone request asks for acoustic echo cancellation, noise suppression, automatic gain control, and mono capture.
- One call keeps capture open across generation and playback.
- Final STT and VAD silence cannot submit the same utterance twice.
- Audio chunks are played serially, providing bounded backpressure.
- Speech during generation or playback aborts the local turn, stops playback, and asks the harness to interrupt the Hermes turn.
- Reconnect retries are bounded and abortable.
- The optional OpenAI Realtime path accepts session material only from a configured credential-free HTTPS OAuth proxy. The renderer never receives a long-lived provider credential.
- Whisper and Kokoro model files have pinned sizes and SHA-256 digests in `server/speech-model-bundle.ts`.

## Not yet verified

- No native Whisper or Kokoro inference executable is wired into the packaged app. Pinned model payloads alone are not a runtime.
- `CallView` still uses the existing macOS half-duplex helper and existing voice output. The new controller is not on the live UI path.
- Windows, macOS, and Linux microphone permissions, device changes, suspend/resume, acoustic echo cancellation, and output-device behavior need real-device evidence.
- OpenAI Realtime needs a real OAuth proxy integration test and a configured account. Unit tests use a fake HTTPS response.
- UI screenshots are required after the live path is wired.

A PR must not describe end-to-end duplex voice as complete until every item above has passing evidence.

## Real proxy readiness command

Run `pnpm e2e:realtime-proxy` on a machine whose Dani config contains the production `liveCall.proxyUrl`, or set `DANI_REALTIME_PROXY_URL`. The command has no local fallback and contacts that HTTPS service to mint real short-lived session material. It reports that WebRTC was not exercised because the CLI has no browser microphone. Use the physical hardware checklist for the subsequent real microphone, SDP, data-channel, and transcription run; do not cite the proxy probe as acoustic evidence.
