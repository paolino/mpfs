import { Level } from 'level'; // Import as a namespace

export class Facts {
    private db: Level; // Explicitly use the default export

    constructor(dbPath: string) {
        this.db = new Level<string, string>(dbPath, { valueEncoding: 'json' }); // Correct instantiation
    }

    async set(key: string, value: string): Promise<void> {
        await this.db.put(key, value);
    }

    async get(key: string): Promise<string | null> {
        try {
            return await this.db.get(key);
        } catch (err: any) {
            if (err.notFound) {
                return null;
            }
            throw err;
        }
    }

    async getAll(): Promise<Record<string, string>> {
        const result: Record<string, string> = {};
        for await (const [key, value] of this.db.iterator()) {
            result[key] = value;
        }
        return result;
    }

    async delete(key: string): Promise<void> {
        try {
            await this.db.del(key);
        } catch (err: any) {
            if (!err.notFound) {
                throw err;
            }
        }
    }
}
