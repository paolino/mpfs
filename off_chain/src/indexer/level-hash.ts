import stableStringify from 'json-stable-stringify';
import { createHash } from 'crypto';

export const levelHash = async (db): Promise<string> => {
    const hash = createHash('sha256');

    for await (const [key, value] of db.iterator()) {
        hash.update(key.toString('hex')); // Serialize key
        hash.update(stableStringify(value) || ''); // Canonical serialization of value with fallback
    }

    return hash.digest('hex');
};
