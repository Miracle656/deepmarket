// MemWal (Walrus-backed semantic memory) wrapper.
//
// What this gives us that local JSON can't:
//   - Vector recall: at decision time we ask `recall("BTC-1h ~$95k UP")`
//     and get the top-K most semantically relevant past trades, not just
//     the most recent N. The agent sees relevant history regardless of age.
//   - Encrypted, decentralized storage via Walrus + Seal — surviving
//     bot restarts / migrations / multi-host setups for free.
//
// Why it sits *alongside* memory.ts instead of replacing it:
//   - Local JSON still holds the structured aggregate (wins/losses, P&L by
//     oracle, hourly exposure cap). Those calculations need structured fields,
//     not text blobs.
//   - MemWal stores the *narrative* — one sentence per trade outcome — that
//     the LLM reads as additional context.
//
// Either path can be disabled independently via env.

import { MemWal } from '@mysten-incubation/memwal';
import { CONFIG } from './config.js';
import type { OracleSummary, OracleState } from './predict.js';

// ── Singleton client (lazy) ──────────────────────────────────────────────

let client: MemWal | null = null;
let clientInitFailed = false;

function getClient(): MemWal | null {
    if (clientInitFailed) return null;
    if (client) return client;
    if (!CONFIG.MEMWAL_ACCOUNT_ID || !CONFIG.MEMWAL_DELEGATE_KEY) return null;
    try {
        client = MemWal.create({
            key: CONFIG.MEMWAL_DELEGATE_KEY,
            accountId: CONFIG.MEMWAL_ACCOUNT_ID,
            serverUrl: CONFIG.MEMWAL_SERVER_URL,
            namespace: CONFIG.MEMWAL_NAMESPACE,
        });
        return client;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[memwal] init failed:', msg);
        clientInitFailed = true;
        return null;
    }
}

export function isMemWalAvailable(): boolean {
    return getClient() !== null;
}

// ── Health check (called once at startup) ────────────────────────────────

export async function pingMemWal(): Promise<boolean> {
    const c = getClient();
    if (!c) return false;
    try {
        const h = await c.health();
        console.log(`[memwal] connected: ${h.status} v${h.version}`);
        return true;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[memwal] health check failed:', msg);
        return false;
    }
}

// ── Memory shape we write to MemWal ──────────────────────────────────────

export interface TradeMemoryInput {
    chatId: number;
    ts: number;
    oracleLabel: string;
    direction: 'UP' | 'DOWN';
    strikeUsd: number;
    entrySpotUsd: number;
    coverUsd: number;
    costUsd: number;
    payoutUsd: number;
    won: boolean;
    rationale: string;
}

/**
 * Encode a finalized trade as a single natural-language memory string.
 * Designed for vector recall: every salient field appears, in plain
 * English, so an embedding can match on situational similarity.
 */
function tradeToMemory(t: TradeMemoryInput): string {
    const date = new Date(t.ts).toISOString().slice(0, 16).replace('T', ' ');
    const pnl = t.payoutUsd - t.costUsd;
    const pnlStr =
        pnl >= 0 ? `won $${pnl.toFixed(2)}` : `lost $${Math.abs(pnl).toFixed(2)}`;
    const moneyness =
        t.direction === 'UP'
            ? t.entrySpotUsd >= t.strikeUsd
                ? 'in the money'
                : 'out of the money'
            : t.entrySpotUsd <= t.strikeUsd
              ? 'in the money'
              : 'out of the money';
    return (
        `[${date}] chat ${t.chatId}: minted ${t.direction} @ $${t.strikeUsd.toFixed(0)} ` +
        `on ${t.oracleLabel}. ` +
        `Entry spot $${t.entrySpotUsd.toFixed(0)} (${moneyness}). ` +
        `Cover $${t.coverUsd.toFixed(2)}, cost $${t.costUsd.toFixed(2)}. ` +
        `Outcome: ${t.won ? 'WON' : 'LOST'} — ${pnlStr}. ` +
        `Rationale at entry: ${t.rationale}`
    );
}

/**
 * Write a single trade outcome to MemWal. Fire-and-forget — we don't await
 * the indexer job, so the strategy tick stays fast. Failures are logged
 * but don't propagate.
 */
export async function rememberTrade(input: TradeMemoryInput): Promise<void> {
    const c = getClient();
    if (!c) return;
    const text = tradeToMemory(input);
    try {
        const job = await c.remember(text);
        console.log(
            `[memwal] remember accepted job=${job.job_id.slice(0, 10)}… status=${job.status}`
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[memwal] remember failed:', msg);
    }
}

/**
 * Recall the top-K memories most relevant to the current decision context.
 * Returns an array of plain-text memories, ready to drop into the prompt.
 * Empty array on any failure (so the agent prompt just has no extra context).
 */
export async function recallRelevant(
    chatId: number,
    oracle: OracleSummary,
    state: OracleState,
    limit = CONFIG.MEMWAL_RECALL_LIMIT
): Promise<string[]> {
    const c = getClient();
    if (!c) return [];
    const spotUsd = state.latest_price ? state.latest_price.spot / 1e9 : 0;
    const oracleLabel = oracle.underlying_asset;
    // The query describes the situation we're about to decide on. The
    // embedding will match on "BTC binary option near $94k 1h to expiry"
    // type semantics — pulling forward past trades on similar setups.
    const expiryMin = Math.round((oracle.expiry - Date.now()) / 60_000);
    const query =
        `chat ${chatId} ${oracleLabel} binary option near $${spotUsd.toFixed(0)}, ` +
        `${expiryMin} minutes to expiry, recent decisions and outcomes`;
    try {
        const res = await c.recall(query, limit);
        return res.results.map((r) => r.text).filter(Boolean);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[memwal] recall failed:', msg);
        return [];
    }
}
