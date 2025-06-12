import { Change, invertChange } from '../trie/change';
import { AbstractSublevel } from 'abstract-level';
import { RollbackKey } from './state/rollbackkey';
import { TrieManager } from '../trie';
import { mkOutputRefId } from '../outputRef';
import { CurrentToken } from '../token';
import { Checkpoints, createCheckpoints } from './state/checkpoints';
import { createRollbacks, Rollbacks } from './state/rollbacks';
import { createTokens, Token, Tokens } from './state/tokens';
import { createRequests, Requests } from './state/requests';
import { Request } from '../request';
import { OutputRef } from '../lib';
import { Level } from 'level';

export type Slotted<T> = {
    slot: RollbackKey;
    value: T;
};

export type TokenChange = {
    token: Token;
    change: Change;
};

export type State = {
    addRequest: (request: Slotted<Request>) => Promise<void>;
    removeRequest: (request: Slotted<OutputRef>) => Promise<void>;
    addToken: (token: Slotted<Token>) => Promise<void>;
    removeToken: (token: Slotted<string>) => Promise<void>;
    updateToken: (change: Slotted<TokenChange>) => Promise<void>;
    rollback: (slot: RollbackKey) => Promise<void>;
    request: (outputRef: OutputRef) => Promise<Request | undefined>;
    tokens: Tokens;
    requests: Requests;
    checkpoints: Checkpoints;
    rollbacks: Rollbacks;
    close: () => Promise<void>;
};

export const createState = async (
    parent: Level<string, any>,
    tries: TrieManager,
    checkpointsSize: number | null = null
): Promise<State> => {
    const state: AbstractSublevel<any, any, string, any> = parent.sublevel(
        'state',
        {
            valueEncoding: 'json'
        }
    );
    await state.open();
    const tokens = await createTokens(state);
    const requests = await createRequests(state);
    const rollbacks = await createRollbacks(state);
    const checkpoints = await createCheckpoints(state, checkpointsSize);
    return {
        close: async (): Promise<void> => {
            try {
                await rollbacks.close();
                await requests.close();
                await tokens.close();
                await checkpoints.close();
                await state.close();
            } catch (error) {
                console.error('Error closing State:', error);
            }
        },
        tokens,
        requests,
        checkpoints,
        rollbacks,
        request: async (outputRef: OutputRef): Promise<Request | undefined> => {
            const requestCore = await requests.get(mkOutputRefId(outputRef));
            if (!requestCore) {
                return undefined;
            }
            return {
                ref: outputRef,
                core: requestCore
            };
        },
        addRequest: async (request: Slotted<Request>): Promise<void> => {
            const { slot, value } = request;
            await requests.put(mkOutputRefId(value.ref), value.core);
            await rollbacks.put(slot, {
                type: 'RemoveRequest',
                request: mkOutputRefId(value.ref)
            });
        },
        removeRequest: async (request: Slotted<OutputRef>): Promise<void> => {
            const ref = request.value;
            const refId = mkOutputRefId(ref);
            const existing = await requests.get(refId);
            if (existing) {
                await requests.delete(refId);
                await rollbacks.put(request.slot, {
                    type: 'AddRequest',
                    ref,
                    request: existing
                });
            }
        },
        addToken: async (token: Slotted<Token>): Promise<void> => {
            const { slot, value } = token;
            await tokens.putToken(value.tokenId, value.current);
            await tries.trie(value.tokenId, async trie => {});
            await rollbacks.put(slot, {
                type: 'RemoveToken',
                tokenId: value.tokenId
            });
        },
        removeToken: async (token: Slotted<string>): Promise<void> => {
            const { slot, value: tokenId } = token;
            const existing = await tokens.getToken(tokenId);
            if (existing) {
                await tries.hide(tokenId);
                await tokens.deleteToken(tokenId);
                await rollbacks.put(slot, {
                    type: 'AddToken',
                    tokenId: tokenId,
                    token: existing
                });
            }
        },
        updateToken: async (change: Slotted<TokenChange>): Promise<void> => {
            const { slot, value: tokenChange } = change;
            const { tokenId } = tokenChange.token;
            const existing = await tokens.getToken(tokenId);
            if (existing) {
                let updatedToken: CurrentToken;
                await tries.trie(tokenId, async trie => {
                    await trie.update(tokenChange.change);
                });
                await tokens.putToken(tokenId, tokenChange.token.current);
                await rollbacks.put(slot, {
                    type: 'UpdateToken',
                    tokenChange: {
                        current: existing,
                        change: invertChange(tokenChange.change),
                        tokenId: tokenId
                    }
                });
            }
        },
        rollback: async (slot: RollbackKey): Promise<void> => {
            const rollbackSteps = await rollbacks.extractAfter(slot);
            for (const rollback of rollbackSteps) {
                switch (rollback.type) {
                    case 'RemoveRequest': {
                        const request = rollback.request;
                        console.log(
                            `Rolling back add request for ${JSON.stringify(
                                request
                            )}`
                        );
                        await requests.delete(request);
                        break;
                    }
                    case 'AddRequest': {
                        const { ref, request } = rollback;
                        console.log(
                            `Rolling back remove request for ${JSON.stringify(
                                ref
                            )} with core ${JSON.stringify(request)}`
                        );
                        await requests.put(mkOutputRefId(ref), request);
                        break;
                    }
                    case 'RemoveToken': {
                        const tokenId = rollback.tokenId;
                        console.log(`Rolling back add token for ${tokenId}`);
                        await tokens.deleteToken(tokenId);
                        await tries.delete(tokenId);
                        break;
                    }
                    case 'AddToken': {
                        const { tokenId, token } = rollback;
                        console.log(
                            `Rolling back remove token for ${tokenId} with token ${JSON.stringify(token)}`
                        );
                        await tokens.putToken(tokenId, token);
                        await tries.unhide(tokenId);
                        break;
                    }
                    case 'UpdateToken': {
                        const { tokenChange } = rollback;
                        console.log(
                            `Rolling back token update for ${JSON.stringify(tokenChange)}`
                        );
                        await tries.trie(tokenChange.tokenId, async trie => {
                            await trie.update(tokenChange.change);
                        });
                        await tokens.putToken(
                            tokenChange.tokenId,
                            tokenChange.current
                        );
                        break;
                    }
                }
            }
        }
    };
};

export const withState = async (
    parent: Level<string, any>,
    tries: TrieManager,
    checkpointsSize: number | null = null,
    f: (state: State) => Promise<void>
): Promise<void> => {
    const state = await createState(parent, tries, checkpointsSize);
    try {
        await f(state);
    } finally {
        await state.close();
    }
};
