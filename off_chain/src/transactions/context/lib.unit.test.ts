import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
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
    PlutusScript,
    PlutusScripts,
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
} from '@sidan-lab/sidan-csl-rs-nodejs';

// ---------------------------------------------------------------------
// Module mocks.
//
// `vi.mock` is hoisted by vitest, so the wrapper picks up the mocked
// bindings even though it imports them as named imports at the top of
// `lib.ts`. We mock:
//
//   * `@meshsdk/core` — substitute a fake `MeshTxBuilder` whose
//     `complete()` returns a synthetic txHex set per-case via
//     `setNextTxHex(...)`. The fake also exposes a writable `txHex`
//     property so `lib.ts`'s wrapper can overwrite it.
//   * `../../ogmios/protocolParameters` — stub `fetchLiveCostModels`
//     per-case so we never open a WebSocket and so the wrong-cost
//     or missing-language cases are deterministic.
//   * `../../submitter` — stub `mkOgmiosEvaluator` so constructing the
//     builder doesn't touch a network endpoint.
//
// We deliberately do NOT exercise the full MeshTxBuilder + Yaci
// pipeline here; that is T003's job. The single contract under test
// is: the wrapper emits exactly one structured `live_cost_models` log
// entry per successful script-bearing build, and stays silent on the
// non-Plutus and incomplete-cost-models paths.
// ---------------------------------------------------------------------

let nextTxHex: string | null = null;
const setNextTxHex = (hex: string) => {
    nextTxHex = hex;
};

vi.mock('@meshsdk/core', async () => {
    class FakeMeshTxBuilder {
        public txHex: string = '';
        // Constructor intentionally takes no parameters: `getTxBuilder`
        // calls `new MeshTxBuilder({ fetcher, submitter, evaluator })`
        // but the fake ignores those — this unit test exercises only
        // the wrapper's log-emission contract, not the Mesh internals.
        constructor() {}
        async complete(): Promise<string> {
            if (nextTxHex === null) {
                throw new Error(
                    'lib.unit.test: nextTxHex not set before complete()',
                );
            }
            this.txHex = nextTxHex;
            return nextTxHex;
        }
    }

    // The mocked module only needs to expose the symbols `lib.ts`
    // imports from `@meshsdk/core` at the top of the file. The
    // `Blockfrost`/`Yaci` providers and `MeshWallet` are not used by
    // `getTxBuilder` itself, so leaving them as `undefined` (or empty
    // class) is fine for this unit slice — only `getTxBuilder` is
    // exercised here, and other helpers from `lib.ts` are never
    // imported into this file.
    return {
        MeshTxBuilder: FakeMeshTxBuilder,
        applyParamsToScript: () => '',
        BlockfrostProvider: class {},
        MeshWallet: class {},
        resolveScriptHash: () => '',
        serializePlutusScript: () => ({ address: '' }),
        YaciProvider: class {},
        deserializeAddress: () => ({ pubKeyHash: '' }),
    };
});

vi.mock('../../ogmios/protocolParameters', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('../../ogmios/protocolParameters')
        >();
    return {
        ...actual,
        fetchLiveCostModels: vi.fn(async () => {
            throw new Error(
                'lib.unit.test: fetchLiveCostModels must be stubbed per case',
            );
        }),
    };
});

vi.mock('../../submitter', () => ({
    mkOgmiosEvaluator: () => ({
        evaluateTx: async () => [],
    }),
}));

// Imports below run AFTER the hoisted vi.mock declarations so each
// imported symbol is bound against the mocked module.
import { getTxBuilder } from './lib';
import { log } from '../../log';
import {
    fetchLiveCostModels,
    LiveCostModelsIncomplete,
} from '../../ogmios/protocolParameters';
import type { LiveCostModels } from '../../tx/recomputeScriptDataHash';

// ---------------------------------------------------------------------
// Synthetic-tx helpers — local to this file by design.
//
// T001's unit test uses a similar recipe but the orchestrator brief
// requires us NOT to import its helpers across files (frozen scope),
// so we rebuild the minimum needed here.
// ---------------------------------------------------------------------

const TEST_ADDR_BECH32 =
    'addr_test1qzx9hu8j4ah3auytk0mwcupd69hpc52t0cw39a65ndrah86djs784u92a3m5w475w3w35tyd6v3qumkze80j8a6h5tuqq5xe8y';

const TEST_TX_HASH_HEX =
    '00000000000000000000000000000000000000000000000000000000deadbeef';

function costModelOfList(values: number[]): CostModel {
    const m = CostModel.new();
    values.forEach((v, i) => {
        m.set(i, Int.new(BigNum.from_str(v.toString())));
    });
    return m;
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

/**
 * Build a synthetic Plutus-bearing txHex with redeemers + plutus_data
 * in the witness set. No plutus_scripts are included, so
 * `inspectPlutusSurface` reports `hasPlutus=true` and
 * `languagesUsed=[]`. With an empty `languagesUsed`, the wrapper's
 * completeness check trivially passes (no language is missing), and
 * `retain_language_versions` with an empty `Languages` produces an
 * empty Costmdls — exactly what `hash_script_data` needs to succeed
 * without depending on any specific language being present in the
 * fixture cost models. This is the cleanest fixture for the success
 * case: redeemers + datums are enough to satisfy the script-data-hash
 * rewrite path.
 */
function mkPlutusBearingTxHex(): string {
    const body = mkSimpleBody();
    const ws = TransactionWitnessSet.new();
    ws.set_redeemers(mkRedeemers());
    ws.set_plutus_data(mkDatums());
    return Transaction.new(body, ws).to_hex();
}

/**
 * Build a synthetic Plutus-bearing txHex with V3 in `plutus_scripts`
 * so `inspectPlutusSurface` reports `languagesUsed=['plutus:v3']`.
 *
 * Used by the LiveCostModelsIncomplete case: when the stubbed fetcher
 * returns cost models without `v3` lengths, the wrapper's own
 * completeness check must throw `LiveCostModelsIncomplete` BEFORE the
 * success log is emitted.
 *
 * The V3 PlutusScript bytes here are a trivially small CBOR payload
 * — they are never executed; only `language_version()` is inspected
 * by the wrapper, and `set_plutus_scripts` accepts the bytes verbatim.
 */
function mkV3OnlyPlutusTxHex(): string {
    const body = mkSimpleBody();
    const ws = TransactionWitnessSet.new();
    ws.set_redeemers(mkRedeemers());
    ws.set_plutus_data(mkDatums());

    const scripts = PlutusScripts.new();
    // Minimal byte payload: 0x46 = bytes(6), six bytes of zeros. This
    // round-trips through `PlutusScript.new_v3(...)` without the WASM
    // crate rejecting it; we never execute it, we only inspect its
    // `language_version()`.
    scripts.add(
        PlutusScript.new_v3(new Uint8Array([0x46, 0, 0, 0, 0, 0, 0])),
    );
    ws.set_plutus_scripts(scripts);

    return Transaction.new(body, ws).to_hex();
}

// ---------------------------------------------------------------------
// Fixture LiveCostModels.
// ---------------------------------------------------------------------

function fixtureLive(): LiveCostModels {
    const costmdls = Costmdls.new();
    costmdls.insert(
        Language.new_plutus_v1(),
        costModelOfList([1, 2]),
    );
    return {
        costMdls: () => costmdls,
        digest: () => 'sha256:fixture',
        lengths: () => ({ v1: 2 }),
    };
}

// ---------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------

beforeEach(() => {
    nextTxHex = null;
    vi.mocked(fetchLiveCostModels).mockReset();
    // Spy on the singleton logger's `info` method. `log` is a shared
    // record-shaped object exported from `../../log`, so spying on its
    // method is enough to capture the wrapper's emission.
    vi.spyOn(log, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('getTxBuilder live_cost_models log emission', () => {
    const OGMIOS_URL = 'ws://test-ogmios:1337';

    it('emits one live_cost_models entry on successful script-bearing build', async () => {
        setNextTxHex(mkPlutusBearingTxHex());
        vi.mocked(fetchLiveCostModels).mockImplementation(
            async () => fixtureLive(),
        );

        const builder = getTxBuilder(
            // The wrapper only consumes the provider via Mesh's own
            // builder plumbing, which we've mocked away. `undefined`
            // is safe here.
            undefined as unknown as Parameters<typeof getTxBuilder>[0],
            OGMIOS_URL,
        );
        const out = await builder.complete();
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);

        const infoSpy = vi.mocked(log.info);
        const liveEntries = infoSpy.mock.calls.filter(
            ([msg]) => msg === 'live_cost_models',
        );
        expect(liveEntries).toHaveLength(1);
        const [, fields] = liveEntries[0];
        expect(fields).toEqual(
            expect.objectContaining({
                source: 'ogmios',
                ogmios_url: OGMIOS_URL,
                lengths: { v1: 2 },
                digest: 'sha256:fixture',
            }),
        );
    });

    it('non-Plutus tx path emits NO live_cost_models entry', async () => {
        // No redeemers, no plutus_data, no plutus_scripts: the wrapper
        // takes the identity early-return without calling the fetcher.
        const body = mkSimpleBody();
        const ws = TransactionWitnessSet.new();
        const nonPlutusHex = Transaction.new(body, ws).to_hex();
        setNextTxHex(nonPlutusHex);

        vi.mocked(fetchLiveCostModels).mockImplementation(async () => {
            throw new Error(
                'lib.unit.test: fetchLiveCostModels must NOT be called for non-Plutus tx',
            );
        });

        const builder = getTxBuilder(
            undefined as unknown as Parameters<typeof getTxBuilder>[0],
            OGMIOS_URL,
        );
        const out = await builder.complete();
        expect(out).toBe(nonPlutusHex);

        expect(vi.mocked(fetchLiveCostModels)).not.toHaveBeenCalled();
        const infoSpy = vi.mocked(log.info);
        const liveEntries = infoSpy.mock.calls.filter(
            ([msg]) => msg === 'live_cost_models',
        );
        expect(liveEntries).toHaveLength(0);
    });

    it('emits NO entry when the wrapper rejects with LiveCostModelsIncomplete', async () => {
        // Synthetic builder yields a V3-only Plutus tx, fetcher returns
        // only V1 lengths — the wrapper's own completeness check must
        // throw `LiveCostModelsIncomplete` before reaching the success
        // log emission point.
        setNextTxHex(mkV3OnlyPlutusTxHex());
        vi.mocked(fetchLiveCostModels).mockImplementation(
            async () => fixtureLive(),
        );

        const builder = getTxBuilder(
            undefined as unknown as Parameters<typeof getTxBuilder>[0],
            OGMIOS_URL,
        );
        await expect(builder.complete()).rejects.toBeInstanceOf(
            LiveCostModelsIncomplete,
        );

        const infoSpy = vi.mocked(log.info);
        const liveEntries = infoSpy.mock.calls.filter(
            ([msg]) => msg === 'live_cost_models',
        );
        expect(liveEntries).toHaveLength(0);
    });
});
