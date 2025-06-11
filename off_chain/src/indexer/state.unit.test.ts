import { describe, it, expect } from 'vitest';
import { withTempDir } from '../test/lib';
import { withLevelDB } from '../trie.test';
import { createState, State, withState } from './state';
import { createTrieManager, TrieManager, withTrieManager } from '../trie';
import { RollbackKey } from './state/rollbackkey';
import { unmkOutputRefId } from '../outputRef';
import { nullHash, OutputRef } from '../lib';
import { Request } from '../request';

describe('State', () => {
    it('should create a State instance with correct properties', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const tries = await createTrieManager(db);
                const checkpointsSize = 100;
                const stateManager = await createState(
                    db,
                    tries,
                    checkpointsSize
                );
            });
        });
    });

    it('supports reopening', async () => {
        const checkpointsSize = 10;
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const tries = await createTrieManager(db);
                const stateManager = await createState(
                    db,
                    tries,
                    checkpointsSize
                );
                await stateManager.close();
            });
            await withLevelDB(tmpDir, async reopenedDb => {
                const tries = await createTrieManager(reopenedDb);
                const reopenedState = await createState(
                    reopenedDb,
                    tries,
                    checkpointsSize
                );
                await reopenedState.close();
            });
        });
    });
    const slot = n => new RollbackKey(n);
    const addToken = async (
        stateManager: State,
        slotNo: number,
        tokenId: string,
        root: string
    ): Promise<void> => {
        const point = slot(slotNo);
        await stateManager.addToken({
            slot: point,
            value: {
                tokenId,
                current: {
                    outputRef: unmkOutputRefId('tx-0'),
                    state: {
                        owner: 'owner',
                        root
                    }
                }
            }
        });
    };
    const withTempTrieAndState = async (
        f: (state: State, tries: TrieManager) => Promise<void>
    ): Promise<void> => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                await withTrieManager(db, async tries => {
                    await withState(db, tries, null, async state => {
                        await f(state, tries);
                    });
                });
            });
        });
    };
    it('can add a token', async () => {
        await withTempTrieAndState(async (state, tries) => {
            await addToken(state, 1, 'token-1', nullHash);
            const token = await state.tokens.getToken('token-1');
            expect(token).toBeDefined();
        });
    });
    it('can rollback a token addition', async () => {
        await withTempTrieAndState(async (state, tries) => {
            await addToken(state, 1, 'token-1', nullHash);
            await state.rollback(slot(0));
            expect(await state.tokens.getToken('token-1')).toBeUndefined();
        });
    });
    it('can remove a token', async () => {
        await withTempTrieAndState(async (state, tries) => {
            await addToken(state, 1, 'token-1', nullHash);
            await state.removeToken({
                slot: slot(2),
                value: 'token-1'
            });
            expect(await state.tokens.getToken('token-1')).toBeUndefined();
        });
    });
    it('can rollback a token removal', async () => {
        await withTempTrieAndState(async (state, tries) => {
            await addToken(state, 1, 'token-1', nullHash);
            await state.removeToken({
                slot: slot(2),
                value: 'token-1'
            });
            await state.rollback(slot(1));
            expect(await state.tokens.getToken('token-1')).toBeDefined();
        });
    });
    it('can rollback a token removal to before the token addition', async () => {
        await withTempTrieAndState(async (state, tries) => {
            await addToken(state, 1, 'token-1', nullHash);
            await state.removeToken({
                slot: slot(2),
                value: 'token-1'
            });
            await state.rollback(slot(0));
            expect(await state.tokens.getToken('token-1')).toBeUndefined();
        });
    });
    const addRequest = async (
        state: State,
        slot: RollbackKey,
        ref: OutputRef,
        tokenId: string
    ): Promise<void> => {
        const request: Request = {
            ref,
            core: {
                tokenId,
                owner: 'owner-1',
                change: {
                    key: 'key-1',
                    value: 'value-1',
                    operation: 'insert'
                }
            }
        };
        await state.addRequest({ slot, value: request });
    };
    it('can add a request', async () => {
        await withTempTrieAndState(async (state, tries) => {
            const ref = unmkOutputRefId('ref-0');
            await addRequest(state, slot(1), ref, 'token-1');
            const req = await state.request(ref);
            expect(req).toBeDefined();
        });
    });
    it('can rollback a request addition', async () => {
        await withTempTrieAndState(async (state, tries) => {
            const ref = unmkOutputRefId('ref-0');
            await addRequest(state, slot(1), ref, 'token-1');
            await state.rollback(slot(0));
            const req = await state.request(ref);
            expect(req).toBeUndefined();
        });
    });
    it('can remove a request', async () => {
        await withTempTrieAndState(async (state, tries) => {
            const ref = unmkOutputRefId('ref-0');
            await addRequest(state, slot(1), ref, 'token-1');
            await state.removeRequest({ slot: slot(2), value: ref });
            const req = await state.request(ref);
            expect(req).toBeUndefined();
        });
    });
    it('can rollback a request removal', async () => {
        await withTempTrieAndState(async (state, tries) => {
            const ref = unmkOutputRefId('ref-0');
            await addRequest(state, slot(1), ref, 'token-1');
            await state.removeRequest({ slot: slot(2), value: ref });
            await state.rollback(slot(1));
            const req = await state.request(ref);
            expect(req).toBeDefined();
        });
    });
    it('can rollback a request removal to before the request addition', async () => {
        await withTempTrieAndState(async (state, tries) => {
            const ref = unmkOutputRefId('ref-0');
            await addRequest(state, slot(1), ref, 'token-1');
            await state.removeRequest({ slot: slot(2), value: ref });
            await state.rollback(slot(0));
            const req = await state.request(ref);
            expect(req).toBeUndefined();
        });
    });
    it('can update a token', async () => {
        await withTempTrieAndState(async (state, tries) => {
            await addToken(state, 1, 'token-1', nullHash);
            await state.updateToken({
                slot: slot(2),
                value: {
                    token: {
                        current: {
                            outputRef: unmkOutputRefId('tx-1'),
                            state: {
                                owner: 'owner-2',
                                root: '2o342op'
                            }
                        },
                        tokenId: 'token-1'
                    },
                    change: {
                        key: 'key-1',
                        value: 'value-2',
                        operation: 'insert'
                    }
                }
            });
            const token = await state.tokens.getToken('token-1');
            expect(token).toBeDefined();
            expect(token!.state.owner).toBe('owner-2');
            expect(token!.state.root).toBe('2o342op');
            expect(token!.outputRef).toEqual(unmkOutputRefId('tx-1'));
        });
    });
    it('can rollback a token update', async () => {
        await withTempTrieAndState(async (state, tries) => {
            await addToken(state, 1, 'token-1', nullHash);
            await state.updateToken({
                slot: slot(2),
                value: {
                    token: {
                        current: {
                            outputRef: unmkOutputRefId('tx-1'),
                            state: {
                                owner: 'owner-2',
                                root: '2o342op'
                            }
                        },
                        tokenId: 'token-1'
                    },
                    change: {
                        key: 'key-1',
                        value: 'value-2',
                        operation: 'insert'
                    }
                }
            });
            await state.rollback(slot(1));
            const token = await state.tokens.getToken('token-1');
            expect(token).toBeDefined();
            expect(token!.state.owner).toBe('owner');
            expect(token!.state.root).toBe(nullHash);
            expect(token!.outputRef).toEqual(unmkOutputRefId('tx-0'));
        });
    });
});
