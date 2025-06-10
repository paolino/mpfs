import { parseStateDatumCbor } from '../token';
import { parseRequestCbor, RequestCore } from '../request';
import { State } from './state';
import { RollbackKey } from './state/rollbackkey';
import { inputToOutputRef } from '../lib';

export type Process = (slotNumber: RollbackKey, tx: any) => Promise<void>;

export const createProcess =
    (state: State, address: string, policyId: string): Process =>
    async (slotNumber: RollbackKey, tx: any): Promise<void> => {
        const minted = tx.mint?.[policyId];
        if (minted) {
            for (const asset of Object.keys(minted)) {
                if (minted[asset] == -1) {
                    // This is a token end request, delete the token state
                    await state.removeToken({
                        slot: slotNumber,
                        value: asset
                    });
                }
            }
        }
        for (
            let outputIndex = 0;
            outputIndex < tx.outputs.length;
            outputIndex++
        ) {
            const output = tx.outputs[outputIndex];
            if (output.address !== address) {
                break; // skip outputs not to the caging script address
            }

            const asset = output.value[policyId];

            if (asset) {
                const tokenId = Object.keys(asset)[0];
                const tokenState = parseStateDatumCbor(output.datum);
                if (tokenState) {
                    const present = await state.tokens.getToken(tokenId);

                    if (present) {
                        for (const input of tx.inputs) {
                            const ref = inputToOutputRef(input);

                            const request = await state.request(ref);
                            if (!request) {
                                continue; // skip inputs with no request
                            }
                            await state.updateToken({
                                slot: slotNumber,
                                value: {
                                    change: request.core.change,
                                    token: {
                                        tokenId,
                                        current: {
                                            outputRef: {
                                                txHash: tx.id,
                                                outputIndex
                                            },
                                            state: tokenState
                                        }
                                    }
                                }
                            });
                        }
                    } else {
                        await state.addToken({
                            slot: slotNumber,
                            value: {
                                tokenId,
                                current: {
                                    outputRef: {
                                        txHash: tx.id,
                                        outputIndex
                                    },
                                    state: tokenState
                                }
                            }
                        });
                    }
                }
            } else {
                const request = parseRequestCbor(output.datum);
                if (!request) {
                    break; // skip outputs with no request datum
                }
                const dbRequest: RequestCore = {
                    tokenId: request.tokenId,
                    change: request.change,
                    owner: request.owner
                };
                const ref = {
                    txHash: tx.id,
                    outputIndex
                };
                await state.addRequest({
                    slot: slotNumber,
                    value: { ref, core: dbRequest }
                });
            }
        }
        const inputs = tx.inputs;
        for (const input of inputs) {
            const ref = inputToOutputRef(input);
            state.removeRequest({ slot: slotNumber, value: ref }); // delete requests from inputs
        }
    };
