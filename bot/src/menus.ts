// Inline menu builders — BONKbot-style. Each top-level view sends a single
// message with header text + a grid of inline buttons. Button taps fire
// callback_data which we route in index.ts via bot.action().

import { Markup } from 'telegraf';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'telegraf/types';
import { CONFIG } from './config.js';

const HTTPS = /^https:\/\//i;

/**
 * Telegram rejects http://localhost URLs on inline keyboards. We swap URL
 * buttons for callback buttons (with the URL embedded in the tap response)
 * whenever WEB_URL isn't HTTPS — so the bot still works in dev.
 */
export function urlOrCallback(
    label: string,
    url: string,
    callbackData: string
): InlineKeyboardButton {
    if (HTTPS.test(url)) {
        return Markup.button.url(label, url);
    }
    return Markup.button.callback(label, callbackData);
}

export interface MenuState {
    addr?: string;
    muted: boolean;
    predictTradingBalance?: number; // dUSDC, already divided
    predictUnrealized?: number;
    predictRealized?: number;
    spotPositionsCount?: number;
    predictOpenCount?: number;
}

export function mainMenu(state: MenuState): {
    text: string;
    reply_markup: InlineKeyboardMarkup;
} {
    const addrShort = state.addr
        ? `${state.addr.slice(0, 10)}…${state.addr.slice(-6)}`
        : 'not set';

    const lines = [
        '*DeepMarket*',
        `\`${addrShort}\`  ·  ${state.muted ? '🔇 muted' : '🔔 alerts on'}`,
        '',
    ];

    if (state.predictTradingBalance !== undefined) {
        lines.push(
            `📈  Predict balance  $${state.predictTradingBalance.toFixed(2)}  ` +
                `unrealized ${state.predictUnrealized! >= 0 ? '+' : ''}$${state.predictUnrealized!.toFixed(2)}`
        );
    }
    if (state.spotPositionsCount !== undefined) {
        lines.push(
            `🟢  Spot positions   ${state.spotPositionsCount} open`
        );
    }
    if (state.predictOpenCount !== undefined) {
        lines.push(
            `📊  Predict positions ${state.predictOpenCount} open`
        );
    }

    return {
        text: lines.join('\n'),
        reply_markup: {
            inline_keyboard: [
                [
                    Markup.button.callback('📊 Positions', 'menu:positions'),
                    Markup.button.callback('📈 Predict', 'menu:predict'),
                ],
                [
                    Markup.button.callback('🟢 Spot', 'menu:spot'),
                    Markup.button.callback('💼 Portfolio', 'menu:portfolio'),
                ],
                [
                    Markup.button.callback('🤖 Bot trader', 'menu:bot'),
                    Markup.button.callback('⚙️ Settings', 'menu:settings'),
                ],
                [
                    Markup.button.callback(
                        state.muted ? '🔔 Unmute alerts' : '🔇 Mute alerts',
                        'menu:togglemute'
                    ),
                ],
                [
                    urlOrCallback(
                        '↗ Open DeepMarket',
                        `${CONFIG.WEB_URL}/markets`,
                        'menu:open'
                    ),
                    Markup.button.callback('🔄 Refresh', 'menu:refresh'),
                ],
            ],
        },
    };
}

export function backButton(target = 'menu:main'): InlineKeyboardButton[] {
    return [Markup.button.callback('‹ Back', target)];
}

export function predictSubMenu(): {
    text: string;
    reply_markup: InlineKeyboardMarkup;
} {
    return {
        text:
            '*DeepBook Predict*\n' +
            'Binary BTC options minted every hour. Pick an action:',
        reply_markup: {
            inline_keyboard: [
                [
                    Markup.button.callback('📋 Active oracles', 'predict:list'),
                    Markup.button.callback('💼 My positions', 'predict:mine'),
                ],
                [
                    urlOrCallback(
                        '↗ Open in app',
                        `${CONFIG.WEB_URL}/predict`,
                        'menu:open'
                    ),
                ],
                backButton('menu:main'),
            ],
        },
    };
}

export function spotSubMenu(): {
    text: string;
    reply_markup: InlineKeyboardMarkup;
} {
    return {
        text:
            '*Spot YES/NO markets*\n' +
            'Anyone-can-create prediction markets traded on DeepBook V3:',
        reply_markup: {
            inline_keyboard: [
                [
                    Markup.button.callback('📋 Active markets', 'spot:list'),
                    Markup.button.callback('💼 My positions', 'spot:mine'),
                ],
                [
                    urlOrCallback(
                        '↗ Open in app',
                        `${CONFIG.WEB_URL}/markets`,
                        'menu:open'
                    ),
                ],
                backButton('menu:main'),
            ],
        },
    };
}

export interface BotTraderState {
    /** No custodial wallet yet — show Generate / Import options. */
    needsSetup: boolean;
    /** Awaiting an `Ed25519` private key in the user's next message. */
    awaitingImportKey?: boolean;
    address?: string;
    suiBalance?: number;
    dusdcBalance?: number;
    managerId?: string | null;
    strategyOn: boolean;
    openPositionLines?: string[];
    recentTradeLines?: string[];
    /** Lifetime fees this user has paid to the bot treasury, in USD. */
    feesPaidUsd?: number;
    /** Per-trade fee rate (basis points) — shown to make the fee visible. */
    feeBps?: number;
    /** Trading brain: LLM-driven (Claude) or rule-based fallback. */
    agentMode?: 'llm' | 'rule';
    /** Latest persisted agent note (most recent first). */
    lastAgentNote?: string;
    /** MemWal (Walrus-backed semantic memory) is wired up + reachable. */
    memwalOn?: boolean;
    /** Heartbeat: epoch ms of the last strategy tick that evaluated this user. */
    lastCheckAt?: number;
    /** Heartbeat: short outcome of that last tick. */
    lastOutcome?: string;
    /** DEMO mode is on — the agent force-mints -EV to show the flow. */
    demoMode?: boolean;
}

export function botTraderMenu(state: BotTraderState): {
    text: string;
    reply_markup: InlineKeyboardMarkup;
} {
    if (state.awaitingImportKey) {
        return {
            text:
                '*📥 Paste your private key*\n\n' +
                'Send your Sui Ed25519 secret key as a regular message — either:\n' +
                '  · bech32 `suiprivkey1…`, or\n' +
                '  · 64-char hex (with or without `0x` prefix).\n\n' +
                '_⚠️ The bot will store this key in plaintext on its server. ' +
                'For mainnet use a fresh throwaway wallet, never your daily-driver._\n\n' +
                'Tap Cancel to abort.',
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback('⏪ Cancel import', 'bot:cancelimport')],
                ],
            },
        };
    }

    if (state.needsSetup) {
        return {
            text:
                '*🤖 Bot trader*\n\n' +
                'Set up a custodial wallet for the bot to trade with:\n\n' +
                '  · *Generate* — bot creates a fresh Sui keypair. Recommended.\n' +
                '  · *Import*   — paste an existing `suiprivkey…` to use that wallet.\n\n' +
                'After setup, fund the address with SUI (gas) + dUSDC (trade collateral).',
            reply_markup: {
                inline_keyboard: [
                    [
                        Markup.button.callback('🆕 Generate fresh', 'bot:generate'),
                        Markup.button.callback('📥 Import existing', 'bot:import'),
                    ],
                    backButton('menu:main'),
                ],
            },
        };
    }

    const addrShort = state.address
        ? `${state.address.slice(0, 10)}…${state.address.slice(-6)}`
        : 'unknown';
    const mgrShort = state.managerId
        ? `${state.managerId.slice(0, 10)}…${state.managerId.slice(-6)}`
        : 'not initialized';
    const lines = [
        '*🤖 Bot trader*',
        '',
        `Wallet: \`${addrShort}\``,
        `SUI: ${(state.suiBalance ?? 0).toFixed(4)}   dUSDC: ${(state.dusdcBalance ?? 0).toFixed(2)}`,
        `Manager: \`${mgrShort}\``,
        `Strategy: ${state.strategyOn ? '🟢 ON' : '⚪ off'}` +
            (state.agentMode
                ? `  ·  ${state.agentMode === 'llm' ? '🧠 Claude' : '📐 rule'}`
                : '') +
            (state.memwalOn ? `  ·  🐋 MemWal` : '') +
            (state.demoMode ? `  ·  ⚠️ DEMO` : ''),
    ];
    if (state.strategyOn && state.lastCheckAt) {
        const t = new Date(state.lastCheckAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });
        lines.push(`💓 Last check ${t} — ${state.lastOutcome ?? 'evaluated'}`);
    }
    if (state.lastAgentNote) {
        lines.push(`📝 _${state.lastAgentNote}_`);
    }
    if (state.feeBps !== undefined && state.feeBps > 0) {
        const feePct = (state.feeBps / 100).toFixed(2);
        const paid = (state.feesPaidUsd ?? 0).toFixed(4);
        lines.push(`Service fee: ${feePct}% per mint  ·  Paid lifetime $${paid}`);
    }
    if (state.openPositionLines && state.openPositionLines.length) {
        lines.push('');
        lines.push('Open positions:');
        for (const p of state.openPositionLines) lines.push(`  ${p}`);
    }
    if (state.recentTradeLines && state.recentTradeLines.length) {
        lines.push('');
        lines.push('Recent activity:');
        for (const t of state.recentTradeLines) lines.push(`  ${t}`);
    }
    const actionRow: InlineKeyboardButton[] = state.managerId
        ? [
              Markup.button.callback(
                  state.strategyOn ? '⏸ Pause strategy' : '▶️ Start strategy',
                  'bot:togglestrategy'
              ),
          ]
        : [
              Markup.button.callback(
                  '⚡ Initialize manager',
                  'bot:initmanager'
              ),
          ];
    return {
        text: lines.join('\n'),
        reply_markup: {
            inline_keyboard: [
                actionRow,
                [
                    Markup.button.callback('📋 Show key', 'bot:export'),
                    Markup.button.callback('🔁 Rotate wallet', 'bot:rotate'),
                ],
                [Markup.button.callback('🔄 Refresh', 'menu:bot')],
                backButton('menu:main'),
            ],
        },
    };
}

export function settingsMenu(state: MenuState): {
    text: string;
    reply_markup: InlineKeyboardMarkup;
} {
    return {
        text:
            '*Settings*\n' +
            `Tracked address: \`${state.addr ?? 'not set'}\`\n` +
            `Alerts: ${state.muted ? '🔇 muted' : '🔔 on'}`,
        reply_markup: {
            inline_keyboard: [
                [
                    Markup.button.callback(
                        state.muted ? '🔔 Unmute alerts' : '🔇 Mute alerts',
                        'menu:togglemute'
                    ),
                ],
                [Markup.button.callback('🔁 Change address', 'menu:changeaddr')],
                [
                    Markup.button.callback(
                        '⏹ Delete subscription',
                        'menu:stop'
                    ),
                ],
                backButton('menu:main'),
            ],
        },
    };
}
