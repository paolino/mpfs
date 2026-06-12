# Introduction to MPFS

## Merkle Patricia Forestry

A Merkle Patricia Forestry (MPF) is a data structure that allows storing key-value pairs (facts) in a verifiable and immutable way on a blockchain.
For a primer on MPF, see [CF Presentation](https://cardanofoundation.org/blog/merkle-patricia-tries-deep-dive).

Storing facts inside an MPF provides cryptographic proofs of inclusion and exclusion for each fact, allowing anyone to verify the integrity of the data. When an MPF is available inside a UTxO on the Cardano blockchain, transactions can refer to it as input to pass smart contract validation.

How to provide and access MPF's facts and how to publish the MPF root is left to be decided.
MPFS takes some decisions to provide a complete solution to manage MPF tokens on Cardano.

### Design choices to run MPF on Cardano

- All modifications to an MPF root have to appear on-chain. This gives anyone with access to the blockchain history the ability to reconstruct the full history of changes and so the current facts.
- All modifications must be consumed under a smart contract validation. This eliminates the burden to prove that an MPF contains only facts that are the result of modifications that have been on chain.
- MPF are owned. This gives the smart contract the ability to operate on multiple MPF tokens, each controlled by a different user. Products of MPF roots and owners are referred to as MPF tokens from now on.
- MPF token can be modified only by their owner. This gives full control to the owner on which facts are part of the MPF token. The owner of an MPF token is referred to as `oracle` from now on.
- MPF tokens have a unique identifier. This gives the ability to address a specific MPF token inside a modification.
- Specific MPF modifications are owned. This gives the modification requester the ability to retract modifications if they are not accepted by the owner. The owner of a modification request is referred to as `requester` from now on.

## MPFS: the service

_MPFS_ is an http service wrapping:

- MPF operations from the [Merkle Patricia Forestry library](https://github.com/aiken-lang/merkle-patricia-forestry) in one smart contract to track and validate each MPF history of changes
- An off-chain transaction builder that helps building transactions to interact with the smart contract
- An indexer over the smart contract events to reconstruct and serve the MPF state

It is designed to be used by anyone who wants to store and manage knowledge in a decentralized manner, allowing contributors to add or remove facts while ensuring the integrity and history of the knowledge database.

It is particularly useful for applications that require a verifiable and immutable record of knowledge, such as decentralized applications (dApps), knowledge management systems, and collaborative platforms.

The repository ships the **signingless** service: it builds and balances
transactions and delegates signing to the caller. Every endpoint returns an
unsigned CBOR transaction that the user signs locally and submits back, so the
service never holds a private key. This makes it suitable for shared, public
deployments — the operator only has to protect the instance from abuse, not
custody anyone's keys.

## Quick Links

- [Getting Started](getting-started.md) - Installation and setup
- [Architecture](architecture.md) - System design and components
- [Signingless Manual](manual/signingless.md) - Production API usage guide
- [API Reference](swagger-ui.md) - OpenAPI documentation
