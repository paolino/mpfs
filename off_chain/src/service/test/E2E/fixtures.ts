import { Name, withServices } from '../../http';
import getPort from 'get-port';
import { Provider, yaciProvider } from '../../../context';
import { generateMnemonic, MeshWallet } from '@meshsdk/core';
import { walletTopup } from '../E2E/client';
import { it, test } from 'vitest';
import { withTempDir } from '../../../test/lib';
import { sleepMs, validatePort } from '../../../lib';

function newWallet(provider: Provider) {
    const seed = crypto.getRandomValues(new Uint32Array(4)).join('');
    const entropy = Buffer.from(`${seed}`.repeat(32).slice(0, 32), 'utf8');
    const mnemonic = generateMnemonic(256, () => entropy);
    return new MeshWallet({
        networkId: 0,
        fetcher: provider,
        submitter: provider,
        key: {
            type: 'mnemonic',
            words: mnemonic.split(' ')
        }
    });
}

export type Wallets = {
    charlie: string;
    bob: string;
    alice: string;
};

export type Runner = {
    run: (test: () => Promise<void>, name: string) => Promise<void>;
    log: (message: string) => void;
    wallets: Wallets;
};

export async function withRunner(test) {
    const yaciStorePort = process.env.YACI_STORE_PORT || '8080';
    const yaciStorePortNumber = validatePort(yaciStorePort, 'YACI_STORE_PORT');
    const yaciStoreHost = `http://localhost:${yaciStorePortNumber}`;

    const yaciAdminPort = process.env.YACI_ADMIN_PORT || '10000';
    const yaciAdminPortNumber = validatePort(yaciAdminPort, 'YACI_ADMIN_PORT');
    const yaciAdminHost = `http://localhost:${yaciAdminPortNumber}`;

    const provider = yaciProvider(yaciStoreHost, yaciAdminHost);

    const ogmiosPort = process.env.OGMIOS_HOST || '1337';
    const ogmiosPortNumber = validatePort(ogmiosPort, 'OGMIOS_PORT');
    const ogmiosHost = `http://localhost:${ogmiosPortNumber}`;

    let namesToServe: Name[] = [];

    const setupService = async (envvar: string, name: string) => {
        const port = process.env[envvar];
        if (!port) {
            const portNumber = await getPort();
            namesToServe.push({ name, port: portNumber });
            return `http://localhost:${portNumber}`;
        } else {
            const portNumber = validatePort(port, envvar);
            return `http://localhost:${portNumber}`;
        }
    };

    const charlie = await setupService('CHARLIE_PORT', 'charlie');
    const bob = await setupService('BOB_PORT', 'bob');
    const alice = await setupService('ALICE_PORT', 'alice');

    await withTempDir(async tmpDir => {
        await withServices(
            tmpDir,
            tmpDir,
            namesToServe,
            provider,
            newWallet,
            ogmiosHost,
            async () => {
                const wallets: Wallets = { charlie, bob, alice };

                const retryTopup = async (
                    wallet: string,
                    retries: number = 30,
                    delay: number = Math.random() * 10000 + 2000
                ) => {
                    for (let attempt = 1; attempt <= retries; attempt++) {
                        try {
                            await walletTopup(wallet);
                            return;
                        } catch (error) {
                            if (attempt === retries) {
                                throw error;
                            }
                            await sleepMs(delay);
                        }
                    }
                };

                await retryTopup(wallets.charlie);
                await retryTopup(wallets.bob);
                await retryTopup(wallets.alice);

                const runner: Runner = {
                    run: async (fn: () => Promise<void>, name: string) => {
                        await fn();
                    },
                    log: async (s: string) => {
                        // console.log(`  - ${s}`);
                    },
                    wallets
                };
                await test(runner);
            }
        );
    });
}

export async function e2eTest(
    name,
    f: (runner: Runner) => Promise<void>,
    secs = 60
) {
    it(name, { concurrent: true, timeout: secs * 1000, retry: 3 }, async () => {
        await withRunner(f);
    });
}
