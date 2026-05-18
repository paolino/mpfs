import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
    BigNum,
    CostModel,
    Costmdls,
    Int,
    Language,
} from '@sidan-lab/sidan-csl-rs-nodejs';

import { boot } from '../transactions/boot';
import { end } from '../transactions/end';
import { request } from '../transactions/request';
import { retract } from '../transactions/retract';
import { Context } from '../transactions/context';
import { firstOutputRef } from '../lib';
import { mkOutputRefId } from '../outputRef';
import { sync, withContext } from '../transactions/transactions.test';
import type { LiveCostModels } from './recomputeScriptDataHash';
import {
    LiveCostModelsIncomplete,
    LiveCostModelsUnavailable,
} from '../ogmios/protocolParameters';

// The wrapper this slice owns calls `fetchLiveCostModels` from
// `../ogmios/protocolParameters`. We mock the whole module so that
// individual cases can swap the implementation (real / wrong-cost /
// missing-language / never-called).
//
// `vi.mock` is hoisted by vitest, so the wrapper picks up the mocked
// binding even though it imports `fetchLiveCostModels` as a named
// import.
vi.mock('../ogmios/protocolParameters', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../ogmios/protocolParameters')>();
    return {
        ...actual,
        fetchLiveCostModels: vi.fn(actual.fetchLiveCostModels),
    };
});

// Imported AFTER the mock declaration so the mocked binding is bound
// before the helper picks it up. (vi.mock is hoisted, so order in
// source doesn't matter at runtime, but readability-wise we keep the
// mock at the top.)
import { fetchLiveCostModels } from '../ogmios/protocolParameters';

// Build a deliberately wrong Costmdls — single-entry vectors for V1+V2,
// which cannot possibly match any real Cardano chain's cost vectors.
// Used by the regression-sentinel case to force Yaci's ogmios to
// reject the tx with `script integrity hash mismatch` (ogmios error
// code 3113).
function wrongCostModels(): LiveCostModels {
    const costmdls = Costmdls.new();
    const v1 = CostModel.new();
    v1.set(0, Int.new(BigNum.from_str('0')));
    costmdls.insert(Language.new_plutus_v1(), v1);

    const v2 = CostModel.new();
    v2.set(0, Int.new(BigNum.from_str('0')));
    costmdls.insert(Language.new_plutus_v2(), v2);

    const v3 = CostModel.new();
    v3.set(0, Int.new(BigNum.from_str('0')));
    costmdls.insert(Language.new_plutus_v3(), v3);

    return {
        costMdls: () => costmdls,
        digest: () => 'sha256:test-wrong-cost-models',
        lengths: () => ({ v1: 1, v2: 1, v3: 1 }),
    };
}

// LiveCostModels that omits V3 entirely. Used by the
// LiveCostModelsIncomplete case — retract uses V3.
function v3MissingCostModels(): LiveCostModels {
    const costmdls = Costmdls.new();
    const v1 = CostModel.new();
    v1.set(0, Int.new(BigNum.from_str('0')));
    costmdls.insert(Language.new_plutus_v1(), v1);
    return {
        costMdls: () => costmdls,
        digest: () => 'sha256:test-missing-v3',
        lengths: () => ({ v1: 1 }),
    };
}

beforeEach(() => {
    // Default each case to the real fetcher; cases that need a stub
    // override it explicitly.
    const mocked = vi.mocked(fetchLiveCostModels);
    mocked.mockReset();
    mocked.mockImplementation(async (...args) => {
        const actual = await vi.importActual<
            typeof import('../ogmios/protocolParameters')
        >('../ogmios/protocolParameters');
        return actual.fetchLiveCostModels(...args);
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('getTxBuilder (live cost models)', () => {
    it(
        'retract submission fails with ogmios 3113 when cost models are wrong',
        { timeout: 120000 },
        async () => {
            // beforeEach wires the real fetcher; we keep it for the
            // setup steps (boot + request), then swap to the wrong-cost
            // stub right before the retract — that is the only step
            // whose hash we want corrupted.
            await withContext(null, null, async (context: Context) => {
                await sync(context);
                const { value: tokenId } = await boot(context);

                await sync(context);
                const { txHash } = await request(context, tokenId, {
                    type: 'insert',
                    key: 'k-wrong',
                    newValue: 'v-wrong',
                });
                const req = firstOutputRef(txHash);

                await sync(context);
                vi.mocked(fetchLiveCostModels).mockImplementation(
                    async () => wrongCostModels(),
                );
                let caught: unknown;
                try {
                    await retract(context, req);
                } catch (err) {
                    caught = err;
                }
                expect(caught).toBeDefined();
                const msg =
                    caught instanceof Error
                        ? caught.message + ' ' + JSON.stringify(
                              (caught as { ogmiosError?: unknown })
                                  .ogmiosError ?? '',
                          )
                        : String(caught);
                // Yaci's ogmios surfaces script-integrity-hash mismatch
                // as code 3113 (ScriptIntegrityHashNoMatch). We match
                // on the numeric code or the phrase "script integrity"
                // — whichever the submitter happens to surface today.
                expect(msg).toMatch(/3113|script integrity/i);
            });
        },
    );

    it(
        'retract submission succeeds with live cost models',
        { timeout: 120000 },
        async () => {
            // beforeEach already wires the real fetcher; no override.
            await withContext(null, null, async (context: Context) => {
                await sync(context);
                const { value: tokenId } = await boot(context);

                await sync(context);
                const { txHash } = await request(context, tokenId, {
                    type: 'insert',
                    key: 'k-ok',
                    newValue: 'v-ok',
                });
                const req = firstOutputRef(txHash);
                const reqId = mkOutputRefId(req);

                await sync(context);
                const { txHash: retractTxHash } = await retract(context, req);
                expect(retractTxHash).toMatch(/^[0-9a-f]{64}$/);

                await sync(context);
                const reqs = await context.fetchRequests(tokenId);
                expect(reqs.some(r => r.outputRefId === reqId)).toBe(false);

                await sync(context);
                await end(context, tokenId);
            });
        },
    );

    it(
        'non-Plutus tx path is identity (no fetchLiveCostModels call)',
        { timeout: 60000 },
        async () => {
            // If the wrapper accidentally calls fetchLiveCostModels on a
            // non-Plutus build, the mock throws and the build dies. The
            // contract is "no fetch on non-Plutus", so the mock must
            // never be invoked.
            vi.mocked(fetchLiveCostModels).mockImplementation(async () => {
                throw new LiveCostModelsUnavailable(
                    'fetchLiveCostModels must not be called for non-Plutus tx',
                );
            });

            await withContext(null, null, async (context: Context) => {
                await sync(context);
                const { walletAddress } =
                    await context.signingWallet!.info();
                const { utxos } =
                    await context.addressWallet(walletAddress);

                const tx = context.newTxBuilder();
                await tx
                    .txOut(walletAddress, [
                        { unit: 'lovelace', quantity: '2000000' },
                    ])
                    .changeAddress(walletAddress)
                    .selectUtxosFrom(utxos)
                    .complete();

                expect(tx.txHex.length).toBeGreaterThan(0);
                expect(vi.mocked(fetchLiveCostModels)).not.toHaveBeenCalled();
            });
        },
    );

    it(
        'throws LiveCostModelsIncomplete when tx uses a missing language',
        { timeout: 120000 },
        async () => {
            // Use the real fetcher for setup (boot + request), then
            // swap to a fetcher that omits V3 right before retract —
            // the only step whose used-language check we want to fail.
            await withContext(null, null, async (context: Context) => {
                await sync(context);
                const { value: tokenId } = await boot(context);

                await sync(context);
                const { txHash } = await request(context, tokenId, {
                    type: 'insert',
                    key: 'k-missing',
                    newValue: 'v-missing',
                });
                const req = firstOutputRef(txHash);

                await sync(context);
                vi.mocked(fetchLiveCostModels).mockImplementation(
                    async () => v3MissingCostModels(),
                );
                let caught: unknown;
                try {
                    await retract(context, req);
                } catch (err) {
                    caught = err;
                }
                expect(caught).toBeInstanceOf(LiveCostModelsIncomplete);
                if (caught instanceof LiveCostModelsIncomplete) {
                    expect(caught.languagesMissing).toContain('plutus:v3');
                }
            });
        },
    );
});
