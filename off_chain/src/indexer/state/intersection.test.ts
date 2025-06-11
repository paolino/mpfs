import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { samplePowerOfTwoPositions } from './intersection';

describe('Power of 2 indices selection', () => {
    it('should select no elements from an empty array', async () => {
        const arr: any[] = [];
        const result = samplePowerOfTwoPositions(arr);
        expect(result).toEqual([]);
    });
    it('should select the first element from a single-element array', async () => {
        const arr = [1];
        const result = samplePowerOfTwoPositions(arr);
        expect(result).toEqual([1]);
    });
    it('should select the first and last elements from a two-element array', async () => {
        const arr = [1, 2];
        const result = samplePowerOfTwoPositions(arr);
        expect(result).toEqual([1, 2]);
    });
    it('should select the first, last on any array with more than 2 elements', async () => {
        fc.assert(
            fc.property(
                fc.array(fc.integer(), { minLength: 3, maxLength: 100 }),
                arr => {
                    const result = samplePowerOfTwoPositions(arr);
                    expect(result[0]).toBe(arr[0]); // First element
                    expect(result[result.length - 1]).toBe(arr[arr.length - 1]); // Last element
                }
            )
        );
    });
    it('should select values at most once from any array with all different values', async () => {
        fc.assert(
            fc.property(generateStrictlyIncreasingArray(3), arr => {
                const result = samplePowerOfTwoPositions(arr);
                const uniqueValues = new Set(result);
                expect(uniqueValues.size).toBe(result.length); // All values should be unique
            })
        );
    });
    it('should preserve the order of elements in the result', async () => {
        fc.assert(
            fc.property(generateStrictlyIncreasingArray(3), arr => {
                const result = samplePowerOfTwoPositions(arr);
                const indices = result.map(v => arr.indexOf(v));
                expect(indices).toEqual(indices.sort((a, b) => a - b)); // Indices should be in ascending order
            })
        );
    });
});

export const generateStrictlyIncreasingArray = minLength =>
    fc
        .tuple(
            fc.integer({ min: 0, max: 100000 }), // Starting value
            fc.array(fc.integer({ min: 1, max: 3 }), {
                minLength
            }) // Positive increments
        )
        .map(([start, increments]) => {
            let current = start;
            const result: number[] = [];
            for (const inc of increments) {
                current += inc; // Add positive increment for strict increase
                result.push(current);
            }
            return result;
        });
