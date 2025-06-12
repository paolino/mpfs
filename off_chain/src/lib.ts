import { UTxO } from '@meshsdk/core';
import { createHash } from 'crypto';

export type OutputRef = {
    txHash: string;
    outputIndex: number;
};

export function outputRefEqual(a: OutputRef, b: OutputRef): boolean {
    return a.txHash === b.txHash && a.outputIndex === b.outputIndex;
}

// this must match the aiken code
export function assetName(outputRef: OutputRef) {
    const { txHash, outputIndex: outputIndex } = outputRef;
    const transaction_id_bytes = Buffer.from(txHash, 'hex');
    const outputIndexBytes = Buffer.alloc(2);
    outputIndexBytes.writeUInt16BE(outputIndex, 0);
    const bytes = Buffer.concat([transaction_id_bytes, outputIndexBytes]);
    return createHash('sha256').update(bytes).digest().toString('hex');
}

export function unitParts(unit: string) {
    const policyId = unit.slice(0, 56);
    const assetName = unit.slice(56);
    return { policyId, assetName };
}

export function containsToken(utxo: UTxO, tokenId: string) {
    const value = utxo.output.amount.find((v: any) => v.unit === tokenId);
    return value !== undefined;
}

export function selectUTxOWithToken(utxos: UTxO[], tokenId: string) {
    return utxos.find(utxo => containsToken(utxo, tokenId));
}

export function validatePort(port: string | undefined, name: string = 'PORT') {
    if (!port) {
        throw new Error(`${name} env var is not set`);
    }
    const portNumber = parseInt(port, 10);
    if (isNaN(portNumber)) {
        throw new Error(`${name} env var is not a number`);
    }
    if (portNumber < 1024 || portNumber > 65535) {
        throw new Error(`${name} env var is not a valid port number`);
    }
    return portNumber;
}

export const nullHash =
    '0000000000000000000000000000000000000000000000000000000000000000';

export const toHex = (buffer: Buffer): string => buffer.toString('hex');
export const rootHex = (root: Buffer | undefined): string => {
    if (!root) {
        return nullHash;
    }
    return toHex(root);
};

export function fromHex(hex: string) {
    const buffer = Buffer.from(hex, 'hex');
    return buffer.toString('utf-8');
}

export const inputToOutputRef = (input: any): OutputRef => {
    return {
        txHash: input.transaction.id,
        outputIndex: input.index
    };
};

export const sleepMs = (ms: number): Promise<void> => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

export const sleep = (seconds: number): Promise<void> => {
    return sleepMs(seconds * 1000);
};

export type WithOrigin<T> = T | 'origin';
