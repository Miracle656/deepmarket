// Agent memory store — per-user record of past trades + agent notes.
//
// Why this exists: the LLM agent makes better decisions when it can see its
// own track record on a given oracle ("last 5 mints on BTC-1h: 3 wins, won
// $1.10 net"). It also lets the agent persist freeform "lessons learned" —
// short notes the model writes to itself across ticks.
//
// Backend: JSON file on disk now. The MemoryBackend interface is the
// boundary — swapping the implementation to Walrus blob storage (one blob
// per chat, refreshed each tick) does not touch agent.ts or strategy.ts.

import { promises as fs } from 'fs';
import { CONFIG } from './config.js';

/** A finalized trade outcome the agent has observed. */
export interface MemoryTrade {
    ts: number;
    oracleId: string;
    /** "BTC-1h", "BTC-1d", etc — derived from oracle.expiry_label */
    oracleLabel: string;
    direction: 'UP' | 'DOWN';
    /** Strike in USD (already divided). */
    strikeUsd: number;
    /** Spot at mint time, USD. */
    entrySpotUsd: number;
    /** Cover (max payout) in USD. */
    coverUsd: number;
    /** Cost paid in USD when minting. */
    costUsd: number;
    /** Final payout in USD after settlement (0 if lost). undefined while pending. */
    payoutUsd?: number;
    /** undefined while pending, true/false after settlement. */
    won?: boolean;
    /** The agent's reason for taking this trade (from its decision). */
    rationale: string;
}

/** A freeform note the agent writes to itself across ticks. */
export interface MemoryNote {
    ts: number;
    /** Short tag for filtering — e.g. "btc-1h", "general", "risk". */
    topic: string;
    text: string;
}

export interface UserMemory {
    chatId: number;
    /** Most recent trades first. Cap at MEMORY_TRADE_LIMIT. */
    trades: MemoryTrade[];
    /** Most recent notes first. Cap at MEMORY_NOTE_LIMIT. */
    notes: MemoryNote[];
    /** Last time the memory was updated by any path. */
    updatedAt: number;
}

const MEMORY_TRADE_LIMIT = 50;
const MEMORY_NOTE_LIMIT = 24;

// ── Backend interface ────────────────────────────────────────────────────
// All persistence goes through this. The local-file impl below is the
// only consumer of fs; a future WalrusBackend can implement the same shape.

export interface MemoryBackend {
    load(): Promise<Record<number, UserMemory>>;
    save(all: Record<number, UserMemory>): Promise<void>;
}

class FileBackend implements MemoryBackend {
    constructor(private path: string) {}

    async load(): Promise<Record<number, UserMemory>> {
        try {
            const raw = await fs.readFile(this.path, 'utf8');
            const parsed = JSON.parse(raw) as { users?: Record<number, UserMemory> };
            return parsed.users ?? {};
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return {};
            throw e;
        }
    }

    async save(all: Record<number, UserMemory>): Promise<void> {
        await fs.writeFile(
            this.path,
            JSON.stringify({ users: all }, null, 2),
            'utf8'
        );
    }
}

// ── In-memory cache + dirty flag ─────────────────────────────────────────

let backend: MemoryBackend = new FileBackend(CONFIG.AGENT_MEMORY_PATH);
let cache: Record<number, UserMemory> = {};
let loaded = false;

/** Swap the backend (Walrus later). Resets the cache. */
export function setMemoryBackend(b: MemoryBackend): void {
    backend = b;
    loaded = false;
    cache = {};
}

async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    cache = await backend.load();
    loaded = true;
}

function blankMemory(chatId: number): UserMemory {
    return {
        chatId,
        trades: [],
        notes: [],
        updatedAt: Date.now(),
    };
}

// ── Public API ───────────────────────────────────────────────────────────

export async function getMemory(chatId: number): Promise<UserMemory> {
    await ensureLoaded();
    return cache[chatId] ?? blankMemory(chatId);
}

export async function appendTrade(
    chatId: number,
    trade: MemoryTrade
): Promise<void> {
    await ensureLoaded();
    const mem = cache[chatId] ?? blankMemory(chatId);
    mem.trades.unshift(trade);
    if (mem.trades.length > MEMORY_TRADE_LIMIT) {
        mem.trades.length = MEMORY_TRADE_LIMIT;
    }
    mem.updatedAt = Date.now();
    cache[chatId] = mem;
    await backend.save(cache);
}

/**
 * Mark a previously-pending trade as settled with its payout. Matched by
 * (oracleId, strike, direction, entry time within 6h) — the closest pending
 * mint wins. If nothing matches we silently no-op (the trade was minted
 * before memory existed, or by the rule loop).
 */
export async function settleTrade(
    chatId: number,
    match: { oracleId: string; strikeUsd: number; direction: 'UP' | 'DOWN' },
    payoutUsd: number,
    won: boolean
): Promise<void> {
    await ensureLoaded();
    const mem = cache[chatId];
    if (!mem) return;
    const sixHrAgo = Date.now() - 6 * 60 * 60 * 1000;
    const candidate = mem.trades.find(
        (t) =>
            t.oracleId === match.oracleId &&
            t.direction === match.direction &&
            Math.abs(t.strikeUsd - match.strikeUsd) < 1 &&
            t.payoutUsd === undefined &&
            t.ts >= sixHrAgo
    );
    if (!candidate) return;
    candidate.payoutUsd = payoutUsd;
    candidate.won = won;
    mem.updatedAt = Date.now();
    await backend.save(cache);
}

export async function appendNote(
    chatId: number,
    note: MemoryNote
): Promise<void> {
    await ensureLoaded();
    const mem = cache[chatId] ?? blankMemory(chatId);
    mem.notes.unshift(note);
    if (mem.notes.length > MEMORY_NOTE_LIMIT) {
        mem.notes.length = MEMORY_NOTE_LIMIT;
    }
    mem.updatedAt = Date.now();
    cache[chatId] = mem;
    await backend.save(cache);
}

/** Aggregate stats helper — used inside the agent prompt. */
export function summarizeMemory(mem: UserMemory): {
    totalTrades: number;
    settled: number;
    wins: number;
    losses: number;
    netPnlUsd: number;
    byOracle: Record<string, { trades: number; wins: number; netPnlUsd: number }>;
} {
    let wins = 0;
    let losses = 0;
    let net = 0;
    let settled = 0;
    const byOracle: Record<string, { trades: number; wins: number; netPnlUsd: number }> = {};
    for (const t of mem.trades) {
        const bucket =
            byOracle[t.oracleLabel] ??
            (byOracle[t.oracleLabel] = { trades: 0, wins: 0, netPnlUsd: 0 });
        bucket.trades += 1;
        if (t.payoutUsd === undefined) continue;
        settled += 1;
        const pnl = t.payoutUsd - t.costUsd;
        net += pnl;
        bucket.netPnlUsd += pnl;
        if (t.won) {
            wins += 1;
            bucket.wins += 1;
        } else {
            losses += 1;
        }
    }
    return {
        totalTrades: mem.trades.length,
        settled,
        wins,
        losses,
        netPnlUsd: net,
        byOracle,
    };
}

/**
 * Count of losses in the most recent unbroken losing streak (newest trades
 * first; stops at the first win or pending). Drives the hard cooldown — a
 * long streak means the agent is mispriced on the current regime, so we
 * stop minting entirely for a few ticks rather than just shrinking size.
 */
export function consecutiveLosses(mem: UserMemory): number {
    let streak = 0;
    for (const t of mem.trades) {
        if (t.payoutUsd === undefined) continue; // skip still-pending
        if (t.won) break;
        streak += 1;
    }
    return streak;
}

/** USD of new exposure (cover) opened in the last hour, for rate-limiting. */
export function exposureLastHourUsd(mem: UserMemory): number {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    return mem.trades
        .filter((t) => t.ts >= hourAgo)
        .reduce((sum, t) => sum + t.coverUsd, 0);
}

/**
 * Rolling win-rate over the last N settled trades. Returns null when
 * we don't have enough data to draw a conclusion (avoid acting on a
 * single bad trade). This is the input to the "cooldown" circuit
 * breaker — when win-rate falls below a threshold, we shrink position
 * sizes (the opposite of Martingale-style loss-chasing).
 */
export function recentWinRate(
    mem: UserMemory,
    lastN = 10,
    minSample = 5
): { settled: number; wins: number; rate: number } | null {
    let settled = 0;
    let wins = 0;
    for (const t of mem.trades) {
        if (t.payoutUsd === undefined) continue;
        settled += 1;
        if (t.won) wins += 1;
        if (settled >= lastN) break;
    }
    if (settled < minSample) return null;
    return { settled, wins, rate: wins / settled };
}
