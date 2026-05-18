import {
    applyParamsToScript,
    BlockfrostProvider,
    MeshTxBuilder,
    MeshWallet,
    resolveScriptHash,
    serializePlutusScript,
    YaciProvider
} from '@meshsdk/core';
import { deserializeAddress } from '@meshsdk/core';
import {
    Language,
    LanguageKind,
    Languages,
    Transaction
} from '@sidan-lab/sidan-csl-rs-nodejs';
import blueprint from '../../plutus.json';
import { retry } from '../../test/lib';
import { WalletInfo } from './wallet';
import { Context } from '../context';
import { mkOgmiosEvaluator } from '../../submitter';
import {
    LiveCostModels,
    recomputeScriptDataHash
} from '../../tx/recomputeScriptDataHash';
import {
    fetchLiveCostModels,
    LiveCostModelsIncomplete
} from '../../ogmios/protocolParameters';

/**
 * Inspect a freshly-built tx hex for which Plutus language versions
 * its witness set actually carries (V1/V2/V3). Returns the set of
 * "plutus:vN" keys present, plus a flag indicating whether the tx has
 * any Plutus surface at all (redeemers OR plutus_data OR plutus_scripts).
 *
 * Reference scripts attached via `txInScriptRef` / `txOutReferenceScript`
 * are NOT inspected here — see the slice's commit body for the
 * documented residual risk. Production MPFS only uses inlined
 * `spendingPlutusScriptV3()` today, so this gap is not reachable from
 * the current code paths.
 */
function inspectPlutusSurface(txHex: string): {
    hasPlutus: boolean;
    languagesUsed: Array<'plutus:v1' | 'plutus:v2' | 'plutus:v3'>;
} {
    const tx = Transaction.from_hex(txHex);
    const witnessSet = tx.witness_set();
    const redeemers = witnessSet.redeemers();
    const plutusData = witnessSet.plutus_data();
    const plutusScripts = witnessSet.plutus_scripts();

    const hasPlutus =
        redeemers !== undefined ||
        plutusData !== undefined ||
        (plutusScripts !== undefined && plutusScripts.len() > 0);

    const languagesUsed: Array<'plutus:v1' | 'plutus:v2' | 'plutus:v3'> = [];
    if (plutusScripts !== undefined) {
        for (let i = 0; i < plutusScripts.len(); i++) {
            const lang = plutusScripts.get(i).language_version();
            switch (lang.kind()) {
                case LanguageKind.PlutusV1:
                    if (!languagesUsed.includes('plutus:v1')) {
                        languagesUsed.push('plutus:v1');
                    }
                    break;
                case LanguageKind.PlutusV2:
                    if (!languagesUsed.includes('plutus:v2')) {
                        languagesUsed.push('plutus:v2');
                    }
                    break;
                case LanguageKind.PlutusV3:
                    if (!languagesUsed.includes('plutus:v3')) {
                        languagesUsed.push('plutus:v3');
                    }
                    break;
            }
        }
    }

    return { hasPlutus, languagesUsed };
}

export function getTxBuilder(provider: Provider, ogmios: string) {
    const builder = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        // Auto-correct plutus exec units via ogmios evaluateTransaction
        // during complete() — replaces the hardcoded redeemer budgets
        // with the actual phase-2 cost. Fixes #15 (IsValid mismatch on
        // tokens whose trie depth pushes per-request cost above the
        // hardcoded constants). We talk to ogmios directly rather than
        // through yaci-store's evaluate proxy, which has been observed
        // returning empty 500s on Plutus V3 txs.
        evaluator: mkOgmiosEvaluator(ogmios)
    });

    // Wrap `complete()` so the returned builder's `txHex` carries a
    // script_data_hash computed against the LIVE chain cost models
    // (fetched via Ogmios) instead of Mesh's bundled defaults. See
    // specs/021-cost-models-from-ogmios/contracts/cost-models.md
    // (Contract 3) for the invariant.
    //
    // The wrapper:
    //   1. Runs Mesh's original complete() — its evaluator must see the
    //      unrewritten body so phase-2 budget evaluation is correct.
    //   2. Inspects builder.txHex for a Plutus surface (redeemers /
    //      plutus_data / plutus_scripts). If none, returns unchanged
    //      (Contract 3: non-Plutus tx path is identity).
    //   3. Fetches live cost models via Ogmios. On
    //      LiveCostModelsUnavailable, the error propagates — no silent
    //      fallback to bundled defaults (FR-003, Contract 4).
    //   4. Verifies every Plutus language version present in the tx is
    //      also present in the live cost-model set. If a language is
    //      missing (e.g. V3 absent from a V1-only set), throws
    //      LiveCostModelsIncomplete naming the missing key(s).
    //   5. Rewrites the script_data_hash with recomputeScriptDataHash
    //      and overwrites builder.txHex in place.
    const originalComplete = builder.complete.bind(builder);
    builder.complete = (async (
        customizedTx?: Parameters<MeshTxBuilder['complete']>[0]
    ): Promise<string> => {
        const txHex = await originalComplete(customizedTx);

        const { hasPlutus, languagesUsed } = inspectPlutusSurface(
            builder.txHex
        );
        if (!hasPlutus) {
            return txHex;
        }

        const live = await fetchLiveCostModels(ogmios);
        const lens = live.lengths();
        const missing: string[] = [];
        for (const lang of languagesUsed) {
            const shortKey =
                lang === 'plutus:v1'
                    ? 'v1'
                    : lang === 'plutus:v2'
                      ? 'v2'
                      : 'v3';
            if (lens[shortKey] === undefined) {
                missing.push(lang);
            }
        }
        if (missing.length > 0) {
            throw new LiveCostModelsIncomplete(
                `ogmios ${ogmios}: live cost models missing language(s) used by this tx: ${missing.join(', ')}`,
                missing
            );
        }

        // The Cardano ledger's `language_views_encoding` (an input to
        // `script_data_hash`) covers ONLY the cost models for languages
        // actually used by this tx. Restrict the live Costmdls to the
        // used set before recomputing — otherwise V1/V2 cost-model bytes
        // would bleed into the hash for V3-only txs and the chain would
        // reject the submission.
        const retainedLanguages = Languages.new();
        for (const lang of languagesUsed) {
            switch (lang) {
                case 'plutus:v1':
                    retainedLanguages.add(Language.new_plutus_v1());
                    break;
                case 'plutus:v2':
                    retainedLanguages.add(Language.new_plutus_v2());
                    break;
                case 'plutus:v3':
                    retainedLanguages.add(Language.new_plutus_v3());
                    break;
            }
        }
        const restrictedLive: LiveCostModels = {
            costMdls: () =>
                live.costMdls().retain_language_versions(retainedLanguages),
            digest: () => live.digest(),
            lengths: () => live.lengths()
        };

        const rewritten = recomputeScriptDataHash(
            builder.txHex,
            restrictedLive
        );
        builder.txHex = rewritten;
        return rewritten;
    }) as MeshTxBuilder['complete'];

    return builder;
}

export async function getWalletInfoForTx(
    wallet: MeshWallet
): Promise<WalletInfo> {
    const utxos = await wallet.getUtxos();
    const collateral = (await wallet.getCollateral())[0];
    const walletAddress = wallet.getChangeAddress();

    if (!walletAddress) {
        throw new Error('No wallet address found');
    }
    const firstUTxO = utxos[0];
    const signerHash = deserializeAddress(walletAddress).pubKeyHash;
    const walletInfo = {
        utxos,
        firstUTxO,
        collateral,
        walletAddress,
        signerHash
    };
    return walletInfo;
}

export async function onTxConfirmedPromise(
    provider,
    txHash,
    limit = 100
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let attempts = 0;
        const checkTx = setInterval(async () => {
            if (attempts >= limit) {
                clearInterval(checkTx);
                reject(new Error('Transaction confirmation timed out'));
            }
            provider
                .fetchTxInfo(txHash)
                .then(txInfo => {
                    if (txInfo.block === undefined) {
                        clearInterval(checkTx);
                        resolve('No block info available');
                    } else {
                        provider
                            .fetchBlockInfo(txInfo.block)
                            .then(blockInfo => {
                                if (blockInfo?.confirmations > 0) {
                                    clearInterval(checkTx);
                                    resolve(blockInfo.hash); // Resolve the promise when confirmed
                                }
                            })
                            .catch(() => {
                                attempts += 1;
                            });
                    }
                })
                .catch(() => {
                    attempts += 1;
                });
        }, 5000);
    });
}

export type CagingScript = {
    cbor: string;
    address: string;
    scriptHash: string;
    policyId: string;
};

export function getCagingScript(): CagingScript {
    const cbor = applyParamsToScript(
        blueprint.validators[0].compiledCode, // crap
        []
    );
    const address = serializePlutusScript({
        code: cbor,
        version: 'V3'
    }).address;
    const { scriptHash } = deserializeAddress(address);
    const policyId = resolveScriptHash(cbor, 'V3');
    const caging = {
        cbor,
        address,
        scriptHash,
        policyId
    };
    return caging;
}

export type Provider = BlockfrostProvider | YaciProvider;

export const yaciProvider = (
    storeHost: string,
    adminHost?: string
): Provider => {
    return new YaciProvider(
        `${storeHost}/api/v1/`,
        adminHost ? `${adminHost}` : undefined
    );
};

export const blockfrostProvider = (projectId: string): Provider => {
    return new BlockfrostProvider(projectId);
};

export const hasTopup = (provider: Provider): provider is YaciProvider => {
    return provider instanceof YaciProvider;
};

export type TopUp = (address: string, amount: number) => Promise<void>;
export const topup =
    (provider: Provider) => async (address: string, amount: number) => {
        if (hasTopup(provider)) {
            await retry(
                30,
                () => Math.random() * 6000 + 4000,
                async () => {
                    await provider.addressTopup(address, amount.toString());
                }
            );
        }
    };

export type WithUnsignedTransaction<T> = {
    unsignedTransaction: string;
    value: T;
};

export type WithTxHash<T> = {
    txHash: string;
    value: T;
};

export async function signAndSubmit<T>(
    context: Context,
    f: (walletAddress: string) => PromiseLike<WithUnsignedTransaction<T>>
): Promise<WithTxHash<T>> {
    const signingWallet = context.signingWallet;
    if (!signingWallet) {
        throw new Error('No signing wallet found');
    }
    const { info, signTx } = signingWallet;
    const { walletAddress } = await info();

    const { unsignedTransaction, value } = await f(walletAddress);

    const signedTx = await signTx(unsignedTransaction);
    const txHash = await context.submitTx(signedTx);
    return { txHash, value };
}
