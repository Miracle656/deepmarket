// DeepBook Predict — Move-call tx builders.
//
// The deployed package's `predict::create_manager(ctx)` shares the manager
// internally and returns only its ID, so we cannot compose init+mint into one
// PTB. First-mint is therefore two signatures:
//   1. createManagerTx — pops up wallet, waits, caches the new manager id.
//   2. depositMintTx   — funds (if needed) and mints in one PTB.
// Repeat mints are always one signature.

import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { CONFIG } from './config';

const PKG = CONFIG.PREDICT_PACKAGE_ID;
const PREDICT = CONFIG.PREDICT_OBJECT_ID;
const DUSDC = CONFIG.PREDICT_DUSDC_TYPE;

/** Stand-alone tx that creates + shares a PredictManager owned by the sender. */
export function buildCreateManagerTx(): Transaction {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PKG}::predict::create_manager`,
        arguments: [],
    });
    return tx;
}

export interface DepositMintParams {
    managerId: string;
    oracleId: string;
    /** Oracle expiry in ms (passed straight into MarketKey). */
    expiry: number;
    /** Strike in 1e9-scaled u64 (matches min_strike / tick_size on the oracle). */
    strike: number;
    isUp: boolean;
    /** Position size in dUSDC base units (1_000_000 = 1 contract = $1 max payout). */
    quantity: bigint;
    /** Extra dUSDC to deposit before minting. Set to 0n to skip the deposit step. */
    depositAmount: bigint;
}

/**
 * Compose deposit (optional) + mint in one PTB. Caller must already own a
 * PredictManager and pass its id.
 */
export function buildDepositMintTx(p: DepositMintParams): Transaction {
    const tx = new Transaction();
    const manager = tx.object(p.managerId);

    if (p.depositAmount > 0n) {
        const coin = tx.add(coinWithBalance({ balance: p.depositAmount, type: DUSDC }));
        tx.moveCall({
            target: `${PKG}::predict_manager::deposit`,
            typeArguments: [DUSDC],
            arguments: [manager, coin],
        });
    }

    const key = tx.moveCall({
        target: `${PKG}::market_key::new`,
        arguments: [
            tx.pure.id(p.oracleId),
            tx.pure.u64(p.expiry),
            tx.pure.u64(p.strike),
            tx.pure.bool(p.isUp),
        ],
    });

    tx.moveCall({
        target: `${PKG}::predict::mint`,
        typeArguments: [DUSDC],
        arguments: [
            tx.object(PREDICT),
            manager,
            tx.object(p.oracleId),
            key,
            tx.pure.u64(p.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });

    return tx;
}

/** Standalone PTB to deposit dUSDC into an existing manager. */
export function buildDepositTx(managerId: string, amount: bigint): Transaction {
    const tx = new Transaction();
    const coin = tx.add(coinWithBalance({ balance: amount, type: DUSDC }));
    tx.moveCall({
        target: `${PKG}::predict_manager::deposit`,
        typeArguments: [DUSDC],
        arguments: [tx.object(managerId), coin],
    });
    return tx;
}

export interface RedeemParams {
    managerId: string;
    oracleId: string;
    expiry: number;
    strike: number;
    isUp: boolean;
    /** Quantity to redeem in dUSDC base units (max = position.open_quantity). */
    quantity: bigint;
}

/**
 * Redeem a binary position. Payout flows back into the PredictManager's
 * dUSDC balance. Use this for live (pre-expiry) sells; settled positions
 * also work but cannot use the permissionless path here.
 */
export function buildRedeemTx(p: RedeemParams): Transaction {
    const tx = new Transaction();
    const key = tx.moveCall({
        target: `${PKG}::market_key::new`,
        arguments: [
            tx.pure.id(p.oracleId),
            tx.pure.u64(p.expiry),
            tx.pure.u64(p.strike),
            tx.pure.bool(p.isUp),
        ],
    });
    tx.moveCall({
        target: `${PKG}::predict::redeem`,
        typeArguments: [DUSDC],
        arguments: [
            tx.object(PREDICT),
            tx.object(p.managerId),
            tx.object(p.oracleId),
            key,
            tx.pure.u64(p.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });
    return tx;
}

/**
 * Withdraw dUSDC from the PredictManager back to the caller's wallet.
 * Returns a Coin<DUSDC> via the move call, transferred to the sender.
 */
export function buildWithdrawTx(
    managerId: string,
    amount: bigint,
    sender: string,
): Transaction {
    const tx = new Transaction();
    const coin = tx.moveCall({
        target: `${PKG}::predict_manager::withdraw`,
        typeArguments: [DUSDC],
        arguments: [tx.object(managerId), tx.pure.u64(amount)],
    });
    tx.transferObjects([coin], tx.pure.address(sender));
    return tx;
}

/**
 * Build a devInspect-only PTB for reading per-unit (cost, payout) on a market
 * key. Use this for price previews before the user commits to a tx.
 */
export function buildPreviewTx(args: {
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
            tx.pure.id(args.oracleId),
            tx.pure.u64(args.expiry),
            tx.pure.u64(args.strike),
            tx.pure.bool(args.isUp),
        ],
    });
    tx.moveCall({
        target: `${PKG}::predict::get_trade_amounts`,
        arguments: [
            tx.object(PREDICT),
            tx.object(args.oracleId),
            key,
            tx.pure.u64(args.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });
    return tx;
}

// ──────────────────────────────────────────────────────────────────────────
// Range positions — vertical bands priced as a single instrument.
// Pays $1·qty if settlement lands in the half-open band (lower, higher].
// ──────────────────────────────────────────────────────────────────────────

export interface RangeMintParams {
    managerId: string;
    oracleId: string;
    expiry: number;
    /** 1e9-scaled lower strike (must align to oracle tick grid). */
    lowerStrike: number;
    /** 1e9-scaled higher strike (must be > lowerStrike, aligned to grid). */
    higherStrike: number;
    quantity: bigint;
    depositAmount: bigint;
}

/** Compose deposit (optional) + mint_range in one PTB. */
export function buildDepositMintRangeTx(p: RangeMintParams): Transaction {
    const tx = new Transaction();
    const manager = tx.object(p.managerId);

    if (p.depositAmount > 0n) {
        const coin = tx.add(coinWithBalance({ balance: p.depositAmount, type: DUSDC }));
        tx.moveCall({
            target: `${PKG}::predict_manager::deposit`,
            typeArguments: [DUSDC],
            arguments: [manager, coin],
        });
    }

    const key = tx.moveCall({
        target: `${PKG}::range_key::new`,
        arguments: [
            tx.pure.id(p.oracleId),
            tx.pure.u64(p.expiry),
            tx.pure.u64(p.lowerStrike),
            tx.pure.u64(p.higherStrike),
        ],
    });

    tx.moveCall({
        target: `${PKG}::predict::mint_range`,
        typeArguments: [DUSDC],
        arguments: [
            tx.object(PREDICT),
            manager,
            tx.object(p.oracleId),
            key,
            tx.pure.u64(p.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });

    return tx;
}

/** devInspect-only PTB for range cost/payout preview. */
export function buildRangePreviewTx(args: {
    oracleId: string;
    expiry: number;
    lowerStrike: number;
    higherStrike: number;
    quantity: bigint;
}): Transaction {
    const tx = new Transaction();
    const key = tx.moveCall({
        target: `${PKG}::range_key::new`,
        arguments: [
            tx.pure.id(args.oracleId),
            tx.pure.u64(args.expiry),
            tx.pure.u64(args.lowerStrike),
            tx.pure.u64(args.higherStrike),
        ],
    });
    tx.moveCall({
        target: `${PKG}::predict::get_range_trade_amounts`,
        arguments: [
            tx.object(PREDICT),
            tx.object(args.oracleId),
            key,
            tx.pure.u64(args.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });
    return tx;
}
