import { describe, it, expect } from 'vitest';
import { mkOutputRefId, unmkOutputRefId } from '../outputRef';
import * as fc from 'fast-check';
import { withTempDir } from '../test/lib';
import { withLevelDB } from '../trie.test';
import { createState } from './state';
import { createTrieManager } from '../trie';

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
