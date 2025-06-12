import { AbstractSublevel } from 'abstract-level';
import { levelHash } from '../indexer/level-hash';

export type Facts = {
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | undefined>;
    getAll(): Promise<Record<string, string>>;
    delete(key: string): Promise<void>;
    close(): Promise<void>;
    hash(): Promise<string>;
};

export const createFacts = async (
    parent: AbstractSublevel<any, any, string, any>
) => {
    const db = parent.sublevel('facts');

    return {
        async set(key: string, value: string): Promise<void> {
            await db.put(key, value);
        },

        async get(key: string): Promise<string | undefined> {
            return await db.get(key);
        },

        async getAll(): Promise<Record<string, string>> {
            const result: Record<string, string> = {};
            for await (const [key, value] of db.iterator()) {
                result[key] = value;
            }
            return result;
        },

        async delete(key: string): Promise<void> {
            await db.del(key);
        },

        async close(): Promise<void> {
            await db.close();
        },
        async hash(): Promise<string> {
            return await levelHash(db);
        }
    };
};
