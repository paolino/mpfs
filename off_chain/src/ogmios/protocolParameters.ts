import { createHash } from 'crypto';
import WebSocket from 'ws';
import {
    CostModel,
    Costmdls,
    Int,
    Language,
} from '@sidan-lab/sidan-csl-rs-nodejs';
import type { LiveCostModels } from '../tx/recomputeScriptDataHash';

/*
 * Ogmios `queryLedgerState/protocolParameters` — observed shape
 * (Yaci DevKit, ws://localhost:1337, 2026-05-18).
 *
 *   request:
 *     { "jsonrpc": "2.0",
 *       "method":  "queryLedgerState/protocolParameters",
 *       "id":      "queryProtocolParameters" }
 *
 *   reply top-level keys:
 *     jsonrpc, method, result, id
 *
 *   result.plutusCostModels is an object keyed by:
 *     "plutus:v1", "plutus:v2", "plutus:v3"
 *   each value is an array of integers (some entries may be negative
 *   in the wire format, hence the use of `Int.from_str` below).
 *
 *   Observed (old, pre-bump) Yaci-bundled lengths:
 *     plutus:v1 = 166, plutus:v2 = 185, plutus:v3 = 297
 *   Current mainnet/preprod values are 332 / 332 / 350 after the
 *   recent hard-fork bump. This fetcher does NOT assume any specific
 *   length; it consumes whatever the chain advertises.
 *
 *   See specs/021-cost-models-from-ogmios/research.md Q3 / Q4 / Q7
 *   and contracts/cost-models.md (Contract 1) for the design.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const REQUEST_ID = 'queryProtocolParameters';
const RPC_METHOD = 'queryLedgerState/protocolParameters';

/**
 * Thrown when the live cost models cannot be obtained at all:
 * WebSocket connect/handshake failure, RPC error reply, malformed
 * response, or timeout. Carries the underlying cause for diagnostic
 * triage; the `ogmiosUrl` is surfaced in the message so an FR-003
 * abort log makes the failed endpoint explicit.
 *
 * See specs/021-cost-models-from-ogmios/contracts/cost-models.md
 * Contract 1 and research.md Q7 (no silent fallback).
 */
export class LiveCostModelsUnavailable extends Error {
    constructor(
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'LiveCostModelsUnavailable';
    }
}

/**
 * Thrown by the caller (Slice 3 wrapper) when a Plutus language the
 * tx actually uses is missing from `lengths()`. This module never
 * raises it: a partial cost-model set (e.g. V1+V2 only) is a valid
 * network state, and only the consumer knows which languages this
 * particular transaction touches.
 *
 * See specs/021-cost-models-from-ogmios/data-model.md "Error model"
 * and contracts/cost-models.md (Contract 4).
 */
export class LiveCostModelsIncomplete extends Error {
    constructor(
        message: string,
        public readonly languagesMissing: string[],
    ) {
        super(message);
        this.name = 'LiveCostModelsIncomplete';
    }
}

// Wire-shape helpers --------------------------------------------------

type WireCostVector = ReadonlyArray<number | string>;

interface WirePlutusCostModels {
    'plutus:v1'?: WireCostVector;
    'plutus:v2'?: WireCostVector;
    'plutus:v3'?: WireCostVector;
}

interface WireReply {
    id?: unknown;
    error?: unknown;
    result?: {
        plutusCostModels?: WirePlutusCostModels;
    };
}

const LANGUAGE_KEYS = ['plutus:v1', 'plutus:v2', 'plutus:v3'] as const;
type LanguageKey = (typeof LANGUAGE_KEYS)[number];

const newLanguage = (key: LanguageKey): Language => {
    switch (key) {
        case 'plutus:v1':
            return Language.new_plutus_v1();
        case 'plutus:v2':
            return Language.new_plutus_v2();
        case 'plutus:v3':
            return Language.new_plutus_v3();
    }
};

const shortKey = (key: LanguageKey): 'v1' | 'v2' | 'v3' => {
    switch (key) {
        case 'plutus:v1':
            return 'v1';
        case 'plutus:v2':
            return 'v2';
        case 'plutus:v3':
            return 'v3';
    }
};

const costModelOfVector = (values: WireCostVector): CostModel => {
    const m = CostModel.new();
    values.forEach((v, i) => {
        // `Int.from_str` accepts both positive and negative decimal
        // strings; some cost-model entries are negative in the wire
        // format. Coerce numeric values via String() rather than
        // BigNum (BigNum is unsigned).
        m.set(i, Int.from_str(String(v)));
    });
    return m;
};

const buildLive = (wire: WirePlutusCostModels): LiveCostModels => {
    const costmdls = Costmdls.new();
    const lengths: { v1?: number; v2?: number; v3?: number } = {};

    for (const key of LANGUAGE_KEYS) {
        const vec = wire[key];
        if (vec === undefined) continue;
        // Defensive: an explicitly empty vector is treated as
        // "language absent". See data-model.md Validation.
        if (vec.length === 0) continue;
        costmdls.insert(newLanguage(key), costModelOfVector(vec));
        lengths[shortKey(key)] = vec.length;
    }

    const bytes = costmdls.to_bytes();
    const digestHex = createHash('sha256')
        .update(Buffer.from(bytes))
        .digest('hex');
    const digest = `sha256:${digestHex}`;

    return {
        costMdls: () => costmdls,
        digest: () => digest,
        lengths: () => ({ ...lengths }),
    };
};

// Fetcher -------------------------------------------------------------

/**
 * Open a fresh WebSocket to `ogmiosUrl`, request
 * `queryLedgerState/protocolParameters`, parse `result.plutusCostModels`
 * into a `Costmdls`, and resolve to a `LiveCostModels` wrapper.
 *
 * The WebSocket is closed before resolve/reject. No caching: each call
 * is a fresh round-trip (FR-001).
 *
 * Rejects with `LiveCostModelsUnavailable` on:
 *  - WebSocket connect/handshake failure,
 *  - JSON-RPC error reply,
 *  - reply missing `result.plutusCostModels`,
 *  - timeout (default 5s; override via `options.timeoutMs`).
 *
 * Never falls back to bundled defaults (research.md Q7). A partial
 * cost-model set (e.g. only V1+V2 present) is NOT an error here:
 * `lengths()` reports the per-language availability, and the
 * tx-build consumer decides whether the missing language matters
 * for the tx it's building.
 *
 * Independence note: in production MPFS, Ogmios runs alongside the
 * cardano-node as a standalone service. The provider (Yaci /
 * Blockfrost / …) has no relationship to the Ogmios endpoint URL.
 * This fetcher only needs `ogmiosUrl`.
 */
export async function fetchLiveCostModels(
    ogmiosUrl: string,
    options?: { timeoutMs?: number },
): Promise<LiveCostModels> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<LiveCostModels>((resolve, reject) => {
        let ws: WebSocket;
        try {
            ws = new WebSocket(ogmiosUrl);
        } catch (err) {
            reject(
                new LiveCostModelsUnavailable(
                    `ogmios ${ogmiosUrl}: failed to construct WebSocket`,
                    err,
                ),
            );
            return;
        }

        let settled = false;
        const settle = (action: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                ws.close();
            } catch {
                // best-effort close; the promise outcome is already
                // decided.
            }
            action();
        };

        const timer = setTimeout(() => {
            settle(() =>
                reject(
                    new LiveCostModelsUnavailable(
                        `ogmios ${ogmiosUrl}: queryLedgerState/protocolParameters timed out after ${timeoutMs}ms`,
                    ),
                ),
            );
        }, timeoutMs);

        ws.on('error', err => {
            settle(() =>
                reject(
                    new LiveCostModelsUnavailable(
                        `ogmios ${ogmiosUrl}: WebSocket error`,
                        err,
                    ),
                ),
            );
        });

        ws.on('open', () => {
            try {
                ws.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        method: RPC_METHOD,
                        id: REQUEST_ID,
                    }),
                );
            } catch (err) {
                settle(() =>
                    reject(
                        new LiveCostModelsUnavailable(
                            `ogmios ${ogmiosUrl}: failed to send protocolParameters request`,
                            err,
                        ),
                    ),
                );
            }
        });

        ws.on('message', raw => {
            let response: WireReply;
            try {
                response = JSON.parse(raw.toString());
            } catch (err) {
                settle(() =>
                    reject(
                        new LiveCostModelsUnavailable(
                            `ogmios ${ogmiosUrl}: failed to parse JSON reply`,
                            err,
                        ),
                    ),
                );
                return;
            }

            // Multiple replies can flow over a single WebSocket;
            // filter by id (matching the mkOgmiosEvaluator pattern in
            // submitter.ts).
            if (response.id !== REQUEST_ID) return;

            if (response.error) {
                settle(() =>
                    reject(
                        new LiveCostModelsUnavailable(
                            `ogmios ${ogmiosUrl}: RPC error: ${JSON.stringify(
                                response.error,
                            )}`,
                            response.error,
                        ),
                    ),
                );
                return;
            }

            const wire = response.result?.plutusCostModels;
            if (wire === undefined) {
                settle(() =>
                    reject(
                        new LiveCostModelsUnavailable(
                            `ogmios ${ogmiosUrl}: reply missing result.plutusCostModels`,
                        ),
                    ),
                );
                return;
            }

            let live: LiveCostModels;
            try {
                live = buildLive(wire);
            } catch (err) {
                settle(() =>
                    reject(
                        new LiveCostModelsUnavailable(
                            `ogmios ${ogmiosUrl}: failed to build Costmdls from reply`,
                            err,
                        ),
                    ),
                );
                return;
            }

            settle(() => resolve(live));
        });
    });
}
