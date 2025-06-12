import { AbstractSublevel } from 'abstract-level';
import { RollbackKey } from './rollbackkey';
import { samplePowerOfTwoPositions } from './intersection';
import { levelHash } from '../level-hash';
import { WithOrigin } from '../../lib';

export type Checkpoint = {
    slot: RollbackKey;
    id: string;
};
export type BlockHash = string;

export type CheckpointValue = {
    blockHash: BlockHash;
    consumedRefIds: string[];
};

export const checkpointWithOriginGreaterThan = (
    a: WithOrigin<Checkpoint>,
    b: WithOrigin<Checkpoint>
): boolean => {
    if (a === 'origin') return false;
    if (b === 'origin') return true;
    return a.slot > b.slot;
};

export type Checkpoints = {
    putCheckpoint(
        checkpoint: Checkpoint,
        consumedRefIds: string[]
    ): Promise<void>;
    getCheckpoint(slot: RollbackKey): Promise<BlockHash | undefined>;
    getAllCheckpoints(): Promise<Checkpoint[]>;
    rollback(cp: WithOrigin<RollbackKey>): Promise<void>;
    getIntersections(): Promise<WithOrigin<Checkpoint>[]>;
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
                id: value.blockHash
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
                blockHash: checkpoint.id,
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
            const goods = samplePowerOfTwoPositions(
                allPoints.reverse()
            ) as any[];
            goods.push('origin');
            return goods;
        },
        rollback: async (slot: WithOrigin<RollbackKey>) => {
            const checkpoints: CheckpointValue[] = [];
            const iterator =
                slot !== 'origin'
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
