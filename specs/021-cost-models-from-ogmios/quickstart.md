# Quickstart: Verifying the Live Cost-Models Fix Locally

**Feature**: `specs/021-cost-models-from-ogmios/`
**Date**: 2026-05-18

This document is the operator's runbook for confirming the fix works
locally (Yaci) and on preprod (live boundary smoke). The PR must record
a live-preprod txid in its description before it is marked ready.

## Prerequisites

- `nix develop` shell from the repo root (provides aiken, node, yaci-cli,
  cardano-cli, cardano-node, etc.).
- Yaci DevKit running locally (`yaci-cli up --enable-yaci-store`,
  ports: yaci-store 8080, yaci-admin 10000, ogmios 1337).
- A funded preprod wallet matching the production token from issue #21
  (needed only for the live-boundary smoke).

## Step 1 — Run the focused test against Yaci

```bash
cd /code/mpfs-issue-21
nix develop --quiet -c just run-tests "cost-models"
```

Expected: the focused test (added in tasks T002–T003) passes. It
exercises two paths:

1. A pre-recorded tx hex + known-correct cost-models pair: the rewriter
   produces a known-correct `script_data_hash`. This catches regressions
   in the CBOR round-trip and the cost-model insertion order.
2. A pre-recorded tx hex + intentionally-wrong cost-models pair: the
   rewriter produces a hash *different* from the unfixed-code hash.
   This is the binary regression sentinel (SC-004).

If the test fails on a HEAD that reverts the fix, the gate is doing
its job.

## Step 2 — Run the full suite

```bash
nix develop --quiet -c just test-all
```

Expected: every existing transaction (boot, request, retract, update,
end) still submits successfully. No regression on the "Yaci's bundled
cost models happen to match Mesh's defaults" baseline (SC-005).

## Step 3 — Live-boundary smoke against preprod

This is the load-bearing one-time verification required by constitution
Principle III. Operator-driven; cannot run inside the automated suite.

```bash
# 1. Point MPFS at a preprod-connected Ogmios.
export OGMIOS_URL=wss://preprod-ogmios.example
export PROVIDER_HOST=…           # whatever yaci-store-equivalent provider is in use

# 2. Build MPFS off the patched code.
( cd off_chain && npm install )

# 3. Run moog retract against the failing production token from #21.
moog retract --token <production-token-id> --output-dir /tmp/retract-21

# 4. Watch the submitted txid land on-chain.
cardano-cli conway query tx-mempool --testnet-magic 1 \
  --tx-id "$(jq -r '."tx-hash"' /tmp/retract-21/log.json)"
# Expected: tx leaves the mempool, then:
cardano-cli conway query utxo --testnet-magic 1 --tx-in <retracted-input>
# Expected: the request UTxO is gone (proof of retraction).
```

Record the txid in the PR description (FR-008, SC-002). If the tx is
rejected with `ogmios 3113`, the fix has not actually worked — *do not
mark the PR ready*; rerun the diagnostic loop.

## Step 4 — Confirm the log shape

In the MPFS logs from Step 3, find the structured log entry for the
retract tx and confirm it carries the cost-models digest line:

```text
{"event":"live_cost_models","source":"ogmios", "ogmios_url":"...",
 "lengths":{"v1":332,"v2":332,"v3":350}, "digest":"sha256:..."}
```

If this line is missing for a script-bearing tx, FR-006 is not
satisfied — open the gate back up.

## What "done" looks like

- `just run-tests "cost-models"` green locally.
- `just test-all` green locally.
- One preprod txid recorded in the PR description, observable via a
  block explorer or `cardano-cli query utxo`.
- One structured log entry per script-bearing tx, with `lengths` and
  `digest`.
- No `ogmios 3113` errors in preprod logs over the 24-hour observation
  window post-deploy.

## Latest verified run

**2026-05-18** — `moog retract` against the production token from
issue #21, executed against `mpfs.plutimus.com` running
`ghcr.io/cardano-foundation/mpfs/mpfs:issue-21-fe14058c` (the patched
image built off this branch's tip).

- **Retracted request**: `6ba164a16e7e8a73d176117dd01c48e1b23baacfe9f00edca1c626a0fa9a33cb#0`
  (an agent-owned request stuck on `UpdateTestRunFailure /
  keyDoesNotExist`).
- **Retract txid**: [`1ebceec995b900a84b5c3bbd25c271441c4053f137f6aefd28d7e0470547d1b0`](https://preprod.cardanoscan.io/transaction/1ebceec995b900a84b5c3bbd25c271441c4053f137f6aefd28d7e0470547d1b0)
- **Token after retract**: the request is gone from `moog token`'s
  pending list; the two remaining requests are unchanged.
- **`live_cost_models` log entry captured at build time**:

  ```json
  {
    "ts":         "2026-05-18T15:19:07.968Z",
    "level":      "info",
    "msg":        "live_cost_models",
    "source":     "ogmios",
    "ogmios_url": "http://ogmios-preprod:1337",
    "lengths":    { "v1": 332, "v2": 332, "v3": 350 },
    "digest":     "sha256:8430db226d71e399a2bb0e119e983b36f252fc7da25f339b444d0de792255ec2"
  }
  ```

  The `lengths` match the post-bump preprod cost-model vectors from
  the issue body (V1: 166→332, V2: 175→332, V3: missing→350). The
  fix is sourcing the correct values from the live chain at
  tx-build time — exactly the path the unfixed code missed.

- **Build → submit latency**: ~32 ms between the `live_cost_models`
  log line (15:19:07.968) and `tx_submit_ok` (15:19:08.000). Cost
  to the wrapper is dominated by the Ogmios round-trip and is small
  relative to overall tx-build time.

This is the load-bearing constitution-Principle-III evidence
required by SC-002. The fix is verified end-to-end against the
chain whose enacted cost models broke MPFS in production.

### Recovery of the oracle crash-loop (same deploy)

The same image was deployed to the internal MPFS instance the
moog oracle talks to (`10.1.21.21:3000` behind the cf-systems
jumpbox). The oracle had been crashing at `MPFS.hs:87:29` on every
poll cycle. Once the patched MPFS came up, the oracle picked up
the two remaining validated requests and pushed them through the
chain in two successive batch-update txs, both built via the new
wrapper:

| Batch tx | Inputs | Outputs | Redeemers | Size | `live_cost_models` ts |
|---|---|---|---|---|---|
| [`9505ae23…918e7cf10`](https://preprod.cardanoscan.io/transaction/9505ae231c2a8786ab5906579343d2d201fe73f3b3d90f1334e2a1b918e7cf10) | 2 | 2 | 2 | 6,708 bytes | 2026-05-18T15:26:14.447Z |
| [`d4b433b5…f2c4bb68`](https://preprod.cardanoscan.io/transaction/d4b433b56c38738649682edd3eb2f200c6d24bfcc77a470e1d2304c7f2c4bb68) | 2 | 2 | 2 | 6,781 bytes | 2026-05-18T15:26:57.526Z |

After both confirmed, the token state was:

```json
{
  "root":     null,
  "requests": 0,
  "state": {
    "owner": "1f5cebecb4cd1cad6108a86014de9d8f23f9d4477bbddb3e1289b224",
    "root":  "c08ed8e2c7322968405c1803af093ded833f5ef1db2893e01ccf327ec436c17b"
  }
}
```

Oracle logs flipped to `Sleeping for 30 seconds...` (idle) — the
crash-loop from `MPFS.hs:87:29` is over. The fix unsticks the
oracle without any change to moog itself; the bug was always in
the off-chain tx-builder path MPFS exposed.
