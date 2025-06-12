import { RequestCore } from '../../request';
import { Change } from '../../trie/change';
import { AbstractSublevel } from 'abstract-level';
import { levelHash } from '../level-hash';

export type Requests = {
    get(outputRef: string): Promise<RequestCore | undefined>;
    put(outputRef: string, value: RequestCore): Promise<void>;
    delete(outputRef: string): Promise<void>;
    byToken(
        tokenId: string | null
    ): Promise<{ outputRef: string; change: Change; owner: string }[]>;
    close(): Promise<void>;
    hash(): Promise<string>;
};

export async function createRequests(
    parent: AbstractSublevel<any, any, string, any>
): Promise<Requests> {
    const requestStore: AbstractSublevel<any, any, string, RequestCore> =
        parent.sublevel('requests', {
            valueEncoding: 'json'
        });
    await requestStore.open();
    return {
        get: async (outputRef: string): Promise<RequestCore | undefined> => {
            return await requestStore.get(outputRef);
        },
        put: async (outputRef: string, value: RequestCore): Promise<void> => {
            await requestStore.put(outputRef, value);
        },
        delete: async (outputRef: string): Promise<void> => {
            await requestStore.del(outputRef);
        },
        byToken: async (
            tokenId: string | null
        ): Promise<{ outputRef: string; change: Change; owner: string }[]> => {
            const requests: {
                outputRef: string;
                change: Change;
                owner: string;
            }[] = [];
            for await (const [key, value] of requestStore.iterator()) {
                if (!tokenId || value.tokenId === tokenId) {
                    requests.push({
                        outputRef: key,
                        change: value.change,
                        owner: value.owner
                    });
                }
            }
            return requests;
        },
        close: async (): Promise<void> => {
            await requestStore.close();
        },
        hash: async (): Promise<string> => {
            return await levelHash(requestStore);
        }
    };
}
