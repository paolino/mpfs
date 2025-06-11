import { describe, it, expect } from 'vitest';
import { withTempDir } from '../test/lib';
import { withLevelDB } from '../trie.test';
import { createState, State, withState } from './state';
import { createTrieManager, TrieManager, withTrieManager } from '../trie';
import { createProcess } from './process';
import { Context, getCagingScript, yaciProvider } from '../context';
import { createIndexer, withIndexer, Indexer } from './indexer';
import { Checkpoint } from './state/checkpoints';
import { generateMnemonic } from 'bip39';
import { mkWallet } from '../transactions/transactions.test';
import { boot } from '../transactions/boot';
import { request } from '../transactions/request';
import { update } from '../transactions/update';
import { SafeTrie } from '../trie/safeTrie';
import { nullHash, sleep, sleepMs } from '../lib';
import { a } from 'vitest/dist/chunks/suite.d.FvehnV49.js';

describe('State and Indexer', () => {
    it('can restart with indexer', { timeout: 20000 }, async () => {
        const checkpointsSize = 10;
        const { address, policyId } = getCagingScript();
        let last: Checkpoint | undefined = undefined;
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const tries = await createTrieManager(db);
                const stateManager = await createState(
                    db,
                    tries,
                    checkpointsSize
                );
                const process = createProcess(stateManager, address, policyId);
                const indexer = await createIndexer(
                    stateManager.checkpoints,
                    process,
                    'http://localhost:1337'
                );
                await indexer.waitBlocks(0);
                await indexer.close();
                const cps = await stateManager.checkpoints.getIntersections();
                last = cps[0];
                await stateManager.close();
            });

            expect(last).toBeDefined();
            await sleep(2);

            await withLevelDB(tmpDir, async reopenedDb => {
                const tries = await createTrieManager(reopenedDb);
                const reopenedState = await createState(
                    reopenedDb,
                    tries,
                    checkpointsSize
                );
                const process = createProcess(reopenedState, address, policyId);

                const indexer = await createIndexer(
                    reopenedState.checkpoints,
                    process,
                    'http://localhost:1337'
                );
                await indexer.waitBlocks(1);
                await indexer.close();
                const finalPoints =
                    await reopenedState.checkpoints.getAllCheckpoints();
                expect(finalPoints).toContainEqual(last);
                const intersections =
                    await reopenedState.checkpoints.getIntersections();
                expect(intersections[0].slot.value).toBeGreaterThan(
                    last!.slot.value
                );

                await reopenedState.close();
            });
        });
    });
    it(
        'can restart after rolling back the db by hand',
        { timeout: 20000 },
        async () => {
            const checkpointsSize = 10;
            const { address, policyId } = getCagingScript();
            let rollback: Checkpoint | undefined = undefined;
            await withTempDir(async tmpDir => {
                await withLevelDB(tmpDir, async db => {
                    const tries = await createTrieManager(db);
                    const stateManager = await createState(
                        db,
                        tries,
                        checkpointsSize
                    );
                    const process = createProcess(
                        stateManager,
                        address,
                        policyId
                    );
                    const indexer = await createIndexer(
                        stateManager.checkpoints,
                        process,
                        'http://localhost:1337'
                    );
                    await indexer.waitBlocks(0);
                    await indexer.close();
                    const cps =
                        await stateManager.checkpoints.getAllCheckpoints();
                    rollback = cps[Math.floor(Math.random() * cps.length)];
                    await stateManager.rollback(rollback.slot);
                    await stateManager.close();
                });

                expect(rollback).toBeDefined();
                await sleep(2);

                await withLevelDB(tmpDir, async reopenedDb => {
                    const tries = await createTrieManager(reopenedDb);
                    const reopenedState = await createState(
                        reopenedDb,
                        tries,
                        checkpointsSize
                    );
                    const process = createProcess(
                        reopenedState,
                        address,
                        policyId
                    );

                    const indexer = await createIndexer(
                        reopenedState.checkpoints,
                        process,
                        'http://localhost:1337'
                    );
                    await indexer.waitBlocks(1);
                    await indexer.close();
                    const finalPoints =
                        await reopenedState.checkpoints.getAllCheckpoints();
                    expect(finalPoints).toContainEqual(rollback);
                    const intersections =
                        await reopenedState.checkpoints.getIntersections();
                    expect(intersections[0].slot.value).toBeGreaterThan(
                        rollback!.slot.value
                    );

                    await reopenedState.close();
                });
            });
        }
    );
    it(
        'can restart after rolling back the db by hand and contains one empty token',
        { timeout: 60000 },
        async () => {
            let rollback: Checkpoint | undefined = undefined;
            let tokenId: string | undefined = undefined;
            await withTempDir(async tmpDir => {
                // first run
                await withSetup(
                    10, // checkpointsSize
                    tmpDir,
                    async (tries, state, indexer, context) => {
                        tokenId = await boot(context);
                        await indexer.waitBlocks(2);
                        await indexer.close(); // this is not very friendly with 'withIndexer', but we risk to lose the last checkpoint
                        const cps = await state.checkpoints.getAllCheckpoints();
                        console.log(`Checkpoints after boot: ${cps}`);
                        // rollback = cps[cps.length - 1]; // newest possible checkpoint, cheating
                        rollback = cps[0]; // oldest possible checkpoint
                        await state.rollback(rollback.slot);
                    }
                );
                // restart with the same DB
                await withSetup(
                    10,
                    tmpDir,
                    async (tries, state, indexer, context) => {
                        await indexer.waitBlocks(0);
                        const token = await state.tokens.getToken(tokenId!);
                        expect(token).toBeDefined();
                        const signerHash = await context
                            .wallet()
                            .then(w => w.signerHash);
                        expect(token!.state.owner).toEqual(signerHash);
                        expect(token!.state.root).toEqual(nullHash);
                    }
                );
            });
        }
    );
});

const withSetup = async (
    checkpointsSize: number,
    tmpDir: string,
    f: (
        tries: TrieManager,
        state: State,
        indexer: Indexer,
        context: Context
    ) => Promise<void>
): Promise<void> => {
    const { address, policyId } = getCagingScript();
    const ctxProvider = yaciProvider(
        `http://localhost:8080`,
        `http://localhost:10000`
    );
    const mnemonic = generateMnemonic();
    const wallet = mkWallet(mnemonic)(ctxProvider.provider);
    await withLevelDB(tmpDir, async db => {
        await withTrieManager(db, async tries => {
            await withState(db, tries, checkpointsSize, async state => {
                const process = createProcess(state, address, policyId);
                await withIndexer(
                    state.checkpoints,
                    process,
                    'http://localhost:1337',
                    async indexer => {
                        const context = await new Context(
                            ctxProvider.provider,
                            wallet,
                            indexer,
                            state,
                            tries
                        );
                        const { walletAddress } = await context.wallet();

                        while (true) {
                            try {
                                await ctxProvider.topup!(walletAddress, 10_000);
                                break;
                            } catch (error) {
                                console.error(
                                    'Top-up failed, retrying...',
                                    error
                                );
                                await sleepMs(
                                    Math.floor(Math.random() * 5000) + 1000
                                );
                            }
                        }
                        await indexer.waitBlocks(0);
                        await f(tries, state, indexer, context);
                    }
                );
            });
        });
    });
};
