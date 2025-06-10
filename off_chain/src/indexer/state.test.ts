import { describe, it, expect } from 'vitest';
import { withTempDir } from '../test/lib';
import { withLevelDB } from '../trie.test';
import { createState } from './state';
import { createTrieManager } from '../trie';

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
});
