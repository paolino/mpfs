---
name: mpfs-guide
description: >-
  Orient an agent inside the cardano-foundation/mpfs repository (Merkle Patricia
  Forestry Service). Load this when working on MPFS: the Aiken "cage" validator
  in on_chain/ (cage.ak, types.ak, lib.ak; mpfCage minting + spending,
  MintRedeemer Minting/Burning, UpdateRedeemer End/Contribute/Modify/Retract,
  Operation Insert/Delete/Update), or the off-chain TypeScript service in
  off_chain/ (Express HTTP API in src/service/signingless/http.ts, transaction
  builders in src/transactions/{boot,request,update,retract,end}.ts, the
  Ogmios-driven indexer in src/indexer/, the MPF trie manager in src/trie/, and
  the wallet/cli helpers in src/service/). Use it for questions about the HTTP
  endpoints (/tokens, /token/{id}, /token/{id}/facts, /config, boot-token,
  request-insert, request-delete, request-update, update-token, retract-change,
  end-token, POST /transaction), the request body fields (newValue / oldValue),
  building/testing with nix develop + just + aiken + ava/vitest, running the
  signingless service with tsx, Yaci Store / Ogmios / cardano-node dependencies,
  LevelDB state, or the mkdocs docs under docs-mkdocs/. Keywords: MPF, oracle,
  requester, caged token, signingless, plutus.json, mpfs.plutimus.com.
---

# MPFS guide

MPFS manages verifiable key-value stores (facts) on Cardano. An owner (the
*oracle*) controls an MPF token whose datum holds a Merkle Patricia Forestry
root; contributors (*requesters*) submit change requests; the oracle folds them
into the root under smart-contract validation. The service is signingless — it
returns unsigned CBOR that the caller signs and submits back.

## Repository map

| Path | Purpose |
| --- | --- |
| `on_chain/validators/cage.ak` | The `mpfCage` validator: minting policy + spending validator |
| `on_chain/validators/types.ak` | On-chain types: `Mint`, `MintRedeemer`, `UpdateRedeemer`, `State`, `Operation`, `Request`, `CageDatum` |
| `on_chain/validators/lib.ak` | `TokenId` + token helpers (`quantity`, `assetName`, `valueFromToken`, `tokenFromValue`, `extractTokenFromInputs`) |
| `on_chain/plutus.json` | Compiled blueprint; copied to `off_chain/src/plutus.json` by `just build-off-chain` |
| `off_chain/src/service/signingless/` | The shipped service: `main.ts` (CLI entry), `http.ts` (Express routes), `public/openapi.json` |
| `off_chain/src/service/wallet.ts` | Local wallet helper: `create-wallet`, `reveal-address`, `sign-transaction` |
| `off_chain/src/service/cli/` | Interactive REPL client — imports a removed `signing/` module; does not run |
| `off_chain/src/transactions/` | Transaction builders: `boot.ts`, `request.ts`, `update.ts`, `retract.ts`, `end.ts`, plus `context.ts` |
| `off_chain/src/indexer/` | Ogmios-driven indexer and on-disk state (tokens, requests, rollbacks, checkpoints) |
| `off_chain/src/trie/` | MPF trie manager and proof generation (`safeTrie.ts`, `proof.ts`, `change.ts`) |
| `off_chain/src/mpf/` | Vendored `merkle-patricia-forestry` JS library |
| `docs-mkdocs/` | Documentation site (mkdocs; `docs_dir` in `mkdocs.yml`), published by `.github/workflows/publish-docs.yml` |
| `docs/` | Abandoned Docusaurus scaffold — not built or published; ignore it |

## Build, test, run

All tools come from `nix develop`; tasks run through `just` (see `justfile`).

```bash
nix develop
just check-on-chain      # aiken check (on_chain/)
just build-on-chain      # aiken build (on_chain/)
just build-off-chain     # copy plutus.json into off_chain, npm install
just test-all            # ava + vitest; needs Yaci Store/admin + Ogmios up
just format              # prettier over off_chain/**/*.ts
mkdocs build --strict    # build the docs site
```

Tests expect Yaci Store on `:8080`, Yaci admin on `:10000`, Ogmios on `:1337`.
`just run-yaci` (or `just run-yaci-docker`) starts the Yaci devkit; `just
test-docker` runs the whole suite against a throwaway container.

Run the service from source:

```bash
cd off_chain && npm install
npx tsx src/service/signingless/main.ts --port 3000 \
    --provider yaci --yaci-store-host http://localhost:8080 \
    --ogmios-host http://localhost:1337 --database-path ./mpfs.db \
    --since-slot <slot> --since-block-id <block-hash>
```

CLI flags are defined in `src/service/signingless/main.ts` (`--port`,
`--provider blockfrost|yaci`, `--blockfrost-project-id`, `--yaci-store-host`,
`--yaci-admin-host`, `--ogmios-host`, `--database-path`, `--logs-path`,
`--since-slot`, `--since-block-id`). State is stored in LevelDB at
`<database-path>/<port>`.

## Navigating the code

- **HTTP endpoints**: every route is registered in `mkAPI()` in
  `off_chain/src/service/signingless/http.ts`. Each transaction route delegates
  to a builder in `src/transactions/` and returns `{ unsignedTransaction, ... }`.
- **Transaction building**: start at `src/transactions/context.ts` (`Context`
  bundles script info, wallet access, state queries, trie access, submit). Each
  operation has its own module (`boot.ts`, `request.ts`, `update.ts`,
  `retract.ts`, `end.ts`).
- **On-chain validation**: `on_chain/validators/cage.ak`. `mint` dispatches on
  `MintRedeemer` (`Minting`/`Burning`); `spend` dispatches on `UpdateRedeemer`
  (`Retract`, `Contribute`, then `Modify`/`End` for State datums). The MPF fold
  lives in `mkUpdate` / `validRootUpdate`.
- **Indexer & state**: `src/indexer/indexer.ts` consumes Ogmios chain-sync;
  `src/indexer/state/` holds tokens, requests, rollbacks, and checkpoints.
- **Proofs**: `src/trie/safeTrie.ts` applies a change to a local trie copy,
  captures the proof, and rolls back; `update.ts` uses this for the `Modify`
  redeemer.

## Using MPFS (the HTTP API)

Base URL of the public preprod instance: `https://mpfs.plutimus.com`. All
transaction endpoints return `unsignedTransaction` (CBOR) to be signed and
submitted via `POST /transaction`.

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/tokens` | lists tokens; includes `indexerStatus` (tips) |
| GET | `/token/{tokenId}` | token state + pending `requests` |
| GET | `/token/{tokenId}/facts` | all facts in the token's MPF |
| GET | `/config` | cage address, policyId, blueprint |
| GET | `/transaction/{address}/boot-token` | returns `{unsignedTransaction, value}` (value = new token id) |
| POST | `/transaction/{address}/request-insert/{tokenId}` | `{ "key", "newValue" }` |
| POST | `/transaction/{address}/request-delete/{tokenId}` | `{ "key", "oldValue" }` |
| POST | `/transaction/{address}/request-update/{tokenId}` | `{ "key", "oldValue", "newValue" }` |
| GET | `/transaction/{address}/update-token/{tokenId}?request=<ref>` | one `request` query param per request consumed |
| GET | `/transaction/{address}/retract-change/{requestId}` | requestId is `txHash-index` |
| GET | `/transaction/{address}/end-token/{tokenId}` | destroy the token |
| POST | `/transaction` | `{ "signedTransaction" }` → `{ txHash }` |
| GET | `/transaction?txHash=<hash>` | tx info, 404 if unknown |
| GET | `/wait/{n}` | wait for n blocks |

The request body field names changed in v1.1.0 (insert `value` → `newValue`,
delete `value` → `oldValue`). A full worked walkthrough is in
`docs-mkdocs/manual/signingless.md`.

## Answering questions

- **"What is MPFS / how does it work?"** → README "What is this" and
  `docs-mkdocs/index.md`; the parties (oracle, requester, observer) and the
  boot/update/end/retract flow are in `docs-mkdocs/architecture.md`.
- **"How do I install / run it?"** → README Install/Quickstart and
  `docs-mkdocs/getting-started.md`. Current image tag: `v1.3.0`.
- **"What endpoints exist / what body do I send?"** → README Usage table,
  `docs-mkdocs/swagger-ui.md`, and the routes in `http.ts`. The live OpenAPI is
  at `https://mpfs.plutimus.com/api-docs`.
- **"What does the validator enforce?"** → `docs-mkdocs/code/on-chain.md` and
  `on_chain/validators/cage.ak`.
- **"How is the off-chain service structured?"** → `docs-mkdocs/code/off-chain.md`
  and `src/transactions/context.ts`.
- **Version / history** → `off_chain/CHANGELOG.md` and GitHub releases (latest
  `v1.3.0`). Note `off_chain/package.json` may lag the release tag.
