// MarketChat — per-market chat panel using @mysten/sui-stack-messaging.
//
// Capabilities:
//   - Looks up the messaging group registered for the given market objectId
//   - Loads recent messages, subscribes to new ones (AsyncIterable from SDK)
//   - Sends messages via the connected wallet (DappKitSigner)
//   - Handles all the relevant states: no wallet, no group, error, loading
//
// Group provisioning (creating a new chat for a market) is a separate flow
// — for v0, channels are bootstrapped via a script and registered locally.

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type FormEvent,
} from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Send, MessageCircle, Lock, RefreshCw, Plus, UserPlus, X } from 'lucide-react';
import { useMessagingClient, useMessagingSigner } from '../contexts/MessagingClientContext';
import { marketUuidFor } from '../lib/messaging';

interface Props {
    marketObjectId: string;
    marketTitle: string;
}

interface ChatMessage {
    messageId: string;
    order: number;
    text: string;
    senderAddress: string;
    createdAt: number;
    isEdited?: boolean;
    isDeleted?: boolean;
    syncStatus?: string;
}

type Status =
    | { kind: 'no-wallet' }
    | { kind: 'no-group' }
    | { kind: 'creating-group' }
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'error'; message: string };

function shortAddr(addr: string) {
    if (!addr || addr.length < 10) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function relativeTime(seconds: number) {
    const ms = seconds * 1000;
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

function mergeMessage(prev: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
    const idx = prev.findIndex((m) => m.messageId === incoming.messageId);
    if (idx !== -1) {
        const next = [...prev];
        next[idx] = incoming;
        return next;
    }
    return [...prev, incoming].sort((a, b) => a.order - b.order);
}

export default function MarketChat({ marketObjectId, marketTitle }: Props) {
    const account = useCurrentAccount();
    const client = useMessagingClient();
    const signer = useMessagingSigner();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

    const [status, setStatus] = useState<Status>({ kind: 'no-wallet' });
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteAddr, setInviteAddr] = useState('');
    const [inviting, setInviting] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);

    // Deterministic UUID derived from the market objectId — every wallet
    // computes the same value, so chat is self-discoverable per market.
    const groupUuid = marketUuidFor(marketObjectId);
    const lastOrderRef = useRef<number | undefined>(undefined);
    const scrollerRef = useRef<HTMLDivElement>(null);

    // Update lastOrderRef whenever messages change.
    useEffect(() => {
        if (messages.length > 0) {
            lastOrderRef.current = messages.at(-1)?.order;
        }
    }, [messages]);

    // ── status reconciliation ───────────────────────────────
    useEffect(() => {
        if (!account || !client || !signer) {
            setStatus({ kind: 'no-wallet' });
            return;
        }
        setStatus((prev) =>
            prev.kind === 'creating-group' ? prev : { kind: 'loading' }
        );
    }, [account, client, signer, groupUuid]);

    // ── load initial messages ───────────────────────────────
    useEffect(() => {
        if (!client || !signer) return;
        if (status.kind === 'creating-group') return;
        let cancelled = false;
        setMessages([]);
        lastOrderRef.current = undefined;

        (async () => {
            try {
                const result = await client.messaging.getMessages({
                    signer,
                    groupRef: { uuid: groupUuid },
                    limit: 50,
                });
                if (cancelled) return;
                setMessages(result.messages as ChatMessage[]);
                setStatus({ kind: 'ready' });
            } catch (e) {
                if (cancelled) return;
                const msg = e instanceof Error ? e.message : String(e);
                // If the group object isn't on-chain yet, fall through to
                // the no-group state so the user can create it.
                const looksMissing = /not.?found|does.?not.?exist|missing/i.test(msg);
                setStatus(
                    looksMissing
                        ? { kind: 'no-group' }
                        : { kind: 'error', message: msg }
                );
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [client, signer, groupUuid, status.kind]);

    // ── live subscription ───────────────────────────────────
    useEffect(() => {
        if (!client || !signer || !groupUuid || status.kind !== 'ready') return;

        const controller = new AbortController();
        (async () => {
            try {
                const stream = client.messaging.subscribe({
                    signer,
                    groupRef: { uuid: groupUuid },
                    afterOrder: lastOrderRef.current,
                    signal: controller.signal,
                }) as AsyncIterable<ChatMessage>;

                for await (const msg of stream) {
                    if (controller.signal.aborted) break;
                    setMessages((prev) => mergeMessage(prev, msg));
                }
            } catch {
                // AbortError on cleanup is expected; swallow others
            }
        })();

        return () => controller.abort();
    }, [client, signer, groupUuid, status.kind]);

    // auto-scroll on new messages
    useEffect(() => {
        if (!scrollerRef.current) return;
        scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }, [messages.length]);

    const handleRefresh = useCallback(async () => {
        if (!client || !signer || !groupUuid) return;
        setRefreshing(true);
        try {
            const result = await client.messaging.getMessages({
                signer,
                groupRef: { uuid: groupUuid },
                limit: 50,
            });
            setMessages(result.messages as ChatMessage[]);
        } catch {
            // ignore
        } finally {
            setRefreshing(false);
        }
    }, [client, signer, groupUuid]);

    const handleInvite = useCallback(
        async (e: FormEvent) => {
            e.preventDefault();
            const addr = inviteAddr.trim();
            setInviteError(null);
            if (!/^0x[a-fA-F0-9]{64}$/.test(addr)) {
                setInviteError('Invalid Sui address (expected 0x + 64 hex chars).');
                return;
            }
            if (!client) return;
            setInviting(true);
            try {
                const groupId = client.messaging.derive.groupId({
                    uuid: groupUuid,
                });
                const perms = [
                    client.messaging.bcs.MessagingReader.name,
                    client.messaging.bcs.MessagingSender.name,
                    client.messaging.bcs.MessagingEditor.name,
                    client.messaging.bcs.MessagingDeleter.name,
                ];
                const tx = client.groups.tx.grantPermissions({
                    groupId,
                    member: addr,
                    permissionTypes: perms,
                });
                await signAndExecute({ transaction: tx });
                setInviteAddr('');
                setInviteOpen(false);
            } catch (e) {
                setInviteError(
                    e instanceof Error ? e.message : 'Failed to invite member'
                );
            } finally {
                setInviting(false);
            }
        },
        [client, inviteAddr, groupUuid, signAndExecute]
    );

    const handleCreateGroup = useCallback(async () => {
        if (!client) return;
        setStatus({ kind: 'creating-group' });
        try {
            const tx = new (
                await import('@mysten/sui/transactions')
            ).Transaction();
            await client.messaging.call.createAndShareGroup({
                uuid: groupUuid,
                name: marketTitle.slice(0, 80),
            })(tx);
            await signAndExecute({ transaction: tx });
            // Trigger reload via status flip
            setStatus({ kind: 'loading' });
        } catch (e) {
            setStatus({
                kind: 'error',
                message: e instanceof Error ? e.message : 'Failed to create chat',
            });
        }
    }, [client, groupUuid, marketTitle, signAndExecute]);

    const handleSend = useCallback(
        async (e: FormEvent) => {
            e.preventDefault();
            const trimmed = draft.trim();
            if (!trimmed || !client || !signer || !groupUuid || sending) return;

            setSending(true);
            try {
                const { messageId } = await client.messaging.sendMessage({
                    signer,
                    groupRef: { uuid: groupUuid },
                    text: trimmed,
                });
                // Optimistic local append; subscription will replace it.
                const optimistic: ChatMessage = {
                    messageId,
                    order: (lastOrderRef.current ?? 0) + 1,
                    text: trimmed,
                    senderAddress: account!.address,
                    createdAt: Date.now() / 1000,
                    syncStatus: 'SYNC_PENDING',
                };
                setMessages((prev) => mergeMessage(prev, optimistic));
                setDraft('');
            } catch (e) {
                setStatus({
                    kind: 'error',
                    message: e instanceof Error ? e.message : 'Failed to send',
                });
            } finally {
                setSending(false);
            }
        },
        [draft, client, signer, groupUuid, sending, account]
    );

    // ── render ──────────────────────────────────────────────
    return (
        <div className="chat-panel">
            <div className="chat-header">
                <div className="chat-title">
                    <MessageCircle size={16} />
                    <span>Market chat</span>
                </div>
                <div className="chat-subtitle">
                    Sui Stack Messaging · Walrus + Seal
                </div>
                {status.kind === 'ready' && (
                    <>
                        <button
                            className="chat-refresh"
                            onClick={handleRefresh}
                            disabled={refreshing}
                            title="Refresh messages"
                        >
                            <RefreshCw
                                size={14}
                                className={refreshing ? 'spin' : ''}
                            />
                        </button>
                        <button
                            className="chat-refresh"
                            onClick={() => setInviteOpen((v) => !v)}
                            title="Invite member"
                        >
                            {inviteOpen ? <X size={14} /> : <UserPlus size={14} />}
                        </button>
                    </>
                )}
            </div>

            {status.kind === 'ready' && inviteOpen && (
                <form
                    className="chat-input"
                    onSubmit={handleInvite}
                    style={{ borderTop: '1px solid var(--border-base)', borderBottom: '1px solid var(--border-base)' }}
                >
                    <input
                        type="text"
                        placeholder="0x… address to invite"
                        value={inviteAddr}
                        onChange={(e) => setInviteAddr(e.target.value)}
                        disabled={inviting}
                        autoFocus
                    />
                    <button
                        type="submit"
                        className="btn btn-yes btn-sm"
                        disabled={inviting || !inviteAddr.trim()}
                    >
                        {inviting ? '…' : 'Invite'}
                    </button>
                </form>
            )}
            {inviteError && status.kind === 'ready' && (
                <div className="alert alert-error" style={{ margin: '0 14px 8px', fontSize: 12 }}>
                    {inviteError}
                </div>
            )}

            <div className="chat-body" ref={scrollerRef}>
                {status.kind === 'no-wallet' && (
                    <div className="chat-empty">
                        <Lock size={32} />
                        <div className="chat-empty-title">Connect your wallet</div>
                        <div className="chat-empty-desc">
                            Chat is end-to-end encrypted. Connect a wallet to join
                            the conversation for this market.
                        </div>
                    </div>
                )}

                {status.kind === 'no-group' && (
                    <div className="chat-empty">
                        <MessageCircle size={32} />
                        <div className="chat-empty-title">No chat yet</div>
                        <div className="chat-empty-desc">
                            Create a discussion group for "{marketTitle}". You'll
                            become the chat creator and can invite traders.
                        </div>
                        <button
                            className="btn btn-yes"
                            style={{ marginTop: 16, display: 'inline-flex', gap: 6, alignItems: 'center' }}
                            onClick={handleCreateGroup}
                        >
                            <Plus size={14} /> Create chat
                        </button>
                    </div>
                )}

                {status.kind === 'creating-group' && (
                    <div className="chat-empty">
                        <RefreshCw size={32} className="spin" />
                        <div className="chat-empty-title">Creating chat…</div>
                        <div className="chat-empty-desc">
                            Approve the transaction in your wallet. This deploys
                            the encrypted group on Sui.
                        </div>
                    </div>
                )}

                {status.kind === 'loading' && (
                    <div className="chat-empty">
                        <RefreshCw size={32} className="spin" />
                        <div className="chat-empty-title">Loading chat…</div>
                        <div className="chat-empty-desc">
                            Fetching messages from the relayer and decrypting via
                            Seal.
                        </div>
                    </div>
                )}

                {status.kind === 'error' && (
                    <div className="chat-empty">
                        <div className="chat-empty-title">Chat error</div>
                        <div className="chat-empty-desc">{status.message}</div>
                    </div>
                )}

                {status.kind === 'ready' && messages.length === 0 && (
                    <div className="chat-empty">
                        <MessageCircle size={32} />
                        <div className="chat-empty-title">No messages yet</div>
                        <div className="chat-empty-desc">
                            Be the first to share your thesis on this market.
                        </div>
                    </div>
                )}

                {status.kind === 'ready' &&
                    messages
                        .filter((m) => !m.isDeleted)
                        .map((m) => {
                            const mine = m.senderAddress === account?.address;
                            return (
                                <div
                                    key={m.messageId}
                                    className={`chat-msg ${mine ? 'mine' : ''}`}
                                >
                                    <div className="chat-msg-meta">
                                        <span className="chat-msg-sender">
                                            {mine
                                                ? 'you'
                                                : shortAddr(m.senderAddress)}
                                        </span>
                                        <span className="chat-msg-time">
                                            {relativeTime(m.createdAt)}
                                            {m.isEdited ? ' · edited' : ''}
                                            {m.syncStatus === 'SYNC_PENDING'
                                                ? ' · pending'
                                                : ''}
                                        </span>
                                    </div>
                                    <div className="chat-msg-body">{m.text}</div>
                                </div>
                            );
                        })}
            </div>

            <form className="chat-input" onSubmit={handleSend}>
                <input
                    type="text"
                    placeholder={
                        status.kind === 'ready'
                            ? 'Share your thesis…'
                            : status.kind === 'no-wallet'
                            ? 'Connect wallet to chat'
                            : 'Chat unavailable'
                    }
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={status.kind !== 'ready' || sending}
                />
                <button
                    type="submit"
                    className="btn btn-yes btn-sm"
                    disabled={
                        status.kind !== 'ready' || sending || !draft.trim()
                    }
                    aria-label="Send message"
                >
                    <Send size={14} />
                </button>
            </form>
        </div>
    );
}
