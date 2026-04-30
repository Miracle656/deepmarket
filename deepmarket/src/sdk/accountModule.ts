import { Transaction } from '@mysten/sui/transactions';

export class AccountModule {
    private deepbookPackageId: string;

    constructor(deepbookPackageId: string) {
        this.deepbookPackageId = deepbookPackageId;
    }

    /**
     * Creates a new BalanceManager for the user.
     */
    createBalanceManager(tx: Transaction) {
        const [manager] = tx.moveCall({
            target: `${this.deepbookPackageId}::balance_manager::new`,
            arguments: [],
        });
        // The newly created manager needs to be returned or transferred to the user
        // Typically, the SDK user will transfer it to their address in the same PTB
        return manager;
    }

    /**
     * Deposits a coin into the BalanceManager.
     */
    deposit(tx: Transaction, balanceManagerId: string, coinObj: string, coinType: string) {
        tx.moveCall({
            target: `${this.deepbookPackageId}::balance_manager::deposit`,
            arguments: [tx.object(balanceManagerId), tx.object(coinObj)],
            typeArguments: [coinType],
        });
    }

    /**
     * Withdraws an amount from the BalanceManager.
     */
    withdraw(tx: Transaction, balanceManagerId: string, amount: string | number, coinType: string) {
        const withdrawnCoin = tx.moveCall({
            target: `${this.deepbookPackageId}::balance_manager::withdraw`,
            arguments: [tx.object(balanceManagerId), tx.pure.u64(amount)],
            typeArguments: [coinType],
        });
        return withdrawnCoin;
    }

    /**
     * Generates a trade proof for permissioned order placement.
     */
    generateTradeProof(tx: Transaction, balanceManagerId: string) {
        return tx.moveCall({
            target: `${this.deepbookPackageId}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(balanceManagerId)],
        });
    }

    /**
     * Helper to ensure the balance manager has DEEP tokens for fee discounts.
     */
    depositDeepToken(tx: Transaction, balanceManagerId: string, deepCoinObj: string) {
        this.deposit(tx, balanceManagerId, deepCoinObj, `${this.deepbookPackageId}::deepbook::DEEP`);
    }
}
