# Research: Live Plutus Cost Models for MPFS Transaction Building

**Feature**: `specs/021-cost-models-from-ogmios/`
**Date**: 2026-05-18

## Question 1 — Where in the Mesh SDK pipeline do cost models flow into the script-data hash?

### Decision

Cost models enter through the underlying `@sidan-lab/sidan-csl-rs-nodejs`
Rust-WASM crate, **not through Mesh's `Protocol` type**. Mesh's
`MeshTxBuilder` accepts `params?: Partial<Protocol>` in its constructor
options, but the `Protocol` type at
`off_chain/node_modules/@meshsdk/common/dist/index.d.ts:192` has **no
`costModels` field**. There is no public Mesh API to inject cost models
at tx-build time.

The default serializer is `CSLSerializer`
(`off_chain/node_modules/@meshsdk/transaction/dist/index.cjs:1727`),
whose `serializeTxBody(txBody, protocolParams)` calls
`csl.js_serialize_tx_body(txBodyJson, params)`. That Rust function uses
hard-bundled cost models from `@meshsdk/common`:
`DEFAULT_V1_COST_MODEL_LIST` (~166 elements) and
`DEFAULT_V2_COST_MODEL_LIST` (~175). For PlutusV3 the `core-cst` path
at line 2659 has an *empty* if-block — V3 cost models are simply not
written into the `Costmdls` map at all.

### Rationale

This explains the issue exactly: the chain has bumped V1 to 332, V2 to
332, V3 to 350; Mesh has 166/175/0; the script-data hash computed by
Mesh diverges from the node's by construction.

### Alternatives considered

- **Inject via `params: { ..., costModels: ... }`.** Rejected — type
  doesn't exist on `Protocol`; would require Mesh code change.
- **Patch `DEFAULT_V*_COST_MODEL_LIST` at runtime.** Rejected — these are
  exported `const` arrays from `@meshsdk/common`; mutating them is
  brittle and would change behavior of every other consumer in the
  process.
- **Replace `CSLSerializer` wholesale.** Possible (`MeshTxBuilder` accepts
  `serializer?: IMeshTxSerializer`) but `serializeTxBody` is
  synchronous, and our fix needs an async Ogmios call. Async-wrap would
  require holding a fresh cost-models snapshot on the serializer
  instance — workable but couples the fetch to the build call in a
  way that's harder to test.

## Question 2 — What is the right injection point in MPFS?

### Decision

**Wrap `MeshTxBuilder.complete()` in `getTxBuilder()`** to perform a
post-build script-data-hash rewrite. `complete()` is already async, so
fetching cost models from Ogmios fits naturally:

```text
getTxBuilder(provider, ogmios) {
  builder = new MeshTxBuilder({ fetcher, submitter, evaluator: mkOgmiosEvaluator(ogmios) })
  origComplete = builder.complete.bind(builder)
  builder.complete = async (...args) => {
    await origComplete(...args)
    if (txUsesPlutusScripts(builder)) {
      liveCostModels = await fetchLiveCostModels(ogmios)
      builder.txHex = recomputeScriptDataHash(builder.txHex, liveCostModels)
    }
    return builder
  }
  return builder
}
```

This is the same shape as the existing `mkOgmiosEvaluator` injection from
issue #15 — Mesh stays a configured library, not a patched one
(constitution Principle II). One choke point catches every
script-bearing tx the codebase already routes through `getTxBuilder`.

### Rationale

- Single injection site (`getTxBuilder` in `lib.ts`) reaches every
  consumer (boot, request, retract, update, end).
- `complete()` returns the builder; `txHex` is read afterward by every
  caller — overwriting `builder.txHex` after we recompute the hash is
  observed by all callers without further changes.
- Async fetch is allowed because `complete()` is async.
- Easy to feature-gate or short-circuit when the tx has no Plutus
  scripts.
- Easy to unit-test the rewriter in isolation.

### Alternatives considered

- **Inject in `signAndSubmit` (`lib.ts:signAndSubmit`).** Rejected — not
  every signing path goes through `signAndSubmit`; we would have to
  audit every consumer. The builder is the universal choke point.
- **Custom synchronous serializer with pre-fetched cost models.**
  Rejected as noted in Q1 above.
- **Replace the serializer with a custom async one.** Rejected — Mesh's
  `IMeshTxSerializer` is synchronous; we would have to lie about the
  return type or pre-cache.

## Question 3 — Which Ogmios method and what is its response shape?

### Decision

Use Ogmios JSON-RPC method **`queryLedgerState/protocolParameters`**
(no parameters). Already speaking Ogmios over WebSocket from
`off_chain/src/submitter.ts`; reuse that client surface and add a query
RPC.

The response carries a `plutusCostModels` object keyed by
`plutus:v1`, `plutus:v2`, `plutus:v3` whose values are integer arrays.
Concrete field name and JSON shape will be confirmed by an
exploratory call against the local Yaci DevKit's Ogmios as the first
implementation slice — if the shape differs across Ogmios versions
this gets recorded back into this file.

### Rationale

- The codebase already commits to Ogmios as the live-chain boundary
  (existing `mkOgmiosEvaluator` from #15 plus `submitTransaction` /
  `evaluateTransaction` calls).
- `queryLedgerState/protocolParameters` is the canonical
  way to read currently-enacted protocol parameters at the chain
  tip. It is supported on Ogmios 5.x (used by Yaci 0.10.x bundled
  release) and 6.x.

### Alternatives considered

- **`queryNetwork/protocolParameters`.** Rejected — that returns the
  parameters at the *start* of the current era, not the
  currently-enacted set. After an in-era parameter update (exactly
  the scenario in #21) it is stale.
- **`queryLedgerState/genesisConfiguration`.** Rejected — returns
  static genesis values, not the evolved chain tip.
- **Direct cardano-cli `query gov-state` (used as evidence in
  the issue).** Rejected — requires a local `cardano-cli` shelling
  out; we have a live Ogmios connection already.

## Question 4 — What is the canonical mapping from Ogmios cost models to `Costmdls`?

### Decision

Build the `Costmdls` value with explicit per-language insertion using
`@sidan-lab/sidan-csl-rs-nodejs` primitives:

```text
costmdls = Costmdls.new()
if ogmios.plutusCostModels['plutus:v1']:
  costmdls.insert(Language.new_plutus_v1(), costModelOfList(v1_list))
if ogmios.plutusCostModels['plutus:v2']:
  costmdls.insert(Language.new_plutus_v2(), costModelOfList(v2_list))
if ogmios.plutusCostModels['plutus:v3']:
  costmdls.insert(Language.new_plutus_v3(), costModelOfList(v3_list))

costModelOfList(xs) = let m = CostModel.new() in
  for i, x in enumerate(xs): m.set(i, Int.from(x)); m
```

The `Costmdls`/`CostModel`/`Language.new_plutus_v3()` classes are in the
public surface of `@sidan-lab/sidan-csl-rs-nodejs` (see
`sidan_csl_rs.d.ts:2297-2417, 4620-4628`).

### Rationale

- Length-agnostic loop: `CostModel.set(operation, cost)` fills any size
  vector. Satisfies FR-004 ("no fixed-length assumption").
- Per-language inserts are conditional on the presence of that
  language in the Ogmios response: a network without V3 produces a
  Costmdls without a V3 entry (FR-005, edge case "partial cost-model
  set").
- Reuses an already-resident Rust-WASM crate (no new build dependency).

### Alternatives considered

- **`Costmdls.from_json(...)` with the raw Ogmios payload.** Rejected
  — the JSON shape Costmdls expects (named-operations object) differs
  from the integer-array shape Ogmios returns. A converter would have
  to maintain the operation→index ordering, which is exactly what
  `CostModel.set(operation, cost)` already does for us.
- **Use `Costmdls.plutus_conway_cost_models()` static** (a bundled
  snapshot inside the Rust crate). Rejected — same class of bug as
  Mesh's bundled defaults; violates constitution Principle I.

## Question 5 — How do we recompute `script_data_hash` and rewrite the tx CBOR?

### Decision

Use `@sidan-lab/sidan-csl-rs-nodejs` directly:

```text
tx = Transaction.from_hex(builder.txHex)
witnessSet = tx.witness_set()
body = tx.body()
redeemers = witnessSet.redeemers()                  // may be undefined
datums = witnessSet.plutus_data()                   // may be undefined
hash = hash_script_data(redeemers, costMdls, datums)
body.set_script_data_hash(hash)
newTx = Transaction.new(body, witnessSet, tx.auxiliary_data())
return newTx.to_hex()
```

`hash_script_data(redeemers, costModels, datums?)` is exported as a
top-level function from the crate (`sidan_csl_rs.d.ts:186`). `Transaction`
exposes `body()`, `witness_set()`, `auxiliary_data()`, and a static
`new(body, witness_set, auxiliary_data?)` re-constructor
(`sidan_csl_rs.d.ts:8687-8746`).

### Rationale

- All-synchronous WASM calls; the only async is the upstream Ogmios fetch.
- Same crate that Mesh's `CSLSerializer` uses, so re-encoding produces
  byte-identical CBOR to what Mesh would have produced if it had used
  the correct cost models. No new dependency, no new serialization
  surface.
- Idempotent for non-Plutus txs (we skip the path if no redeemers).

### Alternatives considered

- **Mutate `TransactionBody` in place, leave outer Transaction CBOR
  reused.** Rejected — CBOR encoding is whole-object; the body byte
  span is not in a fixed offset in the outer Transaction CBOR. A
  decode/re-encode round-trip is cleaner.
- **Use `core-cst`'s `hashScriptData`.** Same algorithm, but
  `core-cst` interleaves the cost-models-defaults bug we are trying to
  bypass; staying on the lower layer avoids accidentally reintroducing
  the bug.

## Question 6 — How do we test against Yaci DevKit, and what is the live-boundary smoke?

### Decision

Two complementary proofs:

**Yaci-based integration test** (`just test-all` surface): boot Yaci
DevKit (yaci-store + yaci-admin + ogmios) as the existing suite does,
submit a script-bearing MPFS tx through the fixed code path, assert
that the tx is accepted by the node (it is — even though Yaci's bundled
chain has cost models matching Mesh's defaults, the fixed path now
sources them live from Yaci's ogmios). A second test fixes a known
"wrong" cost-models input and asserts that the unfixed code path
produces a different script-data-hash than the fixed one — this is the
deterministic regression sentinel.

**Live-preprod smoke** (operator follow-up, recorded as evidence in the
PR description): point a patched MPFS at preprod-connected Ogmios,
run `moog retract` against the production token from issue #21, record
the txid and tx URL. This is the only proof that the fix works against
the chain whose enacted cost models broke MPFS in the first place.

### Rationale

- Constitution Principle III: "Test against Yaci DevKit; verify on live
  preprod." Both proofs are required.
- The Yaci test is a binary regression boundary (passes on fix, fails
  on revert) → SC-004.
- The preprod smoke is the only end-to-end confirmation against the
  failing-in-production chain → SC-002.

### Alternatives considered

- **Yaci only.** Rejected — Yaci's bundled ogmios returns cost models
  matching `DEFAULT_V*_COST_MODEL_LIST`, so an "end-to-end submission
  succeeds" test passes on Yaci even with the unfixed code path; we
  would not catch the actual regression.
- **Preprod only.** Rejected — slow, requires preprod funds and a
  flaky-by-design boundary inside automated CI. Yaci is the
  fast/deterministic gate; preprod is the load-bearing one-time
  smoke.

## Question 7 — Behavior when Ogmios is unreachable

### Decision

A script-bearing build fails fast with a typed error
(`LiveCostModelsUnavailable`) naming the Ogmios endpoint. **No fallback
to bundled defaults.**

For non-Plutus txs (no redeemers, no scripts), `txUsesPlutusScripts`
returns false and the cost-model fetch is skipped entirely — those
txs are not affected by the bug.

### Rationale

FR-003 spells this out: silent fallback is the bug. The fix's
correctness is observable only when the live source is consulted. A
failure-mode fall-through reintroduces #21 verbatim.

### Alternatives considered

- **Cache cost models with a chain-tip key and serve from cache when
  Ogmios is briefly unavailable.** Deferred. The bug is reproducible
  whenever cost models diverge; the operational story for "Ogmios
  temporarily down" is a separate ticket (graceful degradation across
  the whole Ogmios boundary, not specific to cost models).
- **Cache cost models for the lifetime of the process.** Rejected —
  re-introduces the same staleness window the chain enacts cost-model
  changes through. Edge case "cost models change between successive
  tx builds in the same MPFS process" covers this.

## Open assumptions, to confirm in implementation

- The exact JSON path for cost models in the Ogmios
  `queryLedgerState/protocolParameters` response (`plutusCostModels`
  vs `plutus_cost_models` vs `plutusV3`-style flat keys). The first
  implementation slice opens an Ogmios WebSocket to Yaci, prints the
  response, and writes the confirmed key path into the helper. The
  research note above is rewritten if the shape differs.
- That Yaci DevKit's bundled Ogmios version supports
  `queryLedgerState/protocolParameters`. If not, the integration test
  for SC-004 must run against a `cardano-node` + standalone `ogmios`
  pair instead of Yaci-bundled, and `just test-all` grows a service
  prerequisite.
- That `@sidan-lab/sidan-csl-rs-nodejs` is bundled with the installed
  `@meshsdk/core@1.8.14` and is available at runtime in both dev and
  production environments. Verified: `package.json` and
  `node_modules` confirm it is a transitive dependency of
  `@meshsdk/core-csl`.

If any of these assumptions break, the plan and tasks are updated
*before* further implementation slices.
