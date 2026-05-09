// MessagingClientContext — provides a per-connected-wallet messaging client
// for the rest of the app. Adapted from the canonical chat-app reference.
//
// Lifecycle:
//   - When no wallet is connected: client = null, signer = null
//   - When a wallet connects: build a DappKitSigner + messaging client
//   - Session-key signing happens on demand via the SDK; we just expose
//     the onSign hook backed by dapp-kit's useSignPersonalMessage.

import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    type ReactNode,
} from 'react';
import {
    useCurrentAccount,
    useSignPersonalMessage,
    useSuiClient,
} from '@mysten/dapp-kit';
import type { Signer } from '@mysten/sui/cryptography';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { DappKitSigner } from '../lib/dapp-kit-signer';
import { createMessagingClient } from '../lib/messaging';

type MessagingClient = ReturnType<typeof createMessagingClient>;

interface MessagingClientContextValue {
    client: MessagingClient | null;
    signer: Signer | null;
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

    // Keep a stable ref to signPersonalMessage so client memoization doesn't
    // bust on every render.
    const signRef = useRef(signPersonalMessage);
    useEffect(() => {
        signRef.current = signPersonalMessage;
    }, [signPersonalMessage]);

    const value = useMemo<MessagingClientContextValue>(() => {
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

    return (
        <MessagingClientContext.Provider value={value}>
            {children}
        </MessagingClientContext.Provider>
    );
}

/** Returns the messaging client, or null if no wallet is connected. */
export function useMessagingClient(): MessagingClient | null {
    const ctx = useContext(MessagingClientContext);
    if (!ctx) {
        throw new Error(
            'useMessagingClient must be used inside <MessagingClientProvider>'
        );
    }
    return ctx.client;
}

/** Returns the signer (DappKitSigner), or null if no wallet is connected. */
export function useMessagingSigner(): Signer | null {
    const ctx = useContext(MessagingClientContext);
    if (!ctx) {
        throw new Error(
            'useMessagingSigner must be used inside <MessagingClientProvider>'
        );
    }
    return ctx.signer;
}

/** Returns both client + signer. Throws if no wallet is connected. */
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
