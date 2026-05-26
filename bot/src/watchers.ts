// Watchers — every POLL_MS, scan oracles + markets + per-user positions
// and fire alerts to each subscriber's Telegram chat.

import type { Telegraf } from 'telegraf';
import { CONFIG } from './config.js';
import { listActive, patchSubscription, type Subscription } from './store.js';
import {
    computeOracleFlow,
    findManagerByOwner,
    getManagerPositions,
    getOracleStateBatch,
    listActiveOracles,
    spotToUsd,
    type OracleState,
    type OracleSummary,
    type Position,
} from './predict.js';
import {
    decodeBalance,
    getMarketPosition,
    listMarkets,
    type SpotMarket,
} from './spot.js';
import {
    alertFlowAgainst,
    alertOracleNearExpiry,
    alertOracleSettled,
    alertOracleStale,
    alertSpotPriceMove,
    alertSpotResolved,
    alertStrikeCrossed,
    type Alert,
} from './alerts.js';

const NEAR_EXPIRY_WINDOW_MS = 5 * 60_000; // 5 minutes
const SPOT_PRICE_MOVE_THRESHOLD = 5; // 5 cent move triggers an alert

// Phase 13 — feed-health + flow-disagreement alerts.
// Thresholds match the OracleHealthPanel + agent-flow conventions.
const STALE_MS = 10 * 60_000;            // >10m since last on-chain price update
const STALE_COOLDOWN_MS = 60 * 60_000;   // re-alert per oracle/user at most hourly
const FLOW_MIN_TRADES = 8;               // need a meaningful window before alerting
const FLOW_AGAINST_SKEW = 0.3;           // ≥30% net crowd lean against user's side
const FLOW_COOLDOWN_MS = 30 * 60_000;    // re-alert per oracle/user at most every 30m

async function send(
    bot: Telegraf,
    chatId: number,
    alert: Alert
): Promise<void> {
    try {
        await bot.telegram.sendMessage(chatId, alert.text, {
            parse_mode: alert.parse_mode,
            reply_markup: alert.reply_markup,
            link_preview_options: { is_disabled: true },
        });
    } catch (e) {
        console.warn(`[bot] failed to send to ${chatId}:`, e);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Predict pass
// ────────────────────────────────────────────────────────────────────────────

async function tickPredict(bot: Telegraf, subs: Subscription[]): Promise<void> {
    if (subs.length === 0) return;
    let oracles: OracleSummary[];
    try {
        oracles = await listActiveOracles();
    } catch (e) {
        console.warn('[predict] listActiveOracles failed:', e);
        return;
    }
    if (oracles.length === 0) return;

    const states = await getOracleStateBatch(oracles.map((o) => o.oracle_id));

    // Resolve per-user manager + positions in parallel
    const userData = await Promise.all(
        subs.map(async (sub) => {
            const managerId = await findManagerByOwner(sub.suiAddr);
            const positions = managerId
                ? await getManagerPositions(managerId)
                : [];
            return { sub, managerId, positions };
        })
    );

    // Cache: oracle_id → flow snapshot. We fetch flow only for oracles where
    // at least one user has an open position, since the API call costs.
    const flowCache = new Map<string, Awaited<ReturnType<typeof computeOracleFlow>>>();
    async function flowFor(oracleId: string) {
        const cached = flowCache.get(oracleId);
        if (cached) return cached;
        const flow = await computeOracleFlow(oracleId);
        flowCache.set(oracleId, flow);
        return flow;
    }

    for (const oracle of oracles) {
        const state = states.get(oracle.oracle_id);
        if (!state) continue;

        const spotUsd = state.latest_price
            ? spotToUsd(state.latest_price.spot)
            : null;
        const now = Date.now();
        const msToExpiry = oracle.expiry - now;
        const wasSettled = oracle.status === 'settled';

        // Feed staleness — real Date.now() − on-chain timestamp delta (ms).
        const lastUpdateMs = state.latest_price?.onchain_timestamp ?? 0;
        const ageMs = lastUpdateMs > 0 ? now - lastUpdateMs : Infinity;
        const isStale = ageMs > STALE_MS;

        for (const { sub, positions } of userData) {
            const userPositions = positions.filter(
                (p) => p.oracle_id === oracle.oracle_id
            );

            // 1. Settlement alert — fires once per oracle per user
            const lastStatus = sub.seenOracleStatus[oracle.oracle_id];
            if (
                wasSettled &&
                lastStatus !== 'settled' &&
                oracle.settlement_price !== null
            ) {
                const settlementUsd = spotToUsd(oracle.settlement_price);
                await send(
                    bot,
                    sub.chatId,
                    alertOracleSettled(oracle, settlementUsd, userPositions)
                );
                await patchSubscription(sub.chatId, {
                    seenOracleStatus: {
                        ...sub.seenOracleStatus,
                        [oracle.oracle_id]: 'settled',
                    },
                });
                continue;
            }

            // Update non-settlement status transitions silently
            if (lastStatus !== oracle.status) {
                await patchSubscription(sub.chatId, {
                    seenOracleStatus: {
                        ...sub.seenOracleStatus,
                        [oracle.oracle_id]: oracle.status,
                    },
                });
            }

            // 2. Near-expiry warning — fires once per oracle within window,
            //    but only if user has open positions on it
            if (
                userPositions.some((p) => p.open_quantity > 0) &&
                oracle.status === 'active' &&
                msToExpiry > 0 &&
                msToExpiry <= NEAR_EXPIRY_WINDOW_MS
            ) {
                const expiryKey = `expiry-${oracle.oracle_id}`;
                if (!sub.seenOracleStatus[expiryKey]) {
                    await send(
                        bot,
                        sub.chatId,
                        alertOracleNearExpiry(oracle, msToExpiry)
                    );
                    await patchSubscription(sub.chatId, {
                        seenOracleStatus: {
                            ...sub.seenOracleStatus,
                            [expiryKey]: 'fired',
                        },
                    });
                }
            }

            // 3. Strike-cross alert — fires when spot transitions across a
            //    strike of one of the user's positions
            if (spotUsd === null) continue;
            for (const pos of userPositions) {
                if (pos.open_quantity === 0) continue;
                const strikeUsd = pos.strike / 1_000_000_000;
                const crossedList =
                    sub.crossedStrikes[oracle.oracle_id] ?? [];
                const recent = crossedList[crossedList.length - 1];
                // Direction: did we cross UP through the strike, or DOWN?
                if (recent === undefined) {
                    // first observation — just record current side, no alert
                    await patchSubscription(sub.chatId, {
                        crossedStrikes: {
                            ...sub.crossedStrikes,
                            [oracle.oracle_id]: [spotUsd],
                        },
                    });
                    continue;
                }
                const wasAbove = recent > strikeUsd;
                const nowAbove = spotUsd > strikeUsd;
                if (wasAbove !== nowAbove) {
                    await send(
                        bot,
                        sub.chatId,
                        alertStrikeCrossed(
                            oracle,
                            pos.strike,
                            nowAbove,
                            spotUsd
                        )
                    );
                    await patchSubscription(sub.chatId, {
                        crossedStrikes: {
                            ...sub.crossedStrikes,
                            [oracle.oracle_id]: [
                                ...crossedList.slice(-9),
                                spotUsd,
                            ],
                        },
                    });
                }
            }

            // 4. Stale-feed warning — only if user has open positions on
            //    this oracle, and price update is older than STALE_MS.
            //    Real on-chain timestamp delta, not a synthetic threshold.
            const userOpen = userPositions.filter((p) => p.open_quantity > 0);
            if (isStale && userOpen.length > 0) {
                const seenStale = sub.seenStaleOracle ?? {};
                const lastFired = seenStale[oracle.oracle_id] ?? 0;
                if (now - lastFired > STALE_COOLDOWN_MS) {
                    await send(
                        bot,
                        sub.chatId,
                        alertOracleStale(oracle, ageMs / 60_000, userOpen.length)
                    );
                    await patchSubscription(sub.chatId, {
                        seenStaleOracle: {
                            ...seenStale,
                            [oracle.oracle_id]: now,
                        },
                    });
                }
            }

            // 5. Flow-against-you warning — if the live trade tape on this
            //    oracle is leaning hard against the user's open side. Uses
            //    the same computeOracleFlow source the agent reads.
            if (userOpen.length > 0) {
                const flow = await flowFor(oracle.oracle_id);
                if (flow.trades >= FLOW_MIN_TRADES) {
                    // Net UP exposure (sum of position sizes with sign).
                    let upSize = 0;
                    let downSize = 0;
                    for (const p of userOpen) {
                        if (p.is_up) upSize += p.open_quantity;
                        else downSize += p.open_quantity;
                    }
                    if (upSize !== downSize) {
                        const userSide: 'UP' | 'DOWN' = upSize > downSize ? 'UP' : 'DOWN';
                        const against =
                            (userSide === 'UP' && flow.netSkew < -FLOW_AGAINST_SKEW) ||
                            (userSide === 'DOWN' && flow.netSkew > FLOW_AGAINST_SKEW);
                        if (against) {
                            const seenFlow = sub.seenFlowAlert ?? {};
                            const lastFlow = seenFlow[oracle.oracle_id] ?? 0;
                            if (now - lastFlow > FLOW_COOLDOWN_MS) {
                                await send(
                                    bot,
                                    sub.chatId,
                                    alertFlowAgainst(oracle, userSide, flow.netSkew, flow.trades)
                                );
                                await patchSubscription(sub.chatId, {
                                    seenFlowAlert: {
                                        ...seenFlow,
                                        [oracle.oracle_id]: now,
                                    },
                                });
                            }
                        }
                    }
                }
            }
        }
        // Silence unused-var lint for the OracleState while keeping the api
        void (state as OracleState);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Spot pass
// ────────────────────────────────────────────────────────────────────────────

async function tickSpot(bot: Telegraf, subs: Subscription[]): Promise<void> {
    if (subs.length === 0) return;
    let markets: SpotMarket[];
    try {
        markets = await listMarkets();
    } catch (e) {
        console.warn('[spot] listMarkets failed:', e);
        return;
    }
    if (markets.length === 0) return;

    for (const sub of subs) {
        for (const m of markets) {
            const key = String(m.id);
            const lastStatus = sub.seenSpotStatus[key];

            // 1. Resolution alert — fires once per user per market
            if (m.status === 'Resolved' && lastStatus !== 'Resolved') {
                const pos = await getMarketPosition(m.id, sub.suiAddr);
                const { yes, no } = decodeBalance(pos);
                await send(bot, sub.chatId, alertSpotResolved(m, yes, no));
                await patchSubscription(sub.chatId, {
                    seenSpotStatus: {
                        ...sub.seenSpotStatus,
                        [key]: 'Resolved',
                    },
                });
                continue;
            }
            if (lastStatus !== m.status) {
                await patchSubscription(sub.chatId, {
                    seenSpotStatus: {
                        ...sub.seenSpotStatus,
                        [key]: m.status,
                    },
                });
            }

            // 2. Price move alert — only if user has a position on this market
            const pos = await getMarketPosition(m.id, sub.suiAddr);
            const { yes, no } = decodeBalance(pos);
            if (yes === 0 && no === 0) continue;
            const lastYes = sub.lastSpotYesPrice[key];
            if (
                lastYes !== undefined &&
                Math.abs(m.yesPrice - lastYes) >= SPOT_PRICE_MOVE_THRESHOLD
            ) {
                await send(
                    bot,
                    sub.chatId,
                    alertSpotPriceMove(m, lastYes, m.yesPrice)
                );
            }
            if (lastYes !== m.yesPrice) {
                await patchSubscription(sub.chatId, {
                    lastSpotYesPrice: {
                        ...sub.lastSpotYesPrice,
                        [key]: m.yesPrice,
                    },
                });
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Main loop
// ────────────────────────────────────────────────────────────────────────────

export function startWatchers(bot: Telegraf): () => void {
    const tick = async () => {
        const subs = listActive();
        if (subs.length === 0) return;
        await Promise.allSettled([tickPredict(bot, subs), tickSpot(bot, subs)]);
    };
    // Fire once immediately so a fresh subscription sees data within seconds,
    // then on the configured cadence.
    void tick();
    const id = setInterval(() => void tick(), CONFIG.POLL_MS);
    return () => clearInterval(id);
}
