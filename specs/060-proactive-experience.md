# 060 - Proactive agent experience

Source: founder directive 2026-09-21 ("the exact experience as a proactive agent -
the agent initiates: notices, suggests, acts"). Benchmark: Grokbot-style
proactiveness as a general-purpose desktop agent. Phase P4. NEW SPEC - no prior
issue covers this end to end.

## Status ledger

- Done: existing substrate to build on - routines/triggers module (serving path),
  approval cards, kernel ledgers (spec 030 slices 1-5, LANDED).
- Remaining: this entire spec as a serving feature.

## Requirements

R1. **Initiation, not just answers.** The agent produces proposals from real
    triggers: user-defined routines/schedules, time, and observable in-app events.
    Every proposal carries a human-readable reason ("why am I seeing this") and
    its trigger source.
R2. **One proposal per trigger.** Dedupe keys make a fired trigger produce
    exactly one durable proposal across restarts and reconnects.
R3. **Same kernel path.** A proposal the user accepts is admitted as a durable
    kernel job (spec 030): same ledgers, same approval cards, same idempotency,
    same evidence. No second control plane, no shadow autonomy loop.
R4. **Autonomy levels per bot:** `off | suggest-only | act-with-approval`.
    Default: `suggest-only`. There is no act-without-approval level in V1;
    consequential/irreversible actions always pause for an approval card with
    recorded provenance.
R5. **Memory is context, never permission.** Recalled facts can inform a
    proposal; they cannot grant authority to execute.
R6. **Quiet hours and rate limits.** Initiation respects user-set quiet hours
    and a per-bot proposal rate cap; suppressed proposals queue and surface
    after the window with their original reason.
R7. **Visible progress and proactive reporting.** Accepted work reports its own
    progress and completion back to the user (the agent initiates the update),
    with terminal states completed/failed/cancelled/uncertain.
R8. **Interruptible.** Any proactive job can be cancelled by the user at any
    point; cancellation uses the same kernel generation fence.
R9. **Dismiss/snooze.** A proposal can be dismissed or snoozed; the choice is
    durable and respected by future triggers of the same kind.

## Design contract

`Trigger (source, dedupe key, payload) -> Proposal (reason, evidence refs,
expiry) -> [user accept] -> kernel job admission -> approval card if required ->
execution -> adapter evidence -> proactive completion report.`

- Proposals render as first-class cards in the existing chat/thread UI, not a
  separate surface.
- Trigger evaluation runs inside the serving path's routines/triggers module;
  no renderer-side permission decisions.
- All state in the kernel ledgers; renderer is presentation only.

## Acceptance criteria (binary)

- [ ] A fired trigger creates exactly one proposal across kill/restart cycles
      (dedupe test with process kill between fire and persist).
- [ ] In `suggest-only` mode, no effect executes without a user tap - verified
      by attempting execution paths programmatically.
- [ ] Every consequential action shows an approval card before dispatch, with
      approval provenance in the effect ledger.
- [ ] Quiet hours suppress initiation; queued proposals surface after the window
      with reason intact.
- [ ] Every proposal in the UI shows its reason and trigger source.
- [ ] Kill/restart mid-proposal or mid-job produces no duplicate proposal and
      no duplicate effect on recovery.
- [ ] Demo-visible: with zero user input in the session, the agent initiates at
      least one genuine suggestion from a real trigger, and on accept completes
      the full approve -> execute -> evidence -> proactive-report loop.
- [ ] Dismiss/snooze persists and suppresses equivalent future proposals.
- [ ] No proactive trigger fires before spec 030's kernel gates have passed
      (enforced by build-time flag default-off until P2 green).

## Test gates

Unit: dedupe, quiet-hours boundary, rate cap, autonomy-level enforcement.
Integration: trigger -> proposal -> approval -> job -> evidence loop on the real
serving path. Packaged: restart-recovery dedupe, demo-scenario run. Gauntlet
critic attacks: duplicate triggers, restart races, quiet-hours boundary
crossing, permission-escalation attempts via crafted memory/context, stale
proposal acceptance after expiry.

## Non-goals

- No multi-agent delegation, no Laya routing, no background act-without-approval
  autonomy in V1.
- No proactive outbound messaging to external parties (email/DMs) in V1.

## Dependencies

Spec 030 kernel gates (P2) - hard dependency per issue #11 non-goals. Spec 020
routines/triggers family extraction. Spec 040 truthful status for proposal
surfaces that reference provider state.
