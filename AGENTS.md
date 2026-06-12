# Repository Agent Guide

## What this repo is

MPFS (Merkle Patricia Forestry Service) is a Cardano-native HTTP service for
verifiable key-value stores. It has two halves: an **on-chain** Aiken validator
under `on_chain/` (the "cage" that mints MPF tokens and validates `boot`,
`update`, `end`, and `retract`), and an **off-chain** TypeScript service under
`off_chain/` that builds those transactions, indexes the chain via Ogmios, and
serves everything over HTTP. The service is *signingless*: every endpoint
returns an unsigned CBOR transaction that the caller signs and submits back. It
targets Cardano preprod and is a proof of concept.

## How to work here

The toolchain comes from the Nix dev shell; tasks run through `just`.

```bash
nix develop                 # Node.js/npm, Aiken, cardano-node/cli, yaci, mkdocs

just build-on-chain         # cd on_chain && aiken build
just check-on-chain         # cd on_chain && aiken check
just build-off-chain        # copy on_chain/plutus.json into off_chain, npm install
just test-all               # off-chain test suite (ava + vitest); needs Yaci + Ogmios
just format                 # prettier over off_chain/**/*.ts

mkdocs build --strict       # build the docs site (docs_dir: docs-mkdocs/)
```

Running the service from source:

```bash
cd off_chain && npm install
npx tsx src/service/signingless/main.ts --port 3000 \
    --provider yaci --yaci-store-host http://localhost:8080 \
    --ogmios-host http://localhost:1337 --database-path ./mpfs.db
```

Tests need Yaci Store (`:8080`), Yaci admin (`:10000`), and Ogmios (`:1337`)
running — `just run-yaci` / `just run-yaci-docker` start the Yaci devkit, or use
`just test-docker` to run the whole suite against a throwaway container.

Scope notes for agents:

- The state store is **LevelDB** (the `level` / `abstract-level` packages), not
  a SQL database.
- Only the **signingless** service is current. `off_chain/src/service/cli`
  still imports a removed `signing/` module and does not run; do not present it
  as a working CLI.
- API request bodies: insert takes `{key, newValue}`, delete takes
  `{key, oldValue}`, update takes `{key, oldValue, newValue}` (renamed in
  v1.1.0). The served `openapi.json` still advertises a `{key, value}` body for
  insert/delete and is out of date relative to the handlers in
  `off_chain/src/service/signingless/http.ts`.

## Skills

Activatable procedures live under `skills/`. Load the one whose description
matches your task:

- `skills/mpfs-guide/` — how MPFS is laid out, how to build/test/run it, where
  the HTTP endpoints and on-chain operations are implemented, and where the
  answers to common user questions live.
