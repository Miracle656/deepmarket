// Per-user custodial wallet — every Telegram chat that opts in gets its own
// Sui Ed25519 keypair, stored in subs.json. The bot signs txs on the user's
// behalf using their key. This is the Maestro/BONKbot model — custodial but
// the UX is unmatched (zero popups).
//
// Two onboarding paths:
//   - Generate fresh: bot creates a new keypair and shows the deposit address
//   - Import existing: user pastes a `suiprivkey…` bech32 string; bot validates
//
// Both end with the same shape: subscription.botWalletKey set, address derived
// and persisted as botWalletAddr.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/sui/utils';
import { CONFIG } from './config.js';
import { getSuiClient } from './sui.js';
import {
    getSubscription,
    patchSubscription,
    type Subscription,
} from './store.js';

export class WalletError extends Error {}

function tryParseSecret(input: string): Ed25519Keypair {
    const raw = input.trim();
    // bech32 path — straight to fromSecretKey
    if (raw.startsWith('suiprivkey')) {
        return Ed25519Keypair.fromSecretKey(raw);
    }
    // hex path — strip optional 0x prefix, decode, then construct
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
        throw new WalletError('Not a valid private key (expected suiprivkey… or hex).');
    }
    if (hex.length !== 64) {
        throw new WalletError(`Hex key must be 32 bytes (64 hex chars); got ${hex.length}.`);
    }
    return Ed25519Keypair.fromSecretKey(fromHex(hex));
}

/** Generate a fresh Ed25519 keypair and persist it for the chat. */
export async function generateUserWallet(
    chatId: number
): Promise<{ address: string; secret: string }> {
    const kp = new Ed25519Keypair();
    const secret = kp.getSecretKey();
    const address = kp.getPublicKey().toSuiAddress();
    await patchSubscription(chatId, {
        botWalletKey: secret,
        botWalletAddr: address,
        botManagerId: null,
        strategyEnabled: false,
        botTrades: [],
        pendingImport: false,
    });
    return { address, secret };
}

/** Import a user-supplied secret key. Validates before persisting. */
export async function importUserWallet(
    chatId: number,
    secretInput: string
): Promise<{ address: string }> {
    const kp = tryParseSecret(secretInput);
    const secret = kp.getSecretKey();
    const address = kp.getPublicKey().toSuiAddress();
    await patchSubscription(chatId, {
        botWalletKey: secret,
        botWalletAddr: address,
        botManagerId: null,
        strategyEnabled: false,
        botTrades: [],
        pendingImport: false,
    });
    return { address };
}

/** Wipe a user's stored wallet (used by rotate / fresh-start flows). */
export async function clearUserWallet(chatId: number): Promise<void> {
    await patchSubscription(chatId, {
        botWalletKey: undefined,
        botWalletAddr: undefined,
        botManagerId: null,
        strategyEnabled: false,
        botTrades: [],
        pendingImport: false,
    });
}

/** Load the keypair for a chat, or null if the chat has no bot wallet. */
export async function getUserKeypair(
    chatId: number
): Promise<Ed25519Keypair | null> {
    const sub = await getSubscription(chatId);
    if (!sub?.botWalletKey) return null;
    try {
        return Ed25519Keypair.fromSecretKey(sub.botWalletKey);
    } catch {
        return null;
    }
}

export async function getUserSubscription(
    chatId: number
): Promise<Subscription | null> {
    return getSubscription(chatId);
}

export interface UserBalances {
    sui: number;
    dusdc: number;
}

/** Fetch SUI + dUSDC balances for the chat's bot wallet. */
export async function getUserBalances(chatId: number): Promise<UserBalances> {
    const sub = await getSubscription(chatId);
    if (!sub?.botWalletAddr) return { sui: 0, dusdc: 0 };
    const c = getSuiClient();
    const [suiRaw, dusdcRaw] = await Promise.all([
        c.getBalance({ owner: sub.botWalletAddr, coinType: '0x2::sui::SUI' })
            .then((b) => BigInt(b.totalBalance))
            .catch(() => 0n),
        c.getBalance({
            owner: sub.botWalletAddr,
            coinType: CONFIG.PREDICT_DUSDC_TYPE,
        })
            .then((b) => BigInt(b.totalBalance))
            .catch(() => 0n),
    ]);
    return {
        sui: Number(suiRaw) / 1e9,
        dusdc: Number(dusdcRaw) / 10 ** CONFIG.DUSDC_DECIMALS,
    };
}

export async function setPendingImport(
    chatId: number,
    pending: boolean
): Promise<void> {
    await patchSubscription(chatId, { pendingImport: pending });
}

export async function isPendingImport(chatId: number): Promise<boolean> {
    const sub = await getSubscription(chatId);
    return !!sub?.pendingImport;
}
