import { describe, test, expect, it } from 'vitest';
import { boot } from './boot';
import { end } from './end';
import { request } from './request';
import { update } from './update';
import { retract } from './retract';
import { generateMnemonic, MeshWallet } from '@meshsdk/core';
import { Context, mkContext } from './context';
import { createIndexer } from '../indexer/indexer';
import { withTempDir } from '../test/lib';
import { withLevelDB } from '../trie.test';
import { mkOutputRefId } from '../outputRef';
import { createTrieManager } from '../trie';
import { createState } from '../indexer/state';
import { createProcess } from '../indexer/process';
import { firstOutputRef, sleep, sleepMs } from '../lib';
import { getCagingScript, topup, yaciProvider } from './context/lib';

const txTest = (name: string, testFn: () => Promise<void>, timeout = 10000) =>
    it(name, { concurrent: true, timeout, retry: 3 }, testFn);

describe('Submitting transactions we', () => {
    txTest(
        'can create and delete a token 1',
        async () => {
            await withTempDir(async () => {
                await withContext(null, null, async context => {
                    await sync(context);

                    const { value: tokenId } = await boot(context);
                    await sync(context);
                    const tokenBooted = await context.fetchToken(tokenId);
                    expect(tokenBooted).toBeDefined();

                    await end(context, tokenId);

                    await sync(context);
                    const tokenDeleted = await context.fetchToken(tokenId);
                    expect(tokenDeleted).toBeUndefined();
                });
            });
        },
        20000
    );

    txTest(
        'can create a request',
        async () => {
            await withContext(null, null, async context => {
                await sync(context);
                const { value: tokenId } = await boot(context);

                await sync(context);
                const { txHash } = await request(context, tokenId, {
                    type: 'insert',
                    key: 'key1',
                    value: 'value1'
                });
                const refId = mkOutputRefId(firstOutputRef(txHash));

                await sync(context);
                const requests = await context.fetchRequests(tokenId);
                if (!requests.some(req => req.outputRefId === refId)) {
                    throw new Error(
                        `Request ID ${refId} not found in requests`
                    );
                }

                await sync(context);
                await end(context, tokenId);
            });
        },
        60000
    );

    txTest(
        'can retract a request',
        async () => {
            await withContext(null, null, async context => {
                await sync(context);
                const { value: tokenId } = await boot(context);

                await sync(context);
                const { txHash } = await request(context, tokenId, {
                    type: 'insert',
                    key: 'key',
                    value: 'value'
                });
                const req = firstOutputRef(txHash);
                const reqId = mkOutputRefId(req);

                await sync(context);
                await retract(context, req);

                await sync(context);
                const reqs = await context.fetchRequests(tokenId);
                if (reqs.some(req => req.outputRef === reqId)) {
                    throw new Error(
                        `Request ID ${reqId} still found in requests after retraction`
                    );
                }
                await sync(context);
                await end(context, tokenId);
            });
        },
        60000
    );
    txTest(
        'can update a token',
        async () => {
            await withContext(null, null, async context => {
                await sync(context);
                const { value: tokenId } = await boot(context);

                await sync(context);
                const { txHash } = await request(context, tokenId, {
                    type: 'insert',
                    key: 'key',
                    value: 'value'
                });
                const requestRef = firstOutputRef(txHash);
                const requestRefId = mkOutputRefId(requestRef);

                await sync(context);
                await update(context, tokenId, [requestRef]);

                await sync(context);
                const requests = await context.fetchRequests(tokenId);
                if (requests.some(req => req.outputRef === requestRefId)) {
                    throw new Error(
                        `Request ID ${requestRefId} still found in requests after update`
                    );
                }

                await sync(context);
                const facts = await context.facts(tokenId);
                expect(facts).toEqual({
                    key: 'value'
                });

                await sync(context);
                await end(context, tokenId);
            });
        },
        60000
    );
    txTest(
        'can update a token twice tr',
        async () => {
            await withContext(null, null, async context => {
                await sync(context);
                const { value: tokenId } = await boot(context);

                await sync(context);
                const { txHash: requestTxHash1 } = await request(
                    context,
                    tokenId,
                    { type: 'insert', key: 'key1', value: 'value1' }
                );
                const requestRef1 = firstOutputRef(requestTxHash1);

                await sync(context);
                await update(context, tokenId, [requestRef1]);

                await sync(context);
                const { txHash: requestTxHash2 } = await request(
                    context,
                    tokenId,
                    { type: 'insert', key: 'key2', value: 'value2' }
                );
                const requestRef2 = firstOutputRef(requestTxHash2);

                await sync(context);
                await update(context, tokenId, [requestRef2]);

                await sync(context);

                await sync(context);
                const facts = await context.facts(tokenId);
                expect(facts).toEqual({
                    key1: 'value1',
                    key2: 'value2'
                });

                await sync(context);
                await end(context, tokenId);
            });
        },
        60000
    );
    txTest(
        'can update the token with a batch',
        async () => {
            await withContext(null, null, async context => {
                await sync(context);
                const { value: tokenId } = await boot(context);

                await sync(context);
                const { txHash: requestTxHash1 } = await request(
                    context,
                    tokenId,
                    { type: 'insert', key: 'key1', value: 'value1' }
                );
                const requestRef1 = firstOutputRef(requestTxHash1);
                const requestRefId1 = mkOutputRefId(requestRef1);

                await sync(context);
                const { txHash: requestTxHash2 } = await request(
                    context,
                    tokenId,
                    { type: 'insert', key: 'key2', value: 'value2' }
                );
                const requestRef2 = firstOutputRef(requestTxHash2);
                const requestRefId2 = mkOutputRefId(requestRef2);

                await sync(context);
                await update(context, tokenId, [requestRef1, requestRef2]);

                await sync(context);
                const requests = await context.fetchRequests(tokenId);
                if (
                    requests.some(req => req.outputRef === requestRefId1) ||
                    requests.some(req => req.outputRef === requestRefId2)
                ) {
                    throw new Error(
                        `Request IDs ${requestRefId1} or ${requestRefId2} still found in requests after update`
                    );
                }

                await sync(context);
                const facts = await context.facts(tokenId);
                expect(facts).toEqual({
                    key1: 'value1',
                    key2: 'value2'
                });

                await sync(context);
                await end(context, tokenId);
            });
        },
        60000
    );
});

describe('Restarting the service', () => {
    txTest(
        'should not throw an error',
        async () => {
            const mnemonics = generateMnemonic();
            await withTempDir(async tmpDir => {
                await withContext(tmpDir, mnemonics, async context1 => {
                    await sync(context1);
                    const { value: tokenId } = await boot(context1);
                    expect(tokenId).toBeDefined();
                    await sync(context1);
                    const { txHash } = await request(context1, tokenId, {
                        type: 'insert',
                        key: 'key1',
                        value: 'value1'
                    });
                    const rq1 = firstOutputRef(txHash);
                    await sync(context1);
                    await update(context1, tokenId, [rq1]);
                    await sync(context1);
                    await end(context1, tokenId);
                });
                await sleep(5);

                await withContext(tmpDir, mnemonics, async context2 => {
                    await sync(context2);
                    const { value: tokenId } = await boot(context2);
                    expect(tokenId).toBeDefined();
                    await sync(context2);
                    await end(context2, tokenId);
                });
            });
        },
        60_000
    );
});

export const mkWallet = mnemonic => provider =>
    new MeshWallet({
        networkId: 0,
        fetcher: provider,
        submitter: provider,
        key: {
            type: 'mnemonic',
            words: mnemonic.split(' ')
        }
    });

export async function withContext(
    maybeDatabaseDir: string | null = null,
    maybeMnemonic: string | null = null,
    f
) {
    await withTempDir(async tmpDirFresh => {
        const databaseDir = maybeDatabaseDir || tmpDirFresh;
        const mnemonics = maybeMnemonic || generateMnemonic();

        const yaciStorePort = process.env.YACI_STORE_PORT;
        const yaciStorePortNumber = yaciStorePort
            ? parseInt(yaciStorePort, 10)
            : 8080;
        const yaciAdminPort = process.env.YACI_ADMIN_PORT;
        const yaciAdminPortNumber = yaciAdminPort
            ? parseInt(yaciAdminPort, 10)
            : 10000;
        const provider = yaciProvider(
            `http://localhost:${yaciStorePortNumber}`,
            `http://localhost:${yaciAdminPortNumber}`
        );
        const ogmiosPort = process.env.OGMIOS_PORT;
        const ogmiosPortNumber = ogmiosPort ? parseInt(ogmiosPort, 10) : 1337;

        const ogmios = `http://localhost:${ogmiosPortNumber}`;
        await withLevelDB(databaseDir, async db => {
            const tries = await createTrieManager(db);
            const state = await createState(db, tries, 2160);
            const { address, policyId } = getCagingScript();
            const process = createProcess(state, address, policyId);

            const indexer = await createIndexer(state, process, ogmios);
            try {
                const context = mkContext(
                    ogmios,
                    provider,
                    mnemonics,
                    indexer,
                    state,
                    tries
                );
                const { walletAddress } = await context.signingWallet!.info();
                await topup(provider)(walletAddress, 10_000);
                await f(context);
            } finally {
                await indexer.close();
                await sleep(1);
                await state.close();
                await tries.close();
            }
        });
    });
}

export async function sync(context: Context) {
    await context.waitBlocks(2);
}
