import {
    Costmdls,
    Transaction,
    hash_script_data,
} from '@sidan-lab/sidan-csl-rs-nodejs';

/**
 * Thrown when the CBOR decode/re-encode round-trip used to rewrite a
 * transaction's `script_data_hash` fails. The underlying cause (e.g. an
 * `Error` from the WASM decoder) is preserved on `cause`.
 *
 * See specs/021-cost-models-from-ogmios/contracts/cost-models.md
 * (Contract 2) and research.md Q5 for the design.
 */
export class ScriptDataHashRewriteError extends Error {
    constructor(
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'ScriptDataHashRewriteError';
    }
}

/**
 * In-memory wrapper around the live cost models obtained from a fresh
 * Ogmios `queryLedgerState/protocolParameters` reply.
 *
 * T001 exposes only `costMdls()`, the WASM-side handle consumed by
 * `hash_script_data`. Slice T002 will extend this interface with
 * `digest()` and `lengths()` for FR-006 logging; consumers should
 * therefore depend on the interface name, not on its current shape.
 */
export interface LiveCostModels {
    costMdls(): Costmdls;
}

/**
 * Pure (synchronous, no I/O) script-data-hash rewriter.
 *
 * If the transaction has neither redeemers nor Plutus datums, returns
 * `txHex` unchanged (identity). Otherwise decodes the transaction,
 * recomputes `script_data_hash = hash_script_data(redeemers, costMdls,
 * datums)`, writes it back into the body, and returns the re-encoded
 * hex. Witness set and auxiliary data are byte-for-byte preserved by
 * round-tripping the original handles.
 *
 * Throws `ScriptDataHashRewriteError` (with `cause` set to the WASM
 * error) if CBOR decode or re-encode fails. The caller is expected to
 * propagate the failure — silent fallback to bundled defaults is the
 * exact bug this slice exists to remove (FR-003).
 */
export function recomputeScriptDataHash(
    txHex: string,
    costModels: LiveCostModels,
): string {
    let tx: Transaction;
    try {
        tx = Transaction.from_hex(txHex);
    } catch (err) {
        throw new ScriptDataHashRewriteError(
            'failed to decode transaction CBOR',
            err,
        );
    }

    const witnessSet = tx.witness_set();
    const redeemers = witnessSet.redeemers();
    const datums = witnessSet.plutus_data();

    if (redeemers === undefined && datums === undefined) {
        // No Plutus surface — script_data_hash is not part of this tx
        // and the bug is not reachable. Return the input verbatim.
        return txHex;
    }

    if (redeemers === undefined) {
        // hash_script_data requires a Redeemers value. A tx with
        // datums-only is not a shape Mesh's CSLSerializer produces, but
        // we still refuse to invent an empty Redeemers vector silently:
        // that would change the script-data-hash semantics.
        throw new ScriptDataHashRewriteError(
            'transaction has plutus_data but no redeemers; cannot recompute script_data_hash',
        );
    }

    try {
        const body = tx.body();
        const newHash = hash_script_data(
            redeemers,
            costModels.costMdls(),
            datums,
        );
        body.set_script_data_hash(newHash);
        const newTx = Transaction.new(body, witnessSet, tx.auxiliary_data());
        return newTx.to_hex();
    } catch (err) {
        throw new ScriptDataHashRewriteError(
            'failed to re-encode transaction CBOR with rewritten script_data_hash',
            err,
        );
    }
}
