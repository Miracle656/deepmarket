// Claude-driven trading agent.
//
// Called once per user per strategy tick. Gathers oracle state, the user's
// open positions, and the agent's own memory (recent trades + freeform notes),
// then asks Claude to either mint a binary option or pass.
//
// Output is enforced via tool use — the model must call submit_decision()
// with a typed JSON payload, so we never have to parse free text.
//
// When ANTHROPIC_API_KEY is empty the agent is disabled and strategy.ts
// falls back to its rule-based pickStrike path.

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from './config.js';
import type {
    OracleState,
    OracleSummary,
    Position,
} from './predict.js';
import {
    spotToUsd,
    strikeToUsd,
    dusdcToUsd,
} from './predict.js';
import type { UserMemory } from './memory.js';
import { summarizeMemory, exposureLastHourUsd, recentWinRate } from './memory.js';
import { recallRelevant, isMemWalAvailable } from './memwal.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface AgentContext {
    chatId: number;
    oracle: OracleSummary;
    state: OracleState;
    /** Positions still open on this manager (so we don't double-up). */
    openPositions: Position[];
    /** The user's persisted memory (trades + notes). */
    memory: UserMemory;
    /** How much USD this user has already locked into mints in the last hour. */
    exposureLastHour: number;
}

export interface AgentMint {
    direction: 'UP' | 'DOWN';
    strikeUsd: number;
    coverUsd: number;
    rationale: string;
}

export type AgentDecision =
    | {
          action: 'mint';
          mints: AgentMint[];
          summaryRationale: string;
          noteForSelf?: string;
      }
    | {
          action: 'pass';
          summaryRationale: string;
          noteForSelf?: string;
      };

// ── Singleton client (lazy) ──────────────────────────────────────────────

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
    if (!CONFIG.ANTHROPIC_API_KEY || !CONFIG.AGENT_ENABLED) return null;
    if (!client) {
        client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
    }
    return client;
}

export function isAgentAvailable(): boolean {
    return getClient() !== null;
}

// ── Prompt building ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous trading agent for DeepBook Predict — \
hourly binary options on BTC settled on Sui. Each tick you receive the current \
oracle state, the user's open positions, and a memory of your past trades on \
this account. You either submit 1-3 MINTS (laddered across strikes/directions) \
or PASS for this tick.

Trade philosophy:
  - Bias toward PASSING when the picture is unclear. One good tick is worth ten mediocre ones.
  - When you do trade, consider opening MULTIPLE positions to diversify:
      * Hedge: one UP + one DOWN at different strikes (captures volatility in either direction)
      * Ladder: 2-3 same-direction mints at adjacent strikes (scales into conviction)
      * Spread: one near-spot ATM mint + one OTM mint (different risk/reward profiles)
    Submit up to 3 mints in a single decision — each one must have a distinct (strike, direction) tuple.
  - Prefer modest cover sizes — when minting 3, keep each one small (e.g. 0.3-0.5 USD) so total exposure stays sane.
  - Avoid opening a position at the same (strike, direction) as one already open.
  - The SUM of cover_usd across all your mints must stay within remaining_budget_usd.
  - Strikes must be on the grid: strike = min_strike + k * tick_size for some integer k >= 0. \
    Round to the nearest grid value when picking.
  - UP wins if final spot > strike. DOWN wins if final spot <= strike.
  - The closer strike is to spot, the more expensive but the higher the win odds.

You will respond by calling the submit_decision tool exactly once. Never reply with prose.`;

function buildUserPrompt(
    ctx: AgentContext,
    defaultCoverUsd: number,
    recalledMemories: string[] = []
): string {
    const { oracle, state, openPositions, memory } = ctx;
    const spotUsd = state.latest_price ? spotToUsd(state.latest_price.spot) : NaN;
    const minStrikeUsd = strikeToUsd(oracle.min_strike);
    const tickUsd = strikeToUsd(oracle.tick_size);
    const expiryIn = oracle.expiry - Date.now();
    const minutesToExpiry = (expiryIn / 60_000).toFixed(1);

    const stats = summarizeMemory(memory);
    const oracleLabel = describeOracle(oracle);

    const lines: string[] = [];
    lines.push(`# Current oracle`);
    lines.push(`id: ${oracle.oracle_id.slice(0, 14)}…`);
    lines.push(`label: ${oracleLabel}`);
    lines.push(`status: ${oracle.status}`);
    lines.push(`spot_usd: ${isFinite(spotUsd) ? spotUsd.toFixed(2) : 'unknown'}`);
    lines.push(`min_strike_usd: ${minStrikeUsd.toFixed(2)}`);
    lines.push(`tick_size_usd: ${tickUsd.toFixed(2)}`);
    lines.push(`minutes_to_expiry: ${minutesToExpiry}`);
    lines.push('');

    lines.push(`# Risk budget`);
    lines.push(`default_cover_usd: ${defaultCoverUsd.toFixed(2)}`);
    lines.push(`exposure_last_hour_usd: ${ctx.exposureLastHour.toFixed(2)}`);
    lines.push(`exposure_cap_usd_per_hour: ${CONFIG.AGENT_MAX_USD_PER_HOUR.toFixed(2)}`);
    lines.push(
        `remaining_budget_usd: ${Math.max(0, CONFIG.AGENT_MAX_USD_PER_HOUR - ctx.exposureLastHour).toFixed(2)}`
    );
    const wr = recentWinRate(memory);
    if (wr) {
        lines.push(
            `recent_win_rate: ${wr.wins}/${wr.settled} = ${(wr.rate * 100).toFixed(0)}%`
        );
        if (wr.rate < 0.4) {
            lines.push(
                `cooldown_active: TRUE — win-rate is below 40%. Cut cover sizes in HALF this tick ` +
                    `(cap each mint at $${Math.max(0.15, defaultCoverUsd * 0.5).toFixed(2)}). ` +
                    `Be MORE selective; consider passing.`
            );
        } else if (wr.rate >= 0.7) {
            lines.push(
                `streak_warm: TRUE — win-rate is above 70%. Default sizing is fine. ` +
                    `Do not chase the streak with oversized bets.`
            );
        }
    }
    lines.push('');

    lines.push(`# Open positions (do not double up at same strike + direction)`);
    if (openPositions.length === 0) {
        lines.push('(none)');
    } else {
        for (const p of openPositions.slice(0, 10)) {
            lines.push(
                `- ${p.is_up ? 'UP' : 'DOWN'} @ $${strikeToUsd(p.strike).toFixed(2)}  ` +
                    `qty=${dusdcToUsd(p.open_quantity).toFixed(2)}  ` +
                    `oracle=${p.oracle_id.slice(0, 10)}…`
            );
        }
    }
    lines.push('');

    lines.push(`# Memory summary`);
    lines.push(`total_trades_logged: ${stats.totalTrades}`);
    lines.push(`settled: ${stats.settled}  wins: ${stats.wins}  losses: ${stats.losses}`);
    lines.push(`net_pnl_usd: ${stats.netPnlUsd.toFixed(2)}`);
    const byOracle = Object.entries(stats.byOracle);
    if (byOracle.length > 0) {
        lines.push(`by_oracle_label:`);
        for (const [label, agg] of byOracle.slice(0, 6)) {
            lines.push(
                `  - ${label}: ${agg.trades} trades, ${agg.wins} wins, ` +
                    `net $${agg.netPnlUsd.toFixed(2)}`
            );
        }
    }
    lines.push('');

    lines.push(`# Recent trades (most recent first, max 8)`);
    if (memory.trades.length === 0) {
        lines.push('(no logged trades yet)');
    } else {
        for (const t of memory.trades.slice(0, 8)) {
            const settled =
                t.payoutUsd === undefined
                    ? 'pending'
                    : t.won
                      ? `won $${(t.payoutUsd - t.costUsd).toFixed(2)}`
                      : `lost $${t.costUsd.toFixed(2)}`;
            lines.push(
                `- ${new Date(t.ts).toISOString().slice(11, 16)}Z  ` +
                    `${t.direction} @ $${t.strikeUsd.toFixed(2)}  ` +
                    `entry=$${t.entrySpotUsd.toFixed(2)}  ${settled}  — ${t.rationale}`
            );
        }
    }
    lines.push('');

    lines.push(`# Your recent notes (most recent first, max 6)`);
    if (memory.notes.length === 0) {
        lines.push('(none yet — feel free to leave one in note_for_self)');
    } else {
        for (const n of memory.notes.slice(0, 6)) {
            lines.push(
                `- [${n.topic}] ${new Date(n.ts).toISOString().slice(0, 10)} — ${n.text}`
            );
        }
    }
    lines.push('');

    if (recalledMemories.length > 0) {
        lines.push(`# Semantic recall (from MemWal — past trades similar to NOW)`);
        for (const m of recalledMemories) {
            lines.push(`- ${m}`);
        }
        lines.push('');
    }

    lines.push(
        `Decide whether to mint a new binary position on this oracle, or pass. ` +
            `Call submit_decision once. If you mint, pick a strike on the grid that ` +
            `aligns with your conviction — closer-to-spot = higher win odds + higher cost.`
    );

    return lines.join('\n');
}

function describeOracle(o: OracleSummary): string {
    // The predict server doesn't ship an "interval" string; we derive one
    // from the expiry distance to give the model a human label.
    const remainingMin = (o.expiry - Date.now()) / 60_000;
    if (remainingMin <= 75) return `${o.underlying_asset}-1h`;
    if (remainingMin <= 60 * 5) return `${o.underlying_asset}-4h`;
    if (remainingMin <= 60 * 24 + 60) return `${o.underlying_asset}-1d`;
    return `${o.underlying_asset}-long`;
}

// ── Tool schema (forces structured output) ───────────────────────────────

const DECISION_TOOL = {
    name: 'submit_decision',
    description:
        'Submit your trading decision for this tick. Call this exactly once.',
    input_schema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['mint', 'pass'],
                description: '"mint" opens 1-3 new positions. "pass" skips this tick.',
            },
            mints: {
                type: 'array',
                maxItems: 3,
                minItems: 1,
                description:
                    'Required when action=mint. 1 to 3 distinct mints. Each must have a unique (strike, direction) combination, ' +
                    'and the SUM of cover_usd must stay within remaining_budget_usd.',
                items: {
                    type: 'object',
                    properties: {
                        direction: {
                            type: 'string',
                            enum: ['UP', 'DOWN'],
                            description: 'UP wins if final spot > strike. DOWN wins if final spot <= strike.',
                        },
                        strike_usd: {
                            type: 'number',
                            description: 'Strike price in USD; must align to the oracle grid.',
                        },
                        cover_usd: {
                            type: 'number',
                            description: 'Max payout in USD for this mint.',
                        },
                        rationale: {
                            type: 'string',
                            description:
                                'One short sentence for this specific mint — what role it plays in the ladder/hedge.',
                        },
                    },
                    required: ['direction', 'strike_usd', 'cover_usd', 'rationale'],
                },
            },
            summary_rationale: {
                type: 'string',
                description:
                    'One short sentence summarizing the overall thesis for this tick. Shown to the user via Telegram.',
            },
            note_for_self: {
                type: 'string',
                description:
                    'Optional. A short lesson or observation to persist into your memory for next time.',
            },
        },
        required: ['action', 'summary_rationale'],
    },
};

// ── Public entrypoint ────────────────────────────────────────────────────

/**
 * Ask Claude for a decision. Returns null when the agent is disabled or
 * the call/parse fails — strategy.ts treats null as "pass" without DM'ing
 * the user (so a transient API hiccup doesn't spam them).
 */
export async function decide(
    ctx: AgentContext,
    defaultCoverUsd: number
): Promise<AgentDecision | null> {
    const c = getClient();
    if (!c) return null;

    // Pull semantic memory if MemWal is wired up. Recall is best-effort —
    // a failure here returns [] so the prompt just has no extra context.
    let recalled: string[] = [];
    if (isMemWalAvailable()) {
        recalled = await recallRelevant(ctx.chatId, ctx.oracle, ctx.state);
        if (recalled.length > 0) {
            console.log(
                `[agent] recalled ${recalled.length} memories from MemWal for chat ${ctx.chatId}`
            );
        }
    }

    const userPrompt = buildUserPrompt(ctx, defaultCoverUsd, recalled);

    let response: Anthropic.Messages.Message;
    try {
        response = await c.messages.create({
            model: CONFIG.AGENT_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            tools: [DECISION_TOOL],
            tool_choice: { type: 'tool', name: 'submit_decision' },
            messages: [{ role: 'user', content: userPrompt }],
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[agent] Anthropic call failed:', msg);
        return null;
    }

    const block = response.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock =>
            b.type === 'tool_use' && b.name === 'submit_decision'
    );
    if (!block) {
        console.warn('[agent] no submit_decision tool call in response');
        return null;
    }

    const input = block.input as {
        action?: string;
        mints?: Array<{
            direction?: string;
            strike_usd?: number;
            cover_usd?: number;
            rationale?: string;
        }>;
        summary_rationale?: string;
        note_for_self?: string;
    };

    if (!input.summary_rationale || typeof input.summary_rationale !== 'string') {
        console.warn('[agent] missing summary_rationale in decision');
        return null;
    }

    if (input.action === 'pass') {
        return {
            action: 'pass',
            summaryRationale: input.summary_rationale,
            ...(input.note_for_self ? { noteForSelf: input.note_for_self } : {}),
        };
    }

    if (input.action !== 'mint') {
        console.warn('[agent] invalid action:', input.action);
        return null;
    }

    if (!Array.isArray(input.mints) || input.mints.length === 0) {
        console.warn('[agent] action=mint but no mints array');
        return null;
    }

    const mints: AgentMint[] = [];
    for (const m of input.mints.slice(0, 3)) {
        if (m.direction !== 'UP' && m.direction !== 'DOWN') {
            console.warn('[agent] dropping mint — invalid direction:', m.direction);
            continue;
        }
        if (typeof m.strike_usd !== 'number' || !isFinite(m.strike_usd)) {
            console.warn('[agent] dropping mint — invalid strike_usd:', m.strike_usd);
            continue;
        }
        if (
            typeof m.cover_usd !== 'number' ||
            !isFinite(m.cover_usd) ||
            m.cover_usd <= 0
        ) {
            console.warn('[agent] dropping mint — invalid cover_usd:', m.cover_usd);
            continue;
        }
        if (!m.rationale || typeof m.rationale !== 'string') {
            console.warn('[agent] dropping mint — missing rationale');
            continue;
        }
        mints.push({
            direction: m.direction,
            strikeUsd: m.strike_usd,
            coverUsd: m.cover_usd,
            rationale: m.rationale,
        });
    }
    if (mints.length === 0) {
        console.warn('[agent] all mints invalid after validation');
        return null;
    }

    return {
        action: 'mint',
        mints,
        summaryRationale: input.summary_rationale,
        ...(input.note_for_self ? { noteForSelf: input.note_for_self } : {}),
    };
}

/**
 * Snap a USD strike to the on-chain grid (min_strike + k * tick_size).
 * Returns the strike in raw on-chain units (bigint), or null if it would
 * fall below min_strike.
 */
export function snapStrikeUsdToRaw(
    oracle: OracleSummary,
    strikeUsd: number
): bigint | null {
    const RAW = 1_000_000_000;
    const target = BigInt(Math.round(strikeUsd * RAW));
    const minStrike = BigInt(oracle.min_strike);
    const tick = BigInt(oracle.tick_size);
    if (target < minStrike) return null;
    const k = (target - minStrike + tick / 2n) / tick;
    return minStrike + k * tick;
}
