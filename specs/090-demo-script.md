# 090 - Investor demo script and gate

Source: founder directive 2026-09-21 ("a real flow, zero mocks - the thing
investors actually watch") + issue #14's honest-demo scope. Phase P6. NEW SPEC.

## Status ledger

- Done: nothing landed.
- Remaining: this entire spec.

## The demo path (scripted, every step with an expected observable)

1. **Cold open.** Launch the installed app from first-run state. Expected: the
   truthful setup wizard (spec 080), no mocks, no fake status.
2. **A real task in text.** Give the bot a genuine browser/computer task.
   Expected: Hermes proposes, the kernel admits a durable job, progress streams.
3. **The approval beat.** The task hits an irreversible step. Expected: a clear
   approval card; on approve, the effect executes exactly once and evidence is
   recorded.
4. **The voice beat.** Open a call: talk naturally, barge in mid-answer, hear
   the revised streamed answer. Expected: real mic, real interruption, real
   streaming, sustained two-way (spec 050; shown only if fully gated).
5. **The proactive beat.** A genuine trigger fires with no user input.
   Expected: the agent initiates a suggestion with its reason; on accept it
   runs the full approve -> execute -> evidence loop and reports back on its
   own (spec 060).
6. **The interruption beat.** Cancel a running job. Expected: immediate stop,
   cancelled terminal state, no stale revival.
7. **The crash beat.** Kill the app mid-job and relaunch. Expected: recovery
   reconciles, no duplicate effect, truthful uncertain/completed states.
8. **The evidence close.** Open diagnostics. Expected: redacted, inspectable
   evidence trail request -> job -> effect -> approval -> evidence with a
   correlation ID.

## Hard rules

- Zero mocks. Every beat runs on the production binary and production API path.
- Voice appears only if spec 050 is fully gated; otherwise it is labeled
  unavailable on screen and skipped - never faked (spec 050 investor demo rule).
- Provider for the demo: an explicitly selected free/local or budget-capped
  provider, per issue #14's honest-demo scope.
- Not demoed (per #14): background autonomy beyond spec 060's approved scope,
  multi-agent delegation, local duplex voice, unsupported platforms, anything
  mobile (parked).

## Acceptance criteria (binary)

- [ ] A written runbook exists: machine setup checklist, data-reset procedure,
      per-beat script with expected observables, timing, and a failure playbook
      (what to do live when a beat fails).
- [ ] 20 consecutive clean-room runs of the full demo path pass across the
      target OSes with zero duplicate effects (aligns with issue #14).
- [ ] Two complete end-to-end rehearsals recorded and reviewed; every observed
      glitch either fixed or scripted around with an honest fallback.
- [ ] Every on-screen status shown during the demo traces to live verification
      (spec 040), confirmed by walking the script with network/provider faults
      injected.
- [ ] Demo data reset is one command and verified between runs.

## Test gates

The 20-run clean-room gate is the gate. Supporting: fault-injection walkthrough,
reset-script verification, rehearsal recordings archived with the runbook.

## Non-goals

- Not a marketing video; no edited footage substitutes for a live-capable path.
- No new product features - this spec composes specs 030/040/050/060/080.

## Dependencies

P2 (kernel), P3 (voice, or its labeled-unavailable fallback), P4 (proactive),
P5 (truthful status + picker), spec 080 (first-run state the demo opens with).
