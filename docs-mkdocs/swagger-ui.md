# API Reference

## Live API Documentation

The interactive API documentation is available at:

**[https://mpfs.plutimus.com/api-docs](https://mpfs.plutimus.com/api-docs)**

A public preprod instance is running at [https://mpfs.plutimus.com](https://mpfs.plutimus.com).

## API Overview

### Configuration

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/config` | GET | Get service configuration including network and policy ID |

### Tokens

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tokens` | GET | List all tracked MPF tokens |
| `/token/{tokenId}` | GET | Get details of a specific token |
| `/token/{tokenId}/facts` | GET | Get all facts stored in a token's MPF |

### Transactions

All transaction endpoints return unsigned CBOR transactions that must be signed by the user's wallet.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/transaction/{address}/boot-token` | GET | Build a transaction to create a new MPF token |
| `/transaction/{address}/request-insert/{tokenId}` | POST | Build a transaction to request inserting a fact |
| `/transaction/{address}/request-update/{tokenId}` | POST | Build a transaction to request updating a fact |
| `/transaction/{address}/request-delete/{tokenId}` | POST | Build a transaction to request deleting a fact |
| `/transaction/{address}/update-token/{tokenId}` | GET | Build a transaction to process pending requests |
| `/transaction/{address}/retract-change/{outputRef}` | GET | Build a transaction to retract a pending request |
| `/transaction/{address}/end-token/{tokenId}` | GET | Build a transaction to destroy a token |
| `/transaction` | POST | Submit a signed transaction |
| `/transaction` | GET | Get transaction info by hash |

### Status

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/wait/{nBlocks}` | GET | Wait for the given number of blocks |

The current network and indexer tips are returned alongside the token list by
`GET /tokens` (in the `indexerStatus` field); there is no standalone `/tips`
endpoint.

## Authentication

The API is public and does not require authentication. However, all state-changing operations require transaction signatures from the user's wallet.

## Error Handling

The API returns standard HTTP status codes:

- `200`: Success
- `400`: Bad request (invalid parameters)
- `404`: Resource not found
- `500`: Internal server error

Error responses include a JSON body with `error` and `details` fields.

## OpenAPI Specification

The full OpenAPI specification is available at:

- **Live**: [https://mpfs.plutimus.com/api-docs](https://mpfs.plutimus.com/api-docs)
- **JSON**: [openapi.json](https://github.com/cardano-foundation/mpfs/blob/main/off_chain/src/service/signingless/public/openapi.json)
