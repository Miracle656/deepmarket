import { Transaction } from '@mysten/sui/transactions';

export class ResolutionModule {
    private packageId: string;

    constructor(packageId: string) {
        this.packageId = packageId;
    }

    /**
     * Resolve a market. Requires the AdminCap objectId.
     */
    resolveMarket(
        tx: Transaction,
        adminCapId: string,
        registryId: string,
        marketId: number,
        outcome: boolean,
        quoteType: string,
        yesType: string,
        noType: string
    ) {
        tx.moveCall({
            target: `${this.packageId}::market_factory::resolve_market`,
            arguments: [
                tx.object(adminCapId),
                tx.object(registryId),
                tx.pure.u64(marketId),
                tx.pure.bool(outcome),
            ],
            typeArguments: [quoteType, yesType, noType],
        });
    }

    /**
     * Redeem winning tokens for the quote coin.
     */
    redeem(
        tx: Transaction,
        registryId: string,
        marketId: number,
        tokenObj: string,
        isYesToken: boolean,
        quoteType: string,
        yesType: string,
        noType: string
    ) {
        const targetFunction = isYesToken ? 'redeem_yes' : 'redeem_no';
        tx.moveCall({
            target: `${this.packageId}::market_factory::${targetFunction}`,
            arguments: [tx.object(registryId), tx.pure.u64(marketId), tx.object(tokenObj)],
            typeArguments: [quoteType, yesType, noType],
        });
    }
}
