// MessagingClientContext — provides per-connected-wallet messaging clients.
//
// Two clients per wallet:
//   - walletClient: signs with the user's wallet via dapp-kit
//                   (used for group creation, invites, permission grants)
//   - delegateClient: signs with a persistent Ed25519 delegate keypair
//                     (used for ALL message sends to groups that have
//                      granted the delegate Reader/Sender permission)
//
// The delegate keypair is lazy: created on demand when the user opts in to
// auto-sign. Without provisioning, delegateClient === walletClient (every
// message still triggers a wallet popup, unchanged from previous behaviour).

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import {
    useCurrentAccount,
    useSignPersonalMessage,
    useSuiClient,
} from '@mysten/dapp-kit';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { DappKitSigner } from '../lib/dapp-kit-signer';
import { createMessagingClient } from '../lib/messaging';
import {
    delegateAddress,
    getDelegate,
    getOrCreateDelegate,
} from '../lib/chat-session';

type MessagingClient = ReturnType<typeof createMessagingClient>;

interface MessagingClientContextValue {
    /** Wallet-backed client; needed for group creation, invites, grants. */
    client: MessagingClient | null;
    /** Wallet-backed signer (1 popup per signature). */
    signer: Signer | null;
    /** Delegate-backed client (if a delegate exists). Falls back to wallet. */
    delegateClient: MessagingClient | null;
    /**
     * Delegate keypair acting as a Signer — Ed25519Keypair implements the
     * Signer interface directly. Pass this to SDK methods to send messages
     * without any wallet popups.
     */
    delegateSigner: Signer | null;
    /** Delegate address (if provisioned) — what the relayer sees as sender. */
    delegateAddress: string | null;
    /** True iff a delegate exists for the connected wallet. */
    hasDelegate: boolean;
    /**
     * Ensure a delegate exists for the connected wallet. Idempotent — returns
     * the existing keypair if one is already persisted. No on-chain side
     * effects; the caller still has to grant the delegate group permissions.
     */
    ensureDelegate: () => Ed25519Keypair | null;
}

const MessagingClientContext = createContext<MessagingClientContextValue | null>(
    null
);

export function MessagingClientProvider({
    children,
}: Readonly<{ children: ReactNode }>) {
    const account = useCurrentAccount();
    const suiClient = useSuiClient() as unknown as SuiJsonRpcClient;
    const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

    const signRef = useRef(signPersonalMessage);
    useEffect(() => {
        signRef.current = signPersonalMessage;
    }, [signPersonalMessage]);

    // Tracks whether a delegate exists for the connected wallet. We restore
    // from localStorage on wallet change so a previously-provisioned delegate
    // resumes immediately on page refresh.
    const [delegate, setDelegate] = useState<Ed25519Keypair | null>(null);

    useEffect(() => {
        if (!account?.address) {
            setDelegate(null);
            return;
        }
        const existing = getDelegate(account.address);
        setDelegate(existing);
    }, [account?.address]);

    const ensureDelegate = useCallback((): Ed25519Keypair | null => {
        if (!account?.address) return null;
        if (delegate) return delegate;
        const fresh = getOrCreateDelegate(account.address);
        setDelegate(fresh);
        return fresh;
    }, [account?.address, delegate]);

    const walletPart = useMemo(() => {
        if (!account) return { client: null, signer: null };

        const signer = new DappKitSigner({
            address: account.address,
            publicKeyBytes: account.publicKey
                ? new Uint8Array(account.publicKey)
                : undefined,
            signPersonalMessage: (args) =>
                signRef.current({ message: args.message }),
        });

        const client = createMessagingClient({
            suiClient,
            address: account.address,
            onSign: async (message: Uint8Array) => {
                const { signature } = await signRef.current({ message });
                return signature;
            },
        });

        return { client, signer };
    }, [account, suiClient]);

    const delegatePart = useMemo(() => {
        if (!account || !delegate) {
            return { delegateClient: null, delegateAddress: null };
        }
        const addr = delegateAddress(delegate);
        const client = createMessagingClient({
            suiClient,
            address: addr,
            onSign: async (message: Uint8Array) => {
                const { signature } = await delegate.signPersonalMessage(
                    message
                );
                return signature;
            },
        });
        return { delegateClient: client, delegateAddress: addr };
    }, [account, suiClient, delegate]);

    const value = useMemo<MessagingClientContextValue>(
        () => ({
            client: walletPart.client,
            signer: walletPart.signer,
            // delegateClient falls back to wallet client when no delegate
            delegateClient: delegatePart.delegateClient ?? walletPart.client,
            delegateSigner: delegate as unknown as Signer | null,
            delegateAddress: delegatePart.delegateAddress,
            hasDelegate: !!delegate,
            ensureDelegate,
        }),
        [walletPart, delegatePart, delegate, ensureDelegate]
    );

    return (
        <MessagingClientContext.Provider value={value}>
            {children}
        </MessagingClientContext.Provider>
    );
}

/** Returns the wallet messaging client, or null if no wallet is connected. */
export function useMessagingClient(): MessagingClient | null {
    const ctx = useContext(MessagingClientContext);
    if (!ctx) {
        throw new Error(
            'useMessagingClient must be used inside <MessagingClientProvider>'
        );
    }
    return ctx.client;
}

/** Returns the wallet-backed signer, or null if no wallet is connected. */
export function useMessagingSigner(): Signer | null {
    const ctx = useContext(MessagingClientContext);
    if (!ctx) {
        throw new Error(
            'useMessagingSigner must be used inside <MessagingClientProvider>'
        );
    }
    return ctx.signer;
}

/** Returns both wallet client + signer. Throws if no wallet is connected. */
export function useRequiredMessaging(): {
    client: MessagingClient;
    signer: Signer;
} {
    const ctx = useContext(MessagingClientContext);
    if (!ctx) {
        throw new Error(
            'useRequiredMessaging must be used inside <MessagingClientProvider>'
        );
    }
    if (!ctx.client || !ctx.signer) {
        throw new Error('Wallet must be connected to use messaging.');
    }
    return { client: ctx.client, signer: ctx.signer };
}

/**
 * Returns the delegate-backed client (no wallet popups). Falls back to the
 * wallet client when no delegate is provisioned. Use this for read paths and
 * message sends on groups where the delegate already has permissions.
 */
export function useDelegateMessagingClient(): MessagingClient | null {
    const ctx = useContext(MessagingClientContext);
    if (!ctx) {
        throw new Error(
            'useDelegateMessagingClient must be used inside <MessagingClientProvider>'
        );
    }
    return ctx.delegateClient;
}

/** Returns the delegate signer (Ed25519Keypair), or null if none provisioned. */
export function useDelegateSigner(): Signer | null {
    const ctx = useContext(MessagingClientContext);
    if (!ctx) {
        throw new Error(
            'useDelegateSigner must be used inside <MessagingClientProvider>'
        );
    }
    return ctx.delegateSigner;
}

/**
 * Returns delegate session helpers: whether a delegate exists, its address,
 * and a function to provision one. Provisioning is local-only — the caller
 * must still send a grantPermissions tx with the wallet client to actually
 * authorize the delegate on a group.
 */
export function useDelegateSession(): {
    hasDelegate: boolean;
    delegateAddress: string | null;
    ensureDelegate: () => Ed25519Keypair | null;
} {
    const ctx = useContext(MessagingClientContext);
    if (!ctx) {
        throw new Error(
            'useDelegateSession must be used inside <MessagingClientProvider>'
        );
    }
    return {
        hasDelegate: ctx.hasDelegate,
        delegateAddress: ctx.delegateAddress,
        ensureDelegate: ctx.ensureDelegate,
    };
}
