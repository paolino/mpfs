import { describe, it, expect } from 'vitest';
import { withTempDir } from './test/lib';
import { createTrieManager, TrieManager } from './trie';
import { Store, Trie } from './mpf/lib';
import { Level } from 'level';
import { createLoaded } from './trie/loaded';

export async function withLevelDB(
    tmpDir,
    callback: (db: Level<any, any>) => Promise<void>
) {
    const db = new Level(tmpDir, { valueEncoding: 'json' });
    try {
        await callback(db);
    } catch (error) {
        console.error('Error during LevelDB operation:', error);
        throw error;
    } finally {
        await db.close();
    }
}

describe('Trie', () => {
    it('can close and reopen without errors', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const store = new Store('testTrie', db);
                await store.ready();
                const trie = new Trie(store);
                await store.ready();
                expect(trie).toBeDefined();
                await store.close();
            });
            await withLevelDB(tmpDir, async dbReopened => {
                const storeReopened = new Store('testTrie', dbReopened);
                await storeReopened.ready();
            });
        });
    });
});

describe('Loaded', () => {
    it('can create and close', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const trie = await createLoaded('tk1', db);
                expect(trie).toBeDefined();
                await trie.close();
            });
        });
    });
    it('can close and reopen without errors', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const trie = await createLoaded('tk1', db);
                expect(trie).toBeDefined();
                await trie.close();
            });
            await withLevelDB(tmpDir, async reopenedDb => {
                const reopenedTrie = await createLoaded('tk1', reopenedDb);
                expect(reopenedTrie).toBeDefined();
                await reopenedTrie.close();
            });
        });
    });
});

describe('TrieManager', () => {
    it('can load with 0 tries', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const trieManager = await createTrieManager(db);
                expect(trieManager).toBeDefined();
                const trieIds = await trieManager.trieIds();
                expect(trieIds).toBeDefined();
                expect(trieIds.length).toBe(0);
            });
        });
    });
    it('can create a trie', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const trieManager = await createTrieManager(db);

                async function onTrie(trie) {
                    expect(trie).toBeDefined();
                    expect(trie.root()).toBeDefined();
                    expect(await trie.allFacts()).toEqual({});
                }
                await trieManager.trie('testTokenId', onTrie);
                const tries = await trieManager.trieIds();
                expect(tries).toBeDefined();
                expect(tries.includes('testTokenId')).toBe(true);
            });
        });
    });
    it('can update a trie', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const trieManager = await createTrieManager(db);

                async function onTrie(trie) {
                    await trie.update({
                        key: 'testKey',
                        value: 'testValue',
                        operation: 'insert'
                    });
                    expect(trie.root()).toBeDefined();
                    expect(await trie.allFacts()).toEqual({
                        testKey: 'testValue'
                    });
                }
                await trieManager.trie('testTokenId', onTrie);
            });
        });
    });
    it('can close and reopen without errors', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const trieManager = await createTrieManager(db);
                await trieManager.close();
            });
            await withLevelDB(tmpDir, async reopenedDb => {
                const reopenedTrieManager = await createTrieManager(reopenedDb);
                expect(reopenedTrieManager).toBeDefined();
                await reopenedTrieManager.close();
            });
        });
    });
    it('can reopen a non-empty trie manager', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const trieManager = await createTrieManager(db);
                async function onTrie(trie) {}
                await trieManager.trie('testTokenId', onTrie);
                expect(await trieManager.trieIds()).toEqual(['testTokenId']);
                await trieManager.close();
            });
            await withLevelDB(tmpDir, async reopenedDb => {
                const reopenedTrieManager = await createTrieManager(reopenedDb);
                expect(await reopenedTrieManager.trieIds()).toEqual([
                    'testTokenId'
                ]);
                await reopenedTrieManager.close();
            });
        });
    });
    it('can reopen a non-empty trie manager with non-empty-trie', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const trieManager = await createTrieManager(db);
                async function onTrie(trie) {
                    await trie.update({
                        key: 'testKey',
                        value: 'testValue',
                        operation: 'insert'
                    });
                }
                await trieManager.trie('testTokenId', onTrie);
                expect(await trieManager.trieIds()).toEqual(['testTokenId']);
                await trieManager.close();
            });
            await withLevelDB(tmpDir, async reopenedDb => {
                const reopenedTrieManager = await createTrieManager(reopenedDb);
                expect(await reopenedTrieManager.trieIds()).toEqual([
                    'testTokenId'
                ]);
                await reopenedTrieManager.trie('testTokenId', async trie => {
                    expect(await trie.allFacts()).toEqual({
                        testKey: 'testValue'
                    });
                });
                await reopenedTrieManager.close();
            });
        });
    });
});
