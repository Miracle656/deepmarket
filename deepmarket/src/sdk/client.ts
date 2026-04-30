import type { ClientWithCoreApi } from '@mysten/sui/client';
import { DeepBookClient } from '@mysten/deepbook-v3';
import { AccountModule } from './accountModule';
import { ExecutionModule } from './executionModule';
import { ResolutionModule } from './resolutionModule';
import { StrategyModule } from './strategyModule';

export class PredictionMarketClient {
    public suiClient: ClientWithCoreApi;
    public deepBookClient: DeepBookClient;

    public account: AccountModule;
    public execution: ExecutionModule;
    public resolution: ResolutionModule;
    public strategy: StrategyModule;

    constructor(
        suiClient: ClientWithCoreApi,
        deepBookClient: DeepBookClient,
        deepbookPackageId: string,
        marketPackageId: string
    ) {
        this.suiClient = suiClient;
        this.deepBookClient = deepBookClient;

        this.account = new AccountModule(deepbookPackageId);
        this.execution = new ExecutionModule(deepbookPackageId, this.suiClient);
        this.resolution = new ResolutionModule(marketPackageId);
        this.strategy = new StrategyModule(this.execution);
    }
}
