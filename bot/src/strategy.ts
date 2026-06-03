// Strategy engine — runs every STRATEGY_TICK_MS.
//
// For each user with strategyEnabled=true:
//   1) Redeem any settled positions first (frees up dUSDC + records the
//      outcome in agent memory).
//   2) Pick the closest active oracle.
//   3) Ask the LLM agent for a decision; if the agent is disabled or the
//      call fails, fall back to the rule-based "mint UP just below spot" path.
//   4) Mint the chosen position (or pass) and DM the user with the rationale.

import type { Telegraf } from 'telegraf';
import { CONFIG } from './config.js';
import {
    decide,
    isAgentAvailable,
    snapStrikeUsdToRaw,
    EDGE_THRESHOLD,
    type AgentContext,
} from './agent.js';
import { quoteLadder, type StrikeQuote } from './quote.js';
import {
    appendNote,
    appendTrade,
    consecutiveLosses,
    exposureLastHourUsd,
    getMemory,
    recentWinRate,
    settleTrade,
    spentTodayUsd,
} from './memory.js';
import { rememberTrade, isMemWalAvailable } from './memwal.js';
import {
    dusdcToUsd,
    formatExpiry,
    getManagerPositions,
    getOracleState,
    listActiveOracles,
    computeOracleFlow,
    spotToUsd,
    strikeToUsd,
    type OracleState,
    type OracleSummary,
    type Position,
} from './predict.js';
import { listAll, patchSubscription, type Subscription } from './store.js';
import { mintBinary, redeemBinary } from './trader.js';
import { getUserBalances } from './user-wallet.js';
import {
    findAgentCapForBot,
    getAgentCapState,
    isCapUsable,
    recordDecision,
    type AgentCapInfo,
} from './agent-cap.js';

const DUSDC_SCALE = 1_000_000;
const COVER_USD_MIN = 0.1;
/**
 * Hard cooldown: after this many losses in a row the agent is clearly
 * mispriced on the current regime. Stop minting entirely (still redeem)
 * until a settled win breaks the streak. This is stronger than the
 * size-halving cooldown and is what was missing during the 10-loss run.
 */
const LOSS_PAUSE_THRESHOLD = 4;

/** chatId → last time we DM'd "daily cap reached" (throttle to ~6h). */
const dailyCapNotified = new Map<number, number>();

function maxCoverUsd(): number {
    return Math.max(CONFIG.STRATEGY_QTY_USD * 3, 1.5);
}

// DEMO mode — runtime-toggleable from the Bot trader menu. Defaults to the
// DEMO_MODE env flag. When on, the agent bypasses the edge bar and force-mints
// a small -EV position so the flow is demoable while the vault prices ~100%.
let demoMode = CONFIG.DEMO_MODE;
export function isDemoMode(): boolean {
    return demoMode;
}
export function setDemoMode(on: boolean): void {
    demoMode = on;
    console.log(`[strategy] DEMO_MODE ${on ? 'ON' : 'off'} (runtime)`);
}

/** How many eligible oracles to probe per tick looking for an edgy table. */
const MAX_ORACLE_SCAN = 5;

interface PickedOracle {
    oracle: OracleSummary;
    state: OracleState;
    quotes: StrikeQuote[];
    /** True when some strike is priced ≤ 1 − EDGE_THRESHOLD (edge achievable). */
    achievable: boolean;
}

/**
 * Pick an oracle worth evaluating. Scans up to MAX_ORACLE_SCAN eligible
 * oracles (soonest-expiry first), quoting each ladder, and returns the FIRST
 * whose table has an achievable edge (cheapest implied ≤ 1 − EDGE_THRESHOLD).
 * Most testnet oracles are priced at cost/payout ≈ 1 (implied ~100% both
 * sides) where no edge can ever exist — this stops the agent from fixating on
 * the soonest oracle and lets it find a tradeable one. Falls back to the
 * soonest (with its quotes, achievable=false) so the tick can still heartbeat.
 */
async function pickTradeableOracle(
    senderAddr: string | undefined
): Promise<PickedOracle | null> {
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
        .sort((a, b) => a.expiry - b.expiry)
        .slice(0, MAX_ORACLE_SCAN);
    if (eligible.length === 0) return null;

    let fallback: PickedOracle | null = null;
    for (const oracle of eligible) {
        let state: OracleState;
        try {
            state = await getOracleState(oracle.oracle_id);
        } catch {
            continue;
        }
        const spotRaw = state.latest_price?.spot ?? 0;
        let quotes: StrikeQuote[] = [];
        if (senderAddr && spotRaw > 0) {
            try {
                quotes = await quoteLadder(senderAddr, oracle, spotRaw);
            } catch {
                /* devInspect hiccup — treat as no quotes for this candidate */
            }
        }
        const minImplied =
            quotes.length > 0
                ? Math.min(...quotes.map((q) => q.impliedProb))
                : Infinity;
        // DEMO mode trades any oracle that has quotable strikes at all.
        const achievable = demoMode
            ? quotes.length > 0
            : minImplied <= 1 - EDGE_THRESHOLD;
        if (achievable) {
            console.log(
                `[strategy] picked tradeable oracle ${oracle.oracle_id.slice(0, 10)} ` +
                    `(min implied ${(minImplied * 100).toFixed(0)}% ≤ ${((1 - EDGE_THRESHOLD) * 100).toFixed(0)}%)`
            );
            return { oracle, state, quotes, achievable: true };
        }
        if (!fallback) fallback = { oracle, state, quotes, achievable: false };
    }
    // Nothing tradeable in the scan window — return the soonest for heartbeating.
    return fallback;
}

/** Record a one-line heartbeat so the Bot trader menu can show that the
 *  strategy is alive and what it last decided — even when it passes silently. */
async function recordHeartbeat(chatId: number, outcome: string): Promise<void> {
    await patchSubscription(chatId, {
        lastCheckAt: Date.now(),
        lastOutcome: outcome,
    }).catch(() => {});
}

interface MintAttempt {
    direction: 'UP' | 'DOWN';
    strike: bigint;
    coverUsd: number;
    rationale: string;
}

interface BatchPlan {
    mints: MintAttempt[];
    summaryRationale: string;
    noteForSelf?: string;
}

/**
 * Ask the agent for a 1-3 mint plan, validate + snap each one, drop
 * duplicates against open positions, and clamp the total cover to the
 * remaining hourly budget. Returns null to indicate "pass". Falls back
 * to a single-mint rule plan when the agent is unavailable.
 */
async function chooseMintBatch(
    chatId: number,
    managerId: string,
    oracle: OracleSummary,
    state: OracleState,
    quotes: StrikeQuote[]
): Promise<BatchPlan | null> {
    // No quotable strike → the vault is pricing nothing this tick. There is
    // literally no in-band trade to make; minting anything would abort.
    if (quotes.length === 0) {
        console.log(
            `[strategy] no quotable strikes for oracle ${oracle.oracle_id.slice(0, 10)} — skipping chat ${chatId}`
        );
        return null;
    }

    // DEMO ONLY — bypass the agent + edge bar to force one small visible mint.
    // Picks the most balanced quotable strike (implied closest to 50%) so it
    // looks like a real coin-flip bet, and labels it clearly as -EV demo.
    if (demoMode) {
        const pick = [...quotes].sort(
            (a, b) => Math.abs(a.impliedProb - 0.5) - Math.abs(b.impliedProb - 0.5)
        )[0]!;
        const cover = Math.max(COVER_USD_MIN, Math.min(CONFIG.STRATEGY_QTY_USD, 0.5));
        console.log(
            `[strategy] DEMO_MODE — forcing ${pick.direction} @ $${pick.strikeUsd.toFixed(0)} (implied ${(pick.impliedProb * 100).toFixed(0)}%) for chat ${chatId}`
        );
        return {
            mints: [
                {
                    direction: pick.direction,
                    strike: pick.strikeRaw,
                    coverUsd: cover,
                    rationale: `⚠️ DEMO MODE — forced mint to show the flow (NOT +EV)`,
                },
            ],
            summaryRationale:
                '⚠️ DEMO MODE: edge bar bypassed to demonstrate live execution. Set DEMO_MODE=false for real trading.',
        };
    }
    // Quotable-strike index — the deterministic backstop. Even if the model
    // hallucinates a strike, anything not in here is dropped BEFORE it hits
    // the chain, so EAskPriceOutOfBounds can no longer happen.
    const quotableKeys = new Set(
        quotes.map((q) => `${q.strikeRaw.toString()}:${q.direction}`)
    );

    let openPositions: Position[] = [];
    try {
        openPositions = (await getManagerPositions(managerId)).filter(
            (p) => p.open_quantity > 0
        );
    } catch {
        /* ignore — agent can still decide */
    }

    if (isAgentAvailable()) {
        const memory = await getMemory(chatId);

        // Hard cooldown — a long losing streak means the agent is
        // systematically mispriced on the current regime. Stop minting
        // entirely until a win breaks the streak; redeeming still runs.
        const streak = consecutiveLosses(memory);
        if (streak >= LOSS_PAUSE_THRESHOLD) {
            console.log(
                `[strategy] hard cooldown for chat ${chatId}: ${streak} losses in a row — skipping mint`
            );
            await appendNote(chatId, {
                ts: Date.now(),
                topic: 'risk',
                text: `Hard cooldown: ${streak} consecutive losses. Minting paused until a settled win breaks the streak. Re-examine whether the edge thesis actually held.`,
            });
            return null;
        }

        // Real order flow for this oracle (trade tape) — confirmation signal
        // for the agent. Returns an empty snapshot if there are no trades.
        const flow = await computeOracleFlow(oracle.oracle_id);

        const ctx: AgentContext = {
            chatId,
            oracle,
            state,
            openPositions,
            memory,
            exposureLastHour: exposureLastHourUsd(memory),
            quotes,
            flow,
        };
        const wr = recentWinRate(memory);
        const cooldownActive = wr !== null && wr.rate < 0.4;
        const decision = await decide(ctx, CONFIG.STRATEGY_QTY_USD);
        if (!decision) {
            console.warn(
                `[strategy] agent returned null for chat ${chatId}, falling back to rule`
            );
            // fall through to rule path
        } else if (decision.action === 'pass') {
            if (decision.noteForSelf) {
                await appendNote(chatId, {
                    ts: Date.now(),
                    topic: 'pass',
                    text: decision.noteForSelf,
                });
            }
            console.log(
                `[strategy] agent passed for chat ${chatId}: ${decision.summaryRationale}`
            );
            return null;
        } else {
            // mint — validate + snap each entry, dedupe, clamp budget
            let remainingBudget = Math.max(
                0,
                CONFIG.AGENT_MAX_USD_PER_HOUR - ctx.exposureLastHour
            );
            const seen = new Set<string>(); // "<strikeRaw>:<UP|DOWN>"
            const planned: MintAttempt[] = [];

            for (const rawM of decision.mints) {
                // Server-side circuit breaker: if recent win-rate is bad,
                // halve cover sizes server-side even if the agent didn't.
                // This is the opposite of Martingale — lose more → bet less.
                const m = cooldownActive
                    ? { ...rawM, coverUsd: rawM.coverUsd * 0.5 }
                    : rawM;
                if (remainingBudget < COVER_USD_MIN) break;
                const snapped = snapStrikeUsdToRaw(oracle, m.strikeUsd);
                if (snapped === null) {
                    console.warn(
                        `[strategy] dropping mint — strike $${m.strikeUsd} below min`
                    );
                    continue;
                }
                const key = `${snapped.toString()}:${m.direction}`;
                if (!quotableKeys.has(key)) {
                    console.warn(
                        `[strategy] dropping mint — ${m.direction} $${m.strikeUsd} is not a devInspect-quotable strike (would abort on-chain)`
                    );
                    continue;
                }
                if (seen.has(key)) {
                    console.warn(
                        `[strategy] dropping duplicate mint within batch ${key}`
                    );
                    continue;
                }
                const dupOpen = openPositions.find(
                    (p) =>
                        p.oracle_id === oracle.oracle_id &&
                        BigInt(p.strike) === snapped &&
                        p.is_up === (m.direction === 'UP')
                );
                if (dupOpen) {
                    console.warn(
                        `[strategy] dropping mint — position already open at ${key}`
                    );
                    continue;
                }
                const cover = clamp(
                    m.coverUsd,
                    COVER_USD_MIN,
                    Math.min(maxCoverUsd(), remainingBudget)
                );
                if (cover < COVER_USD_MIN) continue;
                planned.push({
                    direction: m.direction,
                    strike: snapped,
                    coverUsd: cover,
                    rationale: m.rationale,
                });
                seen.add(key);
                remainingBudget -= cover;
            }

            if (planned.length === 0) {
                console.log(
                    `[strategy] all batch mints filtered out for chat ${chatId}`
                );
                return null;
            }
            const summary =
                cooldownActive && wr
                    ? `${decision.summaryRationale} [cooldown: ${wr.wins}/${wr.settled}=${(wr.rate * 100).toFixed(0)}% — sizes halved]`
                    : decision.summaryRationale;
            return {
                mints: planned,
                summaryRationale: summary,
                ...(decision.noteForSelf
                    ? { noteForSelf: decision.noteForSelf }
                    : {}),
            };
        }
    }

    // No LLM agent configured → DO NOT TRADE.
    //
    // The old rule fallback minted "UP near spot" every tick. With real
    // quotes we can now see why that bleeds: the nearest-spot strike prices
    // at ~100% implied (cost ≈ payout) — you pay ~$1 to win ~$0. A rule
    // with no probability model has no edge on ANY strike, so the only
    // correct move is to pass. Trading resumes automatically once
    // ANTHROPIC_API_KEY is set and isAgentAvailable() is true.
    console.warn(
        `[strategy] no LLM agent configured (ANTHROPIC_API_KEY missing) — ` +
            `passing for chat ${chatId}. Set the key on the bot service to enable trading.`
    );
    return null;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * Resolve the user's on-chain AgentCap. Uses the cached `sub.agentCapId`
 * when present, otherwise auto-discovers it from AgentCapCreated events
 * keyed by the bot wallet address and caches the result. Returns null
 * when the user hasn't authorized an agent (cap is opt-in — absence does
 * not block trading, since funding the custodial wallet already implies
 * authorization in the current model).
 */
async function resolveCap(sub: Subscription): Promise<AgentCapInfo | null> {
    const wallet = sub.botWalletAddr?.toLowerCase();
    if (sub.agentCapId) {
        const state = await getAgentCapState(sub.agentCapId);
        // Only trust the cached cap if it still belongs to the CURRENT bot
        // wallet. After a wallet rotation the cached cap is for the old agent,
        // and record_decision would abort on the Move `cap.agent == sender`
        // assert — so fall through and re-discover the right cap.
        if (state && (!wallet || state.agent.toLowerCase() === wallet)) {
            if (state.revoked !== sub.agentCapRevoked) {
                await patchSubscription(sub.chatId, {
                    agentCapRevoked: state.revoked,
                });
            }
            return state;
        }
        // stale (wrong agent / gone) — re-discover below.
    }
    if (!wallet) return null;
    const discovered = await findAgentCapForBot(wallet);
    if (discovered) {
        await patchSubscription(sub.chatId, {
            agentCapId: discovered.capId,
            agentCapRevoked: discovered.revoked,
        });
    }
    return discovered;
}

async function tryMintForUser(
    bot: Telegraf,
    sub: Subscription,
    oracle: OracleSummary,
    state: OracleState,
    quotes: StrikeQuote[]
): Promise<void> {
    const chatId = sub.chatId;
    const managerId = sub.botManagerId;
    if (!managerId) return;

    // AgentCap gate — if the user authorized an agent cap and then revoked
    // (or it expired), stop minting for them. Redeeming is still allowed
    // elsewhere so revocation never traps funds.
    const cap = await resolveCap(sub);
    if (cap && !isCapUsable(cap)) {
        if (!sub.agentCapRevoked) {
            await patchSubscription(chatId, { agentCapRevoked: true });
            await bot.telegram
                .sendMessage(
                    chatId,
                    `🛑 *Agent paused* — your on-chain AgentCap is ` +
                        `${cap.revoked ? 'revoked' : 'expired'}. ` +
                        `New mints are stopped; existing positions still auto-redeem. ` +
                        `Re-authorize in the app to resume.`,
                    { parse_mode: 'Markdown' }
                )
                .catch(() => {});
        }
        await recordHeartbeat(chatId, 'paused · AgentCap revoked/expired');
        return;
    }

    const plan = await chooseMintBatch(chatId, managerId, oracle, state, quotes);
    if (!plan) {
        await recordHeartbeat(chatId, 'passed · no +EV trade this tick');
        return;
    }

    // ── HARD daily spend cap ───────────────────────────────────────────
    // Enforced on EVERY mint path here (single choke point). The on-chain
    // AgentCap's dailySpendCapUsd wins when set (> 0); otherwise the config
    // fallback applies. UTC-day window — does NOT roll like the hourly cap.
    const memForCap = await getMemory(chatId);
    const dailyCapUsd =
        cap && cap.dailySpendCapUsd > 0
            ? cap.dailySpendCapUsd
            : CONFIG.AGENT_MAX_USD_PER_DAY;
    let dailyRemaining = Math.max(0, dailyCapUsd - spentTodayUsd(memForCap));
    if (dailyRemaining < COVER_USD_MIN) {
        const last = dailyCapNotified.get(chatId) ?? 0;
        if (Date.now() - last > 6 * 60 * 60 * 1000) {
            dailyCapNotified.set(chatId, Date.now());
            await bot.telegram
                .sendMessage(
                    chatId,
                    `🛑 *Daily spend cap reached* — $${dailyCapUsd.toFixed(2)}/day. ` +
                        `No more mints until 00:00 UTC; open positions still auto-redeem.`,
                    { parse_mode: 'Markdown' }
                )
                .catch(() => {});
        }
        console.log(
            `[strategy] daily cap reached for chat ${chatId} ($${dailyCapUsd.toFixed(2)}) — skipping mint`
        );
        await recordHeartbeat(chatId, `paused · daily cap $${dailyCapUsd.toFixed(2)} reached`);
        return;
    }

    const balances = await getUserBalances(chatId).catch(() => ({
        sui: 0,
        dusdc: 0,
    }));
    const walletDusdcBase = BigInt(Math.floor(balances.dusdc * DUSDC_SCALE));
    const spotUsd = state.latest_price ? spotToUsd(state.latest_price.spot) : 0;
    const oracleLabel = `${oracle.underlying_asset}-${approxBucket(oracle.expiry - Date.now())}`;

    interface SettledMint {
        attempt: MintAttempt;
        digest: string;
    }
    interface FailedMint {
        attempt: MintAttempt;
        reason: string;
    }
    const settled: SettledMint[] = [];
    const failed: FailedMint[] = [];
    // Track on-chain decision-log outcome so the DM can report it.
    let decisionsLogged = 0;
    let decisionLogFailed = false;

    // Walk the planned mints sequentially — each mint debits the wallet
    // dUSDC, so we deduct as we go to stop minting when the wallet runs dry.
    let walletRemaining = walletDusdcBase;

    for (const attempt of plan.mints) {
        if (dailyRemaining < COVER_USD_MIN) {
            failed.push({ attempt, reason: 'daily cap reached' });
            continue;
        }
        // Clamp this mint to whatever daily budget is left, so a 3-mint
        // batch can't collectively blow past the cap.
        attempt.coverUsd = Math.min(attempt.coverUsd, dailyRemaining);
        const quantity = BigInt(Math.floor(attempt.coverUsd * DUSDC_SCALE));
        if (walletRemaining < quantity) {
            failed.push({ attempt, reason: 'insufficient dUSDC' });
            continue;
        }
        try {
            const { digest } = await mintBinary(chatId, {
                oracleId: oracle.oracle_id,
                expiry: oracle.expiry,
                strike: Number(attempt.strike),
                isUp: attempt.direction === 'UP',
                quantity,
                depositAmount: quantity,
            });
            walletRemaining -= quantity;
            dailyRemaining -= attempt.coverUsd;
            settled.push({ attempt, digest });

            await appendTrade(chatId, {
                ts: Date.now(),
                oracleId: oracle.oracle_id,
                oracleLabel,
                direction: attempt.direction,
                strikeUsd: strikeToUsd(Number(attempt.strike)),
                entrySpotUsd: spotUsd,
                coverUsd: attempt.coverUsd,
                costUsd: attempt.coverUsd, // refined on settlement
                rationale: attempt.rationale,
            });

            // On-chain audit log — emit an AgentDecisionMade event via the
            // user's AgentCap. Best-effort: a failed record never undoes the
            // mint that already happened. The Move side aborts if the cap was
            // revoked mid-tick, so the log stays binding.
            if (cap) {
                const rec = await recordDecision(chatId, {
                    capId: cap.capId,
                    oracleId: oracle.oracle_id,
                    isMint: true,
                    directionUp: attempt.direction === 'UP',
                    strike: Number(attempt.strike),
                    coverUsd: Math.floor(attempt.coverUsd * DUSDC_SCALE),
                    rationale: attempt.rationale,
                });
                if (rec) decisionsLogged++;
                else decisionLogFailed = true;
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            failed.push({ attempt, reason: msg.slice(0, 80) });
            console.warn(`[strategy] mint failed for chat ${chatId}:`, msg);
        }
    }

    if (plan.noteForSelf) {
        await appendNote(chatId, {
            ts: Date.now(),
            topic: oracleLabel,
            text: plan.noteForSelf,
        });
    }

    // Heartbeat the mint outcome.
    if (settled.length > 0) {
        const totalCover = settled.reduce(
            (s, m) => s + m.attempt.coverUsd,
            0
        );
        await recordHeartbeat(
            chatId,
            `minted ${settled.length} on ${oracleLabel} · $${totalCover.toFixed(2)} cover`
        );
    } else if (failed.length > 0) {
        await recordHeartbeat(chatId, `mint failed (${failed.length} leg(s))`);
    }

    if (settled.length === 0 && failed.length === 0) return;

    // Build a single summary DM. Header changes based on agent vs rule and
    // batch size; each mint gets its own line with strike/direction/cover/why.
    const isAgent = isAgentAvailable();
    const headerWord = isAgent ? 'Agent' : 'Auto';
    const header =
        settled.length > 1
            ? `🧠 *${headerWord} batch — ${settled.length} mints*`
            : `🧠 *${headerWord} mint*`;
    const lines: string[] = [header];
    for (const s of settled) {
        const arr = s.attempt.direction === 'UP' ? '↑' : '↓';
        const sk = strikeToUsd(Number(s.attempt.strike));
        lines.push(
            `${arr} ${s.attempt.direction} @ $${sk.toFixed(0)}  ` +
                `cover $${s.attempt.coverUsd.toFixed(2)}  ·  _${mdSafe(s.attempt.rationale)}_`
        );
    }
    if (failed.length > 0) {
        lines.push('');
        for (const f of failed) {
            const arr = f.attempt.direction === 'UP' ? '↑' : '↓';
            const sk = strikeToUsd(Number(f.attempt.strike));
            lines.push(
                `⚠️ skipped ${arr} ${f.attempt.direction} @ $${sk.toFixed(0)} — ${mdSafe(f.reason)}`
            );
        }
    }
    lines.push('');
    lines.push(
        `Spot: $${spotUsd.toFixed(2)}  ·  Expires ${formatExpiry(oracle.expiry)}`
    );
    lines.push(`_${mdSafe(plan.summaryRationale)}_`);
    // On-chain decision-log status — so it's obvious whether the AgentCap audit
    // recorded this mint (the /agents feed), instead of having to check chain.
    if (!cap) {
        lines.push('⚠️ No AgentCap — decision NOT logged on-chain. Authorize at /agent.');
    } else if (decisionsLogged > 0) {
        lines.push(`✓ ${decisionsLogged} decision(s) logged on-chain (AgentCap)`);
    } else if (decisionLogFailed) {
        lines.push('⚠️ On-chain log failed — cap mismatch/revoked or gas. See logs.');
    }
    if (settled[0]) {
        lines.push(`\`${settled[0].digest.slice(0, 14)}…\``);
    }

    const body = lines.join('\n');
    try {
        await bot.telegram.sendMessage(chatId, body, { parse_mode: 'Markdown' });
    } catch (e) {
        // Markdown parse error (stray entity) or transient — retry as plain
        // text so a mint notification ALWAYS lands. Better unstyled than silent.
        console.warn('[strategy] mint DM Markdown failed, retrying plain:', e);
        await bot.telegram
            .sendMessage(chatId, body.replace(/[*_`]/g, ''))
            .catch(() => {
                /* user blocked the bot — ignore */
            });
    }
}

/** Neutralize legacy-Markdown control chars in free text (agent rationales)
 *  so one stray _ or * can't make Telegram reject the whole message. */
function mdSafe(s: string): string {
    return s.replace(/[_*`[\]]/g, ' ').trim();
}

/** Rough bucket label for an oracle's remaining lifetime. */
function approxBucket(remainingMs: number): string {
    const m = remainingMs / 60_000;
    if (m <= 75) return '1h';
    if (m <= 60 * 5) return '4h';
    if (m <= 60 * 24 + 60) return '1d';
    return 'long';
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

            // Record outcome in agent memory so future decisions see the result.
            await settleTrade(
                chatId,
                {
                    oracleId: p.oracle_id,
                    strikeUsd,
                    direction: p.is_up ? 'UP' : 'DOWN',
                },
                payoutUsd,
                isWin
            );

            // Mirror the finalized trade to MemWal as a natural-language memory
            // so the agent can semantically recall it later. We look up the
            // matching memory record to grab the original rationale + entry spot.
            if (isMemWalAvailable()) {
                const mem = await getMemory(chatId).catch(() => null);
                const matched = mem?.trades.find(
                    (t) =>
                        t.oracleId === p.oracle_id &&
                        t.direction === (p.is_up ? 'UP' : 'DOWN') &&
                        Math.abs(t.strikeUsd - strikeUsd) < 1
                );
                if (matched) {
                    void rememberTrade({
                        chatId,
                        ts: matched.ts,
                        oracleLabel: matched.oracleLabel,
                        direction: matched.direction,
                        strikeUsd: matched.strikeUsd,
                        entrySpotUsd: matched.entrySpotUsd,
                        coverUsd: matched.coverUsd,
                        costUsd: costUsd,
                        payoutUsd,
                        won: isWin,
                        rationale: matched.rationale,
                    });
                }
            }

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
            if (!/already.?redeemed|EInsufficientPosition/i.test(msg)) {
                console.warn(
                    `[strategy] redeem failed for chat ${chatId}:`,
                    msg
                );
            }
        }
    }
}

/**
 * Run ONE strategy tick: redeem settled positions, then evaluate + maybe mint
 * for every strategy-enabled user. Safe to call from both the in-process
 * setInterval AND an external scheduler (e.g. a cron ping hitting /tick) — the
 * latter is how the loop stays alive on hosts that sleep idle instances
 * (Render free tier), where setInterval can't be relied on.
 */
export async function runStrategyTick(bot: Telegraf): Promise<void> {
    const subs = listAll().filter(
        (s) => s.strategyEnabled && !!s.botManagerId && !!s.botWalletKey
    );
    if (subs.length === 0) return;

        // 1) Redeem settled positions first — frees up dUSDC for the next mint.
        for (const sub of subs) {
            if (!sub.botManagerId) continue;
            await redeemSettledForUser(bot, sub.chatId, sub.botManagerId);
        }

        // 2) Then try to mint. Scan up to MAX_ORACLE_SCAN eligible oracles for
        // one with an achievable-edge table (devInspect needs any valid sender
        // — reuse a subscriber's bot wallet; reads touch no sender objects).
        // The chosen oracle's ladder is quoted once and shared across users.
        const senderAddr = subs.find((s) => s.botWalletAddr)?.botWalletAddr;
        const picked = await pickTradeableOracle(senderAddr);
        if (!picked) {
            console.log('[strategy] no eligible oracle right now');
            return;
        }
        const { oracle, state, quotes, achievable } = picked;
        console.log(
            `[strategy] oracle ${oracle.oracle_id.slice(0, 10)} — ${quotes.length} quotable strikes` +
                (achievable ? '' : ' (no achievable edge in scan window)')
        );

        // No oracle in the scan window has an achievable edge — a mint needs
        // p − implied ≥ EDGE_THRESHOLD with p ≤ 1, impossible when every table
        // is priced at cost/payout ≈ 1. Heartbeat + skip the LLM entirely
        // instead of burning a Claude call per user on a guaranteed pass.
        // (Settled-position redemptions above already ran, so funds still free up.)
        if (!achievable) {
            const lbl = `${oracle.underlying_asset}-${approxBucket(oracle.expiry - Date.now())}`;
            await Promise.all(
                subs.map((s) =>
                    recordHeartbeat(
                        s.chatId,
                        `passed · no edge on any of ${MAX_ORACLE_SCAN} oracles (tables ~100% implied)`
                    )
                )
            );
            console.log(
                `[strategy] no achievable edge across ${MAX_ORACLE_SCAN}-oracle scan (closest ${lbl}) — skipping LLM`
            );
            return;
        }

        for (const sub of subs) {
            if (!sub.botManagerId) continue;
            await tryMintForUser(bot, sub, oracle, state, quotes);
        }
}

/**
 * In-process strategy loop. Works on always-on hosts. On hosts that sleep idle
 * instances (Render free), pair an external cron hitting /tick with this — the
 * cron is the reliable clock; this setInterval is the best-effort backup.
 */
export function startStrategyLoop(bot: Telegraf): () => void {
    void runStrategyTick(bot);
    const id = setInterval(() => void runStrategyTick(bot), CONFIG.STRATEGY_TICK_MS);
    const mode = isAgentAvailable() ? 'LLM agent' : 'rule fallback';
    console.log(
        `[strategy] loop running every ${CONFIG.STRATEGY_TICK_MS}ms · ${mode}`
    );
    return () => clearInterval(id);
}
