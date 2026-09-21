# 020 - Typed serving path (kill the god files)

Source: https://github.com/somdipto/dani-desktop/issues/10 (EPIC 2/6). Phase P1.

## Status ledger

- Done:
  - Slice 1, typed auth/pairing boundary - `1247e33` (LANDED in unified candidate
    `bdb92da`): strict Zod contracts for session pairing, unknown scopes rejected,
    route-local parsing for pairing/session-delete, those routes removed from the
    handler-wide mutable regex match. Auth/session matrix 41/41, typecheck, lint.
  - Slice 2, typed voice routes (LANDED in unified candidate `bdb92da`).
- Remaining: route inventory artifact; router/auth/error/schema infrastructure;
  extraction of remaining route families; removal of the handler-wide mutable
  `let m` everywhere; client store split; dormant architecture deletion;
  reachability CI.

## Requirements

R1. Modular monolith with isolated privileged processes - no microservices,
    no framework rewrite.
R2. `server/index.ts` becomes a thin boot/composition root (target < 300 lines).
R3. Application router: route-local params, common auth middleware, schema
    validation, typed errors, request IDs.
R4. Bounded modules: bots, threads, providers, config, routines/triggers,
    computer/browser, voice, approvals/effects.
R5. Shared wire schemas produce both server validation and a generated/inferred
    typed client. Renderer owns presentation only - never permission, completion,
    provider billing, or effect success.
R6. Dependency rules: `server/**` never imports `src/**`; domain modules never
    import adapters/UI.
R7. The dormant ~747-line shadow slice (`server/hermes-runtime.ts`,
    `server/laya-shadow.ts`, `server/memory-sidecar.ts`, `server/dani-*.ts`,
    `shared/dani-runtime.ts`) is deleted or each retained file gains a real
    production importer and packaged-path test. The real serving Hermes path is
    `server/drivers/acp/hermes.ts` through the provider registry.

## Design contract

Migration order (one route family per PR, previous handler kept behind a temporary
test-only comparison seam until response parity passes):

1. Machine-readable route inventory: method/path/auth/body/response/owner.
2. Characterization/contract tests around current behavior before extraction.
3. Router/auth/error/schema infrastructure alongside the legacy handler.
4. Extract low-risk families first (health/config/providers/bots - slices 1-2
   started this), then threads/messages, then routines/computer/voice.
5. Replace shared `m` with route-local matching immediately in touched families.
6. Shared schemas; remove `any` family by family.
7. Split `src/state/store.tsx` (~2,681 lines) into server query/cache, ephemeral
   UI state, domain reducers.
8. Delete dormant architecture and self-referential tests.
9. Dependency/reachability CI labels every runtime module `serving`,
   `test-fixture`, `dev-only`, or rejects it.

Storage safety: every storage change needs a migration, backup-before-migrate, a
compatibility reader for one version, and downgrade/restore instructions. Never
two writers for the same domain.

## Acceptance criteria (binary; from issue #10)

- [ ] Machine-readable route inventory covers every endpoint, auth requirement,
      request/response schema, and owner module.
- [ ] No handler-wide mutable route-match variable remains.
- [ ] Every migrated mutation validates auth, request, permission/idempotency
      metadata, and response.
- [ ] Malformed/fuzzed payloads return deterministic 4xx, never uncaught
      TypeErrors/500s.
- [ ] No `any` remains at migrated wire boundaries.
- [ ] Client calls for migrated endpoints are typed from the same source schemas.
- [ ] `server/index.ts` is a thin boot/composition root (< 300 lines).
- [ ] `src/state/store.tsx` is split into bounded units with no all-domain
      reducer/API god object.
- [ ] The dormant 747-line architecture is deleted or each retained file has a
      real production importer and packaged-path test.
- [ ] Build graph/reachability CI labels each runtime module or rejects it.
- [ ] Existing ordinary chat, approval, browser/computer, provider settings,
      routines, and package smoke behavior is preserved.

## Test gates

Per-family characterization + contract tests before extraction; response-parity
comparison seam per family; fuzz/malformed-payload suite; typecheck; lint; packaged
smoke; reachability CI gate; Gauntlet critic per slice.

## Non-goals

- No framework rewrite, no microservice split, no resurrecting the unpushed
  reconstructed branch by inertia.

## Dependencies

None to start (already started). The kernel mount (spec 030) and voice mount
(spec 050) consume this spec's typed seams.
