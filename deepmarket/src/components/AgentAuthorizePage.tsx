// AgentAuthorizePage — mint / view / revoke on-chain AgentCaps.
//
// An AgentCap is the user's on-chain authorization for a specific bot wallet to
// trade on their behalf within a daily spend cap + expiry. One owner can hold
// MANY caps — one per agent wallet (web bot, Telegram bot, a throwaway) — each
// with its own limits and its own on-chain decision log. The bot auto-discovers
// caps via AgentCapCreated events and records every decision on-chain. Revoking
// stops that agent's next mint immediately (record_decision aborts on a revoked
// cap) without touching the others.

import { useCallback, useEffect, useState } from 'react';
import {
    useCurrentAccount,
    useSuiClient,
    useSignAndExecuteTransaction,
} from '@mysten/dapp-kit';
import {
    ShieldCheck,
    ShieldOff,
    Activity,
    AlertCircle,
    CheckCircle2,
} from 'lucide-react';
import {
    findAgentCapsByOwner,
    getDecisionLog,
    isCapActive,
    type AgentCapInfo,
    type AgentDecision,
} from '../lib/agent-cap';
import { buildCreateCapTx, buildRevokeCapTx } from '../lib/agent-cap-tx';

const DAY_MS = 24 * 60 * 60 * 1000;

type Msg = { kind: 'ok' | 'err'; text: string } | null;

export default function AgentAuthorizePage() {
    const account = useCurrentAccount();
    const sui = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();

    const [caps, setCaps] = useState<AgentCapInfo[] | null>(null);
    const [logsByCap, setLogsByCap] = useState<Record<string, AgentDecision[]>>({});
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<Msg>(null);

    // Create-form state
    const [agentAddr, setAgentAddr] = useState('');
    const [dailyCap, setDailyCap] = useState('5');
    const [durationDays, setDurationDays] = useState('30');

    const load = useCallback(async () => {
        if (!account) {
            setCaps(null);
            setLogsByCap({});
            return;
        }
        const found = await findAgentCapsByOwner(sui, account.address);
        setCaps(found);
        // One decision log per active cap — each agent wallet has its own.
        const active = found.filter(isCapActive);
        const entries = await Promise.all(
            active.map(
                async (c) =>
                    [c.capId, await getDecisionLog(sui, c.capId, 30)] as const
            )
        );
        setLogsByCap(Object.fromEntries(entries));
    }, [account, sui]);

    useEffect(() => {
        void load();
        // Poll so the on-chain decision logs + cap states stay live. The bot
        // mints on a ~60s tick; 20s polling catches new events reasonably fast.
        const id = setInterval(() => void load(), 20_000);
        return () => clearInterval(id);
    }, [load]);

    const onCreate = async () => {
        if (!account) return;
        const addr = agentAddr.trim();
        if (!/^0x[a-fA-F0-9]{64}$/.test(addr)) {
            setMsg({ kind: 'err', text: 'Enter a valid bot wallet address (0x + 64 hex chars).' });
            return;
        }
        const capUsd = Number(dailyCap);
        const days = Number(durationDays);
        if (!(capUsd > 0) || !(days > 0)) {
            setMsg({ kind: 'err', text: 'Daily cap and duration must be positive numbers.' });
            return;
        }
        // Soft guard against authorizing the same wallet twice.
        if (
            caps?.some(
                (c) => isCapActive(c) && c.agent.toLowerCase() === addr.toLowerCase()
            )
        ) {
            setMsg({
                kind: 'err',
                text: 'That wallet already has an active cap. Revoke it first to change its limits.',
            });
            return;
        }
        setBusy(true);
        setMsg(null);
        try {
            const tx = buildCreateCapTx({
                agent: addr,
                dailySpendCapUsd: capUsd,
                expiresAtMs: Date.now() + days * DAY_MS,
                allowedOracles: [],
            });
            await signAndExec({ transaction: tx });
            setMsg({ kind: 'ok', text: 'Agent authorized. The bot will pick up the cap shortly.' });
            setAgentAddr('');
            await load();
        } catch (e) {
            setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
        } finally {
            setBusy(false);
        }
    };

    const onRevoke = async (capId: string) => {
        setBusy(true);
        setMsg(null);
        try {
            await signAndExec({ transaction: buildRevokeCapTx(capId) });
            setMsg({ kind: 'ok', text: 'Cap revoked. That agent stops minting on its next tick.' });
            await load();
        } catch (e) {
            setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
        } finally {
            setBusy(false);
        }
    };

    if (!account) {
        return (
            <div className="page-wrap" style={{ maxWidth: 720, margin: '0 auto' }}>
                <h1 style={{ fontSize: '1.6rem', fontWeight: 800 }}>Authorize Agents</h1>
                <div className="alert alert-info" style={{ marginTop: 16 }}>
                    Connect your wallet to mint or manage AgentCaps.
                </div>
            </div>
        );
    }

    const activeCaps = caps?.filter((c) => isCapActive(c)) ?? [];
    const revokedCaps = caps?.filter((c) => !isCapActive(c)) ?? [];

    return (
        <div className="page-wrap" style={{ maxWidth: 720, margin: '0 auto' }}>
            <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: 6 }}>
                Authorize Agents
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
                An <strong>AgentCap</strong> is an on-chain policy object: it authorizes
                one bot wallet to trade for you within a daily spend cap and expiry.
                Authorize <strong>multiple</strong> wallets — each gets its own limits and
                on-chain decision log. Revoke any one anytime; the bot's next mint on that
                cap aborts.
            </p>

            {msg && (
                <div
                    className={`alert ${msg.kind === 'err' ? 'alert-error' : 'alert-info'}`}
                    style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}
                >
                    {msg.kind === 'err' ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
                    <span>{msg.text}</span>
                </div>
            )}

            {/* ACTIVE CAPS — one card per authorized agent wallet */}
            {activeCaps.map((cap) => (
                <CapCard
                    key={cap.capId}
                    cap={cap}
                    log={logsByCap[cap.capId] ?? []}
                    busy={busy}
                    onRevoke={() => onRevoke(cap.capId)}
                />
            ))}

            {/* CREATE FORM — always available so you can add more agents */}
            <div className="predict-mint-card" style={{ marginBottom: 16 }}>
                <strong style={{ fontSize: '1rem' }}>
                    {activeCaps.length > 0 ? 'Authorize another agent' : 'Authorize a new agent'}
                </strong>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '6px 0 14px' }}>
                    Find a bot wallet address in the Telegram bot menu (Bot trader → wallet).
                    Each wallet you authorize trades under its own cap.
                </p>
                <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Bot wallet address</label>
                <input
                    className="input"
                    style={{ width: '100%', marginTop: 4, marginBottom: 12 }}
                    placeholder="0x…"
                    value={agentAddr}
                    onChange={(e) => setAgentAddr(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Daily cap (USD)</label>
                        <input
                            className="input"
                            style={{ width: '100%', marginTop: 4 }}
                            type="number"
                            min="0"
                            step="0.5"
                            value={dailyCap}
                            onChange={(e) => setDailyCap(e.target.value)}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Duration (days)</label>
                        <input
                            className="input"
                            style={{ width: '100%', marginTop: 4 }}
                            type="number"
                            min="1"
                            step="1"
                            value={durationDays}
                            onChange={(e) => setDurationDays(e.target.value)}
                        />
                    </div>
                </div>
                <button
                    className="btn btn-primary"
                    style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}
                    disabled={busy}
                    onClick={onCreate}
                >
                    <ShieldCheck size={14} /> {busy ? 'Authorizing…' : 'Authorize agent'}
                </button>
            </div>

            {/* REVOKED / EXPIRED HISTORY */}
            {revokedCaps.length > 0 && (
                <div style={{ marginTop: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                        <AlertCircle size={13} /> Past caps (revoked / expired)
                    </div>
                    {revokedCaps.map((c) => (
                        <div key={c.capId} style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            <code>{c.capId.slice(0, 12)}…</code> — {c.revoked ? 'revoked' : 'expired'},
                            agent <code>{c.agent.slice(0, 10)}…</code>, cap ${c.dailySpendCapUsd.toFixed(2)}/day
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function CapCard({
    cap,
    log,
    busy,
    onRevoke,
}: {
    cap: AgentCapInfo;
    log: AgentDecision[];
    busy: boolean;
    onRevoke: () => void;
}) {
    return (
        <div className="predict-mint-card" style={{ marginBottom: 16 }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 16,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ShieldCheck size={18} color="var(--yes)" />
                    <strong style={{ fontSize: '1rem' }}>Agent authorized</strong>
                </div>
                <span
                    style={{
                        fontSize: '0.66rem',
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        color: 'var(--yes)',
                        background: 'var(--yes-dim)',
                        border: '1px solid var(--yes-border)',
                        borderRadius: 100,
                        padding: '3px 10px',
                    }}
                >
                    ● ACTIVE
                </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: '0.84rem' }}>
                {([
                    ['Cap object', <code key="c">{cap.capId.slice(0, 14)}…{cap.capId.slice(-6)}</code>],
                    ['Agent wallet', <code key="a">{cap.agent.slice(0, 14)}…{cap.agent.slice(-6)}</code>],
                    ['Daily spend cap', <strong key="d">${cap.dailySpendCapUsd.toFixed(2)}</strong>],
                    ['Expires', <span key="e">{new Date(cap.expiresAtMs).toLocaleString()}</span>],
                ] as const).map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                        <span style={{ color: 'var(--text-muted)', minWidth: 130, flexShrink: 0 }}>
                            {label}
                        </span>
                        {value}
                    </div>
                ))}
            </div>

            {/* This cap's on-chain decision log */}
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-base)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <Activity size={15} />
                    <strong style={{ fontSize: '0.88rem' }}>On-chain decision log</strong>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        ({log.length})
                    </span>
                </div>
                {log.length === 0 ? (
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                        No decisions recorded yet. The bot logs each mint here.
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {log.map((d, i) => (
                            <div
                                key={`${d.digest}-${i}`}
                                style={{
                                    fontSize: '0.8rem',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    padding: '6px 0',
                                    borderBottom: '1px solid var(--border-base)',
                                }}
                            >
                                <span>
                                    {d.isMint ? (
                                        <strong style={{ color: d.directionUp ? 'var(--yes)' : 'var(--no)' }}>
                                            {d.directionUp ? '↑ UP' : '↓ DOWN'}
                                        </strong>
                                    ) : (
                                        <span style={{ color: 'var(--text-muted)' }}>pass</span>
                                    )}{' '}
                                    @ ${d.strikeUsd.toFixed(0)} · cover ${d.coverUsd.toFixed(2)}
                                </span>
                                <span style={{ color: 'var(--text-muted)' }}>
                                    {new Date(d.tsMs).toLocaleTimeString()}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div
                style={{
                    marginTop: 16,
                    paddingTop: 14,
                    borderTop: '1px solid var(--border-base)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                }}
            >
                <button
                    className="btn btn-danger"
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    disabled={busy}
                    onClick={onRevoke}
                >
                    <ShieldOff size={14} /> Revoke this agent
                </button>
            </div>
        </div>
    );
}
