# Getting Started

## Pre-requisites

Being an HTTP service no particular skill is required to use it, but some knowledge of Cardano transactions and smart contracts is useful to understand how to interact with it.

Deployment has some external requirements:

1. [Yaci store](https://github.com/bloxbean/yaci-store). This is required to provide address to UTxO mapping. When building transactions the user will provide an address that he controls and wants to spend from. The service will use the Yaci store to find the UTxOs that are associated with that address and build the transaction accordingly.
2. [Ogmios](https://github.com/cardanoSolutions/ogmios). This is required to track the events involving the system address.
3. [Cardano node](https://github.com/intersectMBO/cardano-node). This is indirectly required by both Yaci store and Ogmios.

The MPFS service in itself is a TypeScript application so any Node.js supported platform should be able to run it. It is tested on Linux and macOS, but it should work on Windows as well.

## Docker

The image is available on ghcr.io and can be pulled with the command:

```bash
docker pull ghcr.io/cardano-foundation/mpfs/mpfs:v1.3.0
```

This is an example of a working deployment: [mpfs in CF](https://github.com/cardano-foundation/hal/blob/main/docs/deployment/mpfs/docker-compose.yml)

Consider sourcing [bootstrap.sh](https://github.com/cardano-foundation/hal/blob/main/docs/deployment/mpfs/bootstrap.sh) as mentioned in [setup instructions](https://github.com/cardano-foundation/hal/blob/main/docs/deployment/mpfs/README.md) to speedup the node syncing.

## From Source

Alternatively, you can run the service from source. To do so, you need to have Node.js and npm installed on your system. Then you can clone the repository and run the following commands:

```bash
git clone https://github.com/cardano-foundation/mpfs
cd mpfs/off_chain
npm install
npx tsx src/service/signingless/main.ts --port 3000 \
    --provider yaci --yaci-store-host http://localhost:8080 \
    --ogmios-host http://localhost:1337 \
    --database-path ./mpfs.db \
    --since-slot 94898393 \
    --since-block-id ef94934f8eb129ebf07eeaab007b81ecb1bc58b121d19ac0ffe81f928bf56cc
```

This will start the service on port 3000, using the Yaci store running on `http://localhost:8080` and the Ogmios server running on `http://localhost:1337`. The database will be stored in the file `mpfs.db` in the current directory. The `since-slot` and `since-block-id` parameters are used to specify the starting point for the service to track events.

!!! warning
    Be careful to start indexing before the token you are going to use was created. If you are creating a new token, just start from "now-ish".

## Usage

- [Signingless API Reference](swagger-ui.md)
- [Signingless Manual](manual/signingless.md)
