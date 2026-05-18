import { describe, it, expect } from 'vitest';
import {
    Address,
    BigNum,
    CostModel,
    Costmdls,
    ExUnits,
    Int,
    Language,
    PlutusData,
    PlutusList,
    Redeemer,
    RedeemerTag,
    Redeemers,
    Transaction,
    TransactionBody,
    TransactionHash,
    TransactionInput,
    TransactionInputs,
    TransactionOutput,
    TransactionOutputs,
    TransactionWitnessSet,
    Value,
    hash_script_data,
} from '@sidan-lab/sidan-csl-rs-nodejs';

import {
    LiveCostModels,
    ScriptDataHashRewriteError,
    recomputeScriptDataHash,
} from './recomputeScriptDataHash';

// Helpers --------------------------------------------------------------

const TEST_ADDR_BECH32 =
    'addr_test1qzx9hu8j4ah3auytk0mwcupd69hpc52t0cw39a65ndrah86djs784u92a3m5w475w3w35tyd6v3qumkze80j8a6h5tuqq5xe8y';

const TEST_TX_HASH_HEX =
    '00000000000000000000000000000000000000000000000000000000deadbeef';

function liveOf(costmdls: Costmdls): LiveCostModels {
    return { costMdls: () => costmdls };
}

function costModelOfList(values: number[]): CostModel {
    const m = CostModel.new();
    values.forEach((v, i) => {
        m.set(i, Int.new(BigNum.from_str(v.toString())));
    });
    return m;
}

function costMdlsA(): Costmdls {
    const c = Costmdls.new();
    c.insert(Language.new_plutus_v1(), costModelOfList([100, 200, 300]));
    return c;
}

function costMdlsB(): Costmdls {
    const c = Costmdls.new();
    c.insert(Language.new_plutus_v1(), costModelOfList([1, 2, 3, 4]));
    c.insert(Language.new_plutus_v2(), costModelOfList([5, 6, 7]));
    return c;
}

function mkSimpleBody(): TransactionBody {
    const inputs = TransactionInputs.new();
    inputs.add(
        TransactionInput.new(
            TransactionHash.from_hex(TEST_TX_HASH_HEX),
            0,
        ),
    );

    const outputs = TransactionOutputs.new();
    outputs.add(
        TransactionOutput.new(
            Address.from_bech32(TEST_ADDR_BECH32),
            Value.new(BigNum.from_str('1000000')),
        ),
    );

    return TransactionBody.new(inputs, outputs, BigNum.from_str('170000'));
}

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

function mkWitnessSet(opts: {
    redeemers?: Redeemers;
    datums?: PlutusList;
}): TransactionWitnessSet {
    const ws = TransactionWitnessSet.new();
    if (opts.redeemers) ws.set_redeemers(opts.redeemers);
    if (opts.datums) ws.set_plutus_data(opts.datums);
    return ws;
}

function bodyBytesWithSameScriptDataHash(
    body: TransactionBody,
    overlay: TransactionBody,
): string {
    // Re-encode `body` after overwriting its script_data_hash with the
    // value from `overlay`, so the byte comparison isolates "every other
    // body field byte-identical". `TransactionBody` has a setter but no
    // public `remove_script_data_hash`, so we use a known overlay value
    // and apply it to both sides.
    const copy = TransactionBody.from_bytes(body.to_bytes());
    const sdh = overlay.script_data_hash();
    if (sdh !== undefined) copy.set_script_data_hash(sdh);
    return Buffer.from(copy.to_bytes()).toString('hex');
}

// Tests ----------------------------------------------------------------

describe('recomputeScriptDataHash', () => {
    it('rewrites script_data_hash for a Plutus-bearing tx', () => {
        const redeemers = mkRedeemers();
        const datums = mkDatums();
        const body = mkSimpleBody();
        const ws = mkWitnessSet({ redeemers, datums });

        // Initial hash computed with Costmdls A.
        const costA = costMdlsA();
        const initialHash = hash_script_data(redeemers, costA, datums);
        body.set_script_data_hash(initialHash);

        const txA = Transaction.new(body, ws);
        const txHexA = txA.to_hex();

        // Expected hash with Costmdls B, computed from the *decoded*
        // redeemers / datums so we are comparing the same in-WASM values
        // the rewriter will hash. (The WASM crate may consume handles
        // passed into `hash_script_data` and into the rewriter via
        // `liveOf`; we build a fresh `Costmdls` for each use.)
        const txAForExpect = Transaction.from_hex(txHexA);
        const wsForExpect = txAForExpect.witness_set();
        const expectedHash = hash_script_data(
            wsForExpect.redeemers()!,
            costMdlsB(),
            wsForExpect.plutus_data(),
        );

        const outHex = recomputeScriptDataHash(txHexA, liveOf(costMdlsB()));

        // 1) The new tx must differ — distinct hashes => distinct bytes.
        expect(outHex).not.toBe(txHexA);

        const outTx = Transaction.from_hex(outHex);
        const outBody = outTx.body();

        // (a) New body.script_data_hash == hash_script_data(_, B, _).
        const newSdh = outBody.script_data_hash();
        expect(newSdh).toBeDefined();
        expect(newSdh!.to_hex()).toBe(expectedHash.to_hex());

        // (b) Every other body field byte-identical. Overlay both
        // bodies with the new script_data_hash and compare bytes — any
        // unchanged field surfaces here as a byte equality.
        expect(bodyBytesWithSameScriptDataHash(outBody, outBody)).toBe(
            bodyBytesWithSameScriptDataHash(txA.body(), outBody),
        );

        // (c) Witness set bytes byte-identical.
        expect(
            Buffer.from(outTx.witness_set().to_bytes()).toString('hex'),
        ).toBe(
            Buffer.from(txA.witness_set().to_bytes()).toString('hex'),
        );

        // (d) Auxiliary data byte-identical (both absent).
        expect(outTx.auxiliary_data()).toBeUndefined();
        expect(txA.auxiliary_data()).toBeUndefined();
    });

    it('is identity for non-Plutus txs', () => {
        const body = mkSimpleBody();
        const ws = mkWitnessSet({});
        const tx = Transaction.new(body, ws);
        const txHex = tx.to_hex();

        const out = recomputeScriptDataHash(txHex, liveOf(costMdlsB()));

        expect(out).toBe(txHex);
    });

    it('throws ScriptDataHashRewriteError on invalid CBOR', () => {
        expect(() =>
            recomputeScriptDataHash('not-valid-cbor', liveOf(costMdlsB())),
        ).toThrow(ScriptDataHashRewriteError);
    });
});
