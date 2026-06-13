// GlobalAgentFeed — live, public, on-chain audit feed of every agent
// decision recorded across DeepMarket. Reads AgentDecisionMade events
// directly off Sui testnet — no indexer, no server, no mocks. Each row is
// a real tx digest you can verify on suiscan.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSuiClient } from '@mysten/dapp-kit';
import {
    ArrowLeft,
    Activity,
    RefreshCw,
    ArrowUpRight,
    TrendingUp,
    TrendingDown,
    Pause,
    Brain,
} from 'lucide-react';
import {
    getAllRecentDecisions,
    type AgentDecision,
} from '../lib/agent-cap';
import {
    listAllOracles,
    getCachedTradeableOracles,
    type OracleSummary,
} from '../lib/predict';
import { CONFIG } from '../lib/config';

const POLL_MS = 30_000;
const FEED_LIMIT = 80;

function shortAddr(a: string | undefined): string {
    if (!a) return '—';
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function relativeTime(tsMs: number): string {
    const ageMs = Date.now() - tsMs;
    if (ageMs < 0) return 'just now';
    if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
    if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
    if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
    return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

function ActionPill({ d }: { d: AgentDecision }) {
    if (!d.isMint) {
        return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 700 }}>
                <Pause size={12} /> PASS
            </span>
        );
    }
    const color = d.directionUp ? 'var(--yes)' : 'var(--no)';
    const Icon = d.directionUp ? TrendingUp : TrendingDown;
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color, fontSize: '0.75rem', fontWeight: 700 }}>
            <Icon size={12} /> {d.directionUp ? 'UP' : 'DOWN'}
        </span>
    );
}

export default function GlobalAgentFeed() {
    const navigate = useNavigate();
    const sui = useSuiClient();
    const [decisions, setDecisions] = useState<AgentDecision[] | null>(null);
    const [oracleMap, setOracleMap] = useState<Map<string, OracleSummary>>(new Map());
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // MemWal memories (written by the bots' agents, independent of on-chain
    // AgentCap authorization). Pulled from the bot's read-only proxy endpoint.
    const [memories, setMemories] = useState<string[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        const loadMem = async () => {
            try {
                const res = await fetch(`${CONFIG.BOT_URL}/agent-memories?limit=40`);
                const data = await res.json();
                if (!cancelled) setMemories(Array.isArray(data.memories) ? data.memories : []);
            } catch {
                if (!cancelled) setMemories([]);
            }
        };
        loadMem();
        const id = setInterval(loadMem, POLL_MS);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const list = await getAllRecentDecisions(sui, FEED_LIMIT);
            setDecisions(list);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load agent decisions');
        } finally {
            setBusy(false);
        }
    }, [sui]);

    // Oracle metadata so we can display underlying symbol next to id.
    useEffect(() => {
        // Cached list paints instantly; network refresh runs in background.
        const cached = getCachedTradeableOracles();
        if (cached) {
            const m = new Map<string, OracleSummary>();
            for (const o of cached) m.set(o.oracle_id, o);
            setOracleMap(m);
        }
        void (async () => {
            try {
                const all = await listAllOracles();
                const m = new Map<string, OracleSummary>();
                for (const o of all) m.set(o.oracle_id, o);
                setOracleMap(m);
            } catch {
                /* non-fatal; we still render with ids */
            }
        })();
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, POLL_MS);
        return () => clearInterval(id);
    }, [load]);

    const mintCount = (decisions ?? []).filter((d) => d.isMint).length;
    const passCount = (decisions ?? []).filter((d) => !d.isMint).length;
    const upCount = (decisions ?? []).filter((d) => d.isMint && d.directionUp).length;
    const downCount = (decisions ?? []).filter((d) => d.isMint && !d.directionUp).length;
    const totalCover = (decisions ?? [])
        .filter((d) => d.isMint)
        .reduce((s, d) => s + d.coverUsd, 0);

    return (
        <div className="surface-page">
            <div className="predict-header">
                <div>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => navigate('/predict')}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10 }}
                    >
                        <ArrowLeft size={13} /> Back to Predict
                    </button>
                    <div className="predict-eyebrow">
                        <Activity size={14} />
                        <span>DeepMarket · Live AI Activity</span>
                    </div>
                    <h1 className="predict-title">Agent decision feed</h1>
                    <p className="predict-sub">
                        Every decision an AI agent has recorded on-chain via the AgentCap policy
                        object — public, tamper-proof, and queried straight from Sui testnet.
                        No indexer, no server. This is what "AI listening to the platform" looks
                        like when the listening is verifiable.
                    </p>
                </div>
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={load}
                    disabled={busy}
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                    <RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh
                </button>
            </div>

            {/* MemWal memories — the agents' narrative memory (Walrus-backed),
                written every tick regardless of on-chain AgentCap auth. */}
            <div style={{ marginTop: 8, marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Brain size={15} /> Agent memories
                    </span>
                    <span className="vault-muted" style={{ fontSize: '0.78rem' }}>
                        Walrus-backed (MemWal) · {memories?.length ?? 0}
                    </span>
                </div>
                {memories === null && <div className="vs-empty">Loading agent memories…</div>}
                {memories && memories.length === 0 && (
                    <div className="vs-empty">
                        No agent memories yet — start a bot strategy (and set MEMWAL creds on the bot)
                        and its decisions will stream here.
                    </div>
                )}
                {memories && memories.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {memories.map((mem, i) => {
                            const m = mem.match(/^\[([^\]]+)\]\s*(.*)$/);
                            const when = m?.[1];
                            let body = m?.[2] ?? mem;
                            // Pull the "agent 0x… " stamp into its own chip.
                            const am = body.match(/^agent (0x[0-9a-fA-F]+)\s+(.*)$/);
                            const agent = am?.[1];
                            if (am) body = am[2]!;
                            return (
                                <div
                                    key={i}
                                    style={{
                                        display: 'flex', gap: 10, padding: '10px 14px',
                                        border: '1px solid var(--border-base)', borderRadius: 10,
                                        fontSize: '0.85rem', lineHeight: 1.5, flexWrap: 'wrap',
                                    }}
                                >
                                    {when && (
                                        <span className="vault-muted" style={{ fontFamily: 'monospace', fontSize: '0.72rem', flexShrink: 0, whiteSpace: 'nowrap' }}>
                                            {when}
                                        </span>
                                    )}
                                    {agent && (
                                        <a
                                            href={`https://suiscan.xyz/testnet/account/${agent}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title={agent}
                                            style={{
                                                fontFamily: 'monospace', fontSize: '0.72rem', flexShrink: 0,
                                                color: 'var(--blue)', background: 'var(--bg-input)',
                                                padding: '1px 7px', borderRadius: 999, whiteSpace: 'nowrap',
                                            }}
                                        >
                                            {shortAddr(agent)}
                                        </a>
                                    )}
                                    <span>{body}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Aggregate counts */}
            {decisions && decisions.length > 0 && (
                <div
                    style={{
                        display: 'flex',
                        gap: 16,
                        flexWrap: 'wrap',
                        marginTop: 4,
                        marginBottom: 16,
                        padding: '12px 16px',
                        border: '1px solid var(--border-base)',
                        borderRadius: 12,
                        fontSize: '0.85rem',
                    }}
                >
                    <span><strong>{decisions.length}</strong> <span className="vault-muted">decisions</span></span>
                    <span style={{ color: 'var(--yes)' }}>{mintCount} mints</span>
                    <span className="vault-muted">{passCount} passes</span>
                    <span style={{ color: 'var(--yes)' }}>{upCount} UP</span>
                    <span style={{ color: 'var(--no)' }}>{downCount} DOWN</span>
                    <span className="vault-muted" style={{ marginLeft: 'auto' }}>
                        ${totalCover.toLocaleString(undefined, { maximumFractionDigits: 2 })} total cover · poll {POLL_MS / 1000}s
                    </span>
                </div>
            )}

            {error && <div className="vs-empty" style={{ marginTop: 16 }}>{error}</div>}
            {!decisions && !error && <div className="vs-empty" style={{ marginTop: 16 }}>Loading agent feed…</div>}
            {decisions && decisions.length === 0 && (
                <div className="vs-empty" style={{ marginTop: 16 }}>
                    No agent decisions recorded yet. Authorize an agent on /agent to be the first.
                </div>
            )}

            {decisions && decisions.length > 0 && (
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', borderRadius: 12 }}>
                <div
                    style={{
                        border: '1px solid var(--border-base)',
                        borderRadius: 12,
                        overflow: 'hidden',
                        minWidth: 680, /* keep columns full-width; the wrapper scrolls on phones */
                    }}
                >
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: '90px 110px 90px 110px 110px 90px 60px',
                            padding: '10px 14px',
                            borderBottom: '1px solid var(--border-base)',
                            fontSize: '0.74rem',
                            fontWeight: 700,
                            letterSpacing: 0.4,
                            color: 'var(--text-muted)',
                            textTransform: 'uppercase',
                        }}
                    >
                        <span>When</span>
                        <span>Agent</span>
                        <span>Action</span>
                        <span>Oracle</span>
                        <span>Strike</span>
                        <span>Cover</span>
                        <span style={{ textAlign: 'right' }}>Tx</span>
                    </div>
                    {decisions.map((d) => {
                        const o = oracleMap.get(d.oracleId);
                        return (
                            <div
                                key={`${d.digest}-${d.tsMs}-${d.capId}`}
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: '90px 110px 90px 110px 110px 90px 60px',
                                    padding: '12px 14px',
                                    borderBottom: '1px solid var(--border-base)',
                                    fontSize: '0.85rem',
                                    alignItems: 'center',
                                }}
                            >
                                <span className="vault-muted">{relativeTime(d.tsMs)}</span>
                                <span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
                                    {shortAddr(d.agent)}
                                </span>
                                <span><ActionPill d={d} /></span>
                                <span
                                    onClick={() => navigate(`/predict/${d.oracleId}`)}
                                    style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 1 }}
                                    title={d.oracleId}
                                >
                                    <span style={{ fontWeight: 600 }}>{o?.underlying_asset ?? 'BTC'}</span>
                                    <span className="vault-muted" style={{ fontSize: '0.7rem', fontFamily: 'monospace' }}>
                                        {d.oracleId.slice(0, 6)}…
                                    </span>
                                </span>
                                <span>
                                    {d.isMint
                                        ? `$${d.strikeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                                        : '—'}
                                </span>
                                <span>
                                    {d.isMint
                                        ? `$${d.coverUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                                        : '—'}
                                </span>
                                <span style={{ textAlign: 'right' }}>
                                    <a
                                        href={`https://suiscan.xyz/testnet/tx/${d.digest}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 2 }}
                                        title="View on SuiScan"
                                    >
                                        <ArrowUpRight size={13} />
                                    </a>
                                </span>
                            </div>
                        );
                    })}
                </div>
              </div>
            )}

            <div className="vault-muted" style={{ marginTop: 14, fontSize: '0.78rem', textAlign: 'center' }}>
                Every row is an on-chain AgentDecisionMade event. The rationale string is hashed
                to 32 bytes and committed — your agent's reasoning is verifiable post-hoc.
            </div>
        </div>
    );
}
