// Strategy engine — runs every STRATEGY_TICK_MS, picks the closest active
// BTC oracle, and for each user with strategyEnabled=true mints UP at a
// strike `STRATEGY_BUFFER_TICKS` below spot (the "sell vol" play).
//
// Pre-trade checks per user:
//   - Manager exists (else skip silently)
//   - Wallet dUSDC balance covers worst-case cost (= quantity)
//   - No existing open position at the same (oracle, strike, UP) tuple
//
// On each successful mint we DM the user a summary with the tx digest.

import type { Telegraf } from 'telegraf';
import { CONFIG } from './config.js';
import {
    dusdcToUsd,
    getManagerPositions,
    getOracleState,
    listActiveOracles,
    spotToUsd,
    strikeToUsd,
    type OracleState,
    type OracleSummary,
    type Position,
} from './predict.js';
import { listAll } from './store.js';
import { mintBinary, redeemBinary } from './trader.js';
import { getUserBalances } from './user-wallet.js';

const DUSDC_SCALE = 1_000_000;

function pickStrike(state: OracleState, oracle: OracleSummary): bigint | null {
    if (!state.latest_price) return null;
    const spotRaw = BigInt(Math.floor(state.latest_price.spot));
    const minStrike = BigInt(oracle.min_strike);
    const tick = BigInt(oracle.tick_size);
    const buffer = BigInt(CONFIG.STRATEGY_BUFFER_TICKS);
    const offset = buffer * tick;
    if (spotRaw <= minStrike + offset) return null;
    const target = spotRaw - offset;
    const idx = (target - minStrike) / tick;
    return minStrike + idx * tick;
}

async function pickOracle(): Promise<OracleSummary | null> {
    let oracles: OracleSummary[];
    try {
        oracles = await listActiveOracles();
    } catch {
        return null;
    }
    const now = Date.now();
    // Skip oracles within 2 min of expiry — too close to settlement.
    const eligible = oracles
        .filter((o) => o.status === 'active' && o.expiry > now + 2 * 60_000)
        .sort((a, b) => a.expiry - b.expiry);
    return eligible[0] ?? null;
}

async function tryMintForUser(
    bot: Telegraf,
    chatId: number,
    managerId: string,
    oracle: OracleSummary,
    state: OracleState
): Promise<void> {
    const strike = pickStrike(state, oracle);
    if (strike === null) return;

    // Cooldown: skip if user already has an open UP position on this strike.
    const positions = await getManagerPositions(managerId).catch(() => []);
    const dup = positions.find(
        (p) =>
            p.oracle_id === oracle.oracle_id &&
            BigInt(p.strike) === strike &&
            p.is_up === true &&
            p.open_quantity > 0
    );
    if (dup) return;

    // Worst-case position cost = quantity (when ask == 1). We deposit
    // `quantity` from the user's wallet each time — wasteful but safe.
    // Optimization: read manager balance and only deposit the gap. Later.
    const quantity = BigInt(Math.floor(CONFIG.STRATEGY_QTY_USD * DUSDC_SCALE));
    const balances = await getUserBalances(chatId).catch(() => ({
        sui: 0,
        dusdc: 0,
    }));
    const walletDusdcBase = Math.floor(balances.dusdc * DUSDC_SCALE);
    if (BigInt(walletDusdcBase) < quantity) {
        // Insufficient — silently skip. (Avoid spamming users every tick.)
        return;
    }

    try {
        const { digest } = await mintBinary(chatId, {
            oracleId: oracle.oracle_id,
            expiry: oracle.expiry,
            strike: Number(strike),
            isUp: true,
            quantity,
            depositAmount: quantity,
        });
        const strikeUsd = strikeToUsd(Number(strike));
        const spotUsd = state.latest_price
            ? spotToUsd(state.latest_price.spot)
            : 0;
        await bot.telegram
            .sendMessage(
                chatId,
                `🤖 *Auto-mint*\n` +
                    `UP @ $${strikeUsd.toFixed(0)}  cover $${CONFIG.STRATEGY_QTY_USD.toFixed(2)}\n` +
                    `Spot: $${spotUsd.toFixed(2)}  ·  Expires ${new Date(oracle.expiry).toLocaleTimeString()}\n` +
                    `\`${digest.slice(0, 14)}…\``,
                { parse_mode: 'Markdown' }
            )
            .catch(() => {
                /* user blocked the bot — ignore */
            });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[strategy] mint failed for chat ${chatId}:`, msg);
        // Tell the user once per tick — they can pause the strategy if it keeps failing.
        await bot.telegram
            .sendMessage(
                chatId,
                `⚠️ Strategy mint failed: ${msg.slice(0, 200)}`,
                { link_preview_options: { is_disabled: true } }
            )
            .catch(() => {});
    }
}

/**
 * Auto-redeem all of a user's settled positions and DM them the outcome.
 * Runs before the mint pass so any released dUSDC is available for the
 * next mint. Distinguishes won/lost based on mark_value at time of read.
 */
async function redeemSettledForUser(
    bot: Telegraf,
    chatId: number,
    managerId: string
): Promise<void> {
    let positions: Position[];
    try {
        positions = await getManagerPositions(managerId);
    } catch {
        return;
    }
    // "redeemable" (settled winner) or "lost"/"won" — anything terminal.
    const settled = positions.filter(
        (p) =>
            p.open_quantity > 0 &&
            (p.status === 'won' ||
                p.status === 'redeemable' ||
                p.status === 'lost')
    );
    for (const p of settled) {
        const costUsd = dusdcToUsd(p.open_cost_basis);
        const payoutUsd = dusdcToUsd(p.mark_value);
        const pnlUsd = payoutUsd - costUsd;
        const isWin = p.status === 'won' || p.status === 'redeemable';
        const strikeUsd = strikeToUsd(p.strike);
        const dir = p.is_up ? 'UP' : 'DN';
        try {
            const { digest } = await redeemBinary(chatId, {
                oracleId: p.oracle_id,
                expiry: p.expiry,
                strike: p.strike,
                isUp: p.is_up,
                quantity: BigInt(p.open_quantity),
            });
            const header = isWin ? '🎉 *Won*' : '💔 *Lost*';
            const pnlSign = pnlUsd >= 0 ? '+' : '';
            await bot.telegram
                .sendMessage(
                    chatId,
                    `${header}  ${dir} @ $${strikeUsd.toFixed(0)}\n` +
                        `Cost $${costUsd.toFixed(2)}  ·  Payout $${payoutUsd.toFixed(2)}  ·  P&L ${pnlSign}$${pnlUsd.toFixed(2)}\n` +
                        `\`${digest.slice(0, 14)}…\``,
                    { parse_mode: 'Markdown' }
                )
                .catch(() => {});
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // vec_set / already-redeemed errors are noise — only surface real ones.
            if (!/already.?redeemed|EInsufficientPosition/i.test(msg)) {
                console.warn(
                    `[strategy] redeem failed for chat ${chatId}:`,
                    msg
                );
            }
        }
    }
}

export function startStrategyLoop(bot: Telegraf): () => void {
    const tick = async () => {
        const subs = listAll().filter(
            (s) => s.strategyEnabled && !!s.botManagerId && !!s.botWalletKey
        );
        if (subs.length === 0) return;

        // 1) Redeem settled positions first — frees up dUSDC for the next mint.
        for (const sub of subs) {
            if (!sub.botManagerId) continue;
            await redeemSettledForUser(bot, sub.chatId, sub.botManagerId);
        }

        // 2) Then try to mint a fresh position on the next active oracle.
        const oracle = await pickOracle();
        if (!oracle) {
            console.log('[strategy] no eligible oracle right now');
            return;
        }

        let state: OracleState;
        try {
            state = await getOracleState(oracle.oracle_id);
        } catch (e) {
            console.warn('[strategy] getOracleState failed:', e);
            return;
        }

        for (const sub of subs) {
            if (!sub.botManagerId) continue;
            await tryMintForUser(bot, sub.chatId, sub.botManagerId, oracle, state);
        }
    };

    // Fire once immediately, then on the configured cadence.
    void tick();
    const id = setInterval(() => void tick(), CONFIG.STRATEGY_TICK_MS);
    console.log(
        `[strategy] loop running every ${CONFIG.STRATEGY_TICK_MS}ms ` +
            `(buffer=${CONFIG.STRATEGY_BUFFER_TICKS} ticks, qty=$${CONFIG.STRATEGY_QTY_USD})`
    );
    return () => clearInterval(id);
}
