# Data Model: Live Plutus Cost Models for MPFS Transaction Building

**Feature**: `specs/021-cost-models-from-ogmios/`
**Date**: 2026-05-18

This feature has a thin data-flow surface — no persistent storage, no
new schemas, no on-chain data shape change. The model below names the
in-memory entities the implementation slices will touch.

## Entities

### `OgmiosProtocolParameters`

What we receive over the WebSocket from Ogmios's
`queryLedgerState/protocolParameters` reply. Domain shape (subset):

| Field                | Type            | Meaning                                |
|---------------------|-----------------|----------------------------------------|
| `plutusCostModels`  | object          | Per-language cost models               |
| ↳ `plutus:v1`       | int[]           | V1 cost vector (currently 332 elems)   |
| ↳ `plutus:v2`       | int[]           | V2 cost vector (currently 332 elems)   |
| ↳ `plutus:v3`       | int[] \| absent | V3 cost vector (currently 350 elems)   |

The implementation only consumes `plutusCostModels`; other fields in
the response are ignored. Exact JSON key spelling is confirmed by an
exploratory Ogmios call in the first slice; this document is rewritten
if the keys differ on the Ogmios version Yaci ships.

Validation:

- At least one of V1/V2/V3 must be present, *if* the tx uses any
  Plutus language. Otherwise the helper raises
  `LiveCostModelsUnavailable`.
- Each `int[]` must be non-empty. An empty vector is treated as
  "language absent" (defensive — protocol-allowed today, may not be in
  future).

### `LiveCostModels`

In-memory wrapper produced by `fetchLiveCostModels(ogmios)`. Hidden
field is a `Costmdls` value from `@sidan-lab/sidan-csl-rs-nodejs`,
populated by per-language insertion (see research.md Q4). Exposed for
logging:

| Field         | Type    | Meaning                                                  |
|---------------|---------|----------------------------------------------------------|
| `digest()`    | string  | Short hash for log lines (FR-006)                        |
| `lengths()`   | object  | `{ v1?: number, v2?: number, v3?: number }`              |
| `costMdls()`  | Costmdls| WASM-side handle, consumed by the hash rewriter          |

### `ScriptDataHashRewrite`

A pure function:

```text
recomputeScriptDataHash(txHex: string, costModels: LiveCostModels) -> string
```

Inputs:

- `txHex` — hex-encoded unsigned transaction from `MeshTxBuilder.complete()`.
- `costModels` — live `LiveCostModels` value.

Output:

- New hex-encoded unsigned transaction CBOR, identical to the input
  except `script_data_hash` in the body has been recomputed.

Pre-conditions:

- Input is a valid CBOR-encoded Transaction.
- If the transaction has no redeemers and no Plutus scripts, this
  function MUST be a no-op (returns the input unchanged). Caller is
  expected to short-circuit before calling, but the function is
  defensive.

Post-conditions:

- The output decodes to a Transaction whose `body.script_data_hash`
  equals `hash_script_data(redeemers, costModels.costMdls(), datums)`.
- Witness set and auxiliary data are byte-identical to the input.

## Error model

| Error                          | Raised when                                                       |
|--------------------------------|-------------------------------------------------------------------|
| `LiveCostModelsUnavailable`    | Ogmios connection failed / timed out                              |
| `LiveCostModelsIncomplete`     | A Plutus language version used by the tx is missing in the reply  |
| `ScriptDataHashRewriteError`   | CBOR decode / re-encode failure                                   |

All three failures abort the tx build with a diagnostic that names the
Ogmios endpoint (FR-003). None of them silently fall through to bundled
defaults.

## Log shape

Every script-bearing build emits one structured log entry covering the
cost-models source (FR-006):

```json
{
  "event": "live_cost_models",
  "source": "ogmios",
  "ogmios_url": "ws://localhost:1337",
  "lengths": { "v1": 332, "v2": 332, "v3": 350 },
  "digest": "sha256:7f12…"
}
```

The digest is a hash of the canonical CBOR of `Costmdls` (matches what
flows into `hash_script_data`). The digest lets post-incident triage
correlate a tx hash with the cost-model vector that built it without
exposing the full vectors in every log line.
