# Feature Specification: Live Plutus Cost Models for MPFS Transaction Building

**Feature Branch**: `fix/issue-21-cost-models-from-ogmios`
**Created**: 2026-05-18
**Status**: Draft
**Input**: GitHub issue [cardano-foundation/mpfs#21](https://github.com/cardano-foundation/mpfs/issues/21)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator submits a script tx after a cost-model bump (Priority: P1)

As an MPFS operator (oracle, requester, agent), I submit a script-bearing
transaction — oracle batch update, requester retract, agent accept — against
a Cardano chain whose enacted Plutus cost models differ from the
`@meshsdk/core` bundled defaults, and the transaction is accepted by the
node and confirmed on-chain.

**Why this priority**: This is the only failure mode the ticket addresses,
and it is currently a production outage: as of 2026-05-16 (preprod epoch
289 boundary) the live oracle is in a crash-loop because every script tx
it builds is rejected with `ogmios 3113 (provided vs. computed script
integrity mismatch)`. Without this story, MPFS cannot operate on a chain
that has enacted any Plutus cost-model parameter change — past or future.

**Independent Test**: Point MPFS at any Cardano network (DevKit or
preprod) whose currently-enacted Plutus cost models do not byte-for-byte
match the `DEFAULT_V1/V2/V3_COST_MODEL_LIST` constants in the linked
`@meshsdk/common` version. Trigger any script-bearing operation. The tx
is submitted and confirmed (no `ogmios 3113`, no script integrity hash
mismatch).

**Acceptance Scenarios**:

1. **Given** a network whose currently-enacted Plutus cost models differ
   from Mesh's bundled defaults (at minimum: vector length differs, or
   any element differs), **When** the operator triggers a script-bearing
   MPFS operation, **Then** the resulting transaction's script-data hash
   matches the node's computed hash and the tx is accepted by the node
   (no `ogmios 3113`).
2. **Given** a network whose currently-enacted Plutus cost models are
   byte-for-byte identical to Mesh's bundled defaults, **When** the
   operator triggers a script-bearing MPFS operation, **Then** the tx
   continues to succeed (regression baseline: this PR must not break
   the previously-working case).
3. **Given** the live Ogmios endpoint returns cost models including
   PlutusV3, **When** MPFS builds a tx that references a PlutusV3
   script, **Then** the V3 cost model is propagated into Mesh's view
   of protocol parameters (no silent fallback to a missing/empty
   `DEFAULT_V3_COST_MODEL_LIST`).

### User Story 2 - Operator retracts a stuck production request (Priority: P1)

As the on-call MPFS operator, after this fix lands I run `moog retract`
(or equivalent recovery command) against the production token whose
request triggered the crash-loop, and the retraction is accepted by the
chain — closing out the incident from issue #21.

**Why this priority**: This is the named manual proof in the issue's
acceptance criteria. Without it we have no end-to-end confirmation that
the code change resolved the real-world failure, only that synthetic tests
pass.

**Independent Test**: With MPFS rebuilt off this PR, attempt the
production retract from a previously-affected token. The tx confirms; the
oracle exits its crash-loop without intervention; no further
`ogmios 3113` log lines appear for that token.

**Acceptance Scenarios**:

1. **Given** a production token in the failing state that triggered issue
   #21, **When** the operator runs `moog retract` against it using a
   patched MPFS build, **Then** the retract tx is submitted and confirmed
   on-chain.
2. **Given** the patched MPFS is restarted from the crash-loop state,
   **When** the queued operations replay against the patched code,
   **Then** the oracle processes them without ledger rejection.

### Edge Cases

- **Ogmios endpoint is unreachable at tx-build time.** Tx build must fail
  fast with a diagnostic that names the missing live source, not silently
  fall through to bundled defaults. Falling back to defaults reproduces
  the bug the fix is supposed to remove.
- **Ogmios returns a partial cost-model set** (e.g., only V1+V2, no V3,
  on a network that has not enacted V3). Tx build for a script of the
  missing language version must fail with a diagnostic; tx build for
  available versions proceeds normally.
- **Cost models change between successive tx builds in the same MPFS
  process.** Each tx build must observe the currently-enacted cost
  models, not a value cached from process start. Caching is allowed only
  if the cache key includes the chain tip (or an equivalent
  invalidation signal).
- **Chain enacts a future cost-model parameter change** (e.g., a CIP-XXX
  rollout extending PlutusV3 to 360+ elements). MPFS must continue
  building correct txs without a code change, because the values are
  sourced from the live chain.
- **MPFS is run against Yaci DevKit** (used in `just test-all`). Yaci's
  Ogmios endpoint is the same surface as preprod's, so the same fetch
  path serves both environments. No DevKit-specific branch.
- **The `@meshsdk/core` API surface for injecting protocol parameters
  changes between minor versions.** This spec does not pin behavior to a
  specific Mesh API; it pins the *observable outcome* (script-data hash
  matches node).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: MPFS MUST source the currently-enacted Plutus cost models
  (V1, V2, V3, and any future version) from a live ledger-state source at
  the moment each script-bearing transaction is built.
- **FR-002**: MPFS MUST configure the transaction builder so that the
  cost models used to compute `script_data_hash` are the ones from
  FR-001, not bundled SDK defaults.
- **FR-003**: MPFS MUST NOT silently fall back to bundled or hardcoded
  cost models when the live source is unavailable or incomplete. A
  failure to obtain current cost models MUST surface as a transaction-
  build failure with a diagnostic that names the missing source.
- **FR-004**: MPFS MUST handle cost-model vectors of arbitrary length
  (lengths grow as the chain enacts Plutus-primitive rollouts; see CIPs
  109/132/133/138/153). No fixed-length assumption may be encoded in
  MPFS code.
- **FR-005**: MPFS MUST handle a missing PlutusV3 cost model in the live
  source gracefully (no crash on undefined access). V3 absence is valid
  on networks that have not enacted V3; V3 absence is a failure only
  when a V3 script is referenced by the tx.
- **FR-006**: MPFS MUST log the source, era, and a stable digest (e.g.,
  per-language length and a hash) of the cost models used to build each
  submitted tx, so post-incident triage can confirm which cost-model
  vector produced a given hash.
- **FR-007**: An automated test in the repository MUST exercise FR-001
  through FR-006 against the local Yaci DevKit (boots ogmios alongside
  yaci-store) and MUST be runnable via the existing `just test-all`
  surface — no new manual setup beyond what the test suite already
  requires.
- **FR-008**: The fix MUST be verified once on live preprod against the
  production token whose request triggered issue #21, with the
  resulting txid recorded in the PR description as evidence (live-
  boundary smoke per the project constitution, Principle III).

### Key Entities

- **Cost model**: a per-Plutus-language vector of integers, defined by
  the ledger, that the script evaluator and the script-integrity hash
  function consume. Length and contents are chain-enacted and change
  over time as new Plutus primitives are added.
- **Script-data hash**: a hash committed into every transaction that
  bears a script. Its inputs include datums, redeemers, and the cost
  models for languages used by the tx. Tx submission is rejected if the
  hash the builder commits to differs from the hash the node computes
  over the same inputs.
- **Live ledger-state source**: an endpoint (e.g., Ogmios's
  `queryLedgerState/protocolParameters`) that returns the
  currently-enacted protocol parameters, including cost models, as of
  the tip of the chain the node is synced to.
- **MPFS operator role**: the actor (oracle, requester, agent) that
  triggers a script-bearing tx via the MPFS off-chain service. Distinct
  operator roles do not have distinct cost-model behavior; the fix
  applies uniformly to all script-bearing operations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero `ogmios 3113 — provided vs. computed script
  integrity mismatch` errors from MPFS-built transactions against any
  network whose enacted cost models differ from Mesh's bundled defaults
  (measured: count of such errors in production logs over the 7 days
  following deploy is zero).
- **SC-002**: The production token retract from issue #21 confirms
  on-chain on the first attempt after deploy (measured: a single txid
  recorded in the PR description, observable via cardano-cli).
- **SC-003**: When the chain enacts the next Plutus cost-model
  parameter change (a future event, not under our control), MPFS
  continues to build successful script txs without a code change
  (measured: continued successful operation across the enactment epoch
  boundary, with no operator intervention required).
- **SC-004**: The automated test added in FR-007 fails on the unfixed
  code path and passes on the fixed one (measured: the test is observed
  failing on a HEAD that reverts the fix, and passing on the merged
  HEAD).
- **SC-005**: No regression on environments where Mesh's bundled
  defaults happen to match the chain (measured: existing
  `just test-all` suite remains green).

## Assumptions

- The MPFS deployment has, or can be configured to have, network access
  to an Ogmios endpoint synced to the same node it already relies on
  for `evaluateTransaction`. Constitution Principle I already commits us
  to a live Ogmios; this spec assumes that endpoint exposes the
  `queryLedgerState/protocolParameters` (or equivalent) method.
- Yaci DevKit's bundled Ogmios exposes the same query surface as
  upstream Ogmios, sufficient for the automated test in FR-007. (If
  not, FR-007 may need to fall back to a live preprod boundary smoke,
  and the assumption gets recorded as a research finding in the plan
  phase.)
- The fix does not require upgrading `@meshsdk/core` past its current
  major version (consistent with the issue's non-goals). Whatever API
  surface Mesh exposes today for injecting protocol parameters is
  sufficient. If Mesh's current API does not allow this, the plan phase
  must surface that and choose between a minor Mesh bump, a wrapper
  layer, or a different injection point (e.g., post-build cost-model
  rewrite).
- The cost models returned by the live source are in a representation
  that is — possibly after a deterministic conversion — directly
  consumable by Mesh's script-data-hash computation. If a representation
  conversion is required (e.g., named-map ↔ ordered-array), the plan
  phase will name the conversion and ensure it is exercised by the test
  in FR-007.
- The fix is forward-only: there is no plan to keep working on the
  old, broken code path under a feature flag. Once merged, MPFS always
  uses the live source.
