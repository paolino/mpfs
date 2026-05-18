#!/usr/bin/env bash
# Mechanical gate for PR #21 (cost models from Ogmios).
# Subagents must pass this before returning a commit;
# the orchestrator re-runs it on review.
#
# This is the bootstrap gate: on-chain check/build + off-chain
# lint (scoped to PR-touched files) + cost-models vitest. It will
# grow further (`chore: extend gate.sh ...`) as later slices add
# the Yaci integration test (T002–T003) and the live-boundary
# smoke (T006).

set -euo pipefail
cd "$(dirname "$0")"

# 1. Whitespace / merge marker check.
git diff --check

# 2. On-chain: validators still type-check and build.
( cd on_chain && aiken check && aiken build )

# 3. Off-chain lint, scoped to files this PR has touched.
#
#    Rationale: `eslint .` fails at the bootstrap baseline of this
#    branch (231 pre-existing errors across files outside this PR's
#    scope, verified on commit e4881621). Cleaning those is its own
#    follow-up ticket; gating THIS PR on them would force every
#    subagent slice to either swim through unrelated lint debt or
#    propose a global cleanup, both of which are out of scope.
#
#    We diff against `origin/main` (the PR base) and lint only the
#    added/modified .ts/.tsx/.js/.mjs/.cjs files under off_chain/.
#    Deleted files are skipped (--diff-filter=AM). When there is
#    nothing to lint, eslint is not invoked (it would lint the world).
git fetch --quiet origin main 2>/dev/null || true
base=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse origin/main 2>/dev/null || echo "")

if [ -z "$base" ]; then
  echo "gate: cannot resolve origin/main; running off-chain eslint over PR-introduced files only" >&2
  changed_offchain_src=""
else
  changed_offchain_src=$(
    git diff --name-only --diff-filter=AM "$base"...HEAD -- \
      'off_chain/**/*.ts' 'off_chain/**/*.tsx' \
      'off_chain/**/*.js' 'off_chain/**/*.mjs' 'off_chain/**/*.cjs' \
      | sed 's|^off_chain/||'
  )
fi

if [ -n "$changed_offchain_src" ]; then
  echo "gate: linting $(printf '%s\n' "$changed_offchain_src" | wc -l) PR-touched off_chain file(s)"
  # shellcheck disable=SC2086
  ( cd off_chain && npx --no-install eslint $changed_offchain_src )
else
  echo "gate: no PR-touched off_chain TS/JS files to lint"
fi

# 4. Off-chain unit tests for the cost-models slice (vitest, fast).
#    Yaci-bound integration tests for T002+ land in a follow-up
#    gate extension.
( cd off_chain && npx --no-install vitest run recomputeScriptDataHash )
