# Implementation Plan: Live Plutus Cost Models for MPFS Transaction Building

**Branch**: `fix/issue-21-cost-models-from-ogmios` | **Date**: 2026-05-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/021-cost-models-from-ogmios/spec.md`

## Summary

MPFS-built script transactions are rejected by `cardano-node` with
`ogmios 3113` because Mesh SDK falls back to bundled `DEFAULT_V*_COST_MODEL_LIST`
constants that no longer match the chain's enacted cost models
(preprod, epoch 289 boundary, 2026-05-16). Mesh's public `Protocol`
type has no `costModels` field, so the fix injects cost models below
Mesh: after `MeshTxBuilder.complete()` returns, MPFS deserializes the
unsigned tx, recomputes `script_data_hash` over live cost models
fetched from Ogmios's `queryLedgerState/protocolParameters`, and
re-encodes the tx. The injection point is `getTxBuilder()` in
`off_chain/src/transactions/context/lib.ts:17`, mirroring the
existing `mkOgmiosEvaluator` precedent from issue #15.

Full research, including the alternatives that were considered and
rejected, lives in [research.md](./research.md). Internal contracts
live in [contracts/cost-models.md](./contracts/cost-models.md).

## Technical Context

**Language/Version**: TypeScript on Node 20 (run via `tsx`)
**Primary Dependencies**: `@meshsdk/core@1.8.14`, `@meshsdk/core-csl`,
  `@sidan-lab/sidan-csl-rs-nodejs` (Rust-WASM, transitive via core-csl),
  `ws` (WebSocket client to Ogmios), `vitest` + `ava` (existing test
  runners)
**Storage**: N/A (no persistent state added by this fix)
**Testing**: `vitest` for unit tests (deterministic CBOR + hash), `ava`
  for Yaci-integration tests (boots yaci-store + yaci-admin + ogmios),
  live preprod smoke via `moog retract` (operator-driven; recorded txid
  in PR description)
**Target Platform**: Linux/macOS Node 20 server runtime; the off-chain
  service runs containerized in production behind the existing reverse
  proxy.
**Project Type**: Off-chain Cardano service (TypeScript) + on-chain
  Aiken validators (untouched by this fix).
**Performance Goals**: Negligible regression — one extra Ogmios
  WebSocket round-trip per script-bearing tx build (typically
  10–50 ms locally; <500 ms over public preprod). The existing tx
  build path already does a similar round-trip for
  `evaluateTransaction`.
**Constraints**: No `@meshsdk/core` major version bump (issue #21
  non-goal); no `yaci-store` endpoint additions; no provider-abstraction
  refactor; no upstream Mesh PR in this slice (a separate ticket can
  do that asynchronously).
**Scale/Scope**: Single off-chain service instance per network; tx-
  build rate bounded by user request rate (single-digit per minute
  during typical MPFS operation).

## Constitution Check

Reviewed against `.specify/memory/constitution.md` v1.0.0.

| Principle | Plan complies? | Notes |
|---|---|---|
| I. Live chain is the source of truth | ✅ | Cost models read live from Ogmios at every script-bearing tx build; bundled fallback explicitly rejected (FR-003). |
| II. Mesh SDK is configured, not patched | ✅ | Same shape as the existing `mkOgmiosEvaluator` injection. Mesh remains a configured dependency; no fork. |
| III. Test against Yaci DevKit + verify on live preprod | ✅ | Both proofs are required by the plan: deterministic unit + Yaci integration for SC-004/SC-005; preprod `moog retract` txid for SC-002. |
| IV. On-chain validators are gates; off-chain is the service | ✅ | No on-chain changes; `aiken check` + `aiken build` stay in `gate.sh`. |
| V. Bisect-safe vertical slices | ✅ | See "Implementation Slices" below — each slice is a single subagent commit that builds, passes gate, and stands alone. RED + GREEN ride together. |

No violations; "Complexity Tracking" section is empty.

## Project Structure

### Documentation (this feature)

```text
specs/021-cost-models-from-ogmios/
├── plan.md                         # This file
├── research.md                     # Phase 0 output (7 questions resolved)
├── data-model.md                   # In-memory entities + error model
├── quickstart.md                   # Operator verification runbook
├── contracts/
│   └── cost-models.md              # Internal function contracts (5)
├── checklists/
│   └── requirements.md             # Spec-quality checklist (all green)
└── tasks.md                        # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
off_chain/
├── src/
│   ├── transactions/
│   │   └── context/
│   │       └── lib.ts                       # MODIFY: wrap getTxBuilder().complete()
│   ├── ogmios/                              # NEW (or under submitter/): tiny query client
│   │   └── protocolParameters.ts            # NEW: fetchLiveCostModels(ogmiosUrl)
│   ├── tx/
│   │   └── recomputeScriptDataHash.ts       # NEW: pure CBOR rewriter
│   └── submitter.ts                         # MAY REUSE: existing ws client helpers
└── test/
    └── cost-models/
        ├── recompute.unit.test.ts           # NEW: deterministic unit test (vitest)
        └── fetch-and-rewrite.integration.test.ts  # NEW: Yaci integration (ava)

on_chain/                                    # UNCHANGED (no validator change)
```

**Structure Decision**: Two new modules under `off_chain/src/`
(`ogmios/protocolParameters.ts` for the live fetch, `tx/recomputeScriptDataHash.ts`
for the pure rewriter), wired in from `transactions/context/lib.ts`.
The shape is deliberately small — one async I/O module, one pure
transform, one wiring change. No new top-level abstraction.

## Implementation Slices

Each slice is exactly one subagent commit (the resolve-ticket
contract). Each slice includes its RED + GREEN proof and the
`Tasks: T###` trailer. Slices are listed in the order the subagent
should run them.

### Slice 1 — Pure CBOR rewriter (`recomputeScriptDataHash`)

**Tasks**: T001, T002

**Owned files**:
- `off_chain/src/tx/recomputeScriptDataHash.ts` (new)
- `off_chain/test/cost-models/recompute.unit.test.ts` (new)

**RED proof**: a vitest unit test that:
- Builds a `Costmdls` value from a recorded "live preprod 2026-05-17"
  cost-models snapshot (committed as a fixture).
- Takes a recorded unsigned tx CBOR (committed as a fixture) whose
  `script_data_hash` was computed with Mesh's bundled defaults.
- Computes the expected correct hash via direct `hash_script_data`
  invocation.
- Asserts the rewriter's output's `script_data_hash` equals the
  expected hash, and that no other tx field changed.

The test must be observed failing before the rewriter is implemented.

**GREEN proof**: same test passes.

**Live-boundary diagnostic** (Q: "What boundary does this exercise
that the unit suite cannot?"): N/A — this slice is deliberately
pure; no live boundary is touched. The boundary is exercised by
Slice 3.

### Slice 2 — Ogmios fetch (`fetchLiveCostModels`)

**Tasks**: T003, T004

**Owned files**:
- `off_chain/src/ogmios/protocolParameters.ts` (new)
- `off_chain/test/cost-models/fetch-and-rewrite.integration.test.ts` (new — set up only; full Yaci wiring lands in Slice 3)
- `off_chain/src/submitter.ts` (extend the existing client helper if reused)

**RED proof**: an ava test that boots Yaci's ogmios and asserts the
fetcher returns a `LiveCostModels` whose `.lengths()` are
non-zero and whose `.digest()` is stable across calls in the same
session. The test must fail before the module is implemented (the
import does not resolve).

**GREEN proof**: the same test passes against a running Yaci DevKit.

**Live-boundary diagnostic**: ✅ — this is the live boundary. A unit
test with a recorded JSON-RPC reply would prove the parser, not the
JSON-RPC method name or the Ogmios protocol version. The test runs
against Yaci's actual Ogmios.

### Slice 3 — Wire the rewriter into `getTxBuilder`

**Tasks**: T005, T006

**Owned files**:
- `off_chain/src/transactions/context/lib.ts` (modify `getTxBuilder`)
- `off_chain/test/cost-models/fetch-and-rewrite.integration.test.ts` (extend with end-to-end build → rewrite → submit)

**RED proof**: extend the integration test from Slice 2:
1. Build a script-bearing MPFS tx via the existing `getTxBuilder`
   (request, retract, or update — pick the cheapest in test setup).
2. Inject a *wrong* set of cost models into the fetcher (test seam).
3. Submit the tx through Yaci's ogmios.
4. Assert: submission is rejected with `ogmios 3113`.
5. Repeat with the *correct* live cost models.
6. Assert: submission succeeds.

This double-test is the binary regression sentinel for SC-004.

**GREEN proof**: both assertions pass; `./gate.sh` (extended in Slice 4)
runs green.

**Live-boundary diagnostic**: ✅ — submits to ogmios. Boundary fully
exercised.

### Slice 4 — Extend `gate.sh` with the new tests + chore commit

**Tasks**: T007

**Owned files**:
- `gate.sh` (extend)

**Subagent-free**: orchestrator owns gate.sh edits (per resolve-ticket
invariant). Done as a `chore: extend gate.sh …` commit directly,
no Tasks trailer required.

After this commit, `gate.sh` runs:
- existing on-chain `aiken check` + `aiken build`
- existing off-chain eslint
- new: `npx vitest run -t "cost-models"` (unit)
- new: integration test under `just run-tests "cost-models"`
  (Yaci-bound; only runs if Yaci is up — gate gracefully skips when
  yaci services aren't reachable, so subagents can iterate locally
  even without a Yaci instance)

### Slice 5 — Structured log entry (FR-006)

**Tasks**: T008

**Owned files**:
- `off_chain/src/transactions/context/lib.ts` (extend the
  `complete()` wrapper to emit the log entry)
- `off_chain/src/logging.ts` (if a structured log helper exists; reuse,
  do not duplicate)
- `off_chain/test/cost-models/recompute.unit.test.ts` (assert the
  log helper is called with the right shape)

**RED proof**: a vitest test that stubs the log helper and asserts
the wrapper emits exactly one entry per script-bearing build with the
expected fields (`event`, `source`, `ogmios_url`, `lengths`, `digest`).

**GREEN proof**: same test passes.

**Live-boundary diagnostic**: N/A — pure logging; no boundary.

### Slice 6 — Live-preprod smoke evidence (operator follow-up)

**Tasks**: T009

**Owned by**: orchestrator + operator. Not a subagent slice. Runs
once after Slice 5 lands on the branch. The operator follows
`quickstart.md` Step 3 against preprod, captures the txid, and the
orchestrator records it in the PR description and the `quickstart.md`
"Latest verified run" section.

This is the load-bearing live-boundary smoke per constitution
Principle III; SC-002 evidence comes from here.

### Slice 7 — Finalization

**Tasks**: T010

**Owned by**: orchestrator. Drops `gate.sh` in a `chore: drop gate.sh
(ready for review)` commit, marks the PR ready, records final
state.

## Risks and Edge Cases

- **Yaci's bundled Ogmios version does not expose
  `queryLedgerState/protocolParameters`.** Mitigation: Slice 2's RED
  test will fail with a clear "method not found" diagnostic; we fall
  back to running the integration test against a separate ogmios
  process (e.g., `nix run` from the flake) or, in the worst case,
  defer the integration test to a separate ticket and rely on the
  unit + live-preprod proofs (Slices 1 and 6).
- **Yaci's bundled cost models match Mesh's defaults.** This is *not*
  a problem for Slice 3 because the test injects a deliberately wrong
  cost-models payload to drive the rejection path; the correct-payload
  path is exercised by Slices 1 (unit) and 6 (live preprod). Yaci's
  on-chain cost models are never the variable being tested — the
  *fetcher's* output is.
- **`Transaction.from_hex(builder.txHex)` round-trip is not
  byte-identical.** If the Rust-WASM crate's encoder is canonical
  but Mesh's encoder is not, the rewrite slice might change other
  body bytes. Mitigation: Slice 1's unit test asserts byte equality
  on every field except `script_data_hash`. If the assertion fails
  after the rewriter is correct, we either patch the rewriter to
  preserve foreign bytes (rare path) or accept the canonicalization
  (likely path; submission will still succeed).
- **Mesh upgrades silently change `CSLSerializer` to a non-CSL
  serializer in a minor.** Detection: Slice 3's integration test
  would fail. Mitigation is the same as today's #15 fix — bind to
  the known good Mesh minor, bump in a separate ticket.

## Out of scope (carried from issue #21 non-goals)

- Upgrading `@meshsdk/core` to a new major version.
- Adding a `/api/v1/epochs/latest/parameters` endpoint to yaci-store.
- Refactoring the `YaciProvider | BlockfrostProvider` abstraction.
- Filing or fixing the missing `DEFAULT_V3_COST_MODEL_LIST` upstream
  in `@meshsdk/common`.

## Complexity Tracking

Constitution Check passed without violations. No items.
