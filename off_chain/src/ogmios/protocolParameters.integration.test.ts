import { describe, it, expect } from 'vitest';
import {
    BigNum,
    PlutusData,
    PlutusList,
    Redeemer,
    RedeemerTag,
    Redeemers,
    ExUnits,
    hash_script_data,
} from '@sidan-lab/sidan-csl-rs-nodejs';

import {
    fetchLiveCostModels,
    LiveCostModelsUnavailable,
} from './protocolParameters';

// Integration tests assume Ogmios is up at $OGMIOS_PORT (default 1337,
// matching the project's other *.integration.test.ts files). The
// orchestrator boots Yaci DevKit before dispatching each slice.

const ogmiosPort = process.env.OGMIOS_PORT || '1337';
const ogmiosUrl = `ws://localhost:${ogmiosPort}`;

function mkRedeemers(): Redeemers {
    const rs = Redeemers.new();
    rs.add(
        Redeemer.new(
            RedeemerTag.new_spend(),
            BigNum.from_str('0'),
            PlutusData.new_empty_constr_plutus_data(BigNum.from_str('0')),
            ExUnits.new(BigNum.from_str('1000'), BigNum.from_str('2000')),
        ),
    );
    return rs;
}

function mkDatums(): PlutusList {
    const list = PlutusList.new();
    list.add(PlutusData.new_empty_constr_plutus_data(BigNum.from_str('1')));
    return list;
}

describe('fetchLiveCostModels (integration)', () => {
    it(
        'fetches non-empty live cost models from Ogmios',
        { timeout: 5000 },
        async () => {
            const live = await fetchLiveCostModels(ogmiosUrl);
            const lens = live.lengths();
            expect(lens.v1).toBeDefined();
            expect(lens.v1!).toBeGreaterThan(0);
            expect(lens.v2).toBeDefined();
            expect(lens.v2!).toBeGreaterThan(0);
            if (lens.v3 !== undefined) {
                expect(lens.v3).toBeGreaterThan(0);
            }
        },
    );

    it(
        'digest is non-empty and stable across consecutive calls',
        { timeout: 10000 },
        async () => {
            const a = await fetchLiveCostModels(ogmiosUrl);
            const b = await fetchLiveCostModels(ogmiosUrl);
            const da = a.digest();
            const db = b.digest();
            expect(da.startsWith('sha256:')).toBe(true);
            expect(db.startsWith('sha256:')).toBe(true);
            expect(da.length).toBeGreaterThan('sha256:'.length);
            expect(da).toBe(db);
        },
    );

    it(
        'costMdls returns a Costmdls usable by hash_script_data',
        { timeout: 5000 },
        async () => {
            const live = await fetchLiveCostModels(ogmiosUrl);
            const redeemers = mkRedeemers();
            const datums = mkDatums();
            const hash = hash_script_data(redeemers, live.costMdls(), datums);
            expect(hash.to_bytes().length).toBeGreaterThan(0);
        },
    );

    it(
        'rejects with LiveCostModelsUnavailable on unreachable URL',
        { timeout: 5000 },
        async () => {
            await expect(
                fetchLiveCostModels('ws://127.0.0.1:1', { timeoutMs: 2000 }),
            ).rejects.toBeInstanceOf(LiveCostModelsUnavailable);
        },
    );
});
