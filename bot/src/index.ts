// DeepMarket Telegram bot — entry point.
//
// UX model: BONKbot-style inline menus. After /start, every interaction
// happens via inline keyboard buttons attached to a single message that
// gets edited in place on each tap.

import { Markup, Telegraf, type Context } from 'telegraf';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'telegraf/types';
import { CONFIG } from './config.js';
import {
    getOrCreateUserManager,
    recentTrades,
} from './trader.js';
import {
    dusdcToUsd as dusdcUsd,
    getManagerPositions as fetchManagerPositions,
    strikeToUsd as strikeUsd,
} from './predict.js';
import {
    clearUserWallet,
    generateUserWallet,
    getUserBalances,
    getUserSubscription,
    importUserWallet,
    isPendingImport,
    setPendingImport,
    WalletError,
} from './user-wallet.js';
import {
    deleteSubscription,
    getSubscription,
    loadStore,
    patchSubscription,
    setMuted,
    upsertSubscription,
} from './store.js';
import { startWatchers } from './watchers.js';
import { startStrategyLoop } from './strategy.js';
import {
    dusdcToUsd,
    findManagerByOwner,
    getManagerPositions,
    getManagerSummary,
    listActiveOracles,
    spotToUsd,
    strikeToUsd,
    formatExpiry,
    getOracleState,
    type Position,
} from './predict.js';
import {
    decodeBalance,
    getMarketPosition,
    listMarkets,
    type SpotMarket,
} from './spot.js';
import {
    botTraderMenu,
    mainMenu,
    predictSubMenu,
    spotSubMenu,
    settingsMenu,
    backButton,
    urlOrCallback,
    type MenuState,
} from './menus.js';

const SUI_ADDR_RE = /^0x[a-fA-F0-9]{64}$/;

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function loadMenuState(chatId: number): Promise<MenuState> {
    const sub = await getSubscription(chatId);
    if (!sub) return { muted: false };
    const state: MenuState = {
        addr: sub.suiAddr,
        muted: sub.muted,
    };
    try {
        const managerId = await findManagerByOwner(sub.suiAddr);
        if (managerId) {
            const summary = await getManagerSummary(managerId);
            if (summary) {
                state.predictTradingBalance = dusdcToUsd(summary.trading_balance);
                state.predictUnrealized = dusdcToUsd(summary.unrealized_pnl);
                state.predictRealized = dusdcToUsd(summary.realized_pnl);
                state.predictOpenCount = summary.open_positions;
            }
        }
    } catch {
        /* offline */
    }
    try {
        const markets = await listMarkets();
        let count = 0;
        for (const m of markets) {
            const p = await getMarketPosition(m.id, sub.suiAddr);
            const { yes, no } = decodeBalance(p);
            if (yes > 0.0001 || no > 0.0001) count++;
        }
        state.spotPositionsCount = count;
    } catch {
        /* indexer offline */
    }
    return state;
}

/**
 * Replace the current callback-query message with new content + keyboard.
 * Falls back to sending a fresh message if the original can't be edited
 * (e.g., it was sent more than 48h ago).
 */
async function editOrReply(
    ctx: Context,
    text: string,
    extra: { reply_markup: InlineKeyboardMarkup }
): Promise<void> {
    try {
        await ctx.editMessageText(text, {
            ...extra,
            link_preview_options: { is_disabled: true },
            parse_mode: 'Markdown',
        });
    } catch {
        await ctx.reply(text, {
            ...extra,
            link_preview_options: { is_disabled: true },
            parse_mode: 'Markdown',
        });
    }
}

async function showMain(ctx: Context): Promise<void> {
    if (!ctx.chat) return;
    const state = await loadMenuState(ctx.chat.id);
    const view = mainMenu(state);
    await editOrReply(ctx, view.text, { reply_markup: view.reply_markup });
}

// ────────────────────────────────────────────────────────────────────────────
// Menu content builders (positions snapshot, oracle list, market list)
// ────────────────────────────────────────────────────────────────────────────

async function buildPositionsView(chatId: number): Promise<{
    text: string;
    extra: { reply_markup: InlineKeyboardMarkup };
}> {
    const sub = await getSubscription(chatId);
    if (!sub) {
        return {
            text: 'No subscription. Send /start <sui-address> first.',
            extra: { reply_markup: { inline_keyboard: [backButton('menu:main')] } },
        };
    }
    const lines: string[] = [
        `*Positions for* \`${sub.suiAddr.slice(0, 10)}…${sub.suiAddr.slice(-6)}\``,
        '',
    ];

    // Spot
    try {
        const markets = await listMarkets();
        const held: { m: SpotMarket; yes: number; no: number }[] = [];
        for (const m of markets) {
            const p = await getMarketPosition(m.id, sub.suiAddr);
            const { yes, no } = decodeBalance(p);
            if (yes > 0.0001 || no > 0.0001) held.push({ m, yes, no });
        }
        lines.push(`*SPOT (${held.length})*`);
        if (held.length === 0) {
            lines.push('  _none_');
        } else {
            for (const p of held.slice(0, 5)) {
                lines.push(
                    `  · ${p.m.question.slice(0, 36)} — YES ${p.yes.toFixed(2)} / NO ${p.no.toFixed(2)}  @ ${p.m.yesPrice}¢`
                );
            }
        }
    } catch {
        lines.push('*SPOT* _(indexer offline)_');
    }
    lines.push('');

    // Predict
    try {
        const managerId = await findManagerByOwner(sub.suiAddr);
        if (!managerId) {
            lines.push('*PREDICT* _(no manager yet)_');
        } else {
            const summary = await getManagerSummary(managerId);
            const positions = await getManagerPositions(managerId);
            const open = positions.filter((p) => p.open_quantity > 0);
            lines.push(`*PREDICT* _(manager ${managerId.slice(0, 10)}…)_`);
            if (summary) {
                lines.push(
                    `  balance $${dusdcToUsd(summary.trading_balance).toFixed(2)}  ` +
                        `unrealized ${dusdcToUsd(summary.unrealized_pnl) >= 0 ? '+' : ''}$${dusdcToUsd(summary.unrealized_pnl).toFixed(2)}  ` +
                        `realized ${dusdcToUsd(summary.realized_pnl) >= 0 ? '+' : ''}$${dusdcToUsd(summary.realized_pnl).toFixed(2)}`
                );
            }
            if (open.length === 0) {
                lines.push('  _no open positions_');
            } else {
                for (const p of open.slice(0, 5)) {
                    lines.push(
                        `  · ${p.is_up ? 'UP' : 'DN'}@$${strikeToUsd(p.strike).toFixed(0)}  cover $${dusdcToUsd(p.open_quantity).toFixed(2)}  mark $${dusdcToUsd(p.mark_value).toFixed(2)}`
                    );
                }
            }
        }
    } catch {
        lines.push('*PREDICT* _(server offline)_');
    }

    return {
        text: lines.join('\n'),
        extra: { reply_markup: { inline_keyboard: [backButton('menu:main')] } },
    };
}

async function buildPredictListView(): Promise<{
    text: string;
    extra: { reply_markup: InlineKeyboardMarkup };
}> {
    const oracles = (await listActiveOracles()).slice(0, 8);
    if (oracles.length === 0) {
        return {
            text: '*Active oracles*\n_No active oracles right now._',
            extra: {
                reply_markup: { inline_keyboard: [backButton('menu:predict')] },
            },
        };
    }
    const lines = ['*Active Predict oracles*', ''];
    const buttons: InlineKeyboardButton[][] = [];
    for (const o of oracles) {
        let spotLabel = '';
        try {
            const state = await getOracleState(o.oracle_id);
            if (state.latest_price) {
                spotLabel = `  ($${spotToUsd(state.latest_price.spot).toFixed(0)})`;
            }
        } catch {
            /* no spot */
        }
        lines.push(
            `· *${o.underlying_asset}*${spotLabel} — expires ${formatExpiry(o.expiry)}`
        );
        buttons.push([
            urlOrCallback(
                `→ ${o.underlying_asset} ${formatExpiry(o.expiry)}`,
                `${CONFIG.WEB_URL}/predict/${o.oracle_id}`,
                `predict:open:${o.oracle_id}`
            ),
        ]);
    }
    buttons.push(backButton('menu:predict'));
    return {
        text: lines.join('\n'),
        extra: { reply_markup: { inline_keyboard: buttons } },
    };
}

async function buildSpotListView(): Promise<{
    text: string;
    extra: { reply_markup: InlineKeyboardMarkup };
}> {
    const markets = (await listMarkets()).slice(0, 8);
    if (markets.length === 0) {
        return {
            text: '*Spot markets*\n_Indexer returned no markets._',
            extra: {
                reply_markup: { inline_keyboard: [backButton('menu:spot')] },
            },
        };
    }
    const lines = ['*Active Spot markets*', ''];
    const buttons: InlineKeyboardButton[][] = [];
    for (const m of markets) {
        const q = m.question.length > 40 ? m.question.slice(0, 37) + '…' : m.question;
        lines.push(`· ${q}  —  *YES ${m.yesPrice}¢*`);
        buttons.push([
            urlOrCallback(
                `→ ${q}`,
                `${CONFIG.WEB_URL}/markets/${m.objectId}`,
                `spot:open:${m.id}`
            ),
        ]);
    }
    buttons.push(backButton('menu:spot'));
    return {
        text: lines.join('\n'),
        extra: { reply_markup: { inline_keyboard: buttons } },
    };
}

async function buildPredictMineView(chatId: number): Promise<{
    text: string;
    extra: { reply_markup: InlineKeyboardMarkup };
}> {
    const sub = await getSubscription(chatId);
    if (!sub) {
        return {
            text: 'No subscription. Send /start <sui-address> first.',
            extra: {
                reply_markup: { inline_keyboard: [backButton('menu:predict')] },
            },
        };
    }
    const mid = await findManagerByOwner(sub.suiAddr);
    if (!mid) {
        return {
            text: '*Predict positions*\n_No manager yet. Mint your first position in the app._',
            extra: {
                reply_markup: { inline_keyboard: [backButton('menu:predict')] },
            },
        };
    }
    const positions = await getManagerPositions(mid);
    const open: Position[] = positions.filter((p) => p.open_quantity > 0);
    const lines = [`*Your Predict positions* (${open.length})`, ''];
    const buttons: InlineKeyboardButton[][] = [];
    if (open.length === 0) {
        lines.push('_No open positions._');
    } else {
        for (const p of open.slice(0, 8)) {
            const sign = dusdcToUsd(p.unrealized_pnl) >= 0 ? '+' : '';
            lines.push(
                `· ${p.is_up ? 'UP' : 'DN'}@$${strikeToUsd(p.strike).toFixed(0)}  ${sign}$${dusdcToUsd(p.unrealized_pnl).toFixed(2)}  (${p.status})`
            );
            buttons.push([
                urlOrCallback(
                    `→ ${p.is_up ? 'UP' : 'DN'} @ $${strikeToUsd(p.strike).toFixed(0)} (${p.status})`,
                    `${CONFIG.WEB_URL}/predict/${p.oracle_id}`,
                    `predict:open:${p.oracle_id}`
                ),
            ]);
        }
    }
    buttons.push(backButton('menu:predict'));
    return {
        text: lines.join('\n'),
        extra: { reply_markup: { inline_keyboard: buttons } },
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Bot wiring
// ────────────────────────────────────────────────────────────────────────────

async function main() {
    await loadStore();

    const bot = new Telegraf(CONFIG.BOT_TOKEN);

    await bot.telegram.setMyCommands([
        { command: 'start', description: 'Show the main menu' },
        { command: 'menu', description: 'Show the main menu' },
    ]);

    bot.start(async (ctx) => {
        const arg = (ctx.payload ?? '').trim();
        if (arg && SUI_ADDR_RE.test(arg)) {
            await upsertSubscription(ctx.chat.id, arg);
        }
        const sub = await getSubscription(ctx.chat.id);
        if (!sub) {
            await ctx.reply(
                'Welcome to *DeepMarket*.\n\n' +
                    'Send `/start <your-sui-address>` to register, e.g.\n' +
                    '`/start 0x669fbc7d…ec58`',
                { parse_mode: 'Markdown' }
            );
            return;
        }
        await showMain(ctx);
    });

    bot.command('menu', showMain);

    // Plain text route:
    //   - If pendingImport is set → treat as private key (Generate/Import flow)
    //   - Else if text looks like a Sui address → set it as the tracked addr
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();

        if (await isPendingImport(ctx.chat.id)) {
            try {
                const { address } = await importUserWallet(ctx.chat.id, text);
                await ctx.reply(
                    `✅ Wallet imported.\n\n` +
                        `Address: \`${address}\`\n\n` +
                        'Fund it with SUI (gas) + dUSDC (trade collateral), then tap *Initialize manager* in the bot menu.',
                    { parse_mode: 'Markdown' }
                );
                await showMain(ctx);
            } catch (e) {
                const msg =
                    e instanceof WalletError
                        ? e.message
                        : e instanceof Error
                          ? e.message
                          : String(e);
                await ctx.reply(`❌ Import failed: ${msg}`);
            }
            return;
        }

        if (!SUI_ADDR_RE.test(text)) return;
        await upsertSubscription(ctx.chat.id, text);
        await ctx.reply(
            `✅ Now tracking \`${text.slice(0, 10)}…${text.slice(-6)}\`.`,
            { parse_mode: 'Markdown' }
        );
        await showMain(ctx);
    });

    // ── inline menu navigation ──────────────────────────────────────────

    bot.action('menu:main', async (ctx) => {
        await ctx.answerCbQuery();
        await showMain(ctx);
    });

    bot.action('menu:refresh', async (ctx) => {
        await ctx.answerCbQuery('Refreshed');
        await showMain(ctx);
    });

    bot.action('menu:positions', async (ctx) => {
        await ctx.answerCbQuery();
        if (!ctx.chat) return;
        const view = await buildPositionsView(ctx.chat.id);
        await editOrReply(ctx, view.text, view.extra);
    });

    bot.action('menu:predict', async (ctx) => {
        await ctx.answerCbQuery();
        const view = predictSubMenu();
        await editOrReply(ctx, view.text, { reply_markup: view.reply_markup });
    });

    bot.action('menu:spot', async (ctx) => {
        await ctx.answerCbQuery();
        const view = spotSubMenu();
        await editOrReply(ctx, view.text, { reply_markup: view.reply_markup });
    });

    bot.action('menu:portfolio', async (ctx) => {
        await ctx.answerCbQuery();
        if (!ctx.chat) return;
        const view = await buildPositionsView(ctx.chat.id);
        await editOrReply(ctx, view.text, view.extra);
    });

    bot.action('menu:settings', async (ctx) => {
        await ctx.answerCbQuery();
        if (!ctx.chat) return;
        const state = await loadMenuState(ctx.chat.id);
        const view = settingsMenu(state);
        await editOrReply(ctx, view.text, { reply_markup: view.reply_markup });
    });

    // ── 🤖 Bot trader menu (per-user custodial) ─────────────────────────

    function buildTradeLines(trades: Awaited<ReturnType<typeof recentTrades>>): string[] {
        return trades.map((t) => {
            const when = new Date(t.ts).toLocaleTimeString();
            if (t.type === 'init-manager') return `${when}  init`;
            if (t.type === 'mint') {
                const usd = (t.quantity ?? 0) / 1_000_000;
                const strikeUsd = (t.strike ?? 0) / 1_000_000_000;
                const tag = t.isUp ? 'UP' : 'DN';
                const status = t.error ? '❌' : '✅';
                return `${when}  ${status} mint ${tag}@$${strikeUsd.toFixed(0)} $${usd.toFixed(2)}`;
            }
            if (t.type === 'redeem') return `${when}  redeem`;
            if (t.type === 'deposit') return `${when}  deposit`;
            return `${when}  ${t.type}`;
        });
    }

    async function renderBotMenu(ctx: Context): Promise<void> {
        if (!ctx.chat) return;
        const sub = await getUserSubscription(ctx.chat.id);
        if (sub?.pendingImport) {
            const view = botTraderMenu({
                needsSetup: true,
                awaitingImportKey: true,
                strategyOn: !!sub.strategyEnabled,
            });
            await editOrReply(ctx, view.text, { reply_markup: view.reply_markup });
            return;
        }
        if (!sub?.botWalletKey) {
            const view = botTraderMenu({ needsSetup: true, strategyOn: false });
            await editOrReply(ctx, view.text, { reply_markup: view.reply_markup });
            return;
        }
        const balances = await getUserBalances(ctx.chat.id).catch(() => ({
            sui: 0,
            dusdc: 0,
        }));
        const trades = await recentTrades(ctx.chat.id, 5);
        let openPositionLines: string[] = [];
        if (sub.botManagerId) {
            const positions = await fetchManagerPositions(
                sub.botManagerId
            ).catch(() => []);
            openPositionLines = positions
                .filter((p) => p.open_quantity > 0)
                .slice(0, 8)
                .map((p) => {
                    const dir = p.is_up ? 'UP' : 'DN';
                    const sk = strikeUsd(p.strike);
                    const cover = dusdcUsd(p.open_quantity);
                    const mark = dusdcUsd(p.mark_value);
                    const pnl = dusdcUsd(p.unrealized_pnl);
                    const pnlSign = pnl >= 0 ? '+' : '';
                    return `${dir}@$${sk.toFixed(0)}  cover $${cover.toFixed(2)}  mark $${mark.toFixed(2)}  ${pnlSign}$${pnl.toFixed(2)}  (${p.status})`;
                });
        }
        const view = botTraderMenu({
            needsSetup: false,
            address: sub.botWalletAddr,
            suiBalance: balances.sui,
            dusdcBalance: balances.dusdc,
            managerId: sub.botManagerId ?? null,
            strategyOn: !!sub.strategyEnabled,
            openPositionLines,
            recentTradeLines: buildTradeLines(trades),
        });
        await editOrReply(ctx, view.text, { reply_markup: view.reply_markup });
    }

    bot.action('menu:bot', async (ctx) => {
        await ctx.answerCbQuery();
        await renderBotMenu(ctx);
    });

    bot.action('bot:generate', async (ctx) => {
        if (!ctx.chat) return;
        await ctx.answerCbQuery();
        const sub = await getUserSubscription(ctx.chat.id);
        if (!sub) {
            // Auto-create the subscription if user opened bot menu first
            await upsertSubscription(ctx.chat.id, '0x' + '0'.repeat(64));
        }
        const { address } = await generateUserWallet(ctx.chat.id);
        await ctx.reply(
            `✅ *Fresh wallet generated*\n\n` +
                `Address: \`${address}\`\n\n` +
                'Send SUI (gas) and dUSDC (trade collateral) to this address. ' +
                'Once funded, tap *Initialize manager* in the bot menu.\n\n' +
                '_Tap *Show key* in the menu any time to export the private key._',
            { parse_mode: 'Markdown' }
        );
        await renderBotMenu(ctx);
    });

    bot.action('bot:import', async (ctx) => {
        if (!ctx.chat) return;
        const sub = await getUserSubscription(ctx.chat.id);
        if (!sub) {
            await upsertSubscription(ctx.chat.id, '0x' + '0'.repeat(64));
        }
        await setPendingImport(ctx.chat.id, true);
        await ctx.answerCbQuery();
        await renderBotMenu(ctx);
    });

    bot.action('bot:cancelimport', async (ctx) => {
        if (!ctx.chat) return;
        await setPendingImport(ctx.chat.id, false);
        await ctx.answerCbQuery('Import cancelled');
        await renderBotMenu(ctx);
    });

    bot.action('bot:initmanager', async (ctx) => {
        if (!ctx.chat) return;
        await ctx.answerCbQuery('Sending tx…');
        try {
            const id = await getOrCreateUserManager(ctx.chat.id);
            await ctx.reply(
                `✅ Manager created: \`${id.slice(0, 16)}…${id.slice(-6)}\``,
                { parse_mode: 'Markdown' }
            );
            await renderBotMenu(ctx);
        } catch (e) {
            await ctx.reply(
                `❌ Init failed: ${e instanceof Error ? e.message : String(e)}`
            );
        }
    });

    bot.action('bot:togglestrategy', async (ctx) => {
        if (!ctx.chat) return;
        const sub = await getUserSubscription(ctx.chat.id);
        if (!sub) return;
        const next = !sub.strategyEnabled;
        await patchSubscription(ctx.chat.id, { strategyEnabled: next });
        await ctx.answerCbQuery(next ? 'Strategy started' : 'Strategy paused');
        await renderBotMenu(ctx);
    });

    bot.action('bot:export', async (ctx) => {
        if (!ctx.chat) return;
        const sub = await getUserSubscription(ctx.chat.id);
        if (!sub?.botWalletKey) {
            await ctx.answerCbQuery('No wallet to export');
            return;
        }
        await ctx.answerCbQuery();
        await ctx.reply(
            '🔑 *Your bot wallet private key*\n\n' +
                `Address: \`${sub.botWalletAddr}\`\n\n` +
                `Key:\n\`${sub.botWalletKey}\`\n\n` +
                '_Keep this safe. Anyone with this key controls the wallet._',
            { parse_mode: 'Markdown' }
        );
    });

    bot.action('bot:rotate', async (ctx) => {
        if (!ctx.chat) return;
        await ctx.answerCbQuery();
        await ctx.reply(
            '⚠️ *Rotate wallet?*\n\n' +
                'This generates a new keypair and wipes the current one from bot storage. ' +
                '*Withdraw any funds first!* Tap *Show key* to back up the current key, ' +
                'transfer SUI + dUSDC + redeem positions, then come back here.\n\n' +
                'Reply *rotate-yes* to confirm.',
            { parse_mode: 'Markdown' }
        );
    });

    // Confirm rotate via plain-text "rotate-yes"
    bot.hears('rotate-yes', async (ctx) => {
        if (!ctx.chat) return;
        await clearUserWallet(ctx.chat.id);
        await ctx.reply('Wallet wiped. Tap *Bot trader* to generate or import a new one.', {
            parse_mode: 'Markdown',
        });
        await renderBotMenu(ctx);
    });

    bot.action('menu:togglemute', async (ctx) => {
        if (!ctx.chat) return;
        const sub = await getSubscription(ctx.chat.id);
        if (!sub) {
            await ctx.answerCbQuery('No subscription yet');
            return;
        }
        await setMuted(ctx.chat.id, !sub.muted);
        await ctx.answerCbQuery(!sub.muted ? 'Muted' : 'Unmuted');
        await showMain(ctx);
    });

    bot.action('menu:changeaddr', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply(
            'Paste a new Sui address (0x + 64 hex chars) as a plain message.'
        );
    });

    bot.action('menu:stop', async (ctx) => {
        if (!ctx.chat) return;
        await deleteSubscription(ctx.chat.id);
        await ctx.answerCbQuery('Subscription deleted');
        await editOrReply(ctx, 'Subscription deleted. Send /start <addr> to re-register.', {
            reply_markup: { inline_keyboard: [] },
        });
    });

    bot.action('menu:open', async (ctx) => {
        await ctx.answerCbQuery(`Open ${CONFIG.WEB_URL} in your browser`);
        await ctx.reply(`Open in your browser: ${CONFIG.WEB_URL}`);
    });

    bot.action('predict:list', async (ctx) => {
        await ctx.answerCbQuery();
        const view = await buildPredictListView();
        await editOrReply(ctx, view.text, view.extra);
    });

    bot.action('predict:mine', async (ctx) => {
        await ctx.answerCbQuery();
        if (!ctx.chat) return;
        const view = await buildPredictMineView(ctx.chat.id);
        await editOrReply(ctx, view.text, view.extra);
    });

    bot.action('spot:list', async (ctx) => {
        await ctx.answerCbQuery();
        const view = await buildSpotListView();
        await editOrReply(ctx, view.text, view.extra);
    });

    bot.action('spot:mine', async (ctx) => {
        await ctx.answerCbQuery();
        if (!ctx.chat) return;
        const view = await buildPositionsView(ctx.chat.id);
        await editOrReply(ctx, view.text, view.extra);
    });

    // open-by-id callbacks: when WEB_URL is non-HTTPS the URL buttons become
    // callback buttons; we acknowledge with a hint to open the browser.
    bot.action(/^predict:open:(0x[a-f0-9]+)$/, async (ctx) => {
        const m = ctx.match[1];
        await ctx.answerCbQuery(`Open ${CONFIG.WEB_URL}/predict/${m}`);
        await ctx.reply(`Open: ${CONFIG.WEB_URL}/predict/${m}`);
    });

    bot.action(/^spot:open:(\d+)$/, async (ctx) => {
        const id = ctx.match[1];
        await ctx.answerCbQuery();
        await ctx.reply(`Open: ${CONFIG.WEB_URL}/markets/${id}`);
    });

    bot.catch((err, ctx) => {
        console.error(`[bot] handler error in update ${ctx.update.update_id}:`, err);
    });

    const stopWatchers = startWatchers(bot);
    const stopStrategy = startStrategyLoop(bot);
    await bot.launch();
    console.log(`[bot] launched. polling every ${CONFIG.POLL_MS}ms`);

    const shutdown = () => {
        stopWatchers();
        stopStrategy();
        bot.stop('SIGTERM');
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

// Silence unused-var warning for the Markup import path (used indirectly via menus.ts).
void Markup;

main().catch((e) => {
    console.error('[bot] fatal:', e);
    process.exit(1);
});
