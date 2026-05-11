// Subscription store — JSON file persisted between restarts.
//
// One record per Telegram chat: a chat watches a Sui address, plus per-product
// alert state so we don't fire duplicate alerts on every poll cycle.

import { promises as fs } from 'fs';
import { CONFIG } from './config.js';

export interface BotTrade {
    ts: number;
    type: 'init-manager' | 'mint' | 'redeem' | 'deposit' | 'withdraw';
    oracleId?: string;
    strike?: number;
    isUp?: boolean;
    quantity?: number;
    digest?: string;
    error?: string;
}

export interface Subscription {
    chatId: number;
    /** Sui address (lowercased) the user is tracking for alerts. */
    suiAddr: string;
    /** When the chat was first registered. */
    createdAt: number;
    /** If true, alerts are paused. */
    muted: boolean;
    /** Per-oracle: last-seen status so we only alert on status transitions. */
    seenOracleStatus: Record<string, string>;
    /** Per-oracle: last alerted "spot crossed strike S" boundary. */
    crossedStrikes: Record<string, number[]>;
    /** Per-Spot-market-id: last seen resolution status. */
    seenSpotStatus: Record<string, string>;
    /** Per-Spot-market-id: last alerted YES price (to throttle moves). */
    lastSpotYesPrice: Record<string, number>;

    // ── Bot trader (custodial) ────────────────────────────────────────
    /** bech32 `suiprivkey…` private key for the bot-managed wallet. */
    botWalletKey?: string;
    /** Derived Sui address from botWalletKey. */
    botWalletAddr?: string;
    /** PredictManager owned by the bot-managed wallet, once created. */
    botManagerId?: string | null;
    /** When true, the strategy engine trades on this user's wallet. */
    strategyEnabled?: boolean;
    /** Recent trade activity for the /strategy menu. */
    botTrades?: BotTrade[];
    /**
     * If true, the next plain-text message from this chat is interpreted
     * as a private key for import (instead of a Sui address).
     */
    pendingImport?: boolean;
}

interface Db {
    subs: Record<number, Subscription>;
}

let inMemory: Db = { subs: {} };

export async function loadStore(): Promise<void> {
    try {
        const raw = await fs.readFile(CONFIG.STORE_PATH, 'utf8');
        inMemory = JSON.parse(raw);
        if (!inMemory.subs) inMemory = { subs: {} };
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            inMemory = { subs: {} };
            await persist();
            return;
        }
        throw e;
    }
}

async function persist(): Promise<void> {
    await fs.writeFile(
        CONFIG.STORE_PATH,
        JSON.stringify(inMemory, null, 2),
        'utf8'
    );
}

export async function getSubscription(chatId: number): Promise<Subscription | null> {
    return inMemory.subs[chatId] ?? null;
}

export async function upsertSubscription(
    chatId: number,
    suiAddr: string
): Promise<Subscription> {
    const existing = inMemory.subs[chatId];
    const sub: Subscription = existing
        ? { ...existing, suiAddr: suiAddr.toLowerCase() }
        : {
              chatId,
              suiAddr: suiAddr.toLowerCase(),
              createdAt: Date.now(),
              muted: false,
              seenOracleStatus: {},
              crossedStrikes: {},
              seenSpotStatus: {},
              lastSpotYesPrice: {},
          };
    inMemory.subs[chatId] = sub;
    await persist();
    return sub;
}

export async function setMuted(chatId: number, muted: boolean): Promise<void> {
    const sub = inMemory.subs[chatId];
    if (!sub) return;
    sub.muted = muted;
    await persist();
}

export async function deleteSubscription(chatId: number): Promise<void> {
    delete inMemory.subs[chatId];
    await persist();
}

export async function patchSubscription(
    chatId: number,
    patch: Partial<Subscription>
): Promise<void> {
    const sub = inMemory.subs[chatId];
    if (!sub) return;
    Object.assign(sub, patch);
    await persist();
}

/** List all active (non-muted) subscriptions. */
export function listActive(): Subscription[] {
    return Object.values(inMemory.subs).filter((s) => !s.muted);
}

/** List all subscriptions including muted (for /status). */
export function listAll(): Subscription[] {
    return Object.values(inMemory.subs);
}
