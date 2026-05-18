#!/usr/bin/env bash
# Mechanical gate for PR #21 (cost models from Ogmios).
# Subagents must pass this before returning a commit;
# the orchestrator re-runs it on review.
#
# This is the bootstrap gate: on-chain check/build + off-chain
# lint. It will be extended (`chore: extend gate.sh ...`) as the
# plan adds focused tests and a live-boundary smoke for the
# script-data-hash invariant.

set -euo pipefail
cd "$(dirname "$0")"

# 1. Whitespace / merge marker check.
git diff --check

# 2. On-chain: validators still type-check and build.
( cd on_chain && aiken check && aiken build )

# 3. Off-chain: lint passes.
( cd off_chain && npx --no-install eslint . )
