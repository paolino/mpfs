import express from 'express';
import {
    withContext,
    ContextProvider,
    TopUp,
    getCagingScript,
    Context
} from '../context';
import { boot } from '../transactions/boot';
import { update } from '../transactions/update';
import { request } from '../transactions/request';
import { end } from '../transactions/end';
import { retract } from '../transactions/retract';
import { Server } from 'http';
import { MeshWallet } from '@meshsdk/core';
import { createTrieManager } from '../trie';
import { createIndexer, Indexer } from '../indexer/indexer';
import { unmkOutputRefId, mkOutputRefId } from '../outputRef';
import { Level } from 'level';
import { Token } from '../indexer/state/tokens';
import { createState } from '../indexer/state';
import { createProcess } from '../indexer/process';
import { sleep } from '../lib';

// API Endpoints
function mkAPI(tmp: string, topup: TopUp | undefined, context) {
    async function withTokens(f: (tokens: Token[]) => any): Promise<any> {
        const tokens = await withContext(
            `${tmp}/logs/tokens`,
            'log',
            context,
            async context => {
                return await context.fetchTokens();
            }
        );
        return f(tokens);
    }

    const app = express();

    app.use(express.json()); // Ensure JSON parsing middleware is applied

    app.get('/wallet', async (req, res) => {
        const wallet = await withContext(
            `${tmp}/logs/wallet`,
            'log',
            context,
            async context => {
                return await context.wallet();
            }
        );
        res.json({
            address: wallet.walletAddress,
            owner: wallet.signerHash,
            utxos: wallet.utxos
        });
    });
    if (topup) {
        app.put('/wallet/topup', async (req, res) => {
            const { amount } = req.body;
            try {
                const { walletAddress } = await context.wallet();
                await topup(walletAddress, amount);
                res.json({ message: 'Top up successful' });
            } catch (error) {
                res.status(500).json({
                    error: 'Error topping up wallet',
                    details: error
                });
            }
        });
    }

    app.post('/token', async (req, res) => {
        try {
            const tokenId = await withContext(
                `${tmp}/logs/boot`,
                'log',
                context,
                async context => await boot(context)
            );
            res.json({ tokenId });
        } catch (error) {
            console.error('Error booting:', error);
            res.status(500).json({
                error: 'Error booting',
                details: JSON.stringify(error)
            });
        }
    });

    app.get('/tokens', async (req, res) => {
        try {
            const indexerStatus = await context.indexer.tips();
            const tokens = await withTokens(tokens => tokens);
            res.json({
                tokens,
                indexerStatus
            });
        } catch (error) {
            res.status(500).json({
                error: 'Error fetching tokens',
                details: error.message
            });
        }
    });

    app.get('/token/:tokenId', async (req, res) => {
        const { tokenId } = req.params;

        try {
            const token: Token = await withTokens(tokens =>
                tokens.find(token => token.tokenId === tokenId)
            );

            if (!token) {
                res.status(404).json({
                    error: `GET token: Token ${tokenId} not found`
                });
                return;
            }
            const requests = await context.fetchRequests(tokenId);
            res.json({
                ...token.current,
                requests
            });
        } catch (error) {
            res.status(500).json({
                error: 'Error fetching token',
                details: error.message
            });
        }
    });
    app.put('/token/:tokenId', async (req, res) => {
        const { tokenId } = req.params;
        const { requestIds } = req.body;
        const refs = requestIds.map(unmkOutputRefId);
        try {
            const tx = await withContext(
                `${tmp}/logs/update`,
                'log',
                context,
                async context => await update(context, tokenId, refs)
            );
            res.json({ txHash: tx });
        } catch (error) {
            res.status(500).json({
                error: 'Error updating',
                details: error.message
            });
        }
    });

    app.delete('/token/:tokenId', async (req, res) => {
        const { tokenId } = req.params;
        try {
            const tx = await withContext(
                `${tmp}/logs/end`,
                'log',
                context,
                async context => await end(context, tokenId)
            );

            res.json({ txHash: tx });
        } catch (error) {
            res.status(500).json({
                error: 'Error ending',
                details: error.message
            });
        }
    });

    app.post('/token/:tokenId/request', async (req, res) => {
        const { tokenId } = req.params;
        const { key, value, operation } = req.body;

        try {
            const ref = await withContext(
                `${tmp}/logs/request`,
                'log',
                context,
                async context => {
                    const ref = await request(
                        context,
                        tokenId,
                        key,
                        value,
                        operation
                    );
                    return mkOutputRefId(ref);
                }
            );
            res.json(ref);
        } catch (error) {
            res.status(500).json({
                error: 'Error requesting',
                details: error.message
            });
        }
    });

    app.delete('/request/:refId/', async (req, res) => {
        const { refId } = req.params;
        const { txHash, outputIndex } = unmkOutputRefId(refId);
        try {
            const tx = await withContext(
                `${tmp}/logs/retract`,
                'log',
                context,
                async context => await retract(context, { txHash, outputIndex })
            );
            res.json({ txHash: tx });
        } catch (error) {
            res.status(500).json({
                error: 'Error retracting',
                details: error.message
            });
        }
    });

    app.get('/token/:tokenId/facts', async (req, res) => {
        const { tokenId } = req.params;
        try {
            const facts = await withContext(
                `${tmp}/logs/facts`,
                'log',
                context,
                async context => await context.facts(tokenId)
            );
            res.json(facts);
        } catch (error) {
            res.status(500).json({
                error: 'Error fetching facts',
                details: error.message
            });
        }
    });

    app.post('/indexer/wait-blocks', async (req, res) => {
        const { n } = req.body;
        const height = await context.indexer.waitBlocks(n);
        res.json({ height });
    });

    return app;
}

export type Service = {
    server: Server;
    indexer: Indexer;
    db: Level<string, any>;
};

export type Name = {
    name: string;
    port: number;
};

export async function withService(
    port: number,
    logsPath: string,
    dbPath: string,
    ctxProvider: ContextProvider,
    mkWallet: (Provider) => MeshWallet,
    ogmios: string,
    f
): Promise<void> {
    const db: Level<any, any> = new Level(`${dbPath}/${port}`, {
        valueEncoding: 'json',
        keyEncoding: 'utf8'
    });
    await db.open();

    try {
        const wallet = mkWallet(ctxProvider.provider);
        const tries = await createTrieManager(db);
        const state = await createState(db, tries, 2160);

        const { address, policyId } = getCagingScript();
        const process = await createProcess(state, address, policyId);

        const indexer = await createIndexer(state, process, ogmios);
        try {
            const context = await new Context(
                ctxProvider.provider,
                wallet,
                indexer,
                state,
                tries
            );
            const app = mkAPI(logsPath, ctxProvider.topup, context);
            const server = app.listen(port);

            await new Promise<void>((resolve, reject) => {
                server.on('listening', resolve);
                server.on('error', reject);
            });
            try {
                await f();
            } finally {
                server.close();
            }
        } finally {
            await indexer.close();
            await sleep(1);
            await state.close();
            await tries.close();
        }
    } finally {
        await db.close();
    }
}

export async function withServices(
    logsPath: string,
    dbPath: string,
    names: Name[],
    ctxProvider: ContextProvider,
    mkWallet: (Provider) => MeshWallet,
    ogmios: string,
    f
): Promise<void> {
    async function loop(names: Name[]) {
        if (names.length === 0) {
            await f();
            return;
        }
        const { port, name } = names[0];
        const remainingNames = names.slice(1);
        await withService(
            port,
            logsPath,
            dbPath,
            ctxProvider,
            mkWallet,
            ogmios,
            async () => await loop(remainingNames)
        );
    }
    await loop(names);
}
