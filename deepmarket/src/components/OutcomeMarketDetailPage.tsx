import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useSignAndExecuteTransaction, useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { ArrowLeft, Trophy, Loader2, Zap, BarChart2, Info } from 'lucide-react';
import { useToast } from '../lib/toast';
import { CONFIG } from '../lib/config';
import {
    fetchOutcomeMarket,
    buildBuyTx,
    buildResolveTx,
    buildRedeemTx,
    recordPriceSnapshot,
    loadPriceSnapshots,
    type OutcomeMarketData,
} from '../lib/outcome';
import {
    buildEnableOutcomeTradingTx,
    buildOutcomeLimitOrderTx,
    buildClaimBalancesTx,
    buildSyncDeepPriceTx,
    fetchPoolFills,
    isZeroPool,
    type PoolFill,
} from '../lib/outcomeTrade';
import { getUserBalanceManager } from '../lib/accountModule';
import { getYesPercentFromPool } from '../lib/poolPricing';
import OutcomeProbChart, { type ChartSeries } from './OutcomeProbChart';
import OrderBook from './OrderBook';

const SUI = 1_000_000_000n;

// Distinct colours per outcome (cycled), à la Polymarket's multi-line legend.
const OUTCOME_COLORS = ['#1E6EF3', '#22C55E', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4', '#EC4899', '#84CC16'];
const colorFor = (i: number) => OUTCOME_COLORS[i % OUTCOME_COLORS.length];

function fmtSui(raw: bigint): string {
    const whole = raw / SUI;
    const frac = Number(raw % SUI) / 1e9;
    return (Number(whole) + frac).toFixed(frac === 0 ? 0 : 4);
}

function fmtDate(ms: number): string {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function OutcomeMarketDetailPage() {
    const { marketId } = useParams<{ marketId: string }>();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const acct = useCurrentAccount();
    const suiClient = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();
    const { toast } = useToast();

    const [market, setMarket] = useState<OutcomeMarketData | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [isAdmin, setIsAdmin] = useState(false);
    const [managerId, setManagerId] = useState<string | null>(null);
    const [poolPct, setPoolPct] = useState<Record<number, number | null>>({});
    const [fills, setFills] = useState<PoolFill[]>([]);
    const [leftTab, setLeftTab] = useState<'outcomes' | 'chart' | 'book' | 'activity'>('outcomes');

    // Ticket state.
    const [selected, setSelected] = useState(0);
    const [panelTab, setPanelTab] = useState<'stake' | 'order'>('stake');
    const [stakeAmt, setStakeAmt] = useState('');
    const [orderPx, setOrderPx] = useState('');
    const [orderQty, setOrderQty] = useState('');

    const refresh = useCallback(async () => {
        if (!marketId) return;
        const m = await fetchOutcomeMarket(suiClient, marketId);
        setMarket(m);
        setLoading(false);
        if (m) {
            const entries = await Promise.all(
                m.pools.map(async (p, i) =>
                    [i, isZeroPool(p) ? null : await getYesPercentFromPool(suiClient as any, p)] as const,
                ),
            );
            setPoolPct(Object.fromEntries(entries));
            if (m.pools.some(p => !isZeroPool(p))) {
                fetchPoolFills(suiClient as any, m.pools).then(setFills).catch(() => setFills([]));
            }
        }
    }, [marketId, suiClient]);

    useEffect(() => { refresh(); }, [refresh]);

    // Honour a ?o=<idx> deep-link to pre-select an outcome (from the card).
    useEffect(() => {
        const o = searchParams.get('o');
        if (o != null && market) {
            const idx = parseInt(o);
            if (!isNaN(idx) && idx >= 0 && idx < market.n) setSelected(idx);
        }
    }, [searchParams, market]);

    useEffect(() => {
        if (!acct) { setManagerId(null); return; }
        getUserBalanceManager(suiClient, acct.address).then(setManagerId).catch(() => setManagerId(null));
    }, [acct, suiClient]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!acct) { setIsAdmin(false); return; }
            try {
                const cap = await suiClient.getObject({ id: CONFIG.ADMIN_CAP_OBJECT_ID, options: { showOwner: true } });
                const owner = cap.data?.owner;
                const addr = owner && typeof owner === 'object' && 'AddressOwner' in owner
                    ? (owner as { AddressOwner: string }).AddressOwner : null;
                if (!cancelled) setIsAdmin(addr === acct.address);
            } catch {
                if (!cancelled) setIsAdmin(false);
            }
        })();
        return () => { cancelled = true; };
    }, [acct, suiClient]);

    const totalPool = market ? market.totalStaked.reduce((s, v) => s + v, 0n) : 0n;
    const hasPools = market ? market.pools.some(p => !isZeroPool(p)) : false;
    const resolved = market?.status === 1;

    // Latest fill price per outcome (fills are newest-first, so first wins).
    const lastPriceByIdx: Record<number, number> = {};
    if (market) {
        for (const f of fills) {
            const idx = market.pools.indexOf(f.poolId);
            if (idx >= 0 && lastPriceByIdx[idx] === undefined) lastPriceByIdx[idx] = f.price;
        }
    }

    // Display probability for outcome i: live order-book mid → last traded
    // price → parimutuel stake share. Returns 0–100.
    const displayPct = (i: number): number => {
        if (!market) return 0;
        const book = poolPct[i];
        if (book != null) return book;
        const last = lastPriceByIdx[i];
        if (last != null) return Math.round(last * 100);
        return totalPool > 0n ? Number((market.totalStaked[i] * 10000n) / totalPool) / 100 : 0;
    };

    // Parimutuel share of the pool (separate signal from the order-book price).
    const stakeSharePct = (i: number): number =>
        market && totalPool > 0n ? Number((market.totalStaked[i] * 10000n) / totalPool) / 100 : 0;
    // True when the headline % comes from the order book / last trade, not the
    // stake share — i.e. when it's worth also showing the stake share.
    const isMarketPriced = (i: number): boolean => poolPct[i] != null || lastPriceByIdx[i] != null;

    const DUAL_HINT =
        'Headline = live market price (order-book mid, or last trade). ' +
        '"staked" = this outcome\'s share of the parimutuel pool. ' +
        'They can differ — the order book reflects current sentiment, while the ' +
        'final payout is your pro-rata share of the whole pool.';

    // Snapshot each outcome's current % so resting-order mid moves (not just
    // fills) accumulate into the chart over time. Only record a *real market
    // price* (order-book mid or last trade) — never the parimutuel fallback,
    // which would zig-zag the line when the live mid read momentarily misses.
    useEffect(() => {
        if (!market || !marketId) return;
        for (let i = 0; i < market.n; i++) {
            const mp = poolPct[i] != null ? poolPct[i]! : (lastPriceByIdx[i] != null ? Math.round(lastPriceByIdx[i] * 100) : null);
            if (mp != null) recordPriceSnapshot(marketId, i, mp);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [market, poolPct, fills, marketId]);

    // ── Actions ──────────────────────────────────────────────────────────
    const handleStake = async () => {
        if (!acct) return toast('error', 'Connect your wallet first');
        if (!market) return;
        const amt = parseFloat(stakeAmt || '0');
        if (!amt || amt <= 0) return toast('error', 'Enter a SUI amount');
        setBusy(true);
        try {
            const tx = buildBuyTx(acct.address, market, selected, BigInt(Math.floor(amt * 1e9)));
            const r = await signAndExec({ transaction: tx });
            await suiClient.waitForTransaction({ digest: r.digest });
            toast('success', 'Stake placed', `${amt} SUI on ${market.outcomeNames[selected]}`);
            setStakeAmt('');
            await refresh();
        } catch (e: any) {
            console.error(e);
            toast('error', 'Stake failed', e.message);
        } finally {
            setBusy(false);
        }
    };

    const handleLimitOrder = async (isBid: boolean) => {
        if (!acct || !market || !managerId) return;
        const poolId = market.pools[selected];
        if (isZeroPool(poolId)) return toast('error', 'No order book for this outcome');
        const px = parseFloat(orderPx || '0');
        const qty = parseFloat(orderQty || '0');
        if (!(px > 0) || !(qty > 0)) return toast('error', 'Enter a price (0–1) and quantity');
        setBusy(true);
        try {
            const tx = await buildOutcomeLimitOrderTx(suiClient as any, acct.address, managerId, poolId, isBid, px, qty);
            const r = await signAndExec({ transaction: tx });
            await suiClient.waitForTransaction({ digest: r.digest });
            toast('success', `${isBid ? 'Bid' : 'Ask'} posted`, `${qty} ${market.outcomeNames[selected]} @ ${px} SUI`);
            setOrderPx(''); setOrderQty('');
            await refresh();
        } catch (e: any) {
            console.error(e);
            toast('error', 'Order failed', e.message);
        } finally {
            setBusy(false);
        }
    };

    const handleResolve = async (idx: number) => {
        if (!acct || !market) return;
        if (!confirm(`Resolve "${market.question}" → ${market.outcomeNames[idx]} wins? This is final.`)) return;
        setBusy(true);
        try {
            const tx = buildResolveTx(acct.address, market, idx);
            const r = await signAndExec({ transaction: tx });
            await suiClient.waitForTransaction({ digest: r.digest });
            toast('success', 'Market resolved', `${market.outcomeNames[idx]} wins`);
            await refresh();
        } catch (e: any) {
            console.error(e);
            toast('error', 'Resolve failed', e.message);
        } finally {
            setBusy(false);
        }
    };

    const handleRedeem = async () => {
        if (!acct || !market || market.winner === null) return;
        setBusy(true);
        try {
            const { tx, tokenAmount } = await buildRedeemTx(suiClient, acct.address, market, market.winner);
            const r = await signAndExec({ transaction: tx });
            await suiClient.waitForTransaction({ digest: r.digest });
            toast('success', 'Redeemed', `Burned ${fmtSui(tokenAmount)} winning tokens for your pool share`);
            await refresh();
        } catch (e: any) {
            console.error(e);
            toast('error', 'Redeem failed', e.message);
        } finally {
            setBusy(false);
        }
    };

    const handleSyncDeepPrice = async () => {
        if (!acct || !market) return;
        const poolId = market.pools[selected];
        if (isZeroPool(poolId)) return toast('error', 'No order book for this outcome');
        setBusy(true);
        try {
            const tx = await buildSyncDeepPriceTx(suiClient as any, acct.address, poolId);
            const r = await signAndExec({ transaction: tx });
            await suiClient.waitForTransaction({ digest: r.digest });
            toast('success', 'DEEP price synced', `${market.outcomeNames[selected]} pool can now price fees`);
        } catch (e: any) {
            const msg = String(e?.message ?? '');
            if (/abort code: 1|DataPointRecentlyAdded/i.test(msg)) {
                toast('success', 'Already primed', 'This pool already has a fresh DEEP price point.');
            } else {
                toast('error', 'Sync failed', msg || 'Unknown error');
            }
        } finally {
            setBusy(false);
        }
    };

    const handleClaim = async () => {
        if (!acct || !market || !managerId) return;
        const poolId = market.pools[selected];
        if (isZeroPool(poolId)) return toast('error', 'No order book for this outcome');
        setBusy(true);
        try {
            const tx = await buildClaimBalancesTx(suiClient as any, acct.address, managerId, poolId);
            const r = await signAndExec({ transaction: tx });
            await suiClient.waitForTransaction({ digest: r.digest });
            toast('success', 'Balances claimed', 'Filled proceeds withdrawn to your wallet');
            await refresh();
        } catch (e: any) {
            console.error(e);
            toast('error', 'Claim failed', e.message);
        } finally {
            setBusy(false);
        }
    };

    const handleEnableTrading = async () => {
        if (!acct || !market) return toast('error', 'Connect your wallet first');
        setBusy(true);
        try {
            const livePools = market.pools.filter(p => !isZeroPool(p));
            const tx = await buildEnableOutcomeTradingTx(suiClient as any, acct.address, managerId, livePools);
            const r = await signAndExec({ transaction: tx });
            await suiClient.waitForTransaction({ digest: r.digest });
            toast('success', 'Trading enabled', 'Account set up and pools can price fees.');
            for (let i = 0; i < 6; i++) {
                await new Promise(res => setTimeout(res, 2000));
                const id = await getUserBalanceManager(suiClient, acct.address);
                if (id) { setManagerId(id); break; }
            }
        } catch (e: any) {
            const msg = String(e?.message ?? '');
            if (/abort code: 1|DataPointRecentlyAdded/i.test(msg)) {
                toast('success', 'Trading already enabled', 'Pools are ready to trade.');
                const id = await getUserBalanceManager(suiClient, acct.address);
                if (id) setManagerId(id);
            } else {
                toast('error', 'Could not enable trading', msg || 'Unknown error');
            }
        } finally {
            setBusy(false);
        }
    };

    // ── Render ───────────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="empty-state" style={{ paddingTop: 100 }}>
                <div className="empty-icon"><Loader2 size={40} className="spin" /></div>
                <div className="empty-title">Loading market…</div>
            </div>
        );
    }
    if (!market) {
        return (
            <div className="empty-state" style={{ paddingTop: 100 }}>
                <div className="empty-title">Market not found</div>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/markets')} style={{ marginTop: 12 }}>
                    Back to markets
                </button>
            </div>
        );
    }

    const selPool = market.pools[selected];
    const selHasPool = !isZeroPool(selPool);
    const canOrder = selHasPool && !!managerId && !resolved;

    // Build multi-line chart series, merging two time sources per outcome:
    //   • on-chain fills (trades)               — price at trade time
    //   • localStorage snapshots (mid over time) — captures resting-order moves
    // plus a trailing "now" point at the current %, and a flat lead-in so every
    // line spans the axis.
    const nowSec = Math.floor(Date.now() / 1000);
    const chartSeries: ChartSeries[] = market.outcomeNames.map((name, i) => {
        const fillPts = fills
            .filter(f => market.pools.indexOf(f.poolId) === i)
            .map(f => ({ time: Math.floor(f.ts / 1000), value: Math.round(f.price * 100) }));
        const snapPts = marketId ? loadPriceSnapshots(marketId, i) : [];
        // Trailing point: prefer the live market price; else the last snapshot;
        // else the parimutuel fallback — so the line doesn't spike at the edge.
        const mp = poolPct[i] != null ? poolPct[i]! : (lastPriceByIdx[i] != null ? Math.round(lastPriceByIdx[i] * 100) : null);
        const cur = mp != null ? mp : (snapPts.length ? snapPts[snapPts.length - 1].value : Math.round(displayPct(i)));

        // Merge + sort + de-dupe to one point per timestamp (snapshots win ties).
        const byTime = new Map<number, number>();
        for (const p of fillPts) byTime.set(p.time, p.value);
        for (const p of snapPts) byTime.set(p.time, p.value);
        byTime.set(nowSec, cur);
        const merged = [...byTime.entries()].map(([time, value]) => ({ time, value })).sort((a, b) => a.time - b.time);

        // Flat lead-in so a fresh market still draws a full-width line.
        const firstT = merged[0]?.time ?? nowSec;
        const lead = { time: Math.min(firstT - 60, nowSec - 3600), value: merged[0]?.value ?? cur };
        return { name, color: colorFor(i), data: [lead, ...merged] };
    });

    return (
        <div className="main-layout om-layout">
            {/* ── LEFT: header + outcomes list ── */}
            <div className="content-area om-detail">
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => navigate('/markets')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10 }}
                >
                    <ArrowLeft size={14} /> All Markets
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                    <span className="market-card-tag">MULTI-OUTCOME</span>
                    <span className="market-card-tag" style={{ color: 'var(--text-muted)' }}>{market.n} OUTCOMES</span>
                    <span
                        className="market-card-tag"
                        style={{
                            color: hasPools ? 'var(--yes)' : 'var(--text-muted)',
                            borderColor: hasPools ? 'var(--yes-border)' : 'var(--border-base)',
                            background: hasPools ? 'var(--yes-dim)' : 'transparent',
                        }}
                    >
                        {hasPools ? 'ORDER BOOK' : 'MINT ONLY'}
                    </span>
                    {resolved && (
                        <span className="market-card-tag" style={{ color: 'var(--yes)', borderColor: 'var(--yes-border)', background: 'var(--yes-dim)' }}>
                            RESOLVED
                        </span>
                    )}
                </div>

                <h1 style={{ margin: '2px 0 4px', fontSize: '1.3rem', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
                    {market.question}
                </h1>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 10 }}>
                    <span>{fmtSui(market.vault)} SUI pool</span>
                    <span>·</span>
                    <span>Closes {fmtDate(market.resolutionTime)}</span>
                    <span>·</span>
                    <span style={{ color: resolved ? 'var(--yes)' : 'var(--blue)' }}>{resolved ? 'Resolved' : 'Active'}</span>
                </div>

                {hasPools && !resolved && !managerId && (
                    <div className="alert alert-info" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <span>This market has live order books. Enable trading once to set up your DeepBook account.</span>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={handleEnableTrading}
                            disabled={busy || !acct}
                            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        >
                            <Zap size={14} /> {busy ? 'Enabling…' : 'Enable trading'}
                        </button>
                    </div>
                )}

                {/* Outcomes / Chart / Order Book / Activity tabs */}
                <div className="om-tabs">
                    {(['outcomes', 'chart', 'book', 'activity'] as const).map(t => (
                        <button
                            key={t}
                            className={`om-tab ${leftTab === t ? 'active' : ''}`}
                            onClick={() => setLeftTab(t)}
                        >
                            {t === 'outcomes' ? 'Outcomes'
                                : t === 'chart' ? 'Chart'
                                : t === 'book' ? 'Order Book'
                                : `Activity${fills.length ? ` (${fills.length})` : ''}`}
                        </button>
                    ))}
                </div>

                {leftTab === 'chart' ? (
                    <div style={{ paddingTop: 14 }}>
                        <OutcomeProbChart series={chartSeries} />
                    </div>
                ) : leftTab === 'book' ? (
                    <div style={{ paddingTop: 14 }}>
                        {/* Outcome picker — the book is per-pool, so choose which one. */}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                            {market.outcomeNames.map((name, i) => (
                                <button
                                    key={i}
                                    onClick={() => setSelected(i)}
                                    disabled={isZeroPool(market.pools[i])}
                                    className={`filter-btn ${selected === i ? 'active' : ''}`}
                                    style={{ opacity: isZeroPool(market.pools[i]) ? 0.4 : 1 }}
                                >
                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: colorFor(i), display: 'inline-block', marginRight: 6 }} />
                                    {name}
                                </button>
                            ))}
                        </div>
                        <OrderBook yesPoolId={market.pools[selected] ?? ''} />
                    </div>
                ) : leftTab === 'activity' ? (
                    <div className="om-activity">
                        {fills.length === 0 ? (
                            <div className="empty-state" style={{ padding: '40px 0' }}>
                                <div className="empty-title">No trades yet</div>
                                <div className="empty-desc">Order-book fills on this market's pools will show here.</div>
                            </div>
                        ) : (
                            <>
                                <div className="om-act-head">
                                    <span>Outcome</span><span>Price</span><span>Size</span><span>Time</span>
                                </div>
                                {fills.map((f, k) => {
                                    const idx = market.pools.indexOf(f.poolId);
                                    const nm = idx >= 0 ? market.outcomeNames[idx] : 'Outcome';
                                    return (
                                        <a
                                            key={k}
                                            className="om-act-row"
                                            href={`https://suiscan.xyz/testnet/tx/${f.digest}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <span className="om-dot" style={{ background: colorFor(idx) }} />{nm}
                                            </span>
                                            <span style={{ color: colorFor(idx), fontWeight: 700 }}>{Math.round(f.price * 100)}¢</span>
                                            <span>{f.baseQty.toFixed(2)}</span>
                                            <span style={{ color: 'var(--text-muted)' }}>{f.ts ? new Date(f.ts).toLocaleTimeString() : '—'}</span>
                                        </a>
                                    );
                                })}
                            </>
                        )}
                    </div>
                ) : (
                <div className="om-list">
                    {market.outcomeNames.map((name, i) => {
                        const pct = displayPct(i);
                        const staked = market.totalStaked[i] ?? 0n;
                        const isWinner = resolved && market.winner === i;
                        const isSel = selected === i;
                        const c = colorFor(i);
                        return (
                            <div
                                key={i}
                                className={`om-row ${isSel ? 'om-row-selected' : ''}`}
                                onClick={() => setSelected(i)}
                            >
                                <div className="om-row-main">
                                    <span className="om-dot" style={{ background: c }} />
                                    <div className="om-row-name">
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
                                            {isWinner && <Trophy size={15} style={{ color: 'var(--yes)' }} />}
                                            {name}
                                        </div>
                                        <div className="om-row-sub">{fmtSui(staked)} SUI staked</div>
                                    </div>
                                </div>

                                <div className="om-row-pct" style={{ color: c, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
                                    <span>{pct.toFixed(1)}%</span>
                                    {isMarketPriced(i) && (
                                        <span
                                            title={DUAL_HINT}
                                            style={{ fontSize: '0.66rem', fontWeight: 600, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 2, cursor: 'help' }}
                                        >
                                            {stakeSharePct(i).toFixed(0)}% staked <Info size={10} />
                                        </span>
                                    )}
                                </div>

                                <div className="om-row-actions" onClick={e => e.stopPropagation()}>
                                    {!resolved ? (
                                        <button
                                            className="om-buy-btn"
                                            onClick={() => { setSelected(i); setPanelTab('stake'); }}
                                        >
                                            Buy {Math.round(pct)}¢
                                        </button>
                                    ) : isWinner ? (
                                        <span className="market-card-tag" style={{ color: 'var(--yes)', borderColor: 'var(--yes-border)', background: 'var(--yes-dim)' }}>WON</span>
                                    ) : (
                                        <span className="market-card-tag" style={{ color: 'var(--text-muted)' }}>—</span>
                                    )}
                                    {isAdmin && !resolved && (
                                        <button
                                            className="om-win-btn"
                                            onClick={() => handleResolve(i)}
                                            disabled={busy}
                                            title="Admin: set this outcome as the winner"
                                        >
                                            Win
                                        </button>
                                    )}
                                </div>

                                <div className="om-row-bar">
                                    <div style={{ width: `${pct}%`, background: c }} />
                                </div>
                            </div>
                        );
                    })}
                </div>
                )}

                <div style={{ marginTop: 16, fontSize: '0.72rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                    Market object: {market.objectId}
                </div>
            </div>

            {/* ── RIGHT: trade ticket ── */}
            <div className="trade-sidebar">
                <div className="sidebar-inner">
                    <div className="sidebar-market-name">{market.question}</div>

                    {/* Selected outcome */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 4px' }}>
                        <span className="om-dot" style={{ background: colorFor(selected) }} />
                        <span style={{ fontWeight: 800, fontSize: '1.05rem' }}>{market.outcomeNames[selected]}</span>
                        <span style={{ marginLeft: 'auto', textAlign: 'right', lineHeight: 1.1 }}>
                            <span style={{ color: colorFor(selected), fontWeight: 800, display: 'block' }}>
                                {displayPct(selected).toFixed(1)}%
                            </span>
                            {isMarketPriced(selected) && (
                                <span
                                    title={DUAL_HINT}
                                    style={{ fontSize: '0.66rem', fontWeight: 600, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'help' }}
                                >
                                    {stakeSharePct(selected).toFixed(0)}% staked <Info size={10} />
                                </span>
                            )}
                        </span>
                    </div>

                    {resolved ? (
                        <>
                            <div className="alert alert-info" style={{ marginTop: 12 }}>
                                {market.winner === selected
                                    ? <>This outcome <strong>won</strong>. Redeem your tokens for a pro-rata share of the {fmtSui(market.vault)} SUI pool.</>
                                    : <>Winner: <strong>{market.outcomeNames[market.winner ?? 0]}</strong>. Switch to it to redeem if you hold its tokens.</>}
                            </div>
                            <button
                                className="trade-cta yes"
                                onClick={handleRedeem}
                                disabled={busy}
                                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                            >
                                {busy ? <Loader2 size={16} className="spin" /> : <Trophy size={16} />}
                                Redeem {market.outcomeNames[market.winner ?? 0]} tokens
                            </button>
                        </>
                    ) : (
                        <>
                            {/* Stake vs Order tabs */}
                            <div style={{ display: 'flex', gap: 6, marginTop: 8, background: 'var(--bg-hover, rgba(255,255,255,0.04))', padding: 4, borderRadius: 8 }}>
                                {(['stake', 'order'] as const).map(k => {
                                    const active = panelTab === k;
                                    const disabled = k === 'order' && !selHasPool;
                                    return (
                                        <button
                                            key={k}
                                            onClick={() => !disabled && setPanelTab(k)}
                                            disabled={disabled}
                                            title={disabled ? 'No order book on this outcome' : ''}
                                            style={{
                                                flex: 1, padding: '8px 6px', borderRadius: 6,
                                                fontSize: '0.8rem', fontWeight: 800, cursor: disabled ? 'not-allowed' : 'pointer',
                                                fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '0.03em',
                                                border: active ? '1px solid var(--blue, #1c6fff)' : '1px solid transparent',
                                                background: active ? 'var(--blue, #1c6fff)' : 'transparent',
                                                color: active ? '#fff' : disabled ? 'var(--border-base)' : 'var(--text-muted)',
                                                opacity: disabled ? 0.5 : 1,
                                            }}
                                        >
                                            {k === 'stake' ? 'Stake' : 'Limit ◆'}
                                        </button>
                                    );
                                })}
                            </div>

                            {panelTab === 'stake' ? (
                                <>
                                    <div className="amount-label-row" style={{ marginTop: 12 }}>
                                        <span className="field-label">Amount (SUI)</span>
                                    </div>
                                    <div className="amount-input-wrap">
                                        <span className="amount-input-symbol">SUI</span>
                                        <input
                                            className="amount-input"
                                            type="number" min="0" step="0.1" placeholder="0.00"
                                            value={stakeAmt}
                                            onChange={e => setStakeAmt(e.target.value)}
                                        />
                                    </div>
                                    <div className="trade-summary">
                                        <div className="trade-summary-row">
                                            <span className="trade-summary-key">You receive</span>
                                            <span className="trade-summary-val">{parseFloat(stakeAmt || '0') || '—'} {market.outcomeNames[selected]}</span>
                                        </div>
                                        <div className="trade-summary-row">
                                            <span className="trade-summary-key">If it wins</span>
                                            <span className="trade-summary-val green">pro-rata pool share</span>
                                        </div>
                                    </div>
                                    <button
                                        className="trade-cta yes"
                                        onClick={handleStake}
                                        disabled={busy || !acct || !(parseFloat(stakeAmt || '0') > 0)}
                                    >
                                        {busy ? 'Submitting…' : `Stake on ${market.outcomeNames[selected]}`}
                                    </button>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                                        Staking mints the outcome token 1:1 into the shared pool. No DEEP required.
                                    </div>
                                </>
                            ) : (
                                <>
                                    {!managerId ? (
                                        <button className="trade-cta neutral" onClick={handleEnableTrading} disabled={busy || !acct} style={{ marginTop: 12 }}>
                                            {busy ? 'Enabling…' : '⚡ Enable trading (one-time)'}
                                        </button>
                                    ) : (
                                        <>
                                            <button
                                                onClick={handleSyncDeepPrice}
                                                disabled={busy}
                                                style={{
                                                    marginTop: 12, width: '100%', padding: '8px',
                                                    background: 'var(--yes-dim)', border: '1px solid var(--border-base)',
                                                    borderRadius: 6, cursor: 'pointer', color: 'var(--blue)',
                                                    fontSize: '0.78rem', fontWeight: 700, fontFamily: 'inherit',
                                                }}
                                                title="Required once per outcome before the first order: imports the DEEP/SUI rate so this pool can price fees."
                                            >
                                                <Zap size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                                                Sync DEEP price (do this once before first order)
                                            </button>
                                            <div className="amount-label-row" style={{ marginTop: 12 }}>
                                                <span className="field-label">Price (SUI per token)</span>
                                                <span className="balance-hint">0 – 1</span>
                                            </div>
                                            <div className="amount-input-wrap">
                                                <span className="amount-input-symbol">SUI</span>
                                                <input
                                                    className="amount-input"
                                                    type="number" min="0" max="1" step="0.01" placeholder="0.40"
                                                    value={orderPx}
                                                    onChange={e => setOrderPx(e.target.value)}
                                                />
                                            </div>
                                            <div className="amount-label-row">
                                                <span className="field-label">Quantity (tokens)</span>
                                            </div>
                                            <div className="amount-input-wrap">
                                                <span className="amount-input-symbol">QTY</span>
                                                <input
                                                    className="amount-input"
                                                    type="number" min="0" step="1" placeholder="0"
                                                    value={orderQty}
                                                    onChange={e => setOrderQty(e.target.value)}
                                                />
                                            </div>
                                            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                                                <button
                                                    className="trade-cta yes"
                                                    style={{ flex: 1 }}
                                                    onClick={() => handleLimitOrder(true)}
                                                    disabled={busy || !canOrder}
                                                >
                                                    Bid (buy)
                                                </button>
                                                <button
                                                    className="trade-cta no"
                                                    style={{ flex: 1 }}
                                                    onClick={() => handleLimitOrder(false)}
                                                    disabled={busy || !canOrder}
                                                >
                                                    Ask (sell)
                                                </button>
                                            </div>
                                            <button
                                                onClick={handleClaim}
                                                disabled={busy}
                                                style={{
                                                    marginTop: 10, width: '100%', padding: '8px',
                                                    background: 'transparent', border: '1px solid var(--border-base)',
                                                    borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)',
                                                    fontSize: '0.78rem', fontWeight: 700, fontFamily: 'inherit',
                                                }}
                                                title="Withdraw filled proceeds (bought tokens / sold SUI) from your DeepBook account to your wallet"
                                            >
                                                Claim filled balances
                                            </button>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                                                Posts a resting order on {market.outcomeNames[selected]}'s DeepBook order book.
                                                After a fill, click <strong>Claim</strong> to move proceeds to your wallet. Fees paid in DEEP.
                                            </div>
                                        </>
                                    )}
                                </>
                            )}
                        </>
                    )}
                </div>

                {/* Market info */}
                <div className="sidebar-section">
                    <div className="sidebar-section-title">Market Info</div>
                    <div className="info-row">
                        <span className="info-row-key">Status</span>
                        <span className={`info-row-val ${resolved ? 'no' : 'yes'}`}>{resolved ? 'Resolved' : 'Active'}</span>
                    </div>
                    <div className="info-row">
                        <span className="info-row-key">Outcomes</span>
                        <span className="info-row-val">{market.n}</span>
                    </div>
                    <div className="info-row">
                        <span className="info-row-key">Pool</span>
                        <span className="info-row-val">{fmtSui(market.vault)} SUI</span>
                    </div>
                    <div className="info-row">
                        <span className="info-row-key">Order books</span>
                        <span className={`info-row-val ${hasPools ? 'yes' : ''}`}>{hasPools ? 'On' : 'Off'}</span>
                    </div>
                    <div className="info-row">
                        <span className="info-row-key">Resolves</span>
                        <span className="info-row-val">{fmtDate(market.resolutionTime)}</span>
                    </div>
                    <div className="info-row" style={{ marginTop: 4 }}>
                        <span className="info-row-key">Explorer</span>
                        <a
                            className="info-row-val link"
                            href={`https://suiscan.xyz/testnet/object/${market.objectId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            View market ↗
                        </a>
                    </div>
                </div>

                {!acct && (
                    <div className="trade-disclaimer">
                        <BarChart2 size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                        <strong>Connect wallet</strong> to stake or trade.
                    </div>
                )}
            </div>
        </div>
    );
}
