// Bot trader — per-user. Signs txs on behalf of each Telegram user using
// THEIR custodial keypair stored in subs.json. No global bot state — every
// function takes a chatId and pulls keys/manager-id from the subscription.

import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import type { SuiObjectChange } from '@mysten/sui/jsonRpc';
import { CONFIG } from './config.js';
import { getSuiClient } from './sui.js';
import { findManagerByOwner } from './predict.js';
import {
    getSubscription,
    patchSubscription,
    type BotTrade,
} from './store.js';
import { getUserKeypair } from './user-wallet.js';

// ──────────────────────────────────────────────────────────────────────────
// Move-call builders — mirror src/lib/predict-tx.ts in the frontend.
// ──────────────────────────────────────────────────────────────────────────

const PKG = CONFIG.PREDICT_PACKAGE_ID;
const PREDICT_OBJECT = CONFIG.PREDICT_OBJECT_ID;
const DUSDC = CONFIG.PREDICT_DUSDC_TYPE;

function buildCreateManagerTx(): Transaction {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PKG}::predict::create_manager`,
        arguments: [],
    });
    return tx;
}

function buildRedeemTx(opts: {
    managerId: string;
    oracleId: string;
    expiry: number;
    strike: number;
    isUp: boolean;
    quantity: bigint;
}): Transaction {
    const tx = new Transaction();
    const key = tx.moveCall({
        target: `${PKG}::market_key::new`,
        arguments: [
            tx.pure.id(opts.oracleId),
            tx.pure.u64(opts.expiry),
            tx.pure.u64(opts.strike),
            tx.pure.bool(opts.isUp),
        ],
    });
    tx.moveCall({
        target: `${PKG}::predict::redeem`,
        typeArguments: [DUSDC],
        arguments: [
            tx.object(PREDICT_OBJECT),
            tx.object(opts.managerId),
            tx.object(opts.oracleId),
            key,
            tx.pure.u64(opts.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });
    return tx;
}

function buildDepositMintTx(opts: {
    managerId: string;
    oracleId: string;
    expiry: number;
    strike: number;
    isUp: boolean;
    quantity: bigint;
    depositAmount: bigint;
    /** Service fee in dUSDC base units, transferred to treasury. 0 to skip. */
    serviceFee: bigint;
}): Transaction {
    const tx = new Transaction();
    const manager = tx.object(opts.managerId);

    if (opts.depositAmount > 0n) {
        const coin = tx.add(
            coinWithBalance({ balance: opts.depositAmount, type: DUSDC })
        );
        tx.moveCall({
            target: `${PKG}::predict_manager::deposit`,
            typeArguments: [DUSDC],
            arguments: [manager, coin],
        });
    }

    const key = tx.moveCall({
        target: `${PKG}::market_key::new`,
        arguments: [
            tx.pure.id(opts.oracleId),
            tx.pure.u64(opts.expiry),
            tx.pure.u64(opts.strike),
            tx.pure.bool(opts.isUp),
        ],
    });

    tx.moveCall({
        target: `${PKG}::predict::mint`,
        typeArguments: [DUSDC],
        arguments: [
            tx.object(PREDICT_OBJECT),
            manager,
            tx.object(opts.oracleId),
            key,
            tx.pure.u64(opts.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });

    // Service fee — sourced from the same wallet that paid the mint deposit.
    // Bundled in the same PTB so either both the trade and the fee happen,
    // or neither does. Atomic by design.
    if (opts.serviceFee > 0n && CONFIG.BOT_TREASURY_ADDRESS) {
        const feeCoin = tx.add(
            coinWithBalance({ balance: opts.serviceFee, type: DUSDC })
        );
        tx.transferObjects(
            [feeCoin],
            tx.pure.address(CONFIG.BOT_TREASURY_ADDRESS)
        );
    }

    return tx;
}

function buildDepositMintRangeTx(opts: {
    managerId: string;
    oracleId: string;
    expiry: number;
    lowerStrike: number;
    higherStrike: number;
    quantity: bigint;
    depositAmount: bigint;
    serviceFee: bigint;
}): Transaction {
    const tx = new Transaction();
    const manager = tx.object(opts.managerId);

    if (opts.depositAmount > 0n) {
        const coin = tx.add(
            coinWithBalance({ balance: opts.depositAmount, type: DUSDC })
        );
        tx.moveCall({
            target: `${PKG}::predict_manager::deposit`,
            typeArguments: [DUSDC],
            arguments: [manager, coin],
        });
    }

    const key = tx.moveCall({
        target: `${PKG}::range_key::new`,
        arguments: [
            tx.pure.id(opts.oracleId),
            tx.pure.u64(opts.expiry),
            tx.pure.u64(opts.lowerStrike),
            tx.pure.u64(opts.higherStrike),
        ],
    });

    tx.moveCall({
        target: `${PKG}::predict::mint_range`,
        typeArguments: [DUSDC],
        arguments: [
            tx.object(PREDICT_OBJECT),
            manager,
            tx.object(opts.oracleId),
            key,
            tx.pure.u64(opts.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });

    if (opts.serviceFee > 0n && CONFIG.BOT_TREASURY_ADDRESS) {
        const feeCoin = tx.add(
            coinWithBalance({ balance: opts.serviceFee, type: DUSDC })
        );
        tx.transferObjects(
            [feeCoin],
            tx.pure.address(CONFIG.BOT_TREASURY_ADDRESS)
        );
    }

    return tx;
}

// ──────────────────────────────────────────────────────────────────────────
// State helpers (per-chatId)
// ──────────────────────────────────────────────────────────────────────────

async function appendTrade(chatId: number, t: BotTrade): Promise<void> {
    const sub = await getSubscription(chatId);
    if (!sub) return;
    const trades = sub.botTrades ?? [];
    trades.push(t);
    // Keep last 200 trades per user.
    if (trades.length > 200) trades.splice(0, trades.length - 200);
    await patchSubscription(chatId, { botTrades: trades });
}

export async function recentTrades(
    chatId: number,
    limit = 5
): Promise<BotTrade[]> {
    const sub = await getSubscription(chatId);
    if (!sub?.botTrades) return [];
    return sub.botTrades.slice(-limit).reverse();
}

// ──────────────────────────────────────────────────────────────────────────
// High-level ops (per user)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create + share the user's PredictManager. Idempotent — returns the cached
 * id if one already exists for this chat.
 */
export async function getOrCreateUserManager(chatId: number): Promise<string> {
    const sub = await getSubscription(chatId);
    if (!sub) throw new Error('No subscription for this chat');
    if (sub.botManagerId) return sub.botManagerId;
    const kp = await getUserKeypair(chatId);
    if (!kp) throw new Error('No custodial wallet for this chat');

    // Before minting a new manager, check whether this wallet already owns
    // one from a prior session (e.g. a recovered/imported wallet that had
    // a manager before the bot's local state was rebuilt). Predict allows
    // multiple managers per address, but if we skipped this check we'd
    // create a duplicate empty manager and silently leave the user's
    // existing funds/positions stranded.
    const owner = kp.getPublicKey().toSuiAddress();
    try {
        const existing = await findManagerByOwner(owner);
        if (existing) {
            await patchSubscription(chatId, { botManagerId: existing });
            await appendTrade(chatId, {
                ts: Date.now(),
                type: 'init-manager',
                digest: 'discovered-existing',
            });
            return existing;
        }
    } catch {
        // Predict server transient — fall through and create a fresh one.
    }

    const sui = getSuiClient();
    const tx = buildCreateManagerTx();

    const res = await sui.signAndExecuteTransaction({
        signer: kp,
        transaction: tx,
        options: { showObjectChanges: true, showEffects: true },
    });
    if (res.effects?.status.status !== 'success') {
        throw new Error(
            `create_manager tx failed: ${res.effects?.status.error ?? 'unknown'}`
        );
    }
    const managerType = `${PKG}::predict_manager::PredictManager`;
    const created = res.objectChanges?.find(
        (c: SuiObjectChange) =>
            c.type === 'created' && c.objectType === managerType
    );
    if (!created || created.type !== 'created') {
        throw new Error('PredictManager not found in tx effects');
    }
    const newId = created.objectId;
    await patchSubscription(chatId, { botManagerId: newId });
    await appendTrade(chatId, {
        ts: Date.now(),
        type: 'init-manager',
        digest: res.digest,
    });
    return newId;
}

/**
 * Mint a binary position for the user. Auto-deposits dUSDC from the user's
 * custodial wallet if the manager balance is below the position cost. Also
 * sends a small service fee to the treasury (atomically bundled into the
 * same PTB so the trade and the fee succeed/fail together).
 */
export async function mintBinary(
    chatId: number,
    opts: {
        oracleId: string;
        expiry: number;
        strike: number;
        isUp: boolean;
        quantity: bigint;
        depositAmount: bigint;
    }
): Promise<{ digest: string; serviceFee: bigint }> {
    const managerId = await getOrCreateUserManager(chatId);
    const kp = await getUserKeypair(chatId);
    if (!kp) throw new Error('No custodial wallet for this chat');
    const sui = getSuiClient();

    // Service fee — bps of cover (quantity). E.g., 100 bps on $0.50 = $0.005.
    const serviceFee =
        CONFIG.BOT_TREASURY_ADDRESS && CONFIG.BOT_FEE_BPS > 0
            ? (opts.quantity * BigInt(CONFIG.BOT_FEE_BPS)) / 10000n
            : 0n;

    const tx = buildDepositMintTx({ ...opts, managerId, serviceFee });
    const res = await sui.signAndExecuteTransaction({
        signer: kp,
        transaction: tx,
        options: { showEffects: true },
    });
    if (res.effects?.status.status !== 'success') {
        const err = res.effects?.status.error ?? 'unknown';
        await appendTrade(chatId, {
            ts: Date.now(),
            type: 'mint',
            oracleId: opts.oracleId,
            strike: opts.strike,
            isUp: opts.isUp,
            quantity: Number(opts.quantity),
            digest: res.digest,
            error: err,
        });
        throw new Error(`mint tx failed: ${err}`);
    }
    await appendTrade(chatId, {
        ts: Date.now(),
        type: 'mint',
        oracleId: opts.oracleId,
        strike: opts.strike,
        isUp: opts.isUp,
        quantity: Number(opts.quantity),
        digest: res.digest,
    });
    // Track lifetime fees per user for the bot menu display.
    if (serviceFee > 0n) {
        const sub = await getSubscription(chatId);
        const prev = BigInt(sub?.botFeesPaid ?? 0);
        await patchSubscription(chatId, {
            botFeesPaid: Number(prev + serviceFee),
        });
    }
    return { digest: res.digest, serviceFee };
}

/**
 * Mint a range position for the user (pays out if settlement lands in the
 * band). Mirror of {@link mintBinary} for the range_key / mint_range path.
 */
export async function mintRange(
    chatId: number,
    opts: {
        oracleId: string;
        expiry: number;
        lowerStrike: number;
        higherStrike: number;
        quantity: bigint;
        depositAmount: bigint;
    }
): Promise<{ digest: string; serviceFee: bigint }> {
    const managerId = await getOrCreateUserManager(chatId);
    const kp = await getUserKeypair(chatId);
    if (!kp) throw new Error('No custodial wallet for this chat');
    const sui = getSuiClient();

    const serviceFee =
        CONFIG.BOT_TREASURY_ADDRESS && CONFIG.BOT_FEE_BPS > 0
            ? (opts.quantity * BigInt(CONFIG.BOT_FEE_BPS)) / 10000n
            : 0n;

    const tx = buildDepositMintRangeTx({ ...opts, managerId, serviceFee });
    const res = await sui.signAndExecuteTransaction({
        signer: kp,
        transaction: tx,
        options: { showEffects: true },
    });
    if (res.effects?.status.status !== 'success') {
        const err = res.effects?.status.error ?? 'unknown';
        throw new Error(`range mint tx failed: ${err}`);
    }
    await appendTrade(chatId, {
        ts: Date.now(),
        type: 'mint',
        oracleId: opts.oracleId,
        strike: opts.lowerStrike,
        isUp: true,
        quantity: Number(opts.quantity),
        digest: res.digest,
    });
    if (serviceFee > 0n) {
        const sub = await getSubscription(chatId);
        const prev = BigInt(sub?.botFeesPaid ?? 0);
        await patchSubscription(chatId, {
            botFeesPaid: Number(prev + serviceFee),
        });
    }
    return { digest: res.digest, serviceFee };
}

/**
 * Redeem a position. Works for both live (sell early) and settled positions.
 * Payout (whatever the contract decides) flows back into the user's manager
 * as dUSDC. We don't pull from manager → wallet here; that's a separate step.
 */
export async function redeemBinary(
    chatId: number,
    opts: {
        oracleId: string;
        expiry: number;
        strike: number;
        isUp: boolean;
        quantity: bigint;
    }
): Promise<{ digest: string }> {
    const sub = await getSubscription(chatId);
    if (!sub?.botManagerId) throw new Error('No manager for chat');
    const kp = await getUserKeypair(chatId);
    if (!kp) throw new Error('No custodial wallet for chat');
    const sui = getSuiClient();

    const tx = buildRedeemTx({ ...opts, managerId: sub.botManagerId });
    const res = await sui.signAndExecuteTransaction({
        signer: kp,
        transaction: tx,
        options: { showEffects: true },
    });
    if (res.effects?.status.status !== 'success') {
        const err = res.effects?.status.error ?? 'unknown';
        await appendTrade(chatId, {
            ts: Date.now(),
            type: 'redeem',
            oracleId: opts.oracleId,
            strike: opts.strike,
            isUp: opts.isUp,
            quantity: Number(opts.quantity),
            digest: res.digest,
            error: err,
        });
        throw new Error(`redeem tx failed: ${err}`);
    }
    await appendTrade(chatId, {
        ts: Date.now(),
        type: 'redeem',
        oracleId: opts.oracleId,
        strike: opts.strike,
        isUp: opts.isUp,
        quantity: Number(opts.quantity),
        digest: res.digest,
    });
    return { digest: res.digest };
}
