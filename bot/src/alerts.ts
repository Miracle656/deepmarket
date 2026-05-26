// Alert engine — composes Telegram message bodies + inline keyboards for
// each event type. Reply markup uses URL-deep-links into the DeepMarket web
// app; clicking on mobile launches the wallet flow inline.

import type { InlineKeyboardMarkup } from 'telegraf/types';
import { CONFIG } from './config.js';
import type { OracleSummary, Position } from './predict.js';
import type { SpotMarket } from './spot.js';

export interface Alert {
    text: string;
    reply_markup?: InlineKeyboardMarkup;
    parse_mode?: 'MarkdownV2' | 'HTML';
}

// Escape MarkdownV2 special chars in user-derived values to keep messages valid.
function esc(s: string): string {
    return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function fmtUsd(n: number, frac = 2): string {
    return `$${n.toLocaleString('en-US', {
        minimumFractionDigits: frac,
        maximumFractionDigits: frac,
    })}`;
}

function predictUrl(oracleId: string): string {
    return `${CONFIG.WEB_URL}/predict/${oracleId}`;
}

function spotUrl(marketObjectId: string): string {
    return `${CONFIG.WEB_URL}/markets/${marketObjectId}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Predict alerts
// ────────────────────────────────────────────────────────────────────────────

export function alertStrikeCrossed(
    oracle: OracleSummary,
    strike: number,
    crossedUp: boolean,
    spotUsd: number
): Alert {
    const strikeUsd = strike / 1_000_000_000;
    const dir = crossedUp ? '⬆️ above' : '⬇️ below';
    const text = [
        `*${esc(oracle.underlying_asset)} spot ${esc(dir)} ${esc(fmtUsd(strikeUsd))}*`,
        `Current: ${esc(fmtUsd(spotUsd))}`,
        `Expiry: ${esc(new Date(oracle.expiry).toLocaleString())}`,
        '',
        `_If you hold an UP@${esc(fmtUsd(strikeUsd))} position, you're now ${crossedUp ? 'in the money' : 'out of the money'}\\._`,
    ].join('\n');
    return {
        text,
        parse_mode: 'MarkdownV2',
        reply_markup: {
            inline_keyboard: [
                [{ text: '→ Open in DeepMarket', url: predictUrl(oracle.oracle_id) }],
            ],
        },
    };
}

export function alertOracleNearExpiry(
    oracle: OracleSummary,
    msToExpiry: number
): Alert {
    const minutes = Math.max(1, Math.floor(msToExpiry / 60_000));
    const text = [
        `*${esc(oracle.underlying_asset)} oracle settling in ~${minutes}m*`,
        `Expires: ${esc(new Date(oracle.expiry).toLocaleString())}`,
        '',
        `_Last chance to sell open positions before settlement freezes payouts\\._`,
    ].join('\n');
    return {
        text,
        parse_mode: 'MarkdownV2',
        reply_markup: {
            inline_keyboard: [
                [{ text: '→ Open oracle', url: predictUrl(oracle.oracle_id) }],
            ],
        },
    };
}

/**
 * Stale-feed warning — fires when an oracle the user has open positions on
 * hasn't had a price update in `ageMin` minutes. Real Date.now() − on-chain
 * timestamp delta; not a synthetic threshold. Comes from /oracles/:id/state
 * tied to /health.
 */
export function alertOracleStale(
    oracle: OracleSummary,
    ageMin: number,
    openPositions: number
): Alert {
    const text = [
        `*⚠️ ${esc(oracle.underlying_asset)} feed is stale — ${esc(String(Math.round(ageMin)))}m since last on-chain update*`,
        `You hold ${esc(String(openPositions))} open position${openPositions === 1 ? '' : 's'} on this oracle\\.`,
        '',
        `_Quotes on a stale feed may not reflect the real market\\. Wait for refresh, or check the health dashboard\\._`,
    ].join('\n');
    return {
        text,
        parse_mode: 'MarkdownV2',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '→ Oracle', url: predictUrl(oracle.oracle_id) },
                    { text: '🩺 Health', url: `${CONFIG.WEB_URL}/health` },
                ],
            ],
        },
    };
}

/**
 * Crowd-disagreement warning — the live trade tape on this oracle is leaning
 * hard against the side the user is positioned on. Confirmation-only signal:
 * we just surface it so the user can decide whether to size down / hedge /
 * close. Same source the agent uses (computeOracleFlow).
 */
export function alertFlowAgainst(
    oracle: OracleSummary,
    userSide: 'UP' | 'DOWN',
    netSkew: number,
    tradeCount: number
): Alert {
    const crowd = netSkew > 0 ? 'UP' : 'DOWN';
    const skewPct = (Math.abs(netSkew) * 100).toFixed(0);
    const text = [
        `*${esc(oracle.underlying_asset)} crowd is ${esc(skewPct)}% net ${esc(crowd)} — you hold ${esc(userSide)}*`,
        `${esc(String(tradeCount))} recent mints disagree with your side\\.`,
        '',
        `_Not necessarily wrong — but worth checking if the crowd sees something you don't\\._`,
    ].join('\n');
    return {
        text,
        parse_mode: 'MarkdownV2',
        reply_markup: {
            inline_keyboard: [
                [{ text: '→ Open oracle', url: predictUrl(oracle.oracle_id) }],
            ],
        },
    };
}

export function alertOracleSettled(
    oracle: OracleSummary,
    settlementUsd: number,
    userPositions: Position[]
): Alert {
    const wins = userPositions.filter((p) => p.status === 'won' || p.status === 'redeemable');
    const losses = userPositions.filter((p) => p.status === 'lost');
    const lines: string[] = [];
    lines.push(`*${esc(oracle.underlying_asset)} settled at ${esc(fmtUsd(settlementUsd))}*`);
    if (wins.length || losses.length) {
        lines.push('');
        lines.push(`Your positions: ${esc(`${wins.length} won, ${losses.length} lost`)}`);
        for (const p of wins.slice(0, 3)) {
            const payout = p.mark_value / 1_000_000;
            const strikeUsd = p.strike / 1_000_000_000;
            lines.push(
                `  ✅ ${esc(p.is_up ? 'UP' : 'DN')}@${esc(fmtUsd(strikeUsd))} → claim ${esc(fmtUsd(payout))}`
            );
        }
        if (wins.length) {
            lines.push('');
            lines.push(`_Tap below to claim your winnings\\._`);
        }
    } else {
        lines.push('');
        lines.push('_You had no positions on this oracle\\._');
    }
    return {
        text: lines.join('\n'),
        parse_mode: 'MarkdownV2',
        reply_markup: {
            inline_keyboard: [
                [{ text: '→ Claim in DeepMarket', url: predictUrl(oracle.oracle_id) }],
            ],
        },
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Spot alerts
// ────────────────────────────────────────────────────────────────────────────

export function alertSpotResolved(
    m: SpotMarket,
    yes: number,
    no: number
): Alert {
    const yesWon = m.outcome === true;
    const holdingWinner = yesWon ? yes > 0 : no > 0;
    const winSize = yesWon ? yes : no;
    const lines: string[] = [];
    lines.push(`*${esc(m.question)}*`);
    lines.push(`Resolved: ${esc(yesWon ? 'YES' : 'NO')} won`);
    if (holdingWinner) {
        lines.push('');
        lines.push(`🎉 You hold ${esc(winSize.toFixed(4))} ${esc(yesWon ? 'YES' : 'NO')} tokens — redeemable now\\.`);
    } else if (yes > 0 || no > 0) {
        lines.push('');
        lines.push(`Your position settled at 0\\.`);
    }
    return {
        text: lines.join('\n'),
        parse_mode: 'MarkdownV2',
        reply_markup: {
            inline_keyboard: [
                [{ text: '→ Open market', url: spotUrl(m.objectId) }],
            ],
        },
    };
}

export function alertSpotPriceMove(
    m: SpotMarket,
    fromYes: number,
    toYes: number
): Alert {
    const arrow = toYes > fromYes ? '⬆️' : '⬇️';
    const text = [
        `*${esc(m.question)}*`,
        `YES ${esc(arrow)} ${esc(`${fromYes}¢ → ${toYes}¢`)}`,
        `NO  ${esc(`${100 - toYes}¢`)}`,
    ].join('\n');
    return {
        text,
        parse_mode: 'MarkdownV2',
        reply_markup: {
            inline_keyboard: [
                [{ text: '→ Open market', url: spotUrl(m.objectId) }],
            ],
        },
    };
}
