import { Transaction } from '@mysten/sui/transactions';
import type { ClientWithCoreApi } from '@mysten/sui/client';

export class ExecutionModule {
    private deepbookPackageId: string;
    private suiClient: ClientWithCoreApi;

    constructor(deepbookPackageId: string, suiClient: ClientWithCoreApi) {
        this.deepbookPackageId = deepbookPackageId;
        this.suiClient = suiClient;
    }

    /**
     * Place a limit order.
     */
    placeLimitOrder(
        tx: Transaction,
        poolId: string,
        balanceManagerId: string,
        tradeProof: any,
        clientOrderId: number,
        price: number,
        quantity: number,
        isBid: boolean,
        orderType: number = 0, // NO_RESTRICTION
        expireTimestamp: number = 0, // MAX_U64 basically if 0
        baseType: string,
        quoteType: string
    ) {
        tx.moveCall({
            target: `${this.deepbookPackageId}::pool::place_limit_order`,
            arguments: [
                tx.object(poolId),
                tx.object(balanceManagerId),
                tradeProof,
                tx.pure.u64(clientOrderId),
                tx.pure.u64(price),
                tx.pure.u64(quantity),
                tx.pure.bool(isBid),
                tx.pure.u8(orderType),
                tx.pure.u64(expireTimestamp),
                tx.object('0x6'), // Clock object
            ],
            typeArguments: [baseType, quoteType],
        });
    }

    /**
     * Place a market order.
     */
    placeMarketOrder(
        tx: Transaction,
        poolId: string,
        balanceManagerId: string,
        tradeProof: any,
        clientOrderId: number,
        quantity: number,
        isBid: boolean,
        baseCoin: string | null = null,
        quoteCoin: string | null = null,
        baseType: string,
        quoteType: string
    ) {
        // In deepbook v3, place_market_order signature uses the same pool but requires the user to return base/quote coins if not using BalanceManager directly for settlement
        tx.moveCall({
            target: `${this.deepbookPackageId}::pool::place_market_order`,
            arguments: [
                tx.object(poolId),
                tx.object(balanceManagerId),
                tradeProof,
                tx.pure.u64(clientOrderId),
                tx.pure.u64(quantity),
                tx.pure.bool(isBid),
                baseCoin ? tx.object(baseCoin) : tx.moveCall({ target: '0x2::coin::zero', typeArguments: [baseType] }),
                quoteCoin ? tx.object(quoteCoin) : tx.moveCall({ target: '0x2::coin::zero', typeArguments: [quoteType] }),
                tx.object('0x6'), // Clock object
            ],
            typeArguments: [baseType, quoteType],
        });
    }

    /**
     * Atomic batching: cancel_order + place_limit_order in a single PTB.
     */
    atomicCancelAndPlace(
        tx: Transaction,
        poolId: string,
        balanceManagerId: string,
        tradeProof: any,
        cancelOrderId: string,
        clientOrderId: number,
        price: number,
        quantity: number,
        isBid: boolean,
        baseType: string,
        quoteType: string
    ) {
        // 1. Cancel existing order
        tx.moveCall({
            target: `${this.deepbookPackageId}::pool::cancel_order`,
            arguments: [tx.object(poolId), tx.object(balanceManagerId), tx.pure.u64(cancelOrderId)],
            typeArguments: [baseType, quoteType],
        });

        // 2. Place new limit order
        this.placeLimitOrder(
            tx,
            poolId,
            balanceManagerId,
            tradeProof,
            clientOrderId,
            price,
            quantity,
            isBid,
            0,
            0,
            baseType,
            quoteType
        );
    }

    /**
     * Dry run a transaction block.
     */
    async verifyTransaction(tx: Transaction, _sender: string) {
        // Build transaction for simulation
        const txBytes = await tx.build({ client: this.suiClient });
        // Use simulateTransaction instead of dryRunTransactionBlock
        return this.suiClient.core.simulateTransaction({
            transaction: txBytes,
        });
    }
}
