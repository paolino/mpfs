import { describe, it, expect } from 'vitest';
import { createRollbacks } from './rollbacks';
import { RollbackKey } from './rollbackkey';
import * as fc from 'fast-check';
import { withLevelDB } from '../../trie.test';
import { withTempDir } from '../../test/lib';

const withTempLevelDB = async (tmpDir, callback) => {
    await withTempDir(async tempDir => {
        await withLevelDB(tempDir, async db => {
            try {
                await callback(db);
            } catch (error) {
                console.error('Error during LevelDB operation:', error);
                throw error;
            }
        });
    });
};

export const generateRollbackKeys = (): fc.Arbitrary<{
    result: RollbackKey[];
    length: number;
}> =>
    fc
        .integer({ min: 3, max: 100 }) // Positive increments
        .map(length => {
            const result: RollbackKey[] = [];
            for (let i = 0; i < length; i++) {
                result.push(new RollbackKey(i));
            }
            return { result, length };
        });

describe('Rollbacks db', async () => {
    it('second extraction has no intersection with first extraction', async () => {
        await fc.assert(
            fc.asyncProperty(
                generateRollbackKeys().chain(({ result, length }) =>
                    fc.tuple(
                        fc.constant(result),
                        fc
                            .integer({ min: 2, max: length - 1 })
                            .chain(cut =>
                                fc.tuple(
                                    fc.constant(cut),
                                    fc.integer({ min: 1, max: cut - 1 })
                                )
                            )
                    )
                ),
                async ([ps, [cut1, cut2]]) => {
                    await withTempLevelDB('testDir', async db => {
                        const rollbacks = await createRollbacks(db);
                        for (let i = 0; i < ps.length; i++) {
                            await rollbacks.put(ps[i], i);
                        }
                        const extract1 = await rollbacks.extractAfter(
                            new RollbackKey(cut1)
                        );

                        expect(extract1.reverse()).toEqual(
                            ps.slice(cut1 + 1).map(r => r.value)
                        );
                        const extract2 = await rollbacks.extractAfter(
                            new RollbackKey(cut2)
                        );
                        expect(extract2.reverse()).toEqual(
                            ps.slice(cut2 + 1, cut1 + 1).map(r => r.value)
                        );
                    });
                }
            ),
            { numRuns: 10, verbose: true }
        );
    });
    it('pruning up to a rollback key doesnt affect extracting after it', async () => {
        await fc.assert(
            fc.asyncProperty(
                generateRollbackKeys().chain(({ result, length }) =>
                    fc.tuple(
                        fc.constant(result),
                        fc.integer({ min: 2, max: length - 1 })
                    )
                ),
                async ([ps, cut]) => {
                    await withTempLevelDB('testDir', async db => {
                        const rollbacks = await createRollbacks(db);
                        for (let i = 0; i < ps.length; i++) {
                            await rollbacks.put(ps[i], i);
                        }
                        await rollbacks.pruneBefore(new RollbackKey(cut));
                        const extract1 = await rollbacks.extractAfter(
                            new RollbackKey(cut)
                        );

                        expect(extract1.reverse()).toEqual(
                            ps.slice(cut + 1).map(r => r.value)
                        );
                    });
                }
            ),
            { numRuns: 100, verbose: true }
        );
    });
    it('pruning up to a rollback key does affect extracting before it', async () => {
        await fc.assert(
            fc.asyncProperty(
                generateRollbackKeys().chain(({ result, length }) =>
                    fc.tuple(
                        fc.constant(result),
                        fc.tuple(
                            fc.integer({ min: 0, max: length - 1 }),
                            fc.integer({ min: -1, max: length - 1 })
                        )
                    )
                ),
                async ([ps, [prune, extract]]) => {
                    await withTempLevelDB('testDir', async db => {
                        const rollbacks = await createRollbacks(db);
                        for (let i = 0; i < ps.length; i++) {
                            await rollbacks.put(ps[i], i);
                        }
                        await rollbacks.pruneBefore(new RollbackKey(prune));
                        const extracted = await rollbacks.extractAfter(
                            extract < 0 ? 'origin' : new RollbackKey(extract)
                        );
                        if (extract < prune) {
                            expect(extracted.reverse()).toEqual(
                                ps.slice(prune).map(r => r.value)
                            );
                        } else {
                            expect(extracted.reverse()).toEqual(
                                ps.slice(extract + 1).map(r => r.value)
                            );
                        }
                    });
                }
            ),
            { numRuns: 100, verbose: true }
        );
    });
});
