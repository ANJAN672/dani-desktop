# 100 - Laya bounded decision service

Source: issue #17 P0D ("Real Laya local service and bounded CUA acceleration"),
founder directive 2026-09-22 ("go all out"). Owner design target: small/fast
tasks go to Laya + the CUA driver, big tasks stay on Hermes; the Dani runtime
routes. Honest architecture from the 2026-09-22 audit: Laya scores bounded
candidate actions, CUA executes - Laya does not do computer use itself.
Hermes remains authoritative until the owner says otherwise.

## Status ledger

- Done (slice 1): checkpoint research and pin (below). The model is real:
  `convaiinnovations/laya` on Hugging Face, Apache-2.0, three checkpoints,
  published Python SDK (`laya` on PyPI). No substitute model needed.
- Remaining: R1-R8 (slices 2-4).

## Slice 1: checkpoint pin and license evidence

All facts below were fetched live on 2026-09-22 (IST) from the sources cited.
Model risk note: the checkpoint family is days old (initial HF release
2026-09-19/20, 7 commits at pin time). Every benchmark number on the model
card is self-published by the vendor; treat them as claims, not evidence of
DANI routing accuracy (per the laya-evaluation skill).

- Hub repo: https://huggingface.co/convaiinnovations/laya
- Pinned revision (main): `1c5edc17a7acd8701df6fc341c0d179f1c62c982`
  (repo lastModified 2026-09-20T01:43:36Z, via HF API
  https://huggingface.co/api/models/convaiinnovations/laya)
- License: Apache-2.0 (model card `license: apache-2.0`; PyPI package metadata
  also Apache-2.0). Commercial use permitted. Vendor: ConvAI Innovations.
- SDK: PyPI `laya` 0.3.5 (wheel sha256
  `4c57f64cbaf893bb5c7b4affddc2bf21a819f55df51941689f11868583be2903`;
  sdist sha256 `5e8a4c2b38dbddc0febe7443f26f74fd9d7571fb172648b1481830c667d59219`).
  Requires `torch>=2.0.0`, `transformers>=4.48.0`, `safetensors>=0.4.0`,
  `huggingface_hub>=0.20.0`, `numpy>=1.20.0`.
- Vendor source mirrors: https://github.com/NandhaKishorM/laya,
  live demo space https://huggingface.co/spaces/convaiinnovations/laya-demo.

### Checkpoints in the pinned revision

| Checkpoint (subfolder) | Encoder | Params | Context | Weights file | Bytes | Weights sha256 (LFS) |
| --- | --- | --- | --- | --- | --- | --- |
| root (English) | ModernBERT-large | 421M | 512 | `model.safetensors` | 842,609,210 | `891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c` |
| `multilingual` | mmBERT-base | 322M | 1024 (8k max) | `multilingual/model.safetensors` | 643,835,514 | `9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204` |
| `typed-decisions` | ModernBERT-large | 421M | 1024 | `typed-decisions/model.safetensors` | 842,609,220 | `4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e` |

Supporting files at the pinned revision (git blob sha): `rl_agent_config.json`
`3e4fcbf12cf36164ce18a1398aa9f35f58375ae0`,
`typed-decisions/rl_agent_config.json` `5f0e1d5f2366fe8ba2ff330dffaeed53b469e97e`,
`multilingual/rl_agent_config.json` `00e35f88bb731bb9126a914666ab1cdac8a204c8`,
`tokenizer/tokenizer.json` `2f4d8583e507b7466d2490e2d6c045647a822698` (root and
typed-decisions share it), `multilingual/tokenizer/tokenizer.json` LFS sha256
`609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f`,
`encoder/config.json` `5881ba831f2db5ce0f606bbaa1f2668e1e6cb706`,
`typed-decisions/encoder/config.json` `d4be4829750fb04c0aa8b9897c3ea827f76c0109`.

Default DANI checkpoint: `typed-decisions` (1024-token context, trained for
the typed-decision workflows the DecisionProvider contract uses). The English
root and multilingual checkpoints stay pinned for later multilingual routing
work; the vendor Router auto-selects per input script.

### Actual API (verified against the card and in-repo `rl_agent_api.py`)

```python
import laya
agent = laya.load("convaiinnovations/laya", subfolder="typed-decisions")
result = agent.predict(state, questions)   # one forward pass for all questions
```

- `state`: dict or text (email, ticket, JSON document).
- `questions`: `{id: {"type": "choice"|"score"|"noul", "instructions": str,
  "criteria": {option: description} | [ordinal labels]}}`.
- Answers carry per-option `probabilities`, `confidence`, and
  `rl_agent.act_probability` (the model's own act-vs-escalate head) - the
  natural abstention signal for the contract's NONE/ABSTAIN path.
- Question types: `choice` (softmax over caller-defined options), `score`
  (ordinal expectation), `noul` (probability). No text is ever generated.
- Known operational notes from the vendor: run with `USE_TF=0` (transformers
  TF probe can deadlock model construction); cold load is multi-second, warm
  GPU inference ~33-40 ms, warm CPU 193-464 ms (vendor-measured, T4 and CPU,
  unverified by us); lazy loading with language switches rebuilds the model
  (7.4 s CPU / 10.3 s T4 median) - so the DANI service must keep one resident
  sidecar, never spawn per decision.

## Requirements

R1. **Pinned, verified install.** The exact revision, file sizes and hashes
    above live in a machine-readable manifest in the repo. Downloads are
    lazy, consented (with disk-size disclosure: ~804 MiB for typed-decisions,
    ~614 MiB multilingual, plus the Python runtime), and verified against the
    manifest before first load. No weights ship inside the installer or the
    Electron renderer.
R2. **Versioned DecisionProvider contract.** Request: schema id + version,
    task id, trace id, objective, minimized state summary, enumerated options
    with explicit `NONE_OF_THE_ABOVE`, timeout. Response: per-option scores,
    selected option or null, confidence, act probability, checkpoint identity
    (repo + subfolder + revision + weights sha256), elapsed ms, abstention
    reason, typed failure. Unknown schema/version, malformed scores,
    unrecognized options and expired deadlines are rejected, never guessed.
R3. **Score-only.** The provider returns scores. It cannot authorize,
    dispatch, retry, or execute. The executor re-checks preconditions and
    permissions on every effect. Low confidence, low act probability,
    abstention, timeout, or any typed failure falls back to Hermes.
R4. **One resident sidecar.** Inference runs in a single long-lived Python
    sidecar process owned by the Node server (stdio JSON protocol), spawned
    lazily on first gated use, never per tool call or per subagent. Idle
    unload and crash restart are explicit. GPU is used when present; CPU
    works (slower) and is the honest default claim until measured.
R5. **Default-off rollout gates.** `features.laya` (service), and separate
    gates for shadow scoring and route execution, mirroring
    `features.proactive`: boolean, optional, default off, explicit opt-in.
R6. **Shadow mode first.** With shadow enabled, real admitted jobs are scored
    and logged (SQLite shadow ledger) against the route Hermes actually took.
    Shadow scoring never blocks, delays, or alters the Hermes turn; failures
    are logged and swallowed. Agreement alone is not correctness.
R7. **Routing seam.** A single router decides job size class at admission:
    `bounded_cua` -> Laya-scored bounded CUA controller, `hermes_general` ->
    Hermes, `NONE_OF_THE_ABOVE`/abstain/timeout/error -> Hermes. Execution
    through the seam requires its own gate on top of the service gate;
    without it the router is shadow-only. The bounded CUA controller uses the
    same guarded computer adapter and device lease as Hermes, keeps step and
    wall-clock budgets, and aborts back to Hermes on abstain, OOD, changed
    state, or any verification failure. Candidate actions come from current
    DOM/accessibility/driver state, never from Laya's imagination.
R8. **Honest validation.** No fake tests, no mocked-model green suites.
    Contract validation, gate defaults, manifest integrity, and failure
    mapping are unit-tested. Anything that needs the real checkpoint is
    validated by a recorded smoke run against the real weights, or marked
    UNVERIFIED.

## Exit criteria (mirrors issue #17 P0D)

- Real local Laya inference demonstrably callable in one bounded decision.
- Independent Hermes-only fallback with no mandatory added latency.
- A measured end-to-end win before any execution gate defaults on - or the
  feature stays disabled and unadvertised.

## Slice 2 evidence addendum (2026-09-22)

- **Real download + hash verification: PASS.** The sidecar `download` method
  fetched all five pinned typed-decisions files through `hf_hub_download` at
  the pinned revision; the weights sha256 verified byte-exact against the pin
  (`4fa56de7...a24e`). Repro: sidecar `download` request with the manifest
  file list.
- **Real checkpoint output on the DANI routing schema: PASS (vendor-hosted).**
  The vendor demo space (`convaiinnovations/laya-demo`, `/run_playground`,
  which runs the same pinned family) answered our exact routing question
  shape: a clear one-action request picked the bounded-CUA option (p 0.464 vs
  Hermes 0.146, NONE 0.390, latency 140.5 ms hosted); garbage input
  ("hmm, whatever you think lol") picked NONE_OF_THE_ABOVE (p 0.381).
  Abstention-by-ranking works on this probe. Confidence is normalized
  entropy (1 - H/log k): the clear case scored 0.085, garbage 0.005, and the
  act head returned 1.0 for both, so NONE-ranking is the primary abstain
  signal; confidence thresholds start at 0.02 and must be re-derived from
  shadow-ledger data before any execution gate opens.
- **Local inference in the task sandbox: BLOCKED BY HARDWARE, not by the
  model.** The sandbox has 2 GB RAM; loading the fp32 421M checkpoint
  (~1.7 GB weights + torch runtime) is OOM-killed (exit 137). Download,
  verification, SDK import, and the sidecar protocol all work; a full local
  load+predict run needs a >=4 GB host. Exact repro for target hardware:
  `pip install laya==0.3.5`, then the sidecar `load` + `predict` requests
  against the verified snapshot dir. Target laptops (8-32 GB) clear this
  easily; CPU-only is supported by the SDK with graceful device fallback.

## Slice 3 + 4 landed (2026-09-22)

- R6 shadow wiring: `server/laya/shadow-scorer.ts` adapts the real
  DecisionProvider to the existing SQLite shadow ledger
  (`server/laya-shadow.ts`); `server/index.ts` fire-and-forget shadow-scores
  every admitted Hermes chat turn's route when `features.laya` +
  `features.layaShadow` are on and the checkpoint is installed. It never
  blocks, delays, or alters the turn. Pre-existing fix folded in:
  `laya-shadow.ts` used a TS parameter property that crashes the strip-types
  server; now runtime-safe (this was latent because the module was imported
  nowhere).
- R7 routing seam: `server/laya/router.ts` (DaniTaskRouter) decides
  bounded_cua vs hermes_general at admission with margin and abstain policy
  (7 policy tests). Wired in `server/index.ts` behind `features.layaRouting`.
  The bounded CUA controller is NOT yet wired: a bounded_cua decision logs
  and Hermes keeps the turn. Remaining before the seam can execute: the
  bounded controller itself (state -> enumerated candidates -> Laya score ->
  guarded computer adapter -> verify), hardware-verified CUA loop, and
  shadow-data-derived thresholds.

## Slice 5 landed (2026-09-22): bounded CUA controller

- `server/laya/cua-controller.ts`: the bounded executor behind the router's
  bounded_cua route. Loop: observe real state -> enumerate candidates from
  that state -> Laya scores -> re-observe (state moved = abort) -> act
  through the guarded driver boundary -> verify completion from FRESH state
  (never the action's own report). Budgets: 4 steps / 60 s / per-decision
  timeout, cancellation fence at every step. Every abort returns a truthful
  handoff transcript for Hermes.
- 8 control-loop tests (no-driver refusal, no candidates, abstain,
  state-changed, verified completion, budget exhaustion, typed failure,
  cancellation). Provider and driver boundaries are scripted; no real-model
  or real-hardware claim is made.
- UNVERIFIED: no guarded CuaDriver is bound. The computer proxy's execution
  path is an MCP stdio server (`server/computer-proxy.ts`), not importable
  functions, so a real driver adapter needs either an extracted shared
  execution module or a stdio client; it must enforce the computer-control
  lease ("who is driving") and adapter evidence rules. Until one is
  registered the controller refuses to run and bounded_cua falls back to
  Hermes. End-to-end CUA verification needs real hardware/a real box.

## Slice 6 landed (2026-09-22): guarded driver binding

- `server/laya/proxy-driver.ts`: BoxProxyCuaDriver drives the EXISTING
  computer proxy as a child MCP stdio server - no execution reimplemented.
  The who-is-driving lease (CONTROL_REFUSAL -> CuaLeaseRefused), stale-ref
  rules, act+observe evidence and box wake logic all apply unchanged.
  Candidates are parsed from the proxy's real semantic browser snapshot
  (disabled elements excluded); stateVersion hashes the snapshot; one child
  process is reused per run because semantic refs live in the process.
- Controller: driver errors and lease refusals are typed aborts with a
  truthful Hermes handoff.
- Gated verification surface: POST /api/laya/bots/:id/cua/run requires BOTH
  features.laya and features.layaRouting, a configured cloud box, and an
  objective; it runs one bounded controller run and returns the transcript.
  Chat-turn pipeline integration (a committed bounded_cua route replacing a
  Hermes dispatch) remains the next slice.
- Tests: 3 new tests spawn the REAL proxy against a stub box API/control
  endpoint (candidate parsing, lease refusal on observe+act, honest tool
  failure). UNVERIFIED: no real box driven; local-VM/VPS surfaces (cua MCP,
  not computer-proxy) have no driver yet.

## Slice 7 landed (2026-09-22): settings UI + consented install surface

- Experimental Settings now exposes all four opt-in flags next to the
  existing switches: features.laya, features.layaShadow, features.layaRouting
  (with prerequisite copy) and features.localSpeech. Toggling a laya gate
  rebuilds only the laya stack (closeLayaStack + createLayaStack) - provider
  turns and the kernel are untouched, no restart needed.
- configStatus() now reports proactive + all three laya flags in features.
  (Drive-by fix: features.proactive was already switchable but missing from
  the status payload, so its switch could not render the stored state.)
- Consented checkpoint download: GET /api/laya/status (gated, 404 while the
  service gate is closed) reports installed/install state, sidecar state,
  pinned checkpoint identity (repo, subfolder, revision, apache-2.0, byte
  size) plus background install progress/failure. POST /api/laya/install
  starts ONE background install (202) and is idempotent when installed.
- Settings UI: a "Laya decision model" card appears while features.laya is
  on. It states exactly what will be downloaded (pinned Hugging Face
  checkpoint + pinned PyPI SDK, hash-verified, fully local) with the real
  size in the install button; progress is a polling "Installing..." state,
  failures surface the server error with a retry path.
- Tests: 3 index.test.ts cases (404 while gated off, config feature flags
  include every laya gate + proactive, status surface opens on toggle
  without restart and closes again). UNTESTED: a real install run (needs
  network + ~850MB download; exercise on a real host), the renderer card
  visually, and install progress byte-reporting (the sidecar reports phase
  lines only, so progress is indeterminate by design).
