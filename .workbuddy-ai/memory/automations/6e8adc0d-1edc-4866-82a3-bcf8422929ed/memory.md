# Dani Bot gauntlet loop — run log

High-level record of each run. Full detail lives in
`.workbuddy-ai/memory/YYYY-MM-DD.md`; the queue lives in
`docs/dani/gauntlet.md` §4 (on branch `dani/upstream-sync`).

---

## 2026-09-18 ~09:38 — run 1

- **Baseline was RED**, and that became the run's work. `verify.sh focused`
  failed 1/121 on `server/harness/registry.test.ts` (`env: node: No such file
  or directory`). Verified cause: the fixture stripped `PATH` to its fake-npm
  dir and then ran a `#!/usr/bin/env node` script; `setup.ts` redirects `HOME`,
  hiding nvm's bin dirs from `augmentedPath()`, and node lives only under
  `~/.nvm` on this machine. Confirmed pre-existing (that `describe` block is
  unchanged from `Som`). Fixed in the fixture. **Focused now 121/121.**
- **Item: W1/H1** — an unlistened `stdin` error in the Hermes catalog probe
  crashed the app at startup. Fixed at `hermes.ts:385`. Reproduced first with a
  fake ACP child that closes fd 0 then answers `initialize`; the test asserts on
  the uncaught exception, because asserting the probe resolves passes against
  the broken code.
- **Proved:** typecheck PASS; focused 121/121; `server/drivers/acp/` +
  `local-inject-matrix` 332/332; `hermes.test.ts` 55/55.
- **Branch:** `dani/upstream-sync` @ `e6d24d3899` (3 commits this run). `Som`
  untouched. Nothing pushed.
- **Next run should take: W1/H2** — `session/prompt` has no timeout, so a
  stalled Hermes wedges the thread forever (`core.ts:1101`). Then H4.

### Lessons that should carry forward

- A red focused baseline is now a **real signal**. It was red from the day the
  script was written and every earlier run worked around it; it is green now.
- When reproducing a stream/lifecycle crash, assert on the *uncaught exception*,
  not on the promise resolving — a write callback can settle the promise while
  the process still dies.
- Verify "pre-existing" by diffing against `Som`, not by assumption.

---

## 2026-09-18 ~11:00 — run 2

- **Baseline green:** `verify.sh focused` 121/121 exit 0; `verify.sh typecheck`
  PASS. First run to start from a trustworthy floor.
- **Item: W1/H2** — `session/prompt` had no deadline, so a stalled agent wedged
  the thread forever (`active` is cleared only in `settle`; later `sendTurn`s
  threw "a turn is already running"). Fixed with an **idle watchdog** in
  `sendTurn` (`core.ts`) — armed at `promptSent`, re-armed by every decoded
  inbound frame, stood down while a permission ask is open, cleared in `settle`,
  fires as `runtime.error` + `settle(false, "prompt_timeout")`. Default 600 s,
  `DANI_ACP_PROMPT_IDLE_TIMEOUT_MS` read **per turn** (not at module load, which
  would be untestable), `<= 0` disables. Chose idle over a fixed `request`
  timeout because a one-shot cap would kill healthy long turns.
- **Reproduced first:** new `acp.test.ts` test with `FAKE_ACP_MODE=hang` and a
  150 ms window — pre-fix saw only `turn.started, session.started` and never a
  `turn.completed`; post-fix 2/2.
- **Proved:** focused 121/121; `server/drivers/acp/` + `local-inject-matrix`
  334/334 (was 332); typecheck PASS.
- **Honest caveat:** the companion "slow but chatty" test (new `drip` fake mode)
  passes with *and* without the fix, so it is a regression guard, not a
  reproduction. Recorded as such in `hermes-hardening.md`.
- **Branch:** `dani/upstream-sync`. `Som` untouched. Nothing pushed.
- **Next run should take: W1/H4** — no session reuse; a full ACP handshake
  (`initialize` → `session/new|load` → `configureSession`) on every turn. This
  is the main reason Hermes feels slow.

---

## 2026-09-18 ~11:10 — run 3

- **Baseline green:** focused 121/121 exit 0; typecheck PASS.
- **Item taken: MEDIUM "a sync throw escapes the error path"** — and NOT H4,
  deliberately. See below; the deviation is the substance of this run.
- **H4 was assessed and deferred.** The queue said H4 next, but its naive form is
  a **security regression**, not just a slow path: the child is configured per
  turn (approval mode, model/effort via `spawnArgs`; `transformEnv`/HERMES_HOME
  via `childEnv`; `cwd`; `mcpServers` from `integrations`), so a per-thread cache
  reuses a child spawned under *different* permissions — a `fullAuto: true`
  child reused for an `approvalMode: "ask"` turn stays in full auto, and a cached
  child keeps MCP servers the new turn no longer grants. It also requires hoisting
  the per-turn message-loop state out of `sendTurn`'s closure, and it inverts the
  per-turn reaping the audit lists as already sound. **Scoped in full** in
  `hermes-hardening.md` (H4) and `gauntlet.md` §4, with a proposed two-run
  slicing: run A = hoist loop state, no behavior change; run B = cache behind a
  spawn-signature key, one test per mismatch class.
- **Fixed instead:** provider preparation (`childEnv`, auth probe,
  `resolveTurnModel`, `applyTurnEnv`, `acpMcpServers`, `resolveCommand`,
  `spawnArgs`) ran unguarded, so a failed provider write (Hermes's
  `resolveTurnModel` does real I/O) rejected `sendTurn` emitting *nothing* — no
  `turn.started`, no `runtime.error`. Now one `failSetup` helper emits the
  `setup_required` triple. Reproduced first: pre-fix the test's own `await`
  rejected with EACCES from `core.ts:507` and no events were recorded.
- **Proved:** typecheck PASS; focused 121/121; `server/drivers/acp/` +
  `local-inject-matrix` 335/335 (was 334).
- **Branch:** `dani/upstream-sync` @ `bb714e1452` (2 commits). `Som` untouched.
  Nothing pushed.
- **Next run should take: W1/H4 run A** — hoist the per-turn message-loop state
  into an explicit session object with no behavior change (whole suite green is
  the acceptance). Do NOT attempt the cache in the same run. If the baseline is
  red, that takes precedence over everything.

---

## 2026-09-18 ~11:15 — run 4

- **Baseline green:** focused 121/121 exit 0; typecheck PASS.
- **Item: MEDIUM "the probe leaks grandchildren"** — confirmed, then fixed.
- **Confirmed against Hermes's own source** (not assumed): `acp_adapter/session.py`
  builds its MCP list from Hermes's own `config.yaml` `mcp_servers`;
  `server.py`'s `_register_session_mcp_servers` returns early on the empty ACP
  list, so the probe's `mcpServers: []` does **not** protect us;
  `tools/mcp_tool.py` runs them via the MCP SDK's `stdio_client` (real
  subprocesses); `hermes_cli/mcp_startup.py` starts discovery on a daemon thread
  that `session.py` joins during the build `session/new` reaches. So every probe
  orphaned one process per configured MCP server, at instance create.
- **The non-obvious part:** `killCliTree` alone would NOT have worked — `procs.ts`
  only group-kills children `spawnCli` registered (`cliGroups`), and the probe
  spawned raw. Fixed by moving the probe onto `spawnCli` + `killCliTree`.
  `spawnCli` gained an optional `resolveEnv` (the exact objection that made H1's
  fix avoid `spawnCli` is now answered, not worked around); probe stderr moved
  from `ignore` to a drained pipe.
- **Reproduced first:** `hermes.test.ts` → "kills the MCP helper the probe child
  started, not just the probe child". Pre-fix `expect(alive(helperPid)).toBe(false)`
  → `false` vs `true` (helper outlived the probe); post-fix 56/56. The fixture
  kills the helper in `afterEach` so the pre-fix run cannot itself leak.
- **Proved:** typecheck PASS (it caught a leftover unused import — run it BEFORE
  committing); focused 121/121; `hermes.test.ts` 56/56; `server/drivers/acp/` +
  `local-inject-matrix` 336/336; `pgrep` shows no strays.
- **Branch:** `dani/upstream-sync` @ `6bca5a525b` (2 commits). `Som` untouched.
  Nothing pushed.
- **Next run should take: the last MEDIUM, unbounded buffers** (stdout line
  buffer + accumulated turn text). Its entry now warns: a legitimately huge
  single line is possible (inline base64 image), so the cap must **discard up to
  the next newline**, not reset the buffer, or it desynchronises the stream and
  eats the following message. H4 (with its scope note) remains the big one after
  that.

---

## 2026-09-18 ~11:22 — run 5

- **Baseline green:** focused 121/121 exit 0; typecheck PASS; clean tree at
  `6bca5a525b`.
- **Item: MEDIUM "unbounded buffers"** — the last MEDIUM finding. Both
  accumulators capped: the stdout line buffer and the turn text.
- **Design:** two **per-turn-read** functions (`DANI_ACP_MAX_FRAME_CHARS` 16 MiB,
  `DANI_ACP_MAX_TURN_TEXT_CHARS` 4M) via a new `positiveEnvOr` that falls back on
  a non-positive value instead of letting a typo disable the limit. Per-turn, not
  module constants, because a module-level `envOr` is frozen at import and no
  test could exercise it. The frame cap is deliberately generous — ACP frames
  legitimately carry whole inline base64 images.
- **The half that is easy to get wrong:** the cap can only fire on an
  *unterminated* frame (a newline-terminated one is consumed by the line loop
  before the cap is consulted). So the drop enters a `discardingFrame` state and
  skips to the next newline. Clearing the buffer and resuming would re-accumulate
  the rest of the same frame — the growth the cap exists to stop. Truncated text
  is not silently shortened; the flush appends
  `[This reply was cut off at N characters.]`.
- **Reproduced first:** two new fake modes (`oversize-frame`, `flood-text`) and
  two tests. Pre-fix: `expected [] to have a length of 1` (no drop ever
  happened), and 5000 `y`s with no marker. Reproduction was run by stashing
  **only** `core.ts`, keeping the test and the fake.
- **Trap found in the fixture itself:** `oversize-frame`'s 40 ms pause is
  load-bearing. Without it the oversized bytes and their newline arrive in one
  chunk, the line loop eats the line before the cap is consulted, the cap never
  fires, and the test passes while proving nothing. **Second time this loop has
  produced a test that could not fail** — worth watching for.
- **Proved:** typecheck exit 0 (run BEFORE committing); focused 121/121;
  `server/drivers/acp/` 229/229; `server/drivers/acp/` + `local-inject-matrix`
  338/338 (was 336); both new tests pass post-fix and fail pre-fix.
- **Branch:** `dani/upstream-sync` @ `173ad4b600` (2 commits). Remotes unchanged,
  no upstream tracking on the branch, reflog shows commits only. `Som` untouched
  at `48311eea29`. Nothing pushed.
- **Next run should take: W1/H4 run A** — hoist the per-turn message-loop state
  into an explicit session object with no behaviour change (whole suite green is
  the acceptance). Do NOT attempt the cache in the same run. **Every MEDIUM
  finding is now closed; H4 is the only W1 item left.** If the baseline is red,
  that takes precedence over everything.

---

## 2026-09-18 ~13:10 — run 6

- **Baseline green:** `verify.sh focused` 121/121 exit 0; `verify.sh typecheck`
  PASS; tree clean at `173ad4b600`.
- **Item: W1/H4 run A** — hoist the per-turn message loop out of `sendTurn`'s
  closure into an explicit `createSession` object, with the turn's state on an
  `AcpTurn` the session reads through `owner`. **No behaviour change**, and
  deliberately not the cache — the run-3 scope note is explicit that the cache is
  a separate run and that a naive one is a security regression.
- **Why the seam matters:** the loop now reads `owner.*` instead of closing over
  constants, so run B can adopt a session by reassigning `owner` and branching in
  `startTurn`, without touching the decoder, the permission broker, or `settle`.
  The session is still created per turn and `settle` still stops the child, so
  the audit's "children are per-turn and always reaped" still holds.
- **Coverage added:** `stopAll` had **no test at all**, and it is exactly what a
  session/active split breaks. New `acp.test.ts` test kills a hung turn's child
  through `stopAll` and asserts the settle (`exit_before_result`). Verified it
  **can** fail — broken on purpose (`stop: () => {}`) it fails with
  `no matching event within 5000ms; saw: turn.started, session.started`. That
  experiment orphaned a `fake-acp-cli` process, which is the leak the test
  describes; killed and confirmed clean.
- **Proved:** typecheck PASS; focused 121/121; `server/drivers/acp/` +
  `local-inject-matrix` **339/339** (was 338).
- **The full suite is still not evidence.** `verify.sh test` was started and
  stopped after **31 minutes** without finishing; the suite is **546 test files**.
  Recorded as sizing in `gauntlet.md` §4 W8.
- **Branch:** `dani/upstream-sync` @ `b468807a08` (2 commits: `3d61500801`
  refactor, `b468807a08` docs). `Som` untouched at `48311eea29`. Remotes
  unchanged, no upstream tracking, reflog commits only. Nothing pushed.
- **Next run should take: W1/H4 run B** — the cache behind a spawn-signature key
  (command + args + cwd + env + mcpServers), one test per mismatch class proving
  a respawn, plus idle eviction and reaping on `dispose`/`stopAll`/bot deletion.
  **H4 is NOT fixed** — nothing is reused yet. If the baseline is red, that takes
  precedence.

### Lessons that should carry forward

- Split the lifetimes before you cache anything. A refactor with no behaviour
  change is the right unit of work when the alternative is a cache keyed on
  something that varies per turn.
- Prove a new test can fail by breaking the exact wiring it guards, not by
  reasoning about it. Here the broken wiring also produced an observable orphan
  process — independent corroboration that the assertion targets the real
  failure mode.
- The full vitest suite is a 546-file job. Do not start it casually; it will
  consume the run and it shares `NATIVE_DIR` with any concurrent run.

