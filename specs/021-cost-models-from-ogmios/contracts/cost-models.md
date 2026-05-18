# Contract: Cost-Models Fetch + Script-Data-Hash Rewrite

**Feature**: `specs/021-cost-models-from-ogmios/`
**Date**: 2026-05-18

This is the internal contract every slice in `tasks.md` must respect.
No public HTTP/RPC surface changes; the contracts here are internal
function signatures.

## Contract 1 — `fetchLiveCostModels`

```ts
function fetchLiveCostModels(ogmiosUrl: string): Promise<LiveCostModels>
```

- Opens a WebSocket to `ogmiosUrl`.
- Sends JSON-RPC `queryLedgerState/protocolParameters` with no params.
- On reply, parses `plutusCostModels` and produces a `LiveCostModels`
  value (a thin wrapper over `Costmdls` from `@sidan-lab/sidan-csl-rs-nodejs`).
- Rejects with `LiveCostModelsUnavailable` if the WebSocket cannot be
  reached, the RPC errors, or the response omits `plutusCostModels`.
- Closes the WebSocket before resolving.

The function is idempotent across calls (same chain tip → same result).
No internal caching — each call is a fresh fetch (FR-001).

## Contract 2 — `recomputeScriptDataHash`

```ts
function recomputeScriptDataHash(txHex: string, costModels: LiveCostModels): string
```

Pure (no I/O). Identity on transactions without redeemers/datums; on
transactions with either, returns a tx whose `body.script_data_hash`
equals `hash_script_data(redeemers, costModels.costMdls(), datums)`.

Witness set, auxiliary data, and every other body field are byte-for-
byte preserved.

Throws `ScriptDataHashRewriteError` on CBOR decode/encode failure.

## Contract 3 — `getTxBuilder` (extension)

The current signature is unchanged:

```ts
function getTxBuilder(provider: Provider, ogmios: string): MeshTxBuilder
```

But the returned builder's `complete()` method is wrapped so that,
after the wrapped invocation, `builder.txHex` reflects the recomputed
script-data hash if the tx is script-bearing.

The wrapper:

- Calls the original `complete()` first (Mesh-side balancing,
  evaluation, etc., must run on the unrewritten body so the evaluator
  sees the correct redeemer budget surface).
- Detects whether the tx uses Plutus scripts (any redeemers present,
  or any V1/V2/V3 script witnesses present).
- If yes, fetches live cost models and rewrites the hash.
- If no, returns the original `txHex` unchanged.

All callers observe `builder.txHex` *after* `await tx.complete()` —
the wrapper preserves that contract by mutating `builder.txHex` in
place before the await resolves.

## Contract 4 — Error surfacing

Any error from contracts 1 or 2 raised inside the wrapped `complete()`
propagates as a rejection of `complete()`. No try/catch swallows the
error and falls through to the unrewritten `txHex`. The MPFS
transaction call site sees a build failure, not a misbuilt tx.

## Contract 5 — Logging

Each successful run of the wrapper emits one log entry (see data-model
"Log shape"). On failure, the existing tx-build error log captures the
typed error class (`LiveCostModelsUnavailable`,
`LiveCostModelsIncomplete`, `ScriptDataHashRewriteError`).

The log carries enough information (lengths + digest + ogmios URL) for
post-incident triage to confirm which cost-model vector produced a
given submitted tx (FR-006).

## What this contract does NOT promise

- It does not promise behavior on tx CBOR that was not produced by
  Mesh's CSLSerializer. The deserializer assumes the canonical CBOR
  shape; foreign tx bytes are out of scope.
- It does not promise to retry on transient Ogmios failures.
  `LiveCostModelsUnavailable` surfaces immediately. Retry policy is
  the caller's concern.
- It does not promise a cache. Every script-bearing build pays one
  WebSocket round-trip to Ogmios. Performance bound: dominated by
  Ogmios round-trip time (typically tens of ms locally, hundreds over
  the public preprod), which is small relative to existing tx-build
  time. If this ever becomes a hotspot, caching with a chain-tip
  invalidation key is a non-blocking follow-up.
