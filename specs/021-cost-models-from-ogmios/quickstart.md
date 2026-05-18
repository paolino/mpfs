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
