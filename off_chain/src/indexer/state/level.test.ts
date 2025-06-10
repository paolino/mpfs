import { describe, it, expect } from 'vitest';
import { RollbackKey } from './rollbackkey';
import { Level } from 'level';
import * as fc from 'fast-check';
import { withTempDir } from '../../test/lib';

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
