import fs from 'node:fs';
import {
    BlockfrostProvider,
    deserializeAddress,
    MeshTxBuilder,
    MeshWallet,
    UTxO,
    YaciProvider
} from '@meshsdk/core';
import { OutputLogger } from './logging';
import { tokenIdParts } from './lib';
import { SafeTrie } from './trie';

export type Log = (key: string, value: any) => void;
export type Provider = BlockfrostProvider | YaciProvider;
export type WithContext = (context: Context) => Promise<any>;
export type Wallet = {
    utxos: UTxO[];
    firstUTxO: UTxO;
    collateral: UTxO;
    walletAddress: string;
    signerHash: string;
};
export type TopUp = (address: string, amount: number) => Promise<void>;
type Progress = (message: string) => void;

export type Context = {
    log: Log;
    logs: () => any;
    deleteLogs: () => void;
    wallet: () => Promise<Wallet>;
    newTxBuilder: () => MeshTxBuilder;
    fetchAddressUTxOs: (address: string) => Promise<UTxO[]>;
    signTx: (tx: MeshTxBuilder) => Promise<string>;
    submitTx: ( tx: string) => Promise<string>;
    evaluate: (txHex: string) => Promise<any>;
    trie: (index: string) => Promise<SafeTrie>;
    waitSettlement: (txHash: string) => Promise<string>;
    facts: (tokenId: string) => Promise<Record<string, string>>;
};

export async function withContext(
    baseDir: string,
    name: string,
    context: Context,
    f: WithContext
) {
    const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
    const newBaseDir = `${baseDir}/${timestamp}`;
    const newPath = `${newBaseDir}/${name}.json`;
    fs.mkdirSync(newBaseDir, { recursive: true });
    const write = () => {
        const json = JSON.stringify(context.logs(), null, 2);
        fs.writeFileSync(newPath, json, 'utf-8');
    };

    try {
        const result = await f(context);
        write();
        return result;
    } catch (error) {
        write();
        throw error;
    }
}

const outputReferenceOrdering = (a, b) => {
    if (a.input.txHash < b.input.txHash) {
        return -1;
    }
    if (a.input.txHash > b.input.txHash) {
        return 1;
    }
    return a.input.outputIndex - b.input.outputIndex;
};

export async function newContext(
    ctxProvider: ContextProvider,
    wallet: MeshWallet,
    progress?: Progress
): Promise<Context> {
    const provider = ctxProvider.provider;
    const logger = new OutputLogger();
    const log = (key: string, value: any) => {
        logger.log(key, value);
    };
    const logs = () => logger.getLogs();
    const deleteLogs = () => logger.deleteLogs();

    const newTxBuilder = () => getTxBuilder(provider);
    const tries = {};

    return {
        log,
        wallet: async () => await getWalletInfoForTx(log, wallet),
        logs,
        deleteLogs,
        newTxBuilder,
        fetchAddressUTxOs: async s => {
            return (await provider.fetchAddressUTxOs(s)).sort(
                outputReferenceOrdering
            );
        },
        signTx: async ( tx: MeshTxBuilder) => {
            const unsignedTx = tx.txHex;
            log('tx-hex', unsignedTx);
            const signedTx = await wallet.signTx(unsignedTx);
            return signedTx;
        },
        submitTx: async ( tx: string) => {
            const txHash = await wallet.submitTx(tx);
            log('tx-hash', txHash);
            return txHash;
        },
        evaluate: async (txHex: string) => {
            await ctxProvider.evaluate(txHex);
        },
        trie: async (index: string) => {
            const { assetName } = tokenIdParts(index);
            if (!tries[assetName]) {
                const path = `tmp/tries/${assetName}`;
                const trie = await SafeTrie.create(path);
                if (trie) {
                    tries[assetName] = trie;
                } else {
                    throw new Error(
                        `Failed to load or create trie for index: ${assetName}`
                    );
                }
            }
            return tries[assetName];
        },
        waitSettlement: async txHash => {
            return await onTxConfirmedPromise(provider, txHash, progress, 50);
        },
        facts: async (tokenId: string) => {
            const { assetName } = tokenIdParts(tokenId);
            const trie = tries[assetName];
            if (!trie) {
                throw new Error(
                    `Trie not found for asset name: ${assetName}`
                );
            }
            const facts = await trie.allFacts();
            return facts;
        }
    };
}

export type ContextProvider = {
    provider: Provider;
    topup: TopUp | undefined;
    evaluate: (txHex: string) => Promise<any>;
};

export function yaciProvider(
    storeHost: string,
    adminHost?: string
): ContextProvider {
    const provider = new YaciProvider(
        `${storeHost}/api/v1/`,
        adminHost ? `${adminHost}` : undefined
    );
    async function topup(address: string, amount: number) {
        await provider.addressTopup(address, amount.toString());
    }
    return {
        provider,
        topup,
        evaluate: async (txHex: string) => {
            await provider.evaluateTx(txHex);
        }
    };
}

export function blockfrostProvider(projectId: string): ContextProvider {
    const provider = new BlockfrostProvider(projectId);
    return {
        provider,
        topup: undefined,
        evaluate: async (txHex: string) => {
            await provider.evaluateTx(txHex);
        }
    };
}

export function getTxBuilder(provider: Provider) {
    return new MeshTxBuilder({
        fetcher: provider,
        submitter: provider
    });
}

export async function getWalletInfoForTx(
    log: Log,
    wallet: MeshWallet
): Promise<Wallet> {
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
function builtinByteString(
    cageScriptHash: string
): object | import('@meshsdk/common').Data {
    throw new Error('Function not implemented.');
}

async function onTxConfirmedPromise(
    provider,
    txHash,
    progress?,
    limit = 100
): Promise<string> {
    const progressR = progress || (() => {});
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
                            .catch(error => {
                                progressR(
                                    `Still fetching block info for txHash: ${txHash}: ${error}`
                                );
                                attempts += 1;
                            });
                    }
                })
                .catch(error => {
                    progressR(
                        `Still fetching tx info for txHash: ${txHash}: ${error}`
                    );
                    attempts += 1;
                });
        }, 5000);
    });
}
