// AgentAuthorizePage — mint / view / revoke an on-chain AgentCap.
//
// The AgentCap is the user's on-chain authorization for the DeepMarket bot
// to trade on their behalf within a daily spend cap + expiry. Once minted,
// the bot auto-discovers it (via AgentCapCreated events) and records every
// decision on-chain. Revoking here stops the bot's next mint immediately —
// record_decision aborts on a revoked cap.

import { useCallback, useEffect, useState } from 'react';
import {
    useCurrentAccount,
    useSuiClient,
    useSignAndExecuteTransaction,
} from '@mysten/dapp-kit';
import { ShieldCheck, ShieldOff, Activity, AlertCircle } from 'lucide-react';
import {
    findAgentCapsByOwner,
    getDecisionLog,
    isCapActive,
    type AgentCapInfo,
    type AgentDecision,
} from '../lib/agent-cap';
import {
    buildCreateCapTx,
    buildRevokeCapTx,
} from '../lib/agent-cap-tx';

const DAY_MS = 24 * 60 * 60 * 1000;

export default function AgentAuthorizePage() {
    const account = useCurrentAccount();
    const sui = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();

    const [caps, setCaps] = useState<AgentCapInfo[] | null>(null);
    const [log, setLog] = useState<AgentDecision[]>([]);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);

    // Create-form state
    const [agentAddr, setAgentAddr] = useState('');
    const [dailyCap, setDailyCap] = useState('5');
    const [durationDays, setDurationDays] = useState('30');

    const load = useCallback(async () => {
        if (!account) {
            setCaps(null);
            return;
        }
        const found = await findAgentCapsByOwner(sui, account.address);
        setCaps(found);
        const active = found.find((c) => !c.revoked);
        if (active) {
            setLog(await getDecisionLog(sui, active.capId, 30));
        } else {
            setLog([]);
        }
    }, [account, sui]);

    useEffect(() => {
        void load();
        // Poll so the on-chain decision log + cap state stay live without a
        // manual refresh. The bot mints on a ~60s tick; 20s polling catches
        // new AgentDecisionMade events reasonably fast.
        const id = setInterval(() => void load(), 20_000);
        return () => clearInterval(id);
    }, [load]);

    const onCreate = async () => {
        if (!account) return;
        if (!/^0x[a-fA-F0-9]{64}$/.test(agentAddr.trim())) {
            setMsg('Enter a valid bot wallet address (0x + 64 hex chars).');
            return;
        }
        const capUsd = Number(dailyCap);
        const days = Number(durationDays);
        if (!(capUsd > 0) || !(days > 0)) {
            setMsg('Daily cap and duration must be positive numbers.');
            return;
        }
        setBusy(true);
        setMsg(null);
        try {
            const tx = buildCreateCapTx({
                agent: agentAddr.trim(),
                dailySpendCapUsd: capUsd,
                expiresAtMs: Date.now() + days * DAY_MS,
                allowedOracles: [],
            });
            await signAndExec({ transaction: tx });
            setMsg('✅ Agent authorized. The bot will pick up the cap shortly.');
            await load();
        } catch (e) {
            setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    const onRevoke = async (capId: string) => {
        setBusy(true);
        setMsg(null);
        try {
            await signAndExec({ transaction: buildRevokeCapTx(capId) });
            setMsg('🛑 Cap revoked. The bot stops minting on its next tick.');
            await load();
        } catch (e) {
            setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    if (!account) {
        return (
            <div className="page-wrap" style={{ maxWidth: 720, margin: '0 auto' }}>
                <h1 style={{ fontSize: '1.6rem', fontWeight: 800 }}>Authorize Agent</h1>
                <div className="alert alert-info" style={{ marginTop: 16 }}>
                    Connect your wallet to mint or manage an AgentCap.
                </div>
            </div>
        );
    }

    const activeCap = caps?.find((c) => isCapActive(c)) ?? null;
    const revokedCaps = caps?.filter((c) => !isCapActive(c)) ?? [];

    return (
        <div className="page-wrap" style={{ maxWidth: 720, margin: '0 auto' }}>
            <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: 6 }}>
                Authorize Agent
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
                An <strong>AgentCap</strong> is an on-chain policy object: it authorizes
                the bot's wallet to trade for you within a daily spend cap and expiry.
                Every decision the bot makes is logged on-chain. Revoke any time — the
                bot's next mint aborts on a revoked cap.
            </p>

            {msg && (
                <div
                    className={`alert ${msg.startsWith('❌') ? 'alert-error' : 'alert-info'}`}
                    style={{ marginBottom: 16 }}
                >
                    {msg}
                </div>
            )}

            {/* ACTIVE CAP */}
            {activeCap && (
                <div className="predict-mint-card" style={{ marginBottom: 16 }}>
                    {/* header row — title left, ACTIVE pill right */}
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

                    {/* key/value rows — flex so the value sits right next to the label */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: '0.84rem' }}>
                        {([
                            ['Cap object', <code key="c">{activeCap.capId.slice(0, 14)}…{activeCap.capId.slice(-6)}</code>],
                            ['Agent wallet', <code key="a">{activeCap.agent.slice(0, 14)}…{activeCap.agent.slice(-6)}</code>],
                            ['Daily spend cap', <strong key="d">${activeCap.dailySpendCapUsd.toFixed(2)}</strong>],
                            ['Expires', <span key="e">{new Date(activeCap.expiresAtMs).toLocaleString()}</span>],
                        ] as const).map(([label, value]) => (
                            <div key={label} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                                <span
                                    style={{
                                        color: 'var(--text-muted)',
                                        minWidth: 130,
                                        flexShrink: 0,
                                    }}
                                >
                                    {label}
                                </span>
                                {value}
                            </div>
                        ))}
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
                            onClick={() => onRevoke(activeCap.capId)}
                        >
                            <ShieldOff size={14} /> Revoke authorization
                        </button>
                    </div>
                </div>
            )}

            {/* CREATE FORM — only when no active cap */}
            {!activeCap && (
                <div className="predict-mint-card" style={{ marginBottom: 16 }}>
                    <strong style={{ fontSize: '1rem' }}>Authorize a new agent</strong>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '6px 0 14px' }}>
                        Find your bot wallet address in the Telegram bot menu (Bot trader → wallet).
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
            )}

            {/* ON-CHAIN DECISION LOG */}
            {activeCap && (
                <div className="predict-mint-card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <Activity size={16} />
                        <strong style={{ fontSize: '0.95rem' }}>On-chain decision log</strong>
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
            )}

            {/* REVOKED / EXPIRED HISTORY */}
            {revokedCaps.length > 0 && (
                <div style={{ marginTop: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                        <AlertCircle size={13} /> Past caps (revoked / expired)
                    </div>
                    {revokedCaps.map((c) => (
                        <div key={c.capId} style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            <code>{c.capId.slice(0, 12)}…</code> — {c.revoked ? 'revoked' : 'expired'},
                            cap ${c.dailySpendCapUsd.toFixed(2)}/day
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
