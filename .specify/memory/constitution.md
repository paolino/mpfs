# MPFS Constitution

This constitution captures the principles that all specs, plans, and tasks
in `cardano-foundation/mpfs` must respect. It is the substrate for the
Spec-Driven Development workflow (see `/code/llm-settings/claude/CLAUDE.md`)
and the resolve-ticket orchestration layer.

## Core Principles

### I. Live chain is the source of truth (NON-NEGOTIABLE)

For any value the Cardano ledger is authoritative over — protocol
parameters, cost models, execution-budget tiers, network era, slot/epoch
boundaries — MPFS reads it from a live source (Ogmios `queryLedgerState/*`,
node-supplied data) at use time. **No bundled-in defaults, hardcoded
constants, or stale snapshots are acceptable substitutes**, because the
chain can enact changes at any epoch boundary without code-level signalling.

Why: see issue #15 (auto-evaluate execution units via Ogmios) and issue
#21 (live cost models). Both were caused by relying on values frozen at
build time.

### II. Mesh SDK is configured, not patched

When `MeshTxBuilder` (or any third-party builder) produces incorrect output
for our environment, the fix is to *configure* it with our own
fetchers/evaluators/submitters, not to fork the library or rewrite tx
construction in CLI glue. The existing `mkOgmiosEvaluator` injection is the
template.

Why: forking `@meshsdk/core` traps us at a Mesh version; CLI-side tx
construction duplicates and diverges from on-chain serialization.

### III. Test against Yaci DevKit; verify on live preprod

Every behavior change that touches tx construction must:
- Have an automated test runnable against a local Yaci DevKit (the existing
  `just test-all` pattern, which boots yaci-store + yaci-admin + ogmios).
- Be verified once against a live preprod chain before merge, with a
  recorded txid as evidence.

This is the live-boundary smoke pattern: unit + Yaci catches most
regressions; only live preprod catches "the chain enacted X under our
feet".

### IV. On-chain validators are gates; off-chain is the service

The on-chain Aiken code is the protocol; off-chain TypeScript is the
service that drives users to it. Off-chain changes never weaken on-chain
guarantees, and the on-chain `aiken check && aiken build` step is part of
every gate.

### V. Bisect-safe vertical slices

Every reviewed commit must build, pass the gate, and stand alone. Test
and implementation for a single behavior ride together (one commit), so
`git bisect` can land on a single SHA and read both sides of the contract.
This is enforced by the resolve-ticket flow and the `commit_gate`
function in `gate.sh`.

## Quality Gates

- `gate.sh` exists for the life of every PR, runs on every subagent
  return, and is dropped in the last commit before the PR is marked
  ready.
- Every behavior-changing commit carries a `Tasks: T###[, T###]` trailer
  linking back to `tasks.md` in the relevant `specs/<issue>-<slug>/`
  directory.
- `tasks.md` items become `[X] T### (commit: <short-sha>)` as slices are
  reviewed.
- No direct pushes to `main`; branch protection enforces PRs.

## Workflow Constraints

- **Spec-Driven Development is mandatory.** Every issue goes through
  specify → plan → tasks → implement, even for "simple" fixes.
- **resolve-ticket is the canonical PR workflow.** The orchestrator
  owns specs/plan/tasks/review/docs/metadata; subagents do one
  bisect-safe commit per run.
- **Constitution updates are PRs.** Changing this file is itself a
  resolve-ticket flow.

## Governance

This constitution supersedes ad-hoc conventions in the codebase. When a
spec, plan, or task conflicts with it, update the artifact, not the
constitution — unless the conflict reveals a missing or wrong principle,
in which case open a PR amending this file.

**Version**: 1.0.0
**Ratified**: 2026-05-18
**Last Amended**: 2026-05-18
