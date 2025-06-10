import { describe, it, expect } from 'vitest';
import { RollbackKey } from './rollbackkey';
import * as fc from 'fast-check';
import { withTempDir } from '../../test/lib';
import { withLevelDB } from '../../trie.test';
import { Checkpoint, createCheckpoints } from './checkpoints';

function mkHash(string: string): string {
    return Buffer.from(string).toString('base64');
}
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

describe('Checkpoints db', () => {
    it('should store and retrieve checkpoints', async () => {
        await withTempDir(async tmpDir => {
            await withLevelDB(tmpDir, async db => {
                // const tries = await createTrieManager(db);
                const checkpointsSize = 10;
                const checkpoints = await createCheckpoints(
                    db as any,
                    checkpointsSize
                );
                const checkpoint = {
                    slot: new RollbackKey(123456789),
                    blockHash: 'blockhash123'
                };

                await checkpoints.putCheckpoint(checkpoint, []);
                const retrievedHash = await checkpoints.getAllCheckpoints();
                expect(retrievedHash).toContainEqual(checkpoint);
            });
        });
    });
    it('should store checkpoints and retrieve them in order', async () => {
        await fc.assert(
            fc.asyncProperty(genCheckpoints(0, 100), async checkpoints => {
                await withTempDir(async tmpDir => {
                    await withLevelDB(tmpDir, async db => {
                        const checkpointsSize = null;
                        const checkpointsDB = await createCheckpoints(
                            db as any,
                            checkpointsSize
                        );

                        for (const checkpoint of checkpoints) {
                            await checkpointsDB.putCheckpoint(checkpoint, []);
                        }

                        const retrievedCheckpoints =
                            await checkpointsDB.getAllCheckpoints();
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
                        const checkpointsSize = 20;
                        expect(checkpoints.length).toBeGreaterThanOrEqual(
                            checkpointsSize
                        );
                        const checkpointsDB = await createCheckpoints(
                            db as any,
                            checkpointsSize
                        );

                        for (const checkpoint of checkpoints) {
                            await checkpointsDB.putCheckpoint(checkpoint, []);
                        }

                        const retrievedCheckpoints =
                            await checkpointsDB.getAllCheckpoints();

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
});
