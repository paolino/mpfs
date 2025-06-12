import { AbstractSublevel } from 'abstract-level';
import { RollbackKey } from './rollbackkey';
import { samplePowerOfTwoPositions } from './intersection';
import { levelHash } from '../level-hash';

export type Checkpoint = {
    slot: RollbackKey;
    blockHash: string;
};
export type BlockHash = string;

export type CheckpointValue = {
    blockHash: BlockHash;
    consumedRefIds: string[];
};

export type Checkpoints = {
    putCheckpoint(
        checkpoint: Checkpoint,
        consumedRefIds: string[]
    ): Promise<void>;
    getCheckpoint(slot: RollbackKey): Promise<BlockHash | undefined>;
    getAllCheckpoints(): Promise<Checkpoint[]>;
    rollback(cp: RollbackKey | null): Promise<void>;
    getIntersections(): Promise<Checkpoint[]>;
    hash(): Promise<string>;
    close(): Promise<void>;
};

export const createCheckpoints = async (
    parent: AbstractSublevel<any, any, any, any>,
    size: number | null = null
): Promise<Checkpoints> => {
    const db: AbstractSublevel<
        any,
        any,
        Buffer<ArrayBufferLike>,
        CheckpointValue
    > = parent.sublevel('checkpoints', {
        valueEncoding: 'json',
        keyEncoding: 'binary'
    });
    await db.open();
    let count = 0;
    const dropCheckpointsTail = async (): Promise<void> => {
        if (size === null) {
            return; // No decimation if checkpointsSize is not set
        }
        if (count < 2 * size) {
            return; // No need to decimate if we have fewer checkpoints than the size
        }
        const iterator = db.iterator({
            gte: RollbackKey.zero.key,
            limit: count - size
        });
        for await (const [key] of iterator) {
            await db.del(key);
            count--;
        }
    };
    const all = async () => {
        const checkpoints: Checkpoint[] = [];
        for await (const [key, value] of db.iterator()) {
            checkpoints.push({
                slot: RollbackKey.fromKey(key),
                blockHash: value.blockHash
            });
        }
        return checkpoints;
    };
    return {
        putCheckpoint: async (
            checkpoint: Checkpoint,
            consumedRefIds: string[]
        ) => {
            await db.put(checkpoint.slot.key, {
                blockHash: checkpoint.blockHash,
                consumedRefIds
            });
            count++;
            await dropCheckpointsTail();
        },
        getCheckpoint: async (slot: RollbackKey) => {
            const value = await db.get(slot.key);
            return value?.blockHash;
        },
        getAllCheckpoints: all,
        getIntersections: async () => {
            const allPoints = await all();
            return samplePowerOfTwoPositions(allPoints.reverse());
        },
        rollback: async (slot: RollbackKey | null) => {
            const checkpoints: CheckpointValue[] = [];
            const iterator = slot
                ? db.iterator({ gt: slot.key })
                : db.iterator();
            for await (const [key] of iterator) {
                db.del(key);
            }
        },
        close: async () => {
            try {
                await db.close();
            } catch (error) {
                console.error('Error closing Checkpoints:', error);
            }
        },
        hash: async () => {
            return await levelHash(db);
        }
    };
};
