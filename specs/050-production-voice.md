# 050 - Production voice through the durable turn path

Source: https://github.com/somdipto/dani-desktop/issues/13 (EPIC 5/6). Phase P3.
Workstream: ACTIVE (slices 1-2 landed in unified prod `bdb92da`). This is the investor-demo centerpiece.

Experience bar (founder's words): exactly like Hermes real-time talk - full-duplex,
interruptible. No hard-coded demo behavior, no mocked paths presented as real.
Proof means actual mic input, actual interruption, actual streaming output through
the real app.

## Status ledger

- Done: slice 1 `b11ef92` landed the provider-neutral generation-fenced call
  state machine and durable turn bridge contract. Slice 2 `bdb92da` landed the
  real OpenAI Realtime WebRTC media adapter with ephemeral-token SDP exchange,
  microphone tracks, transcript item-ID dedupe, barge-in transport cancellation,
  reconnect fencing, and typed network errors. Existing serving assets include
  `CallView` and `/api/live-call/session`; end-to-end kernel mounting remains.
- Active build sequence (voice workstream, 2026-09-21):
  1. Provider-neutral call state machine: generation fence, typed errors,
     utterance IDs, teardown contract. Mount only the existing product
     `CallView` through it; duplicate realtime surfaces removed or made
     non-serving.
  2. OpenAI Realtime WebRTC transport: server-minted short-lived credential
     only, real `getUserMedia` tracks, data-channel event parsing, remote audio,
     deterministic teardown, reconnect generation fences, actionable
     device/network/provider errors.
  3. Kernel bridge: each committed final utterance enters the durable kernel
     TurnService keyed `callId + utteranceId`, persists through the ordinary
     message repository, streams ordinary progress/tool/approval/final events
     back to call commentary.
  4. Barge-in: same durable cancel generation as text interrupt + Realtime
     response cancel/audio clear; stale callbacks rejected; conservative
     approval-ID-bound spoken yes/no.
  5. Duration/cost/privacy UI, redacted metrics, hardware acceptance
     harness/runbook: real macOS/Windows/Linux mic, speaker/headphones, echo,
     silence, reconnect, 50-cycle leak, text-turn regression gates.
- Reference contracts (current OpenAI docs):
  https://developers.openai.com/api/docs/guides/realtime-webrtc and
  https://developers.openai.com/api/docs/guides/realtime-server-controls

## Requirements (architecture, from issue #13)

R1. One provider-neutral call state machine with generation fencing:
    `idle -> connecting -> listening/speaking/thinking -> reconnecting ->
    ended/error`.
R2. Transport adapters own media only. OpenAI WebRTC first; local STT/TTS is a
    separate later adapter.
R3. Server mints short-lived credentials; long-lived keys never enter renderer
    state.
R4. A final utterance becomes a normal idempotent TurnService request keyed
    `callId + utteranceId` (rides spec 030's kernel).
R5. Normal tool/progress/approval/final events feed call context/commentary.
R6. Barge-in invokes the same durable cancellation generation as text interrupt.
R7. Spoken approval accepted only for a specific pending approval ID with
    conservative whole-utterance grammar; ambiguous speech never grants
    authority.
R8. Transcript persistence uses ordinary message APIs/repository - no parallel
    call log.
R9. Sideband/server control enforces tools, policy, spend/time caps,
    observability.
R10. Parked by the founder: domain changes, mobile-to-cloud/mobile-to-desktop
    connection work. Desktop-local voice only.

## Acceptance criteria (binary; from issue #13)

- [ ] One and only one product call UI/state machine is mounted.
- [ ] Real final speech produces exactly one normal persisted user message and
      ordinary provider/Hermes turn.
- [ ] Tool/progress/approval/final events appear in the call without bypassing
      the durable server path.
- [ ] Barge-in stops active provider/tool work; stale callbacks cannot revive it.
- [ ] Spoken yes/no handles only the current approval; ambiguous phrases
      deny/defer rather than approve.
- [ ] Reconnect cannot duplicate a delegation or transcript.
- [ ] Permission denied, no device, busy device, network loss, expired
      credential, provider error and unsupported mode are actionable.
- [ ] 50 repeated open/speak/interrupt/hangup cycles per claimed platform leak
      no microphone, audio track, peer connection, timer, process, session or
      queued work.
- [ ] Real physical-device matrix covers echo, headphones/speaker, silence/VAD,
      interruption and cleanup.
- [ ] Ordinary text turns remain intact during and after call failures.
- [ ] Latency, failure and cost metrics captured with redaction.
- [ ] No acoustic/platform claim is made from mocks/unit tests alone.

## Test gates

Per-package: unit/contract tests, typecheck, lint, Gauntlet critic (attack
handshake races, stale callbacks after cancel, reconnect duplication, timeout
paths, teardown leaks). Package 5: physical-hardware matrix on macOS (both
architectures), Windows, Linux; 50-cycle leak run per platform; text-turn
regression gate.

## Investor demo rule (hard)

If this spec is not fully gated, voice ships disabled or labeled unavailable.
Never a demo-only call path. Voice is demonstrated only when the same production
binary/API path passes real session and hardware acceptance.

## Non-goals

- Local Whisper/Kokoro mode stays disabled until packaged native assets execute
  offline on every claimed platform and licensing is documented.
- No mobile/cloud connection work (parked).

## Dependencies

Spec 030 kernel gates (P2) for the durable turn path; spec 010 for credential
handling; spec 020 seam for mounting.
