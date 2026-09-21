# 000 - Master Plan: the single-shot recovery

This is the one plan that fixes everything. It sequences every spec in this kit into
phases with hard dependencies and a binary "done" per phase. Specs execute in parallel
where the dependency graph allows; phases integrate in strict order.

## North star

An investor-demoable Dani Bot desktop app where:

1. **Full-duplex voice** works exactly like Hermes real-time talk: real mic in,
   barge-in, streaming out, sustained two-way conversation (spec 050).
2. **The agent is proactive**: it initiates - notices, suggests, acts - not just
   answers (spec 060).
3. **Hermes is the only harness**, running through the crash-safe Dani kernel:
   durable jobs, approvals, idempotent effects, cancellation, restart recovery,
   evidence (spec 030).
4. **The user picks a model, never a harness.** Harness selection UI is gone (spec 070).
5. **Nothing in the demo is faked**: truthful status everywhere, zero mocks, a real
   scripted flow on the production binary (specs 040, 090).

## Where we are (2026-09-21)

Unified prod candidate `bdb92da` (base remote prod `b87d7d4`) contains rebrand
slices 1-6, the Electron gate fix, typed auth/pairing and voice routes, kernel
slices 1-5, the model-only Hermes product picker, and voice slices 1-2.

The cumulative gate is green: the full root Vitest corpus was sharded to fit the
runner cap (300 files, 3,362 passed, 9 skipped, 1 todo, 0 failed), typecheck passed,
lint reported 0 errors and 38 inherited warnings, Electron passed 137/0/0, and
diff/fsck/bundle verification passed. The next integration step is mounting
`DaniExecutionKernel` at the stable typed application seam in `server/index.ts`.

## The phase map

| Phase | Name | Specs | Depends on |
| --- | --- | --- | --- |
| P0 | Consolidate the baseline | repo hygiene | - |
| P1 | Security stop line + typed serving core | 010, 020 | P0 |
| P2 | Kernel completion on the serving path | 030 | P0, P1 seam |
| P3 | Production voice | 050 | P2 |
| P4 | Proactive experience | 060 | P2 |
| P5 | Truthful providers + model-only picker | 040, 070 | P1 |
| P6 | First-run install + demo script + demo gate | 080, 090 | P3, P4, P5 |
| P7 | Signed, staged releases | 100 | P6 |

Parallel execution map (how the work is actually staffed):

- **W1 - serving + security track:** P1. Route-family extraction and the security
  boundaries proceed family by family while other tracks build additively.
- **W2 - kernel track:** kernel slices 1-5 are LANDED; P2 mounts and finishes them.
- **W3 - voice track:** ACTIVE now, building additively against the kernel contract;
  mounts onto the durable turn path the moment P2 lands.
- **W4 - product UX track:** P5 and P6 items are independent of W2/W3 until the demo
  gate.

## Phase definitions and what "done" means

### P0 - Consolidate the baseline

Kernel slices 1-5 and rebrand slices 5-6 are merged in `bdb92da`; P0 now tracks only follow-up baseline hygiene and tracker publication.

Done means:
- One unified prod history contains rebrand 1-6, the gate fix, typed routes, and
  kernel slices 1-5. (Satisfied by `bdb92da`.)
- The full repo test suite runs to completion on the unified candidate (raise or
  shard past the 120s cap; a capped run is not a green run), plus typecheck, lint,
  and the Electron suite (137/0/0).
- Tracker #15 records every merge with commit, bundle hash, and validation.

### P1 - Security stop line + typed serving core

Specs 010 and 020, through the seam the kernel and voice need: route inventory,
router/auth/error/schema infrastructure, per-launch owner capability on every
mutation route, renderer sandboxing, SecretStore, and the low-risk route families
extracted. Remaining families continue inside this phase until 020 is fully green.

Done means: every acceptance criterion in specs 010 and 020 is true.

### P2 - Kernel completion on the serving path

Spec 030. Mount the built kernel behind the typed serving layer, deliver the
installed-app vertical slice, and pass the packaged recovery gates.

Done means: every acceptance criterion in spec 030 is true, including 20 consecutive
clean-profile packaged runs of the vertical slice with zero duplicate effects.

### P3 - Production voice

Spec 050. The active voice workstream's five work packages, mounted on the durable
kernel turn path.

Done means: every acceptance criterion in spec 050 is true, including the 50-cycle
leak test and the physical-hardware matrix per claimed platform. If any criterion is
not met, voice ships disabled or labeled unavailable - never a demo-only call path.

### P4 - Proactive experience

Spec 060. Proposals, triggers, quiet hours, and proactive reporting through the same
kernel ledgers as user turns.

Done means: every acceptance criterion in spec 060 is true. This phase cannot start
before P2 is green (kernel gates are the foundation; issue #11's non-goals say so).

### P5 - Truthful providers + model-only picker

Specs 040 and 070. The connectivity state model, migration fixes, and the removal of
all harness-selection UI.

Done means: every acceptance criterion in specs 040 and 070 is true.

### P6 - First-run install + demo script + demo gate

Specs 080 and 090. The one-command install, the scripted zero-mock demo, and the
gate that proves it.

Done means: 20 consecutive clean-room runs of the full demo path pass across the
target OSes with zero duplicate effects, plus two recorded end-to-end rehearsals.

### P7 - Signed, staged releases

Spec 100. Provenance, signing/notarization, installed-artifact matrix, observability,
staged rollout, rollback.

Done means: every acceptance criterion in spec 100 is true. Scheduled after the demo
gate; specified now so nothing built earlier contradicts it.

## Single-shot integration order

When slices are ready, they merge in this exact order; each step reruns the full
matrix before the next:

1. Rebrand 5, rebrand 6 (docs/Dockerfile only; parked items stay out).
2. Kernel 1 -> 2 -> 3 -> 4 (prerequisite chain already verified).
3. Full-matrix green run = end of P0.
4. Security slices (010) interleaved with serving-path families (020), one family
   per PR, until both specs are green = end of P1.
5. Kernel mount + vertical slice + packaged gates (030) = end of P2.
6. Voice packages 1-5 (050) = end of P3.
7. Proactive slices (060) = end of P4.
8. Truthful providers + picker removal (040, 070) = end of P5.
9. First-run + demo script, then the demo gate (080, 090) = end of P6.
10. Release system (100) = end of P7.

## Risk register

- **Full-suite cap (open):** vitest exceeds the 120s execution cap. Owner: P0.
  Fix by sharding/raising the limit; never claim green from a capped run.
- **No push route (open):** delivery is git bundles; a user-side engineer imports and
  pushes. Every slice records commit, bundle SHA-256, and prerequisite in #15.
- **Hardware matrix availability (open):** spec 050 needs physical macOS (both
  architectures), Windows, and Linux devices with mics. Line up devices before P3.
- **Hermes provenance (open):** version/protocol/license must be pinned, documented,
  and contract-tested (spec 030 gate). Do this at mount time, not after.
- **Voice timeline (watch):** voice is the demo centerpiece and has the most hardware
  risk. The investor demo rule in spec 050 is the fallback: ungated voice means
  labeled-unavailable voice, never a fake.

## Parked by the founder (referenced, never scheduled)

- Domain migration (danlab.dev subdomains, Cloudflare tunnels).
- Mobile-to-cloud and mobile-to-desktop connection work.
- Rebrand items in parked tracks: android, ios, cloudflare/enterprise/SBOM, dani-web.

## Future, not scheduled

- **Laya** shadow test (intent class, tool family, needs-human-review) against the
  Hermes-only baseline, per the settled architecture decision. Laya is not in the
  current build and stays out of the V1 critical path.
- Versioned memory sidecar (append-only event log + derived records).
- Local Whisper/Kokoro native runtimes (voice stays disabled for local mode until
  packaged native assets execute offline on every claimed platform).
- Android beyond debug APK; promotion of `prod` to `main` (founder's call).

## Traceability

| Spec | Title | Source | Phase |
| --- | --- | --- | --- |
| 010 | Security stop line | issue #9 | P1 |
| 020 | Typed serving path | issue #10 | P1 |
| 030 | Crash-safe execution kernel | issue #11 | P2 |
| 040 | Truthful providers | issue #12 | P5 |
| 050 | Production voice | issue #13 | P3 |
| 060 | Proactive experience | new (founder directive 2026-09-21) | P4 |
| 070 | Model-only picker | new (founder directive 2026-09-21) | P5 |
| 080 | First-run install | new (founder directive 2026-09-21) | P6 |
| 090 | Demo script and gate | new (founder directive 2026-09-21) + issue #14 honest-demo scope | P6 |
| 100 | Signed staged releases | issue #14 | P7 |
