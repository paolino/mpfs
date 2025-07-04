import { describe } from 'vitest';
import { e2eTest as e2eVitest } from './fixtures';
import { nullHash, OutputRef } from '../../../lib';
import {
    createRequest,
    createToken,
    deleteRequest,
    deleteToken,
    getToken,
    getTokenFacts,
    getTokens,
    getWallet,
    updateToken
} from '../client';
import { Runner, Wallets } from './fixtures';
import { assertThrows, shouldFail } from '../../test/E2E/lib';
import { Change } from '../../../trie/change';

const canAccessWallets = async ({
    run,
    log,
    wallets: { charlie, bob, alice }
}: Runner) => {
    const test = async () => {
        log('charlie can get his wallet');
        await getWallet(charlie);
        log('bob can get his wallet');
        await getWallet(bob);
        log('alice can get her wallet');
        await getWallet(alice);
    };
    await run(test, 'users can access wallets');
};

const canRetrieveTokens = async ({
    run,
    log,
    wallets: { charlie, bob, alice }
}: Runner) => {
    const test = async () => {
        log('charlie can get his tokens');
        log('bob can get his tokens');
        log('alice can get her tokens');
    };
    await run(test, 'users can retrieve their tokens');
};

const canCreateTokenAndDelete = async ({ run, log, wallets: { charlie } }) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        log('charlie waited for the token to sync');
        const tks1 = await getTokens(log, charlie);
        assertThrows(
            tks1.tokens.map(t => t.tokenId).includes(tk),
            'Token not found'
        );
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
        const tks2 = await getTokens(log, charlie);
        assertThrows(
            !tks2.tokens.map(t => t.tokenId).includes(tk),
            'Token still found'
        );
    };
    await run(test, 'users can create and delete a token');
};

const cannotDeleteAnotherUsersToken = async ({
    run,
    log,
    wallets: { charlie, bob }
}) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        await shouldFail(deleteToken(log, bob, tk));
        log('bob failed to delete charlie token as expected');
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users cannot delete another user token');
};

const canRetractRequest = async ({ run, log, wallets: { charlie, bob } }) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        const request = await createRequest(log, bob, tk, {
            type: 'insert',
            key: 'abc',
            value: 'value'
        });
        log('bob created a request to insert a fact');
        await deleteRequest(log, bob, request);
        log('bob retracted his request');
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users can create and retract requests');
};

const cannotRetractAnotherUsersRequest = async ({
    run,
    log,
    wallets: { charlie, bob }
}) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        const request = await createRequest(log, bob, tk, {
            type: 'insert',
            key: 'abc',
            value: 'value'
        });
        log('bob created a request to insert a fact');
        await shouldFail(deleteRequest(log, charlie, request));
        log('charlie failed to retract bob request as expected');
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users cannot retract another user request');
};

const cannotUpdateATokenWithNoRequests = async ({
    run,
    log,
    wallets: { charlie }
}) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        await shouldFail(updateToken(log, charlie, tk, []));
        log('charlie failed to update the mpf token as expected');
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users cannot update a token with no requests');
};

const canInspectRequestsForAToken = async ({
    run,
    log,
    wallets: { charlie, bob, alice }
}) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        await createRequest(log, bob, tk, {
            type: 'insert',
            key: 'abc',
            value: 'value'
        });
        log('bob created a request to insert a fact');
        const { state, requests } = await getToken(log, bob, tk);
        const { signerHash: charlieSig } = await getWallet(charlie);

        assertThrows(state.owner === charlieSig, 'Token owner is not charlie');
        assertThrows(requests.length === 1, 'Requests are not one');
        assertThrows(requests[0].change.key === 'abc', 'Request key abc');
        assertThrows(
            requests[0].change.value === 'value',
            'Request value is not value'
        );
        assertThrows(
            requests[0].change.type === 'insert',
            'Request operation is not insert'
        );
        log('bob inspected charlie mpf token');
        await deleteRequest(log, bob, requests[0].outputRefId);
        log('bob retracted his request');
        const { requests: requests2 } = await getToken(log, alice, tk);
        assertThrows(requests2.length === 0, 'Request still found');
        log('alice inspected charlie mpf token');
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users can inspect requests for a token');
};

const canUpdateAToken = async ({ run, log, wallets: { charlie, bob } }) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        const request = await createRequest(log, bob, tk, {
            type: 'insert',
            key: 'abc',
            value: 'value'
        });
        log('bob created a request to insert a fact');
        await updateToken(log, charlie, tk, [request]);
        log('charlie updated the mpf token');
        const { requests } = await getToken(log, charlie, tk);
        assertThrows(requests.length === 0, 'Requests are not one');
        const facts = await getTokenFacts(log, charlie, tk);
        assertThrows(facts['abc'] === 'value', 'Token fact is not value');
        assertThrows(facts['abc'] === 'value', 'Token fact is not value');
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users can update a token');
};

export const canUpdateATokenTwice = async ({
    run,
    log,
    wallets: { charlie, bob }
}) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        const ref1 = await createRequest(log, bob, tk, {
            type: 'insert',
            key: 'a',
            value: 'a'
        });
        log('bob created a request to insert a fact');
        await updateToken(log, charlie, tk, [ref1]);
        const ref2 = await createRequest(log, bob, tk, {
            type: 'insert',
            key: 'b',
            value: 'b'
        });
        log('bob created a second request to insert a fact');
        await updateToken(log, charlie, tk, [ref2]);
        log('charlie updated the mpf token');
        const factsCharlie = await getTokenFacts(log, charlie, tk);
        assertThrows(factsCharlie['a'] === 'a', 'Token fact a is not a');
        assertThrows(factsCharlie['b'] === 'b', 'Token fact b is not b');
        log('charlie verified the token facts');
        const factsBob = await getTokenFacts(log, bob, tk);
        assertThrows(factsBob['a'] === 'a', 'Token fact a is not a');
        assertThrows(factsBob['b'] === 'b', 'Token fact b is not b');
        log('bob verified the token facts');

        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users can update a token');
};
const cannotUpdateAnotherUsersToken = async ({
    run,
    log,
    wallets: { charlie, bob }
}) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        const request = await createRequest(log, bob, tk, {
            type: 'insert',
            key: 'abc',
            value: 'value'
        });
        log('bob created a request to insert a fact');
        await shouldFail(updateToken(log, bob, tk, [request]));
        log('bob failed to update charlie token as expected');
        await deleteRequest(log, bob, request);
        log('bob retracted his request');
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users cannot update another user token');
};

const canDeleteFacts = async ({
    run,
    log,
    wallets: { charlie, bob, alice }
}) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        const bobRequest = await createRequest(log, bob, tk, {
            type: 'insert',
            key: 'abc',
            value: 'value'
        });
        log('bob created a request to insert a fact');
        await updateToken(log, charlie, tk, [bobRequest]);
        log('charlie updated the mpf token');
        const aliceRequest = await createRequest(log, alice, tk, {
            type: 'delete',
            key: 'abc',
            value: 'value'
        });
        log('alice created a request to delete a fact');
        await updateToken(log, charlie, tk, [aliceRequest]);
        const facts = await getTokenFacts(log, charlie, tk);
        assertThrows(facts['abc'] === undefined, 'Token fact is not deleted');
        log('charlie updated the mpf token');
        const { state } = await getToken(log, charlie, tk);
        assertThrows(state.root === nullHash, 'Token root is not null');
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users can delete facts from a token');
};

const canBatchUpdate = async ({
    run,
    log,
    wallets: { charlie, bob, alice }
}) => {
    const test = async () => {
        const tk = await createToken(log, charlie);
        log('charlie created an mpf token');
        const bobRequest = await createRequest(log, bob, tk, {
            type: 'insert',
            key: 'abc',
            value: 'value'
        });
        log('bob created a request to insert a fact');
        const aliceRequest = await createRequest(log, alice, tk, {
            type: 'insert',
            key: 'abd',
            value: 'value'
        });
        log('alice created a request to insert a fact');
        await updateToken(log, charlie, tk, [bobRequest, aliceRequest]);
        log('charlie updated the mpf token');
        const facts = await getTokenFacts(log, charlie, tk);
        assertThrows(facts['abc'] === 'value', 'Token fact abc is not value');
        assertThrows(facts['abd'] === 'value', 'Token fact abd is not value');
        log('charlie verified the token facts');
        await deleteToken(log, charlie, tk);
        log('charlie deleted the mpf token');
    };
    await run(test, 'users can batch update a token');
};

const requestAndUpdate = async (
    log,
    owner,
    tk,
    requests: { author; change: Change }[]
) => {
    let refs: string[] = [];
    for (const { author, change } of requests) {
        const req = await createRequest(log, author, tk, change);
        refs.push(req);
    }
    await updateToken(log, owner, tk, refs);
    const { state } = await getToken(log, owner, tk);
    return state.root;
};

const insertCommutes = async ({
    run,
    log,
    wallets: { charlie, bob, alice }
}) => {
    const test = async () => {
        const tk = await createToken(log, bob);
        log('bob created an mpf token');
        await requestAndUpdate(log, bob, tk, [
            {
                author: charlie,
                change: { key: 'a', value: 'value1', type: 'insert' }
            }
        ]);
        log('charlie got a token insertion for a = value1');
        const root1 = await requestAndUpdate(log, bob, tk, [
            {
                author: alice,
                change: { key: 'b', value: 'value2', type: 'insert' }
            }
        ]);
        log('alice got a token insertion for b = value2');
        await requestAndUpdate(log, bob, tk, [
            {
                author: bob,
                change: { key: 'a', value: 'value1', type: 'delete' }
            },
            {
                author: bob,
                change: { key: 'b', value: 'value2', type: 'delete' }
            }
        ]);
        log('bob got a token deletion for a = value1 and b = value2');
        await requestAndUpdate(log, bob, tk, [
            {
                author: alice,
                change: { key: 'b', value: 'value2', type: 'insert' }
            }
        ]);
        log('alice got a token insertion for b = value2');
        const root2 = await requestAndUpdate(log, bob, tk, [
            {
                author: charlie,
                change: { key: 'a', value: 'value1', type: 'insert' }
            }
        ]);
        log('charlie got a token insertion for a = value1');
        assertThrows(root1 === root2, 'Token state is not the same');
        await deleteToken(log, bob, tk);
        log('bob deleted the mpf token');
    };
    await run(test, 'user can commute insertions');
};

const deleteCommutes = async ({
    run,
    log,
    wallets: { charlie, bob, alice }
}) => {
    const test = async () => {
        const tk = await createToken(log, bob);
        log('bob created an mpf token');
        await requestAndUpdate(log, bob, tk, [
            {
                author: charlie,
                change: { key: 'a', value: 'value1', type: 'insert' }
            },
            {
                author: alice,
                change: { key: 'b', value: 'value2', type: 'insert' }
            }
        ]);
        log(
            'charlie and alice got token insertions for a = value1 and b = value2'
        );
        await requestAndUpdate(log, bob, tk, [
            {
                author: charlie,
                change: { key: 'a', value: 'value1', type: 'delete' }
            }
        ]);
        log('charlie got a token deletion for a = value1');
        const root1 = await requestAndUpdate(log, bob, tk, [
            {
                author: alice,
                change: { key: 'b', value: 'value2', type: 'delete' }
            }
        ]);
        log('alice got a token deletion for b = value2');
        assertThrows(root1 === nullHash, 'Token root is not null');
        await requestAndUpdate(log, bob, tk, [
            {
                author: charlie,
                change: { key: 'a', value: 'value1', type: 'insert' }
            },
            {
                author: alice,
                change: { key: 'b', value: 'value2', type: 'insert' }
            }
        ]);
        log(
            'charlie and alice got token insertions for a = value1 and b = value2'
        );
        await requestAndUpdate(log, bob, tk, [
            {
                author: alice,
                change: { key: 'b', value: 'value2', type: 'delete' }
            }
        ]);
        log('alice got a token deletion for b = value2');
        const root2 = await requestAndUpdate(log, bob, tk, [
            {
                author: charlie,
                change: { key: 'a', value: 'value1', type: 'delete' }
            }
        ]);
        log('charlie got a token deletion for a = value1');
        assertThrows(root1 === root2, 'Token state is not the same');
        await deleteToken(log, bob, tk);
        log('bob deleted the mpf token');
    };
    await run(test, 'user can commute deletions');
};

describe('E2E Signing Tests', () => {
    e2eVitest('can access wallets', canAccessWallets);
    e2eVitest('can retrieve tokens', canRetrieveTokens);
    e2eVitest('can create and delete a token', canCreateTokenAndDelete);
    e2eVitest(
        "cannot delete another user's token",
        cannotDeleteAnotherUsersToken
    );
    e2eVitest('can retract a request', canRetractRequest);
    e2eVitest(
        "cannot retract another user's request",
        cannotRetractAnotherUsersRequest
    );
    e2eVitest(
        'cannot update a token with no requests',
        cannotUpdateATokenWithNoRequests
    );
    e2eVitest('can inspect requests for a token', canInspectRequestsForAToken);
    e2eVitest('can update a token', canUpdateAToken);
    e2eVitest(
        "cannot update another user's token",
        cannotUpdateAnotherUsersToken
    );
    e2eVitest('can update a token twice', canUpdateATokenTwice);
    e2eVitest('can delete facts', canDeleteFacts);
    e2eVitest('can batch update', canBatchUpdate);
    e2eVitest('can insert commutes', insertCommutes);
    e2eVitest('can delete commutes', deleteCommutes);
});
