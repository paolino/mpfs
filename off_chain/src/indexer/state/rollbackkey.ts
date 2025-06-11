export class RollbackKey extends Number {
    constructor(value: number) {
        super(value);
        this.valueOf = () => value;
    }
    get value(): number {
        return this.valueOf();
    }
    get key(): Buffer {
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64BE(BigInt(this.valueOf()));
        return buffer;
    }
    static fromKey(buffer: Buffer<ArrayBufferLike>): RollbackKey {
        if (!Buffer.isBuffer(buffer)) {
            throw new Error('Input is not a valid Buffer');
        }
        if (buffer.length !== 8) {
            throw new Error('Buffer must be 8 bytes long');
        }
        const value = buffer.readBigUInt64BE(0);
        return new RollbackKey(Number(value));
    }
    static get zero(): RollbackKey {
        return new RollbackKey(0);
    }
}

class AccountC {
    private _balance: number;
    constructor(initialBalance: number = 0) {
        this._balance = initialBalance;
    }
    get balance(): number {
        return this._balance;
    }
    deposit(amount: number): void {
        if (amount < 0) {
            throw new Error('Deposit amount must be non-negative');
        }
        this._balance += amount;
    }
    withdraw(amount: number): void {
        if (amount < 0) {
            throw new Error('Withdrawal amount must be non-negative');
        }
        if (amount > this._balance) {
            throw new Error('Insufficient funds for withdrawal');
        }
        this._balance -= amount;
    }
}
