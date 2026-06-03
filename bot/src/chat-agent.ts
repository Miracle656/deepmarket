// Conversational (NL) assistant for the Telegram bot.
//
// Free-text messages → Claude with a small read-only toolbox (positions,
// oracles, account). Claude picks a tool, we run it, feed the result back, and
// Claude composes the reply. Read-only by design: trading goes through the
// trade panel (tap an oracle) or the autonomous loop — the chat never spends.

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from './config.js';
import {
    getManagerPositions,
    getManagerSummary,
    listActiveOracles,
    strikeToUsd,
    spotToUsd,
    getOracleState,
    type Position,
} from './predict.js';
import { getSubscription } from './store.js';
import { getUserBalances } from './user-wallet.js';

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
    if (!CONFIG.ANTHROPIC_API_KEY) return null;
    if (!client) client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
    return client;
}
export function isChatAvailable(): boolean {
    return getClient() !== null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const dusdc = (raw: number) => raw / 10 ** CONFIG.DUSDC_DECIMALS;
// The server marks live positions 'active' (also 'open'/'awaiting_settlement');
// settled ones are won/lost/redeemable/redeemed. Classify by the SETTLED set so
// any non-settled status with open quantity counts as open.
const SETTLED_STATUSES = new Set(['won', 'lost', 'redeemable', 'redeemed', 'settled']);
const isOpen = (p: Position) =>
    p.open_quantity > 0 && !SETTLED_STATUSES.has(p.status);

function fmtExpiry(ms: number): string {
    const d = ms - Date.now();
    if (d < 0) return 'expired';
    if (d < 3_600_000) return `in ${Math.round(d / 60_000)}m`;
    return `in ${Math.round(d / 3_600_000)}h`;
}

function posLine(p: Position): string {
    const dir = p.is_up ? 'UP' : 'DOWN';
    const pnl = dusdc(p.unrealized_pnl || p.realized_pnl || 0);
    return (
        `${dir} @ $${strikeToUsd(p.strike).toFixed(0)} · cover ${usd(dusdc(p.open_quantity))} · ` +
        `mark ${usd(dusdc(p.mark_value))} · pnl ${pnl >= 0 ? '+' : ''}${usd(pnl)} · ${p.status}`
    );
}

// ── Tools ────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Messages.Tool[] = [
    {
        name: 'get_positions',
        description:
            "The user's DeepBook Predict positions, split into open and closed/settled.",
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'account_summary',
        description:
            'Wallet balances (SUI gas + dUSDC), manager trading balance, account value and realized/unrealized PnL.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'list_oracles',
        description: 'Active Predict oracles available to trade right now.',
        input_schema: { type: 'object', properties: {} },
    },
];

async function runTool(chatId: number, name: string): Promise<string> {
    const sub = await getSubscription(chatId);
    const managerId = sub?.botManagerId ?? null;

    if (name === 'get_positions') {
        if (!managerId) return 'No PredictManager yet. Set one up via 🤖 Bot trader.';
        const positions = await getManagerPositions(managerId).catch(() => [] as Position[]);
        const open = positions.filter(isOpen);
        const closed = positions.filter((p) => !isOpen(p));
        return JSON.stringify({
            open_count: open.length,
            open: open.map(posLine),
            closed_count: closed.length,
            closed: closed.slice(0, 15).map(posLine),
        });
    }

    if (name === 'account_summary') {
        const bal = await getUserBalances(chatId).catch(() => ({ sui: 0, dusdc: 0 }));
        const summary = managerId
            ? await getManagerSummary(managerId).catch(() => null)
            : null;
        return JSON.stringify({
            wallet: { sui: bal.sui, dusdc: bal.dusdc },
            manager: summary
                ? {
                      trading_balance: dusdc(summary.trading_balance),
                      account_value: dusdc(summary.account_value),
                      realized_pnl: dusdc(summary.realized_pnl),
                      unrealized_pnl: dusdc(summary.unrealized_pnl),
                      open_positions: summary.open_positions,
                  }
                : 'no manager yet',
        });
    }

    if (name === 'list_oracles') {
        const oracles = (await listActiveOracles().catch(() => [])).slice(0, 8);
        const rows = await Promise.all(
            oracles.map(async (o) => {
                let spot = '';
                try {
                    const s = await getOracleState(o.oracle_id);
                    if (s.latest_price) spot = `$${spotToUsd(s.latest_price.spot).toFixed(0)}`;
                } catch {
                    /* no spot */
                }
                return `${o.underlying_asset} ${spot} · expires ${fmtExpiry(o.expiry)}`;
            })
        );
        return JSON.stringify({ count: rows.length, oracles: rows, note: 'To trade, open the Predict oracle list and tap an oracle.' });
    }

    return `Unknown tool: ${name}`;
}

const SYSTEM = `You are the DeepMarket assistant inside a Telegram bot. DeepMarket \
is a prediction-market app on Sui; users trade binary/range options on rolling \
BTC oracles (DeepBook Predict). Answer the user's question concisely (Telegram \
message, no markdown headers). Use the tools to fetch live data — never invent \
numbers. You are READ-ONLY: to place a trade, tell the user to open the Predict \
oracle list and tap an oracle (the trade panel). Keep replies short and useful.`;

/** Handle one free-text message. Returns the reply text (or null if the chat
 *  agent is disabled — caller should fall through). */
export async function handleChat(chatId: number, text: string): Promise<string | null> {
    const c = getClient();
    if (!c) return null;

    const messages: Anthropic.Messages.MessageParam[] = [
        { role: 'user', content: text },
    ];

    try {
        let resp = await c.messages.create({
            model: CONFIG.AGENT_MODEL,
            max_tokens: 700,
            system: SYSTEM,
            tools: TOOLS,
            messages,
        });

        // Agent loop — resolve tool calls until Claude produces a final answer.
        let guard = 0;
        while (resp.stop_reason === 'tool_use' && guard++ < 4) {
            const toolUses = resp.content.filter(
                (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
            );
            messages.push({ role: 'assistant', content: resp.content });
            const results: Anthropic.Messages.ToolResultBlockParam[] = [];
            for (const tu of toolUses) {
                const out = await runTool(chatId, tu.name).catch(
                    (e) => `tool error: ${e instanceof Error ? e.message : String(e)}`
                );
                results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
            }
            messages.push({ role: 'user', content: results });
            resp = await c.messages.create({
                model: CONFIG.AGENT_MODEL,
                max_tokens: 700,
                system: SYSTEM,
                tools: TOOLS,
                messages,
            });
        }

        const reply = resp.content
            .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
        return reply || "I couldn't work that out — try 'show my positions' or 'list oracles'.";
    } catch (e) {
        console.warn('[chat] failed:', e);
        return '⚠️ Chat is temporarily unavailable. Try the menu buttons, or ask again shortly.';
    }
}
