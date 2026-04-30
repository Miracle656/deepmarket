import { ExecutionModule } from './executionModule';
import { Transaction } from '@mysten/sui/transactions';

export class StrategyModule {
    private executionModule: ExecutionModule;
    private currentSpread: number = 0.05; // 5% spread around 0.5 initially

    constructor(executionModule: ExecutionModule) {
        this.executionModule = executionModule;
    }

    /**
     * Hook executed when a new market is created.
     * Seeds initial liquidity by quoting YES and NO at symmetric spreads around 0.5.
     */
    onMarketCreated(
        tx: Transaction,
        yesPoolId: string,
        noPoolId: string,
        balanceManagerId: string,
        tradeProofYes: any,
        tradeProofNo: any,
        baseTypeYes: string,
        baseTypeNo: string,
        quoteType: string,
        tickSize: number,
        lotSize: number
    ) {
        // Math logic for initial seeds: 
        // If probability is 0.5, quote bid at 0.5 - spread/2 = 0.475, ask at 0.5 + spread/2 = 0.525
        // But in a YES/NO outcome market: Price of YES + Price of NO = 1 USDC
        // Price represents probability.
        const centerProbability = 0.5;
        const bidPrice = this.toTickValue(centerProbability - this.currentSpread / 2, tickSize);
        const askPrice = this.toTickValue(centerProbability + this.currentSpread / 2, tickSize);

        // Initial YES quoting
        this.executionModule.placeLimitOrder(
            tx, yesPoolId, balanceManagerId, tradeProofYes, 1, bidPrice, 10 * lotSize, true, 0, 0, baseTypeYes, quoteType
        );
        this.executionModule.placeLimitOrder(
            tx, yesPoolId, balanceManagerId, tradeProofYes, 2, askPrice, 10 * lotSize, false, 0, 0, baseTypeYes, quoteType
        );

        // Initial NO quoting
        this.executionModule.placeLimitOrder(
            tx, noPoolId, balanceManagerId, tradeProofNo, 1, bidPrice, 10 * lotSize, true, 0, 0, baseTypeNo, quoteType
        );
        this.executionModule.placeLimitOrder(
            tx, noPoolId, balanceManagerId, tradeProofNo, 2, askPrice, 10 * lotSize, false, 0, 0, baseTypeNo, quoteType
        );
    }

    /**
     * Called after a fill event to re-center quotes around updated probability.
     * Cancels existing bid/ask and places fresh orders at adjusted prices.
     *
     * @param filledSideIsBid - true if our bid was filled (price likely moving down), false if our ask was filled
     * @param currentBidOrderId - on-chain order ID of the current resting bid (to cancel)
     * @param currentAskOrderId - on-chain order ID of the current resting ask (to cancel)
     * @param currentCenterProb - current mid-price probability (0–1)
     * @returns the new center probability so the caller can persist it
     */
    adjustQuotesOnFill(
        tx: Transaction,
        poolId: string,
        balanceManagerId: string,
        tradeProof: any,
        filledSideIsBid: boolean,
        filledQuantity: number,
        currentBidOrderId: string,
        currentAskOrderId: string,
        currentCenterProb: number,
        baseType: string,
        quoteType: string,
        tickSize: number,
        lotSize: number
    ): number {
        // If our bid was hit, buyers are aggressive → price likely moving up, shift center up.
        // If our ask was lifted, sellers are aggressive → price likely moving down, shift center down.
        const inventoryAdjustment = filledSideIsBid ? 0.02 : -0.02;
        // Scale adjustment by fill size (larger fills → stronger signal)
        const scaledAdjustment = inventoryAdjustment * Math.min(filledQuantity / lotSize, 3);
        const newCenter = Math.max(0.02, Math.min(0.98, currentCenterProb + scaledAdjustment));

        const newBidPrice = this.toTickValue(newCenter - this.currentSpread / 2, tickSize);
        const newAskPrice = this.toTickValue(newCenter + this.currentSpread / 2, tickSize);
        const quantity = 10 * lotSize;

        // Atomically cancel + replace both sides in a single PTB
        this.executionModule.atomicCancelAndPlace(
            tx, poolId, balanceManagerId, tradeProof,
            currentBidOrderId, Date.now(), newBidPrice, quantity, true, baseType, quoteType
        );
        this.executionModule.atomicCancelAndPlace(
            tx, poolId, balanceManagerId, tradeProof,
            currentAskOrderId, Date.now() + 1, newAskPrice, quantity, false, baseType, quoteType
        );

        return newCenter;
    }

    private toTickValue(price: number, tickSize: number): number {
        return Math.floor(price * 1_000_000 / tickSize) * tickSize; // Assuming 6 decimals representation
    }
}
