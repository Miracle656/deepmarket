// Watchers — every POLL_MS, scan oracles + markets + per-user positions
// and fire alerts to each subscriber's Telegram chat.

import type { Telegraf } from 'telegraf';
import { CONFIG } from './config.js';
import { listActive, patchSubscription, type Subscription } from './store.js';
import {
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
    alertOracleNearExpiry,
    alertOracleSettled,
    alertSpotPriceMove,
    alertSpotResolved,
    alertStrikeCrossed,
    type Alert,
} from './alerts.js';

const NEAR_EXPIRY_WINDOW_MS = 5 * 60_000; // 5 minutes
const SPOT_PRICE_MOVE_THRESHOLD = 5; // 5 cent move triggers an alert

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

    for (const oracle of oracles) {
        const state = states.get(oracle.oracle_id);
        if (!state) continue;

        const spotUsd = state.latest_price
            ? spotToUsd(state.latest_price.spot)
            : null;
        const now = Date.now();
        const msToExpiry = oracle.expiry - now;
        const wasSettled = oracle.status === 'settled';

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
