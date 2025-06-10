import { describe, test, expect, it } from 'vitest';
import { boot } from './boot';
import { end } from './end';
import { request } from './request';
import { update } from './update';
import { retract } from './retract';
import { generateMnemonic, MeshWallet } from '@meshsdk/core';
import { Context, getCagingScript, yaciProvider } from '../context';
import { createIndexer } from '../indexer/indexer';
import { withTempDir } from '../test/lib';
import { withLevelDB } from '../trie.test';
import { mkOutputRefId } from '../outputRef';
import { createTrieManager } from '../trie';
import { createState } from '../indexer/state';
import { createProcess } from '../indexer/process';

const txTest = (name: string, testFn: () => Promise<void>, timeout = 10000) =>
    it(name, { concurrent: true, timeout, retry: 3 }, testFn);

describe('Submitting transactions we', () => {
    txTest(
        'can create and delete a token 1',
        async () => {
            await withTempDir(async tmpDir => {
                await withContext(3000, null, null, async context => {
                    await sync(context);

                    const tokenId = await boot(context);
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
            await withContext(3000, null, null, async context => {
                await sync(context);
                const tokenId = await boot(context);

                await sync(context);
                const tokenBooted = await context.fetchToken(tokenId);
                const ref = await request(
                    context,
                    tokenId,
                    'key',
                    'value',
                    'insert'
                );
                const refId = mkOutputRefId(ref);

                await sync(context);
                const requests = await context.fetchRequests(tokenId);
                if (!requests.some(req => req.outputRef === refId)) {
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
            await withContext(3000, null, null, async context => {
                await sync(context);
                const tokenId = await boot(context);

                await sync(context);
                const req = await request(
                    context,
                    tokenId,
                    'key',
                    'value',
                    'insert'
                );
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
            await withContext(3000, null, null, async context => {
                await sync(context);
                const tokenId = await boot(context);

                await sync(context);
                const requestRef = await request(
                    context,
                    tokenId,
                    'key',
                    'value',
                    'insert'
                );
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
            await withContext(3000, null, null, async context => {
                await sync(context);
                const tokenId = await boot(context);

                await sync(context);
                const requestRef1 = await request(
                    context,
                    tokenId,
                    'key1',
                    'value1',
                    'insert'
                );
                const requestRefId1 = mkOutputRefId(requestRef1);

                await sync(context);
                await update(context, tokenId, [requestRef1]);

                await sync(context);
                const requestRef2 = await request(
                    context,
                    tokenId,
                    'key2',
                    'value2',
                    'insert'
                );
                const requestRefId2 = mkOutputRefId(requestRef2);

                await sync(context);
                await update(context, tokenId, [requestRef2]);

                await sync(context);
                const requests = await context.fetchRequests(tokenId);

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
            await withContext(3000, null, null, async context => {
                await sync(context);
                const tokenId = await boot(context);

                await sync(context);
                const requestRef1 = await request(
                    context,
                    tokenId,
                    'key1',
                    'value1',
                    'insert'
                );
                const requestRefId1 = mkOutputRefId(requestRef1);

                await sync(context);
                const requestRef2 = await request(
                    context,
                    tokenId,
                    'key2',
                    'value2',
                    'insert'
                );
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
                await withContext(3000, tmpDir, mnemonics, async context1 => {
                    await sync(context1);
                    const tokenId = await boot(context1);
                    expect(tokenId).toBeDefined();
                    await sync(context1);
                    const rq1 = await request(
                        context1,
                        tokenId,
                        'key1',
                        'value1',
                        'insert'
                    );
                    await sync(context1);
                    await update(context1, tokenId, [rq1]);
                    await sync(context1);
                    await end(context1, tokenId);
                });
                await new Promise(resolve => setTimeout(resolve, 5000));

                await withContext(3000, tmpDir, mnemonics, async context2 => {
                    await sync(context2);
                    const tokenId = await boot(context2);
                    expect(tokenId).toBeDefined();
                    await sync(context2);
                    await end(context2, tokenId);
                });
            });
        },
        60_000
    );
});
export async function withContext(
    port: number,
    maybeDatabaseDir: string | null = null,
    maybeMnemonic: string | null = null,
    f
) {
    await withTempDir(async tmpDirFresh => {
        const databaseDir = maybeDatabaseDir || tmpDirFresh;
        const mnemonic = maybeMnemonic || generateMnemonic();

        const mkWallet = provider =>
            new MeshWallet({
                networkId: 0,
                fetcher: provider,
                submitter: provider,
                key: {
                    type: 'mnemonic',
                    words: mnemonic.split(' ')
                }
            });
        const yaciStorePort = process.env.YACI_STORE_PORT;
        const yaciStorePortNumber = yaciStorePort
            ? parseInt(yaciStorePort, 10)
            : 8080;
        const yaciAdminPort = process.env.YACI_ADMIN_PORT;
        const yaciAdminPortNumber = yaciAdminPort
            ? parseInt(yaciAdminPort, 10)
            : 10000;
        const ctxProvider = yaciProvider(
            `http://localhost:${yaciStorePortNumber}`,
            `http://localhost:${yaciAdminPortNumber}`
        );
        const ogmiosPort = process.env.OGMIOS_PORT;
        const ogmiosPortNumber = ogmiosPort ? parseInt(ogmiosPort, 10) : 1337;

        const ogmios = `http://localhost:${ogmiosPortNumber}`;
        const wallet = mkWallet(ctxProvider.provider);
        await withLevelDB(databaseDir, async db => {
            const tries = await createTrieManager(db);
            const state = await createState(db, tries, 2160);
            const { address, policyId } = getCagingScript();
            const process = createProcess(state, address, policyId);

            const indexer = await createIndexer(
                state.checkpoints,
                process,
                ogmios
            );
            try {
                const context = await new Context(
                    ctxProvider.provider,
                    wallet,
                    indexer,
                    state,
                    tries
                );
                if (ctxProvider.topup) {
                    const { walletAddress } = await context.wallet();
                    const startTime = Date.now();
                    const timeout = 60 * 1000; // 30 seconds

                    while (Date.now() - startTime < timeout) {
                        try {
                            await ctxProvider.topup(walletAddress, 10_000);
                            break;
                        } catch (error) {
                            await new Promise(resolve =>
                                setTimeout(resolve, 5000 * Math.random() + 1)
                            );
                        }
                    }
                    await f(context);
                }
            } finally {
                await indexer.close();
                await new Promise(resolve => setTimeout(resolve, 1000));
                await state.close();
                await tries.close();
            }
        });
    });
}

export async function sync(context: Context) {
    await context.waitBlocks(2);
}
