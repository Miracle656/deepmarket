// Chat session keys — Ed25519 delegate per wallet.
//
// Trades one wallet popup per group (to grant the delegate Reader/Sender/etc.)
// for unlimited zero-popup messaging from that group forever.
//
// Lifecycle:
//   1. User opens a chat with no delegate provisioned yet
//   2. Click "Enable auto-sign" → generate Ed25519 keypair → sign + send a
//      groups.tx.grantPermissions tx that adds the delegate's Sui address as
//      a full-permission member of the group (1 wallet popup, ever)
//   3. Persist the delegate's secret key in localStorage
//   4. All future message sends are signed by the delegate keypair via the
//      messaging SDK's relayer auth flow — no wallet popups
//
// SECURITY: Testnet stakes are low; we store the delegate's secret key as
// plain hex in localStorage. For mainnet we'd encrypt with a wallet-signed
// derived key, or move to an on-chain SessionKey object with revocation.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex, toHex } from '@mysten/sui/utils';

const KEY_PREFIX = 'dm.chat-delegate.';
const GRANTS_PREFIX = 'dm.chat-delegate-grants.';

function lower(address: string): string {
    return address.toLowerCase();
}

/**
 * Restore an existing delegate keypair for `walletAddress`, or null if none
 * has been provisioned yet. Reads from localStorage. Tolerates both bech32
 * (`suiprivkey1…`, modern SDK default) and legacy hex-encoded keys.
 */
export function getDelegate(walletAddress: string): Ed25519Keypair | null {
    try {
        const raw = localStorage.getItem(KEY_PREFIX + lower(walletAddress));
        if (!raw) return null;
        // bech32 path — pass the string straight to fromSecretKey
        if (raw.startsWith('suiprivkey')) {
            return Ed25519Keypair.fromSecretKey(raw);
        }
        // hex path — decode and pass bytes
        return Ed25519Keypair.fromSecretKey(fromHex(raw));
    } catch (e) {
        console.warn('[chat-session] getDelegate failed to parse stored key:', e);
        return null;
    }
}

/**
 * Return the existing delegate, or generate + persist a new one. Idempotent.
 */
export function getOrCreateDelegate(walletAddress: string): Ed25519Keypair {
    const existing = getDelegate(walletAddress);
    if (existing) return existing;
    const fresh = new Ed25519Keypair();
    const secret = fresh.getSecretKey();
    // getSecretKey() in v2 returns a bech32 string; fall back to raw bytes via
    // export() if needed. Persist the form we know we can restore from.
    if (typeof secret === 'string') {
        try {
            localStorage.setItem(KEY_PREFIX + lower(walletAddress), secret);
        } catch {
            /* ignore */
        }
        return fresh;
    }
    try {
        localStorage.setItem(
            KEY_PREFIX + lower(walletAddress),
            toHex(secret as unknown as Uint8Array)
        );
    } catch {
        /* ignore */
    }
    return fresh;
}

/** Remove the delegate keypair (used on revoke). */
export function clearDelegate(walletAddress: string): void {
    try {
        localStorage.removeItem(KEY_PREFIX + lower(walletAddress));
        localStorage.removeItem(GRANTS_PREFIX + lower(walletAddress));
    } catch {
        /* ignore */
    }
}

/** Read the set of group UUIDs for which the delegate has been granted permissions. */
export function getGrantedGroups(walletAddress: string): Set<string> {
    try {
        const raw = localStorage.getItem(GRANTS_PREFIX + lower(walletAddress));
        if (!raw) return new Set();
        const arr = JSON.parse(raw) as string[];
        return new Set(arr);
    } catch {
        return new Set();
    }
}

export function hasGrantedDelegate(
    walletAddress: string,
    groupUuid: string
): boolean {
    return getGrantedGroups(walletAddress).has(groupUuid);
}

export function markDelegateGranted(
    walletAddress: string,
    groupUuid: string
): void {
    const set = getGrantedGroups(walletAddress);
    set.add(groupUuid);
    try {
        localStorage.setItem(
            GRANTS_PREFIX + lower(walletAddress),
            JSON.stringify([...set])
        );
    } catch {
        /* ignore */
    }
}

export function unmarkDelegateGranted(
    walletAddress: string,
    groupUuid: string
): void {
    const set = getGrantedGroups(walletAddress);
    set.delete(groupUuid);
    try {
        localStorage.setItem(
            GRANTS_PREFIX + lower(walletAddress),
            JSON.stringify([...set])
        );
    } catch {
        /* ignore */
    }
}

/** Compute the delegate's Sui address from its keypair. */
export function delegateAddress(keypair: Ed25519Keypair): string {
    return keypair.getPublicKey().toSuiAddress();
}
