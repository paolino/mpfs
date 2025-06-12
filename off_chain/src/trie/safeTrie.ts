import { Proof } from '../mpf/lib';
import { Buffer } from 'buffer';
import { createFacts } from './fatcs';
import { AbstractSublevel } from 'abstract-level';
import { Change, invertChange, updateTrie } from '../trie/change';
import { createLoaded } from '../trie/loaded';
import { createHash } from 'crypto';
import { nullHash, rootHex } from '../lib';

export type SafeTrie = {
    getKey(key: string): Promise<Buffer | undefined>;
    temporaryUpdate(change: Change): Promise<Proof>;
    rollback(): Promise<void>;
    update(change: Change): Promise<Proof>;
    root(): Buffer;
    close(): Promise<void>;
    allFacts(): Promise<Record<string, string>>;
    hash(): Promise<string>;
};

export const createSafeTrie = async (
    tokenId: string,
    parent: AbstractSublevel<any, any, string, any>
): Promise<SafeTrie> => {
    const db = parent.sublevel(tokenId, {
        valueEncoding: 'json'
    });
    const loaded = await createLoaded(tokenId, db);
    const facts = await createFacts(db);
    let tempChanges: Change[] = [];
    return {
        getKey: async (key: string): Promise<Buffer | undefined> => {
            return loaded.trie.get(key);
        },
        temporaryUpdate: async (change: Change): Promise<Proof> => {
            tempChanges.push(change);
            return await updateTrie(loaded.trie, change);
        },
        rollback: async (): Promise<void> => {
            for (const change of tempChanges.reverse()) {
                const inverted = invertChange(change);
                await updateTrie(loaded.trie, inverted);
            }
            tempChanges = [];
        },
        update: async (change: Change): Promise<Proof> => {
            const { key, value, operation } = change;
            const proof = await updateTrie(loaded.trie, change);
            switch (change.operation) {
                case 'insert': {
                    await facts.set(key, value);
                    break;
                }
                case 'delete': {
                    await facts.delete(key);
                    break;
                }
                default: {
                    throw new Error(`Unknown operation type: ${operation}`);
                }
            }
            return proof;
        },
        root: (): Buffer => {
            return loaded.trie.hash;
        },
        close: async (): Promise<void> => {
            await loaded.close();
            await facts.close();
            await db.close();
        },
        allFacts: async (): Promise<Record<string, string>> => {
            return await facts.getAll();
        },
        hash: async (): Promise<string> => {
            const hash = createHash('sha256');
            const th = rootHex(loaded.trie.hash) || nullHash;
            hash.update(th);
            const fh = await facts.hash();
            hash.update(fh);
            return hash.digest('hex');
        }
    };
};
