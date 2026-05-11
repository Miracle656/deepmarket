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
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Send, MessageCircle, Lock, RefreshCw, Plus, UserPlus, X, Zap, ShieldCheck } from 'lucide-react';
import { permissionTypes } from '@mysten/sui-groups';
import {
    useMessagingClient,
    useMessagingSigner,
    useDelegateMessagingClient,
    useDelegateSigner,
    useDelegateSession,
} from '../contexts/MessagingClientContext';
import { marketUuidFor } from '../lib/messaging';
import {
    clearDelegate,
    hasGrantedDelegate,
    markDelegateGranted,
    unmarkDelegateGranted,
} from '../lib/chat-session';

// Resolve the groups package's admin types at module load. Two admin types
// exist on a PermissionedGroup:
//   - PermissionsAdmin           — manages CORE perms defined in permissioned_groups
//   - ExtensionPermissionsAdmin  — manages EXTENSION perms (e.g. MessagingReader)
// Granting messaging perms (the ones our delegate needs) requires
// ExtensionPermissionsAdmin, not just PermissionsAdmin.
const GROUPS_PKG = '0xba8a26d42bc8b5e5caf4dac2a0f7544128d5dd9b4614af88eec1311ade11de79';
const PERMISSIONS_ADMIN = permissionTypes(GROUPS_PKG).PermissionsAdmin;
const EXTENSION_PERMISSIONS_ADMIN =
    permissionTypes(GROUPS_PKG).ExtensionPermissionsAdmin;

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
    | { kind: 'needs-autosign' }
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
    const sui = useSuiClient();
    const walletClient = useMessagingClient();
    const walletSigner = useMessagingSigner();
    const delegateClientFromCtx = useDelegateMessagingClient();
    const delegateSigner = useDelegateSigner();
    const {
        hasDelegate,
        ensureDelegate,
        delegateAddress: delegateAddr,
    } = useDelegateSession();
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
    const [delegateGranted, setDelegateGranted] = useState(false);
    const [provisioning, setProvisioning] = useState(false);
    const [provisionError, setProvisionError] = useState<string | null>(null);
    // User explicitly chose "popup per signature" instead of auto-sign.
    // Sticky for the session; relevant only for the gating screen.
    const [useWalletForReads, setUseWalletForReads] = useState(false);
    // Two-step confirmation for the destructive Reset action — avoids the
    // native window.confirm dialog while still preventing fat-fingers.
    const [resetArmed, setResetArmed] = useState(false);

    // Deterministic UUID derived from the market objectId — every wallet
    // computes the same value, so chat is self-discoverable per market.
    const groupUuid = marketUuidFor(marketObjectId);
    const lastOrderRef = useRef<number | undefined>(undefined);
    const scrollerRef = useRef<HTMLDivElement>(null);

    // Track whether the delegate has been granted permissions on THIS group.
    // Provisioned-once-per-wallet, granted-once-per-group.
    useEffect(() => {
        if (!account?.address) {
            setDelegateGranted(false);
            return;
        }
        const granted = hasGrantedDelegate(account.address, groupUuid);
        console.info(
            '[autosign] grant-state check on mount/refresh. granted=',
            granted,
            'wallet=',
            account.address,
            'groupUuid=',
            groupUuid
        );
        setDelegateGranted(granted);
    }, [account?.address, groupUuid]);

    const autoSignActive = hasDelegate && delegateGranted && !!delegateSigner;
    // Use delegate everywhere it's been authorized; fall back to wallet.
    const activeClient = autoSignActive
        ? delegateClientFromCtx ?? walletClient
        : walletClient;
    const activeSigner = autoSignActive ? delegateSigner : walletSigner;
    // Aliases kept so the rest of the component reads cleanly.
    const client = activeClient;
    const signer = activeSigner;

    // Update lastOrderRef whenever messages change.
    useEffect(() => {
        if (messages.length > 0) {
            lastOrderRef.current = messages.at(-1)?.order;
        }
    }, [messages]);

    // ── status reconciliation ───────────────────────────────
    // Gate reads until the user picks a signing mode for this group. If
    // auto-sign is already on (delegate granted), reads happen silently via
    // delegate. Otherwise we render an opt-in card; reading would otherwise
    // burn 3 wallet popups before the user even sees the option.
    useEffect(() => {
        if (!account || !walletClient) {
            setStatus({ kind: 'no-wallet' });
            return;
        }
        const canRead = autoSignActive || useWalletForReads;
        if (!canRead) {
            setStatus({ kind: 'needs-autosign' });
            return;
        }
        setStatus((prev) =>
            prev.kind === 'creating-group' ? prev : { kind: 'loading' }
        );
    }, [account, walletClient, autoSignActive, useWalletForReads, groupUuid]);

    // ── load initial messages ───────────────────────────────
    useEffect(() => {
        if (!client || !signer) return;
        if (status.kind === 'creating-group') return;
        if (status.kind === 'needs-autosign') return;
        // Skip reads until the user has explicitly chosen a signing mode.
        if (!autoSignActive && !useWalletForReads) return;
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
    }, [client, signer, groupUuid, status.kind, autoSignActive, useWalletForReads]);

    // ── live subscription ───────────────────────────────────
    useEffect(() => {
        if (!client || !signer || !groupUuid || status.kind !== 'ready') return;
        if (!autoSignActive && !useWalletForReads) return;

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
            if (!walletClient) return;
            setInviting(true);

            const groupId = walletClient.messaging.derive.groupId({
                uuid: groupUuid,
            });
            const fullPerms = [
                walletClient.messaging.bcs.MessagingReader.name,
                walletClient.messaging.bcs.MessagingSender.name,
                walletClient.messaging.bcs.MessagingEditor.name,
                walletClient.messaging.bcs.MessagingDeleter.name,
                // PermissionsAdmin manages core perms (group-level ops).
                // ExtensionPermissionsAdmin is the one actually required to
                // grant Messaging perms — this is what lets the invitee later
                // grant their own auto-sign delegate.
                PERMISSIONS_ADMIN,
                EXTENSION_PERMISSIONS_ADMIN,
            ];

            // Grant full perms; on vec_set::insert abort (duplicate
            // permission, meaning the member already has at least one of
            // these), fall back to granting ONLY PermissionsAdmin so
            // existing members can be promoted without re-granting the four
            // perms they already have.
            const tryGrant = async (perms: string[]) => {
                const tx = walletClient.groups.tx.grantPermissions({
                    groupId,
                    member: addr,
                    permissionTypes: perms,
                });
                const res = await signAndExecute({ transaction: tx });
                const txRes = await sui.waitForTransaction({
                    digest: res.digest,
                    options: { showEffects: true },
                });
                const status =
                    (txRes as { effects?: { status?: { status?: string; error?: string } } })
                        .effects?.status;
                if (status?.status !== 'success') {
                    throw new Error(status?.error ?? 'Grant tx aborted');
                }
            };

            // Retry chain: full → admin pair → ExtensionPermissionsAdmin only.
            // Each step skips on vec_set::insert (duplicate perm) and tries
            // the next narrower set. Worst case is 3 wallet popups but the
            // final state has the member with both admin types so they can
            // run Enable auto-sign themselves.
            const attempts: { label: string; perms: string[] }[] = [
                { label: 'full', perms: fullPerms },
                {
                    label: 'admin-pair',
                    perms: [PERMISSIONS_ADMIN, EXTENSION_PERMISSIONS_ADMIN],
                },
                {
                    label: 'extension-admin-only',
                    perms: [EXTENSION_PERMISSIONS_ADMIN],
                },
            ];
            let success = false;
            let lastError: unknown = null;
            try {
                for (const step of attempts) {
                    try {
                        console.info(
                            `[invite] attempt "${step.label}" (${step.perms.length} perms)`
                        );
                        await tryGrant(step.perms);
                        console.info(
                            `[invite] attempt "${step.label}" succeeded`
                        );
                        success = true;
                        break;
                    } catch (err) {
                        lastError = err;
                        const m =
                            err instanceof Error ? err.message : String(err);
                        console.warn(
                            `[invite] attempt "${step.label}" failed:`,
                            m
                        );
                        const isDup = /vec_set::insert/i.test(m);
                        if (!isDup) throw err;
                        // fall through to next narrower step
                    }
                }
                if (success) {
                    setInviteAddr('');
                    setInviteOpen(false);
                } else {
                    // All attempts hit vec_set::insert — member already has
                    // every perm we wanted to grant. Treat as success-equivalent.
                    setInviteAddr('');
                    setInviteOpen(false);
                    setInviteError(
                        'Member already has full permissions. They should be able to enable auto-sign now — ask them to refresh.'
                    );
                }
            } catch (e) {
                void lastError;
                const msg = e instanceof Error ? e.message : String(e);
                console.error('[invite] final error:', msg);
                const lacksAdmin =
                    /permissioned_group::grant_permission/.test(msg) &&
                    /abort code: 0/i.test(msg) &&
                    !/vec_set::insert/i.test(msg);
                setInviteError(
                    lacksAdmin
                        ? `You don't have admin rights on this chat. Connected wallet: ${account?.address.slice(0, 12)}…`
                        : `Invite failed: ${msg}`
                );
            } finally {
                setInviting(false);
            }
        },
        [walletClient, inviteAddr, groupUuid, signAndExecute, sui]
    );

    const handleCreateGroup = useCallback(async () => {
        if (!walletClient) return;
        setStatus({ kind: 'creating-group' });
        try {
            const tx = new (
                await import('@mysten/sui/transactions')
            ).Transaction();
            await walletClient.messaging.call.createAndShareGroup({
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
    }, [walletClient, groupUuid, marketTitle, signAndExecute]);

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
                // senderAddress matches the signer that actually authored the
                // message (delegate when auto-sign is active, else wallet).
                const optimisticSender = autoSignActive
                    ? delegateAddr ?? account!.address
                    : account!.address;
                const optimistic: ChatMessage = {
                    messageId,
                    order: (lastOrderRef.current ?? 0) + 1,
                    text: trimmed,
                    senderAddress: optimisticSender,
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
        [draft, client, signer, groupUuid, sending, account, autoSignActive, delegateAddr]
    );

    // ── delegate provisioning ──────────────────────────────────
    // One-time per group: grants the user's chat delegate full member perms
    // on this group's on-chain object, after which the delegate signs every
    // subsequent message with no wallet popups.
    const handleEnableAutoSign = useCallback(async () => {
        if (!account || !walletClient) return;
        setProvisioning(true);
        setProvisionError(null);
        try {
            const keypair = ensureDelegate();
            if (!keypair) throw new Error('Could not provision delegate keypair');
            const delegateAddrLocal = keypair.getPublicKey().toSuiAddress();

            const groupId = walletClient.messaging.derive.groupId({
                uuid: groupUuid,
            });
            const perms = [
                walletClient.messaging.bcs.MessagingReader.name,
                walletClient.messaging.bcs.MessagingSender.name,
                walletClient.messaging.bcs.MessagingEditor.name,
                walletClient.messaging.bcs.MessagingDeleter.name,
            ];
            const tx = walletClient.groups.tx.grantPermissions({
                groupId,
                member: delegateAddrLocal,
                permissionTypes: perms,
            });
            const res = await signAndExecute({ transaction: tx });
            const txRes = await sui.waitForTransaction({
                digest: res.digest,
                options: { showEffects: true },
            });
            // Move aborts don't throw — they return with effects.status.error.
            // Marking the grant as successful when the tx aborted strands the
            // delegate as a non-member; future reads 403 until cleared.
            const status =
                (txRes as { effects?: { status?: { status?: string; error?: string } } })
                    .effects?.status;
            if (status?.status !== 'success') {
                throw new Error(
                    status?.error
                        ? `Grant tx aborted on chain: ${status.error}`
                        : 'Grant tx failed on chain'
                );
            }
            markDelegateGranted(account.address, groupUuid);
            console.info(
                '[autosign] grant succeeded; persisted to localStorage. wallet=',
                account.address,
                'groupUuid=',
                groupUuid
            );
            setDelegateGranted(true);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // vec_set::insert abort: the delegate already has these perms on
            // chain (from a prior successful grant the relayer didn't see).
            // Trust the chain state — mark granted locally so we stop gating.
            const alreadyOnChain = /vec_set::insert/i.test(msg);
            if (alreadyOnChain && account) {
                markDelegateGranted(account.address, groupUuid);
                console.info(
                    '[autosign] vec_set duplicate caught; marking granted. wallet=',
                    account.address,
                    'groupUuid=',
                    groupUuid
                );
                setDelegateGranted(true);
                setProvisionError(null);
                return;
            }
            // Abort in grant_permission (NOT vec_set::insert) typically means
            // the caller doesn't hold PermissionsAdmin on this group.
            const lacksAdmin =
                /permissioned_group::grant_permission/.test(msg) &&
                /abort code: 0/i.test(msg);
            setProvisionError(
                lacksAdmin
                    ? 'This wallet has read/send permission on the chat but no admin rights to grant a delegate. Ask the chat creator to re-invite this address — the latest invite flow includes admin rights.'
                    : `Failed to enable auto-sign: ${msg}`
            );
        } finally {
            setProvisioning(false);
        }
    }, [account, walletClient, ensureDelegate, groupUuid, signAndExecute, sui]);

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
                    {account && (
                        <span
                            style={{
                                marginLeft: 10,
                                fontFamily: 'Space Mono, monospace',
                                fontSize: 10,
                                opacity: 0.55,
                            }}
                            title={`wallet: ${account.address}\ngroupUuid: ${groupUuid}${delegateAddr ? `\ndelegate: ${delegateAddr}` : ''}`}
                        >
                            · {shortAddr(account.address)} → {groupUuid.slice(0, 8)}…
                        </span>
                    )}
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

                {status.kind === 'needs-autosign' && (
                    <div className="chat-empty chat-autosign-gate">
                        <Zap size={28} />
                        <div className="chat-empty-title">
                            Enable auto-sign for this chat?
                        </div>
                        <div className="chat-empty-desc">
                            One wallet signature grants a local delegate
                            permission to sign on your behalf. After that, every
                            read and message is signed silently — no popups.
                        </div>
                        <div className="chat-autosign-actions">
                            <button
                                type="button"
                                className="btn btn-yes"
                                onClick={handleEnableAutoSign}
                                disabled={provisioning}
                            >
                                {provisioning ? (
                                    <>
                                        <RefreshCw size={14} className="spin" />
                                        &nbsp;Provisioning…
                                    </>
                                ) : (
                                    <>
                                        <Zap size={14} />
                                        &nbsp;Enable auto-sign · 1 popup
                                    </>
                                )}
                            </button>
                            <button
                                type="button"
                                className="chat-autosign-skip"
                                onClick={() => setUseWalletForReads(true)}
                                disabled={provisioning}
                            >
                                or sign each request manually
                            </button>
                        </div>
                        {provisionError && (
                            <div
                                className="alert alert-error"
                                style={{ marginTop: 12, fontSize: 12 }}
                            >
                                {provisionError}
                            </div>
                        )}
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
                        {/* If auto-sign is on but reads fail (e.g. stale grant
                            from a previously-aborted tx), let the user reset
                            and re-trigger the gate card. */}
                        {autoSignActive && account && (
                            <button
                                type="button"
                                className="btn btn-yes"
                                style={{ marginTop: 14 }}
                                onClick={() => {
                                    unmarkDelegateGranted(
                                        account.address,
                                        groupUuid
                                    );
                                    setDelegateGranted(false);
                                    setUseWalletForReads(false);
                                    setStatus({ kind: 'needs-autosign' });
                                }}
                            >
                                Reset auto-sign for this chat
                            </button>
                        )}
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
                            const sender = m.senderAddress?.toLowerCase();
                            const wallet = account?.address.toLowerCase();
                            const delegate = delegateAddr?.toLowerCase();
                            const mine =
                                sender === wallet ||
                                (!!delegate && sender === delegate);
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

            {status.kind === 'ready' && (
                <div className="chat-autosign-row">
                    {autoSignActive ? (
                        <button
                            type="button"
                            className={`chat-autosign-pill on ${resetArmed ? 'armed' : ''}`}
                            onClick={() => {
                                if (!account) return;
                                if (!resetArmed) {
                                    setResetArmed(true);
                                    window.setTimeout(
                                        () => setResetArmed(false),
                                        3500
                                    );
                                    return;
                                }
                                // Rotate the delegate keypair so the new grant
                                // tx targets a fresh address — avoids
                                // vec_set::insert aborts when re-enabling.
                                clearDelegate(account.address);
                                unmarkDelegateGranted(
                                    account.address,
                                    groupUuid
                                );
                                setDelegateGranted(false);
                                setUseWalletForReads(false);
                                setResetArmed(false);
                                setStatus({ kind: 'needs-autosign' });
                                // Force a small refresh so the context picks
                                // up the cleared delegate state.
                                window.setTimeout(
                                    () => window.location.reload(),
                                    50
                                );
                            }}
                            title="Auto-sign is on. Click twice to reset and rotate the delegate keypair (useful if reads are 403ing)."
                        >
                            <ShieldCheck size={12} />
                            <span>
                                {resetArmed
                                    ? 'Click again to confirm reset'
                                    : 'Auto-sign on · click to reset'}
                            </span>
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="chat-autosign-pill off"
                            onClick={handleEnableAutoSign}
                            disabled={provisioning}
                            title="One wallet popup grants this chat permission to sign on your behalf. After that, every message is signed silently by a local key."
                        >
                            {provisioning ? (
                                <>
                                    <RefreshCw size={12} className="spin" />
                                    Provisioning…
                                </>
                            ) : (
                                <>
                                    <Zap size={12} />
                                    Enable auto-sign · 1 tx, then no popups
                                </>
                            )}
                        </button>
                    )}
                </div>
            )}
            {provisionError && status.kind === 'ready' && (
                <div className="alert alert-error" style={{ margin: '0 14px 8px', fontSize: 12 }}>
                    {provisionError}
                </div>
            )}

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
