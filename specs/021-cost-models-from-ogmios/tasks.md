# Tasks: Live Plutus Cost Models for MPFS Transaction Building

**Feature**: `specs/021-cost-models-from-ogmios/`
**Branch**: `fix/issue-21-cost-models-from-ogmios`
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Date**: 2026-05-18

## Story Map

- **US1** = User Story 1 from spec.md: operator submits a script tx
  after a cost-model bump and it lands on-chain (the deterministic +
  Yaci proof).
- **US2** = User Story 2 from spec.md: operator runs `moog retract`
  against the production token from #21 and it confirms (the
  load-bearing live-preprod smoke).

Both stories are P1. US2's evidence comes from a live preprod run
after US1's code has merged onto the branch — the dependency is
proof-direction, not code-direction.

## How tasks map to commits

Each implementation task here is **one bisect-safe subagent commit**
in resolve-ticket terms. Where the resolve-ticket flow lists RED and
GREEN separately, both ride in the same commit: the test is added
first, observed failing, then the production code is added; both are
staged together for the single commit the subagent returns. The
commit body carries a `Tasks: T###` trailer; on review the
orchestrator stamps `tasks.md` with `[X] T### (commit: <sha>)`.

Chore commits (gate.sh extend, gate.sh drop) are *orchestrator-
authored* and do not need a `Tasks:` trailer per the commit-message
gate.

## Phase 1 — Setup (already complete on this branch)

- [X] T000 Bootstrap branch + worktree + `gate.sh` + draft PR (commit: 651f2ee4)
- [X] T0a Initialize Spec Kit + filled MPFS constitution v1.0.0 (commit: 89c21a9f)
- [X] T0b Write spec + requirements checklist (commit: ce29112e)

No further setup tasks. The first implementation slice can start
once this tasks document and the plan it derives from are committed.

## Phase 2 — Foundational helpers

These two slices land before either user story can be exercised.
They are the pure substrate that US1's wire-in and US2's smoke both
ride on.

### [X] T001 [US1] Implement and test the pure `recomputeScriptDataHash` rewriter (commit: a8ccef29)

**Owned files**:
- `off_chain/src/tx/recomputeScriptDataHash.ts` (new)
- `off_chain/src/tx/recomputeScriptDataHash.test.ts` (new — co-located per the existing vitest convention `include: ['src/**/*.test.ts']`; fixtures are built inline inside the test from `@sidan-lab/sidan-csl-rs-nodejs` primitives, no committed JSON/CBOR files needed)

**RED**: the vitest unit test imports `recomputeScriptDataHash` and
asserts (a) on the committed tx CBOR + committed cost-models pair,
the rewriter produces the expected `script_data_hash`; (b) every
other body byte is preserved; (c) calling on a non-Plutus tx returns
the input unchanged. The test is observed failing because the import
does not resolve.

**GREEN**: implement `recomputeScriptDataHash(txHex, costModels)`
using `@sidan-lab/sidan-csl-rs-nodejs`'s `Transaction.from_hex`,
`hash_script_data`, body `set_script_data_hash`, and
`Transaction.new` (see research.md Q5 and contracts/cost-models.md
Contract 2). The same test passes.

**Folds into one commit**: stage the test + production module +
fixtures together. `./gate.sh` must be green (extended in T004 but
the unit-test command can be run via `npx vitest run -t cost-models`
locally; the orchestrator runs it before accepting the commit).

**Live-boundary diagnostic**: N/A — pure rewriter, no boundary.

**Commit subject**: `feat(tx): recompute script-data-hash with live cost models`

### [X] T002 [US1] Implement and test `fetchLiveCostModels` against Yaci's Ogmios (commit: 787d586a)

**Owned files**:
- `off_chain/src/ogmios/protocolParameters.ts` (new)
- `off_chain/src/submitter.ts` (extend `Client` with a `query(method, params)` shape *only if* needed — the orchestrator OKs the extension at review)
- `off_chain/src/ogmios/protocolParameters.integration.test.ts` (new — vitest picks up `*.test.ts` per project convention; orchestrator confirms the vitest glob before dispatch of T002)

**RED**: a vitest integration test that:
1. Boots Yaci DevKit (existing `just test-all` prerequisite — guards
   on `OGMIOS_PORT` being open before running).
2. Calls `fetchLiveCostModels('ws://localhost:1337')`.
3. Asserts the returned `LiveCostModels` has non-zero V1 and V2
   lengths (V3 is optional depending on the Yaci-bundled era).
4. Asserts `digest()` is a non-empty stable string and the same
   across two consecutive calls in the same Yaci session.

The test fails before the module is implemented (import does not
resolve).

**GREEN**: implement the WebSocket call + JSON-RPC framing +
`Costmdls`/`CostModel` construction. The same test passes against a
running Yaci. The first commit in this slice also records the
observed JSON shape from Yaci's reply as a comment block at the top
of `protocolParameters.ts` so future readers don't have to re-run
Yaci to know what comes off the wire. If the observed shape differs
from research.md Q3's prediction, `research.md` is *not* edited in
this commit — that's a forward `docs:` commit, by resolve-ticket's
planning-phase-only stgit rule.

**Live-boundary diagnostic**: ✅ — this is the boundary. The unit
suite cannot prove that the JSON-RPC method name and payload shape
match Ogmios's actual surface; the integration test does. Per
constitution Principle III this slice has both a Yaci proof and is
exercised end-to-end by US2's preprod smoke.

**Commit subject**: `feat(ogmios): fetch live Plutus cost models from queryLedgerState/protocolParameters`

## Phase 3 — User Story 1 (Yaci-level proof)

### [X] T003 [US1] Wire `recomputeScriptDataHash` + `fetchLiveCostModels` into `getTxBuilder` and prove the regression boundary (commit: 8636eadf)

**Owned files**:
- `off_chain/src/transactions/context/lib.ts` (modify `getTxBuilder` to wrap `complete()`)
- `off_chain/src/tx/getTxBuilder.integration.test.ts` (new — end-to-end build → rewrite → submit; co-located so vitest picks it up)

**RED**: the vitest integration test that drives the binary regression
sentinel for SC-004:

1. Build a script-bearing MPFS tx (the retract path is the cheapest
   to set up — has no MPF trie state requirement).
2. Submit through Yaci's ogmios with the rewriter *disabled* via a
   test-injected flag — expect rejection with `ogmios 3113`
   (`script integrity mismatch`).
3. Submit through Yaci's ogmios with the rewriter *enabled* — expect
   acceptance.

The first assertion fails before `getTxBuilder` is wrapped (today's
code returns a tx that the bundled-cost-models path makes Yaci
accept *only by accident*, because Yaci's bundled cost models happen
to match Mesh's bundled defaults). The slice therefore also commits
a **wrong-cost-models stub** as the regression sentinel — the
integration test runs the second path with a deliberately corrupted
cost-models payload to force the failing branch, proving the
rewriter is on the critical path. This is the only way to keep the
regression boundary visible on Yaci (see plan.md "Risks and Edge
Cases").

**GREEN**: implement the `complete()` wrapper per contracts/
cost-models.md Contract 3. Same test passes.

**Folds into one commit**: production wrapper + test ride together.

**Live-boundary diagnostic**: ✅ — submitted to Ogmios.

**Commit subject**: `fix(tx): inject live cost models into MeshTxBuilder.complete()`

### [X] T004 (chore, orchestrator-authored) Extend `gate.sh` with the cost-models tests (commit: 957b6731)

**Owned files**:
- `gate.sh`

`gate.sh` grows two lines:
- `( cd off_chain && npx vitest run -t "cost-models" )`
- `( cd off_chain && if nc -z localhost 1337 2>/dev/null; then npx vitest run --testNamePattern '@yaci' ; else echo "skip: yaci not up"; fi )`

Yaci-conditional skip is deliberate: subagents iterating locally
without a Yaci instance still get a green gate on the
non-live-boundary changes. CI brings Yaci up so the full path is
exercised there.

No `Tasks:` trailer — chore commit per commit-message gate.

**Commit subject**: `chore: extend gate.sh with cost-models unit + integration tests`

### [X] T005 [US1] Emit the structured log entry (FR-006) (commit: 473c8e6f)

**Owned files**:
- `off_chain/src/transactions/context/lib.ts` (extend the wrapper's
  success path; lib's existing `logging.ts` import is reused if
  available)
- `off_chain/src/logging.ts` (read-only unless a helper is missing)
- `off_chain/src/tx/recomputeScriptDataHash.test.ts` (extend with
  one new test case)

**RED**: a vitest test that stubs the structured-log helper and
asserts the wrapper emits exactly one entry per script-bearing build,
with fields `event="live_cost_models"`, `source="ogmios"`,
`ogmios_url`, `lengths` (object), `digest` (string starting with
`sha256:`).

**GREEN**: emit the entry.

**Folds into one commit**: test + log emission together.

**Live-boundary diagnostic**: N/A — pure logging.

**Commit subject**: `feat(log): structured cost-models entry per script tx`

## Phase 4 — User Story 2 (live-preprod smoke; operator-driven)

### [X] T006 [US2] Run the preprod live-boundary smoke and record evidence (txid: 1ebceec9)

**Owned by**: orchestrator + operator. Not a subagent slice.

Steps (per quickstart.md Step 3):

1. Point a patched MPFS at a preprod-connected Ogmios.
2. Run `moog retract` against the production token from #21.
3. Capture the txid and a block-explorer or `cardano-cli query utxo`
   confirmation that the request UTxO is gone.
4. Capture one structured `live_cost_models` log entry from the
   build.

Recorded in:

- PR body's "Live-preprod smoke evidence" section (txid +
  explorer link).
- `quickstart.md` "Latest verified run" footer.

This is the load-bearing constitution-Principle-III proof. SC-002
evidence comes from here.

**Commit subject** (the docs commit recording the txid):
`docs(specs): record live-preprod retract txid for #21`

## Phase 5 — Finalization

### [X] T007 (chore, orchestrator-authored) Drop `gate.sh` and mark PR ready (commit: b38f6197)

**Owned files**: `gate.sh` (deleted via `git rm`)

Preconditions:

- Every other task above shows `[X] T### (commit: <sha>)`.
- `./gate.sh` runs green at HEAD.
- PR body has the live-preprod txid evidence.

Action:

```bash
git rm gate.sh
git commit -m "chore: drop gate.sh (ready for review)"
git push
gh pr ready 22
```

Per `gate-script` skill — the absence of `gate.sh` at HEAD is the
"PR finalized" sentinel.

**Commit subject**: `chore: drop gate.sh (ready for review)`

## Dependencies

```text
T001 ──────────┐
               ├──> T003 ──> T004 ──> T005 ──> T006 ──> T007
T002 ──────────┘
```

- T001 and T002 are independent — they could be dispatched in
  parallel, but resolve-ticket prefers serial dispatch unless the
  user explicitly authorizes parallel work, so the default is
  T001 → T002.
- T003 depends on both T001 and T002 (it imports both helpers).
- T004 depends on the test files added in T001/T002/T003 existing.
- T005 depends on T003 (the wrapper exists to extend).
- T006 depends on the code being merged onto the branch through
  T005 (operator runs against a patched build).
- T007 depends on everything else; absence of `gate.sh` is the
  finalization sentinel.

## Parallel opportunities

- T001 and T002 are file-disjoint and could run in parallel sub-
  agent runs. The orchestrator should still inspect them serially.
- Inside T005, the log-emission code and its test are small and
  fit comfortably in one commit; no internal parallelism.

## MVP scope

If pressure forces a partial ship, the MVP is **T001 + T002 + T003 +
T006** (skip T004's gate extension and T005's logging). T007 is then
adjusted to drop `gate.sh` and the operator commits to running
`just run-tests "cost-models"` manually each time. This MVP still
delivers the fix (the bug-killing path) and the live-preprod
evidence; it just loses the regression sentinel automation and the
post-incident triage log.

The full plan (T001–T007) is the recommended path.

## Implementation strategy

1. The orchestrator dispatches a subagent for T001. On return,
   review, stamp the slice, push.
2. Dispatch a subagent for T002. Same review loop.
3. Dispatch a subagent for T003. Review loop.
4. Orchestrator-authored: T004 (gate extend).
5. Dispatch a subagent for T005. Review loop.
6. Coordinate with the operator on T006; record evidence in the PR.
7. Orchestrator-authored: T007 (gate drop, mark ready).

Throughout: WIP.md is the live tail; orchestrator runs `tail -F
./WIP.md` in real time for the duration of each subagent run.
