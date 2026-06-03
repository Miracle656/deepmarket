// In-Telegram manual trade panel for Predict oracles.
//
// Tapping an oracle opens a stateful inline-keyboard panel: switch Binary ↔
// Range, pick direction/strike (binary) or band width (range), pick a USD
// quantity, then Mint (with an explicit confirm step before any spend). Draft
// state lives per-chat in memory; callback_data carries only short tokens
// (oracle ids are 66 chars — far over Telegram's 64-byte callback limit).

import { Telegraf, Markup, type Context } from 'telegraf';
import { getOracleState, strikeToUsd, spotToUsd } from './predict.js';
import { getSubscription } from './store.js';
import { mintBinary, mintRange } from './trader.js';
import { CONFIG } from './config.js';

const RAW = 1_000_000_000; // 1e9 strike scale
const QTY_SCALE = 10 ** CONFIG.DUSDC_DECIMALS; // dUSDC base units
const QTY_PRESETS = [1, 5, 10];

interface TradeDraft {
    oracleId: string;
    expiry: number;
    underlying: string;
    minStrikeRaw: bigint;
    tickRaw: bigint;
    centerIdx: number; // grid index nearest spot
    spotUsd: number;
    mode: 'binary' | 'range';
    isUp: boolean;
    strikeIdx: number; // binary: index into the near-spot grid
    bandTicks: number; // range: half-width in ticks
    qtyUsd: number;
    confirming: boolean;
}

const drafts = new Map<number, TradeDraft>();

const fmtK = (raw: bigint) => {
    const usd = Number(raw) / RAW;
    return usd >= 1000
        ? `$${(usd / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
        : `$${usd.toFixed(0)}`;
};
const fmtUsd0 = (usd: number) =>
    `$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function strikeAt(d: TradeDraft, idx: number): bigint {
    return d.minStrikeRaw + BigInt(idx) * d.tickRaw;
}

/** The 5 near-spot grid strikes shown in binary mode. */
function binaryStrikeIdxs(d: TradeDraft): number[] {
    const out: number[] = [];
    for (let i = d.centerIdx - 2; i <= d.centerIdx + 2; i++) {
        if (i >= 0) out.push(i);
    }
    return out;
}

function rangeBounds(d: TradeDraft): { lower: bigint; higher: bigint } {
    const lo = Math.max(0, d.centerIdx - d.bandTicks);
    const hi = d.centerIdx + d.bandTicks;
    return { lower: strikeAt(d, lo), higher: strikeAt(d, hi) };
}

// ── Rendering ──────────────────────────────────────────────────────────────

function render(d: TradeDraft): {
    text: string;
    reply_markup: ReturnType<typeof Markup.inlineKeyboard>['reply_markup'];
} {
    const expiresMin = Math.max(0, Math.round((d.expiry - Date.now()) / 60_000));
    const head =
        `*Trade · ${d.underlying}*\n` +
        `Spot ${fmtUsd0(d.spotUsd)} · expires in ${expiresMin}m\n`;

    if (d.confirming) {
        const summary =
            d.mode === 'binary'
                ? `${d.isUp ? '↑ UP' : '↓ DOWN'} @ ${fmtK(strikeAt(d, d.strikeIdx))}`
                : (() => {
                      const { lower, higher } = rangeBounds(d);
                      return `RANGE ${fmtK(lower)}–${fmtK(higher)}`;
                  })();
        return {
            text:
                head +
                `\n*Confirm mint*\n${summary}\ncover *$${d.qtyUsd.toFixed(2)}* (max payout)\n\n` +
                `_Spends real dUSDC from your manager. Cost is the premium (≤ cover)._`,
            reply_markup: Markup.inlineKeyboard([
                [
                    Markup.button.callback('✅ Confirm', 'tp:ok'),
                    Markup.button.callback('✖️ Cancel', 'tp:no'),
                ],
            ]).reply_markup,
        };
    }

    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    // Mode toggle
    rows.push([
        Markup.button.callback(
            `${d.mode === 'binary' ? '• ' : ''}Binary`,
            'tp:mode:b'
        ),
        Markup.button.callback(
            `${d.mode === 'range' ? '• ' : ''}Range`,
            'tp:mode:r'
        ),
    ]);

    let actionLabel: string;
    if (d.mode === 'binary') {
        rows.push([
            Markup.button.callback(`${d.isUp ? '• ' : ''}↑ UP`, 'tp:dir:u'),
            Markup.button.callback(`${!d.isUp ? '• ' : ''}↓ DOWN`, 'tp:dir:d'),
        ]);
        rows.push(
            binaryStrikeIdxs(d).map((i) =>
                Markup.button.callback(
                    `${i === d.strikeIdx ? '• ' : ''}${fmtK(strikeAt(d, i))}`,
                    `tp:s:${i}`
                )
            )
        );
        actionLabel = `✅ Mint ${d.isUp ? 'UP' : 'DOWN'} $${d.qtyUsd} @ ${fmtK(strikeAt(d, d.strikeIdx))}`;
    } else {
        const { lower, higher } = rangeBounds(d);
        rows.push([
            Markup.button.callback('⟨ Narrow', 'tp:band:n'),
            Markup.button.callback(`${fmtK(lower)}–${fmtK(higher)}`, 'tp:noop'),
            Markup.button.callback('Widen ⟩', 'tp:band:w'),
        ]);
        actionLabel = `✅ Mint RANGE $${d.qtyUsd} · ${fmtK(lower)}–${fmtK(higher)}`;
    }

    // Quantity presets
    rows.push(
        QTY_PRESETS.map((q) =>
            Markup.button.callback(
                `${q === d.qtyUsd ? '• ' : ''}$${q}`,
                `tp:q:${q}`
            )
        )
    );
    rows.push([Markup.button.callback(actionLabel, 'tp:mint')]);
    rows.push([Markup.button.callback('‹ Back to oracles', 'predict:list')]);

    return {
        text: head + `\nMode: *${d.mode === 'binary' ? 'Binary (UP/DOWN)' : 'Range (band)'}*`,
        reply_markup: Markup.inlineKeyboard(rows).reply_markup,
    };
}

async function rerender(ctx: Context, d: TradeDraft): Promise<void> {
    const view = render(d);
    try {
        await ctx.editMessageText(view.text, {
            reply_markup: view.reply_markup,
            parse_mode: 'Markdown',
            link_preview_options: { is_disabled: true },
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('message is not modified')) {
            await ctx.reply(view.text, {
                reply_markup: view.reply_markup,
                parse_mode: 'Markdown',
            });
        }
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function openTradePanel(
    ctx: Context,
    oracleId: string
): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const sub = await getSubscription(chatId);
    if (!sub?.botWalletKey) {
        await ctx.answerCbQuery();
        await ctx.reply('Set up a Bot trader wallet first (🤖 Bot trader).');
        return;
    }

    let state;
    try {
        state = await getOracleState(oracleId);
    } catch {
        await ctx.answerCbQuery('Could not load oracle');
        return;
    }
    const spotRaw = state.latest_price?.spot ?? 0;
    if (spotRaw <= 0) {
        await ctx.answerCbQuery('No live price for this oracle yet');
        return;
    }
    const minStrikeRaw = BigInt(Math.round(state.oracle.min_strike));
    const tickRaw = BigInt(Math.round(state.oracle.tick_size));
    if (tickRaw <= 0n) {
        await ctx.answerCbQuery('Oracle has no tick grid');
        return;
    }
    const centerIdx = Math.max(
        0,
        Math.round((spotRaw - Number(minStrikeRaw)) / Number(tickRaw))
    );

    const draft: TradeDraft = {
        oracleId,
        expiry: state.oracle.expiry,
        underlying: state.oracle.underlying_asset,
        minStrikeRaw,
        tickRaw,
        centerIdx,
        spotUsd: spotToUsd(spotRaw),
        mode: 'binary',
        isUp: true,
        strikeIdx: centerIdx,
        bandTicks: 2,
        qtyUsd: 1,
        confirming: false,
    };
    drafts.set(chatId, draft);
    await ctx.answerCbQuery();
    await rerender(ctx, draft);
}

// ── Callback wiring ──────────────────────────────────────────────────────────

export function registerTradePanel(bot: Telegraf): void {
    const withDraft = (
        fn: (ctx: Context, d: TradeDraft) => Promise<void>
    ) => async (ctx: Context) => {
        const chatId = ctx.chat?.id;
        const d = chatId != null ? drafts.get(chatId) : undefined;
        if (!d) {
            await ctx.answerCbQuery('Trade session expired — reopen the oracle');
            return;
        }
        await fn(ctx, d);
    };

    bot.action('tp:noop', async (ctx) => ctx.answerCbQuery());

    bot.action('tp:mode:b', withDraft(async (ctx, d) => {
        d.mode = 'binary';
        await ctx.answerCbQuery();
        await rerender(ctx, d);
    }));
    bot.action('tp:mode:r', withDraft(async (ctx, d) => {
        d.mode = 'range';
        await ctx.answerCbQuery();
        await rerender(ctx, d);
    }));
    bot.action('tp:dir:u', withDraft(async (ctx, d) => {
        d.isUp = true;
        await ctx.answerCbQuery();
        await rerender(ctx, d);
    }));
    bot.action('tp:dir:d', withDraft(async (ctx, d) => {
        d.isUp = false;
        await ctx.answerCbQuery();
        await rerender(ctx, d);
    }));
    bot.action(/^tp:s:(\d+)$/, withDraft(async (ctx, d) => {
        const idx = Number((ctx as Context & { match: RegExpExecArray }).match[1]);
        d.strikeIdx = idx;
        await ctx.answerCbQuery();
        await rerender(ctx, d);
    }));
    bot.action('tp:band:n', withDraft(async (ctx, d) => {
        d.bandTicks = Math.max(1, d.bandTicks - 1);
        await ctx.answerCbQuery();
        await rerender(ctx, d);
    }));
    bot.action('tp:band:w', withDraft(async (ctx, d) => {
        d.bandTicks = Math.min(d.centerIdx, d.bandTicks + 1);
        await ctx.answerCbQuery();
        await rerender(ctx, d);
    }));
    bot.action(/^tp:q:(\d+)$/, withDraft(async (ctx, d) => {
        d.qtyUsd = Number((ctx as Context & { match: RegExpExecArray }).match[1]);
        await ctx.answerCbQuery();
        await rerender(ctx, d);
    }));
    bot.action('tp:mint', withDraft(async (ctx, d) => {
        d.confirming = true;
        await ctx.answerCbQuery();
        await rerender(ctx, d);
    }));
    bot.action('tp:no', withDraft(async (ctx, d) => {
        d.confirming = false;
        await ctx.answerCbQuery('Cancelled');
        await rerender(ctx, d);
    }));

    bot.action('tp:ok', withDraft(async (ctx, d) => {
        const chatId = ctx.chat!.id;
        await ctx.answerCbQuery('Minting…');
        const quantity = BigInt(Math.round(d.qtyUsd * QTY_SCALE));
        try {
            let digest: string;
            if (d.mode === 'binary') {
                const r = await mintBinary(chatId, {
                    oracleId: d.oracleId,
                    expiry: d.expiry,
                    strike: Number(strikeAt(d, d.strikeIdx)),
                    isUp: d.isUp,
                    quantity,
                    depositAmount: 0n, // use the pre-funded manager balance
                });
                digest = r.digest;
            } else {
                const { lower, higher } = rangeBounds(d);
                const r = await mintRange(chatId, {
                    oracleId: d.oracleId,
                    expiry: d.expiry,
                    lowerStrike: Number(lower),
                    higherStrike: Number(higher),
                    quantity,
                    depositAmount: 0n,
                });
                digest = r.digest;
            }
            drafts.delete(chatId);
            const label =
                d.mode === 'binary'
                    ? `${d.isUp ? 'UP' : 'DOWN'} @ ${fmtK(strikeAt(d, d.strikeIdx))}`
                    : (() => {
                          const { lower, higher } = rangeBounds(d);
                          return `RANGE ${fmtK(lower)}–${fmtK(higher)}`;
                      })();
            await ctx.editMessageText(
                `✅ *Minted* ${label} · cover $${d.qtyUsd.toFixed(2)}\n\`${digest.slice(0, 16)}…\`\n\nIt'll auto-redeem on settlement.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('‹ Back to oracles', 'predict:list')],
                    ]).reply_markup,
                }
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            d.confirming = false;
            await ctx.editMessageText(
                `❌ Mint failed: ${msg.slice(0, 160)}\n\nIf it's an insufficient-balance error, deposit dUSDC in 🤖 Bot trader.`,
                {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('‹ Back to oracles', 'predict:list')],
                    ]).reply_markup,
                }
            );
        }
    }));
}
