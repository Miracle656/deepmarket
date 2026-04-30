import { useCallback } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CONFIG, type Market, type MarketStatus } from './config';

async function fetchMarketsFromChain(_sui: ReturnType<typeof useSuiClient>): Promise<Market[]> {
    try {
        const res = await fetch('http://localhost:3000/markets');
        if (!res.ok) throw new Error('Failed to fetch markets');
        const data = await res.json();

        const markets = data.markets || [];

        return await Promise.all(markets.map(async (m: any) => {
            const status: MarketStatus = m.status === 'Active' ? 'Active' : 'Resolved';

            let yesPrice: number;
            if (status === 'Resolved') {
                yesPrice = m.outcome ? 100 : 0;
            } else {
                // Try to get real price from history
                try {
                    const histRes = await fetch(`http://localhost:3000/markets/${m.market_id}/history`);
                    const histData = await histRes.json();
                    const pts: any[] = histData.history ?? [];
                    yesPrice = pts.length > 0 ? pts[pts.length - 1].yes_price : 50;
                } catch {
                    yesPrice = 50;
                }
            }
            const noPrice = 100 - yesPrice;

            return {
                objectId: m.market_id.toString(),
                id: Number(m.market_id),
                question: m.question,
                resolutionTime: Number(m.resolution_time),
                oracleFeed: m.oracle_feed,
                status,
                outcome: m.outcome,
                yesPrice,
                noPrice,
                volume: Number(m.volume ?? 0),
                yesPoolId: m.yes_pool_id ?? '',
                noPoolId: m.no_pool_id ?? '',
                tokenPackageId: m.token_package_id ?? '',
            };
        }));
    } catch (e) {
        console.error(e);
        return [];
    }
}

export function useMarkets() {
    const sui = useSuiClient();
    const queryClient = useQueryClient();

    const { data: markets = [], isLoading } = useQuery({
        queryKey: ['markets', CONFIG.MARKET_REGISTRY],
        queryFn: () => fetchMarketsFromChain(sui),
        refetchInterval: 15_000,
        staleTime: 5_000,
    });

    const addMarket = useCallback((_q: string, _rt: number, _o: string) => {
        setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['markets'] });
        }, 3000);
    }, [queryClient]);

    const resolveMarket = useCallback((_id: number, _outcome: boolean) => {
        setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['markets'] });
        }, 3000);
    }, [queryClient]);

    return { markets, isLoading, addMarket, resolveMarket };
}
