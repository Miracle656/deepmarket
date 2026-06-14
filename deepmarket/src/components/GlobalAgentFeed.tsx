// GlobalAgentFeed — live, public, on-chain audit feed of every agent
// decision recorded across DeepMarket. Reads AgentDecisionMade events
// directly off Sui testnet — no indexer, no server, no mocks. Each row is
// a real tx digest you can verify on suiscan.

import { useCallback, useEffect, useMemo, useState } from 'react';
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
    ShieldCheck,
    ShieldAlert,
    ExternalLink,
    Bot,
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

// A MemWal memory parsed into structured fields for correlating with on-chain
// decisions and verifying the rationale against the committed hash.
interface ParsedMemory {
    agent?: string;   // lowercase wallet
    tsMs: number;
    rationale?: string;
    raw: string;
}

// A memory as returned by the bot's /agent-memories endpoint.
interface MemoryItem {
    text: string;
    /** Walrus blob id of the (Seal-encrypted) memory blob. */
    blobId?: string;
}

/** Walrus blob explorer (Walruscan) link for a blob id. */
function walruscanUrl(blobId: string): string {
    return `https://walruscan.com/testnet/blob/${blobId}`;
}

function parseMemory(mem: string): ParsedMemory {
    const m = mem.match(/^\[([^\]]+)\]\s*(.*)$/);
    const when = m?.[1];
    let body = m?.[2] ?? mem;
    const am = body.match(/^agent (0x[0-9a-fA-F]+)\s+(.*)$/);
    const agent = am?.[1]?.toLowerCase();
    if (am) body = am[2]!;
    const rm = body.match(/Rationale at entry:\s*(.+)$/);
    const tsMs = when ? Date.parse(`${when.replace(' ', 'T')}Z`) : NaN;
    return { agent, tsMs: isNaN(tsMs) ? 0 : tsMs, rationale: rm?.[1]?.trim(), raw: mem };
}

/** SHA-256 of a UTF-8 string → lowercase hex (matches the bot's commit). */
async function sha256Hex(s: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
    // Each carries its Walrus blob id so we can deep-link to the encrypted blob.
    const [memories, setMemories] = useState<MemoryItem[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        const loadMem = async () => {
            try {
                const res = await fetch(`${CONFIG.BOT_URL}/agent-memories?limit=40`);
                const data = await res.json();
                const raw: unknown[] = Array.isArray(data.memories) ? data.memories : [];
                // Tolerate both the new {text, blobId} shape and the old string[].
                const items: MemoryItem[] = raw.map((m) =>
                    typeof m === 'string'
                        ? { text: m }
                        : { text: String((m as MemoryItem).text ?? ''), blobId: (m as MemoryItem).blobId },
                );
                if (!cancelled) setMemories(items);
            } catch {
                if (!cancelled) setMemories([]);
            }
        };
        loadMem();
        const id = setInterval(loadMem, POLL_MS);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    // Parsed memories + match each on-chain decision to its memory (same agent
    // wallet, closest timestamp within a day).
    const memParsed = useMemo(() => (memories ?? []).map((m) => parseMemory(m.text)), [memories]);
    const matchMemory = useCallback(
        (d: AgentDecision): ParsedMemory | null => {
            if (!d.agent) return null;
            const agent = d.agent.toLowerCase();
            let best: ParsedMemory | null = null;
            let bestDiff = Infinity;
            for (const p of memParsed) {
                if (p.agent !== agent || !p.rationale) continue;
                const diff = Math.abs(p.tsMs - d.tsMs);
                if (diff < bestDiff) { bestDiff = diff; best = p; }
            }
            return best && bestDiff < 24 * 3_600_000 ? best : null;
        },
        [memParsed]
    );

    // Verify each matched rationale against the on-chain sha256 commitment.
    const [verifyMap, setVerifyMap] = useState<Record<string, 'verified' | 'mismatch'>>({});
    useEffect(() => {
        if (!decisions || memParsed.length === 0) return;
        let cancelled = false;
        (async () => {
            const next: Record<string, 'verified' | 'mismatch'> = {};
            for (const d of decisions) {
                if (!d.rationaleHash) continue;
                const mem = matchMemory(d);
                if (!mem?.rationale) continue;
                try {
                    const h = await sha256Hex(mem.rationale);
                    next[d.digest] = h === d.rationaleHash ? 'verified' : 'mismatch';
                } catch { /* ignore */ }
            }
            if (!cancelled) setVerifyMap(next);
        })();
        return () => { cancelled = true; };
    }, [decisions, memParsed, matchMemory]);

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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => navigate('/agent')}
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                        title="Authorize an AI agent on-chain (AgentCap)"
                    >
                        <ShieldCheck size={14} /> Authorize agent
                    </button>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={load}
                        disabled={busy}
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                        <RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh
                    </button>
                </div>
            </div>

            {/* MemWal memories — the agents' narrative memory (Walrus-backed),
                written every tick regardless of on-chain AgentCap auth. */}
            <div style={{ marginTop: 8, marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Brain size={15} /> Agent memories
                    </span>
                    <span className="vault-muted" style={{ fontSize: '0.78rem' }}>
                        Encrypted on Walrus via MemWal · {memories?.length ?? 0}
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
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                            gap: 10,
                        }}
                    >
                        {memories.map((mem, i) => {
                            const p = memParsed[i];
                            const m = mem.text.match(/^\[([^\]]+)\]\s*(.*)$/);
                            const whenRaw = m?.[1];
                            let body = m?.[2] ?? mem.text;
                            // Pull the "agent 0x… " stamp into its own chip.
                            const am = body.match(/^agent (0x[0-9a-fA-F]+)\s+(.*)$/);
                            const agent = am?.[1];
                            if (am) body = am[2]!;
                            const rel = p && p.tsMs ? relativeTime(p.tsMs) : null;
                            return (
                                <div
                                    key={i}
                                    style={{
                                        display: 'flex', flexDirection: 'column', gap: 8,
                                        padding: '12px 14px',
                                        border: '1px solid var(--border-base)', borderRadius: 12,
                                        background: 'var(--bg-input)',
                                    }}
                                >
                                    {/* meta row */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        {agent ? (
                                            <a
                                                href={`https://suiscan.xyz/testnet/account/${agent}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                title={agent}
                                                style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                    fontFamily: 'monospace', fontSize: '0.72rem',
                                                    color: 'var(--blue)', background: 'var(--bg-card, rgba(125,125,125,0.12))',
                                                    padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                                                    textDecoration: 'none',
                                                }}
                                            >
                                                <Bot size={11} /> {shortAddr(agent)}
                                            </a>
                                        ) : (
                                            <span
                                                className="vault-muted"
                                                style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                    fontSize: '0.72rem', padding: '2px 8px',
                                                    borderRadius: 999, background: 'var(--bg-card, rgba(125,125,125,0.12))',
                                                }}
                                            >
                                                <Bot size={11} /> agent
                                            </span>
                                        )}
                                        {rel && (
                                            <span
                                                className="vault-muted"
                                                title={whenRaw}
                                                style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}
                                            >
                                                {rel}
                                            </span>
                                        )}
                                        {mem.blobId && (
                                            <a
                                                href={walruscanUrl(mem.blobId)}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                title={`View encrypted blob on Walruscan\n${mem.blobId}`}
                                                style={{
                                                    marginLeft: 'auto',
                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                    fontSize: '0.72rem', color: 'var(--blue)',
                                                    textDecoration: 'none', whiteSpace: 'nowrap',
                                                }}
                                            >
                                                <ExternalLink size={11} /> Walrus
                                            </a>
                                        )}
                                    </div>
                                    {/* body */}
                                    <div style={{ fontSize: '0.85rem', lineHeight: 1.55 }}>{body}</div>
                                </div>
                            );
                        })}
                    </div>
                )}
                <p className="vault-muted" style={{ fontSize: '0.72rem', marginTop: 10 }}>
                    Memories are Seal-encrypted before upload, so the Walrus blob shows ciphertext —
                    the plaintext you see here is decrypted server-side by the bot's delegate key.
                </p>
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
                        const mem = matchMemory(d);
                        const v = verifyMap[d.digest];
                        return (
                          <div key={`${d.digest}-${d.tsMs}-${d.capId}`} style={{ borderBottom: '1px solid var(--border-base)' }}>
                            <div
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: '90px 110px 90px 110px 110px 90px 60px',
                                    padding: '12px 14px',
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
                            {(mem?.rationale || v) && (
                                <div style={{ padding: '0 14px 11px', fontSize: '0.78rem', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                                    {v === 'verified' && (
                                        <span style={{ color: 'var(--yes)', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                                            <ShieldCheck size={13} /> rationale verified
                                        </span>
                                    )}
                                    {v === 'mismatch' && (
                                        <span style={{ color: 'var(--no)', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }} title="The MemWal rationale doesn't hash to the on-chain commitment">
                                            <ShieldAlert size={13} /> hash mismatch
                                        </span>
                                    )}
                                    {!v && d.rationaleHash && mem?.rationale && (
                                        <span className="vault-muted" style={{ flexShrink: 0 }}>verifying…</span>
                                    )}
                                    {mem?.rationale && (
                                        <span className="vault-muted" style={{ fontStyle: 'italic' }}>"{mem.rationale}"</span>
                                    )}
                                </div>
                            )}
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
