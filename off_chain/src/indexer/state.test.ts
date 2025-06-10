import { describe, it, expect } from 'vitest';
import { RollbackKey } from './state/rollbackkey';
import { Level } from 'level';
import { mkOutputRefId, unmkOutputRefId } from '../outputRef';
import * as fc from 'fast-check';
import { samplePowerOfTwoPositions } from './state/intersection';
import { withTempDir } from '../test/lib';
import { withLevelDB } from '../trie.test';
import { Checkpoint } from './state/checkpoints';
import { createState } from './state';
import { createTrieManager } from '../trie';

describe('level-db', () => {
    it('supports reopening a database', async () => {
        await withTempDir(async tmpDir => {
            const db = new Level<string, string>(tmpDir, {
                valueEncoding: 'utf8',
                keyEncoding: 'utf8'
            });
            await db.put('key1', 'value1');
            await db.close();
            const reopenedDb = new Level<string, string>(tmpDir, {
                valueEncoding: 'utf8',
                keyEncoding: 'utf8'
            });
            const value = await reopenedDb.get('key1');
            expect(value).toBe('value1');
            await reopenedDb.close();
        });
    });
    it('supports Buffer as keys', async () => {
        await withTempDir(async tmpDir => {
            const db = new Level<Buffer, string>(tmpDir, {
                valueEncoding: 'utf8',
                keyEncoding: 'binary'
            });
            const key = Buffer.from('test-key');
            const value = 'test-value';
            await db.put(key, value);
            const retrievedValue = await db.get(key);
            expect(retrievedValue).toBe(value);
            await db.del(key);
            await db.close();
        });
    });
    it('Return keys in lexicographic order for Buffer keys', async () => {
        fc.assert(
            fc.asyncProperty(
                fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
                    minLength: 1,
                    maxLength: 100
                }),
                async keys => {
                    await withTempDir(async tmpDir => {
                        const db = new Level<Buffer, string>(tmpDir, {
                            valueEncoding: 'utf8',
                            keyEncoding: 'binary'
                        });
                        const uniqueKeys = Array.from(new Set(keys)).sort();
                        // Ensure keys are unique and sorted
                        const bufferKeys = uniqueKeys.map(k => Buffer.from(k));
                        for (const key of bufferKeys) {
                            await db.put(key, 'value');
                        }
                        const retrievedKeys: Buffer[] = [];
                        for await (const key of db.keys()) {
                            retrievedKeys.push(key);
                        }
                        expect(retrievedKeys).toEqual(
                            bufferKeys.sort(Buffer.compare)
                        );
                        await db.close();
                    });
                }
            )
        );
    });
    it('Returns keys in lexicographic order for RollbackKeys', async () => {
        fc.assert(
            fc.asyncProperty(
                fc.array(fc.integer({ min: 0, max: 2 ^ (64 - 1) }), {
                    minLength: 100,
                    maxLength: 1000
                }),
                async values => {
                    await withTempDir(async tmpDir => {
                        const db = new Level<Buffer, string>(tmpDir, {
                            valueEncoding: 'utf8',
                            keyEncoding: 'binary'
                        });
                        const uniqueValues = Array.from(new Set(values)).sort();
                        // Ensure values are unique and sorted
                        const rollbackKeys = uniqueValues.map(
                            v => new RollbackKey(v)
                        );
                        for (const key of rollbackKeys) {
                            await db.put(key.key, 'value');
                        }
                        const retrievedKeys: Buffer[] = [];
                        for await (const key of db.keys()) {
                            retrievedKeys.push(key);
                        }
                        expect(retrievedKeys).toEqual(
                            retrievedKeys.sort(Buffer.compare)
                        );
                        await db.close();
                    });
                }
            )
        );
    });
});
const genCheckpoints = (min, max) =>
    fc
        .tuple(
            fc.tuple(
                fc.integer({ min: 0, max: 100000 }), // Starting value
                fc.array(fc.integer({ min: 1, max: 3 }), {
                    minLength: min,
                    maxLength: max
                }) // Positive increments
            ),
            fc.string({ minLength: 5, maxLength: 10 }).map(s => mkHash(s)) // Random block hash
        )
        .map(([[start, increments], hash]) => {
            let current = start;
            const vector: Checkpoint[] = [];
            for (const inc of increments) {
                current += inc; // Add positive increment for strict increase
                vector.push({
                    slot: new RollbackKey(current),
                    blockHash: hash
                });
            }
            return vector;
        });

function mkHash(string: string): string {
    return Buffer.from(string).toString('base64');
}
describe('mkOutputRefId and unmkOutputRefId', () => {
    it('should correctly generate and parse output reference IDs', () => {
        fc.assert(
            fc.property(
                fc.string({ minLength: 4, maxLength: 64 }), // Random transaction hash with base16 chars
                fc.integer({ min: 0 }), // Random output index
                (txHashS, outputIndex) => {
                    const txHash = mkHash(txHashS);
                    const outputRef = { txHash, outputIndex };
                    const refId = mkOutputRefId(outputRef);
                    const parsedRef = unmkOutputRefId(refId);
                    expect(parsedRef).toEqual(outputRef);
                }
            )
        );
    });
});
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

    it('should generate and parse output reference IDs correctly', () => {
        const outputRef = { txHash: 'abc123', outputIndex: 0 };
        const refId = mkOutputRefId(outputRef);
        expect(refId).toBe('abc123-0');

        const parsedRef = unmkOutputRefId(refId);
        expect(parsedRef).toEqual(outputRef);
    });
    it('should store and retrieve checkpoints', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                const tries = await createTrieManager(db);
                const checkpointsSize = 10;
                const stateManager = await createState(
                    db,
                    tries,
                    checkpointsSize
                );
                const checkpoint = {
                    slot: new RollbackKey(123456789),
                    blockHash: 'blockhash123'
                };

                await stateManager.checkpoints.putCheckpoint(checkpoint, []);
                const retrievedHash =
                    await stateManager.checkpoints.getAllCheckpoints();
                expect(retrievedHash).toContainEqual(checkpoint);
            });
        });
    });
    it('should store checkpoints and retrieve them in order', async () => {
        await fc.assert(
            fc.asyncProperty(genCheckpoints(0, 100), async checkpoints => {
                await withTempDir(async tmpDir => {
                    await withLevelDB(tmpDir, async db => {
                        const tries = await createTrieManager(db);
                        const checkpointsSize = null;
                        const stateManager = await createState(
                            db,
                            tries,
                            checkpointsSize
                        );

                        for (const checkpoint of checkpoints) {
                            await stateManager.checkpoints.putCheckpoint(
                                checkpoint,
                                []
                            );
                        }

                        const retrievedCheckpoints =
                            await stateManager.checkpoints.getAllCheckpoints();
                        expect(retrievedCheckpoints).toEqual(checkpoints);
                    });
                });
            }),
            { numRuns: 100, verbose: true }
        );
    }, 30000);
    it('should maintain a population at most double than requested and at least the requested size', async () => {
        await fc.assert(
            fc.asyncProperty(genCheckpoints(20, 1000), async checkpoints => {
                await withTempDir(async tmpDir => {
                    await withLevelDB(tmpDir, async db => {
                        const tries = await createTrieManager(db);
                        const checkpointsSize = 20;
                        expect(checkpoints.length).toBeGreaterThanOrEqual(
                            checkpointsSize
                        );
                        const stateManager = await createState(
                            db,
                            tries,
                            checkpointsSize
                        );

                        for (const checkpoint of checkpoints) {
                            await stateManager.checkpoints.putCheckpoint(
                                checkpoint,
                                []
                            );
                        }

                        const retrievedCheckpoints =
                            await stateManager.checkpoints.getAllCheckpoints();

                        expect(retrievedCheckpoints.length).toBeLessThan(
                            checkpointsSize * 2
                        );
                        expect(
                            retrievedCheckpoints.length
                        ).toBeGreaterThanOrEqual(checkpointsSize);
                    });
                });
            }),
            { numRuns: 100, verbose: true }
        );
    }, 30000);
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

                // Reopen the State
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
});
