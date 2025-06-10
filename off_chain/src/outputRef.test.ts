import { describe, it, expect } from 'vitest';
import { mkOutputRefId, unmkOutputRefId } from './outputRef';
import * as fc from 'fast-check';

function mkHash(string: string): string {
    return Buffer.from(string).toString('base64');
}

describe('mkOutputRefId and unmkOutputRefId', () => {
    it('should generate and parse output reference IDs correctly', () => {
        const outputRef = { txHash: 'abc123', outputIndex: 0 };
        const refId = mkOutputRefId(outputRef);
        expect(refId).toBe('abc123-0');

        const parsedRef = unmkOutputRefId(refId);
        expect(parsedRef).toEqual(outputRef);
    });

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
