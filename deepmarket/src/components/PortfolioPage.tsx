import { useEffect, useState } from 'react';
import {
    useCurrentAccount,
    useSignAndExecuteTransaction,
    useSuiClient,
} from '@mysten/dapp-kit';
import { useNavigate } from 'react-router-dom';
import {
    Wallet,
    TrendingUp,
    TrendingDown,
    Activity,
    Coins,
    ArrowUpRight,
    Loader2,
} from 'lucide-react';
import type { Market } from '../lib/config';
import { CONFIG } from '../lib/config';
import { formatVol } from '../App';
import {
    getCachedManagerId,
    findManagerByOwner,
    findAllManagersByOwner,
    setCachedManagerId,
    getManagerSummary,
    getManagerPositions,
    formatStrikeUsd,
    formatExpiry,
    type ManagerSummary,
    type Position,
} from '../lib/predict';
import { buildWithdrawTx } from '../lib/predict-tx';

interface SpotPosition {
    market: Market;
    yesBalance: number;
    noBalance: number;
}

interface Props {
    markets: Market[];
}

export default function PortfolioPage({ markets }: Props) {
    const acct = useCurrentAccount();
    const navigate = useNavigate();
    const sui = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();
    const [positions, setPositions] = useState<SpotPosition[]>([]);
    const [loading, setLoading] = useState(false);

    // Predict state — one entry per manager owned by the connected wallet.
    interface ManagerCard {
        id: string;
        summary: ManagerSummary | null;
        positions: Position[];
    }
    const [managerCards, setManagerCards] = useState<ManagerCard[]>([]);
    const [predictLoading, setPredictLoading] = useState(false);
    const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
    const [withdrawMsg, setWithdrawMsg] = useState<string | null>(null);

    // ── Spot positions (existing) ────────────────────────────────────────
    useEffect(() => {
        if (!acct || markets.length === 0) {
            setPositions([]);
            return;
        }
        setLoading(true);

        Promise.all(
            markets.map(async (m) => {
                try {
                    const res = await fetch(
                        `http://localhost:3000/markets/${m.id}/positions/${acct.address}`
                    );
                    const data = await res.json();
                    return {
                        market: m,
                        yesBalance: Number(data.yes_balance ?? 0) / 1e9,
                        noBalance: Number(data.no_balance ?? 0) / 1e9,
                    };
                } catch {
                    return { market: m, yesBalance: 0, noBalance: 0 };
                }
            })
        ).then((all) => {
            setPositions(
                all.filter((p) => p.yesBalance > 0.0001 || p.noBalance > 0.0001)
            );
            setLoading(false);
        });
    }, [acct, markets]);

    // ── Predict managers + positions (multi-manager) ────────────────────
    useEffect(() => {
        if (!acct?.address) {
            setManagerCards([]);
            return;
        }
        let cancelled = false;
        setPredictLoading(true);
        (async () => {
            const ids = await findAllManagersByOwner(acct.address);
            // Seed the localStorage cache with the first manager so the
            // Predict detail page picks it up on cold load.
            if (ids[0] && !getCachedManagerId(acct.address)) {
                setCachedManagerId(acct.address, ids[0]);
            }
            const cards = await Promise.all(
                ids.map(async (id) => {
                    const [summary, positions] = await Promise.all([
                        getManagerSummary(id).catch(() => null),
                        getManagerPositions(id).catch(() => [] as Position[]),
                    ]);
                    return { id, summary, positions };
                })
            );
            if (!cancelled) {
                setManagerCards(cards);
                setPredictLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [acct?.address]);

    // Reference deprecated helper to keep import linkage explicit.
    void findManagerByOwner;

    if (!acct) {
        return (
            <div className="empty-state" style={{ paddingTop: 80 }}>
                <div className="empty-icon">
                    <Wallet
                        size={48}
                        strokeWidth={1}
                        style={{ opacity: 0.8 }}
                    />
                </div>
                <div className="empty-title">Connect your wallet</div>
                <div className="empty-desc">Connect to see your positions</div>
            </div>
        );
    }

    const dusdcDecimals = CONFIG.DUSDC_DECIMALS;

    // Spot aggregates
    const totalYesValue = positions.reduce(
        (sum, p) => sum + p.yesBalance * (p.market.yesPrice / 100),
        0
    );
    const totalNoValue = positions.reduce(
        (sum, p) => sum + p.noBalance * (p.market.noPrice / 100),
        0
    );
    const totalSpotValue = totalYesValue + totalNoValue;

    return (
        <div style={{ width: '100%', maxWidth: 980, margin: '0 auto', paddingTop: 8 }}>
            {/* ── DEEPBOOK PREDICT ───────────────────────────────────── */}
            <div className="markets-header" style={{ marginBottom: 12 }}>
                <span className="markets-title">DeepBook Predict</span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {acct.address.slice(0, 10)}…{acct.address.slice(-6)}
                </span>
            </div>

            {managerCards.length === 0 && !predictLoading && (
                <div
                    className="empty-state"
                    style={{ padding: '24px 20px', marginBottom: 24 }}
                >
                    <div
                        className="empty-icon"
                        style={{ marginBottom: 8 }}
                    >
                        <Activity
                            size={36}
                            strokeWidth={1}
                            style={{ opacity: 0.4 }}
                        />
                    </div>
                    <div className="empty-title">No PredictManager yet</div>
                    <div className="empty-desc">
                        Mint your first binary position on the{' '}
                        <a
                            href="#"
                            onClick={(e) => {
                                e.preventDefault();
                                navigate('/predict');
                            }}
                        >
                            Predict
                        </a>{' '}
                        tab — your manager and positions will appear here.
                    </div>
                </div>
            )}

            {managerCards.length > 1 && (
                <div
                    style={{
                        fontSize: '0.7rem',
                        color: 'var(--text-muted)',
                        fontFamily: 'Space Mono, monospace',
                        letterSpacing: '0.04em',
                        marginBottom: 12,
                    }}
                >
                    Found {managerCards.length} managers for this wallet —
                    each renders separately below.
                </div>
            )}

            {managerCards.map((card) => {
                const manager = card.summary;
                const managerId = card.id;
                const openPredictPositions = card.positions.filter(
                    (p) => p.open_quantity > 0
                );
                const managerBalance =
                    (manager?.trading_balance ?? 0) / 10 ** dusdcDecimals;
                const accountValue =
                    (manager?.account_value ?? 0) / 10 ** dusdcDecimals;
                const openExposure =
                    (manager?.open_exposure ?? 0) / 10 ** dusdcDecimals;
                const unrealized =
                    (manager?.unrealized_pnl ?? 0) / 10 ** dusdcDecimals;
                const realized =
                    (manager?.realized_pnl ?? 0) / 10 ** dusdcDecimals;
                const withdrawing = withdrawingId === managerId;
                return (
                <div key={managerId} style={{ marginBottom: 32 }}>
                    <div className="stat-strip" style={{ marginBottom: 16 }}>
                        <div className="stat-cell">
                            <div className="stat-cell-label">Account Value</div>
                            <div className="stat-cell-value">
                                ${accountValue.toFixed(2)}
                            </div>
                        </div>
                        <div className="stat-cell">
                            <div className="stat-cell-label">Trading Balance</div>
                            <div className="stat-cell-value">
                                ${managerBalance.toFixed(2)}
                            </div>
                        </div>
                        <div className="stat-cell">
                            <div className="stat-cell-label">Open Exposure</div>
                            <div className="stat-cell-value">
                                ${openExposure.toFixed(2)}
                            </div>
                        </div>
                        <div className="stat-cell">
                            <div className="stat-cell-label">Unrealized P&amp;L</div>
                            <div
                                className="stat-cell-value"
                                style={{
                                    color:
                                        unrealized >= 0
                                            ? 'var(--yes)'
                                            : 'var(--no)',
                                }}
                            >
                                {unrealized >= 0 ? '+' : ''}$
                                {unrealized.toFixed(2)}
                            </div>
                        </div>
                        <div className="stat-cell">
                            <div className="stat-cell-label">Realized P&amp;L</div>
                            <div
                                className="stat-cell-value"
                                style={{
                                    color:
                                        realized >= 0
                                            ? 'var(--yes)'
                                            : 'var(--no)',
                                }}
                            >
                                {realized >= 0 ? '+' : ''}${realized.toFixed(2)}
                            </div>
                        </div>
                    </div>

                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            marginBottom: 12,
                            flexWrap: 'wrap',
                        }}
                    >
                        <div
                            style={{
                                fontSize: '0.7rem',
                                color: 'var(--text-muted)',
                                fontFamily: 'Space Mono, monospace',
                                letterSpacing: '0.04em',
                            }}
                        >
                            Manager · {managerId.slice(0, 14)}…
                            {managerId.slice(-6)}
                        </div>
                        {managerBalance > 0 && (
                            <button
                                type="button"
                                className="predict-pos-redeem sell"
                                style={{ width: 'auto', margin: 0 }}
                                disabled={withdrawing}
                                onClick={async () => {
                                    if (!acct || !manager) return;
                                    const amount = BigInt(
                                        manager.trading_balance ?? 0
                                    );
                                    if (amount <= 0n) return;
                                    setWithdrawingId(managerId);
                                    setWithdrawMsg(null);
                                    try {
                                        const tx = buildWithdrawTx(
                                            managerId,
                                            amount,
                                            acct.address
                                        );
                                        const res = await signAndExec({
                                            transaction: tx,
                                        });
                                        await sui.waitForTransaction({
                                            digest: res.digest,
                                            options: { showEffects: true },
                                        });
                                        const fresh = await getManagerSummary(
                                            managerId
                                        ).catch(() => null);
                                        if (fresh) {
                                            setManagerCards((prev) =>
                                                prev.map((c) =>
                                                    c.id === managerId
                                                        ? { ...c, summary: fresh }
                                                        : c
                                                )
                                            );
                                        }
                                        setWithdrawMsg(
                                            `Withdrew $${(Number(amount) / 10 ** dusdcDecimals).toFixed(2)} to wallet`
                                        );
                                    } catch (e) {
                                        console.error(e);
                                        setWithdrawMsg(
                                            'Withdraw failed: ' +
                                                (e instanceof Error
                                                    ? e.message
                                                    : String(e))
                                        );
                                    } finally {
                                        setWithdrawingId(null);
                                    }
                                }}
                            >
                                {withdrawing ? (
                                    <>
                                        <Loader2
                                            size={12}
                                            className="spin"
                                            style={{ marginRight: 4 }}
                                        />
                                        Withdrawing…
                                    </>
                                ) : (
                                    <>
                                        <ArrowUpRight size={12} />
                                        Withdraw ${managerBalance.toFixed(2)} →
                                        wallet
                                    </>
                                )}
                            </button>
                        )}
                    </div>

                    {withdrawMsg && (
                        <div
                            className={`alert ${withdrawMsg.includes('failed') ? 'alert-error' : 'alert-success'}`}
                            style={{
                                marginBottom: 12,
                                fontSize: 12,
                            }}
                        >
                            {withdrawMsg}
                        </div>
                    )}

                    {predictLoading && openPredictPositions.length === 0 && (
                        <div
                            className="empty-state"
                            style={{ padding: 32, marginBottom: 24 }}
                        >
                            <div className="empty-title">Loading positions…</div>
                        </div>
                    )}

                    {!predictLoading &&
                        openPredictPositions.length === 0 && (
                            <div
                                className="empty-state"
                                style={{
                                    padding: '24px 20px',
                                    marginBottom: 24,
                                }}
                            >
                                <div
                                    className="empty-icon"
                                    style={{ marginBottom: 8 }}
                                >
                                    <Coins
                                        size={36}
                                        strokeWidth={1}
                                        style={{ opacity: 0.4 }}
                                    />
                                </div>
                                <div className="empty-title">
                                    No open Predict positions
                                </div>
                                <div className="empty-desc">
                                    Manager has{' '}
                                    <strong>
                                        ${managerBalance.toFixed(2)}
                                    </strong>{' '}
                                    dUSDC ready to trade.
                                </div>
                            </div>
                        )}

                    {openPredictPositions.length > 0 && (
                        <div
                            style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 8,
                                marginBottom: 24,
                            }}
                        >
                            {/* Header */}
                            <div
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns:
                                        '1.4fr 60px 1fr 90px 90px 90px 90px',
                                    gap: 12,
                                    padding: '8px 16px',
                                    fontSize: '0.7rem',
                                    color: 'var(--text-muted)',
                                    fontWeight: 700,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.06em',
                                    borderBottom:
                                        '1px solid var(--border-base)',
                                }}
                            >
                                <div>Market</div>
                                <div style={{ textAlign: 'center' }}>Dir</div>
                                <div style={{ textAlign: 'right' }}>Strike</div>
                                <div style={{ textAlign: 'right' }}>Cover</div>
                                <div style={{ textAlign: 'right' }}>Cost</div>
                                <div style={{ textAlign: 'right' }}>Mark</div>
                                <div style={{ textAlign: 'right' }}>P&amp;L</div>
                            </div>

                            {openPredictPositions.map((p) => {
                                const cover =
                                    p.open_quantity / 10 ** dusdcDecimals;
                                const cost =
                                    p.open_cost_basis / 10 ** dusdcDecimals;
                                const mark = p.mark_value / 10 ** dusdcDecimals;
                                const pnl =
                                    p.unrealized_pnl / 10 ** dusdcDecimals;
                                const dir = p.is_up ? 'UP' : 'DN';
                                return (
                                    <div
                                        key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                                        onClick={() =>
                                            navigate(
                                                `/predict/${p.oracle_id}`
                                            )
                                        }
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns:
                                                '1.4fr 60px 1fr 90px 90px 90px 90px',
                                            gap: 12,
                                            padding: '12px 16px',
                                            background: 'var(--bg-card)',
                                            border: '1px solid var(--border-base)',
                                            borderRadius: 10,
                                            cursor: 'pointer',
                                            alignItems: 'center',
                                            transition: 'border-color 0.15s',
                                            fontFamily: 'Space Mono, monospace',
                                            fontSize: '0.85rem',
                                        }}
                                        onMouseEnter={(e) =>
                                            (e.currentTarget.style.borderColor =
                                                'var(--border-strong)')
                                        }
                                        onMouseLeave={(e) =>
                                            (e.currentTarget.style.borderColor =
                                                'var(--border-base)')
                                        }
                                    >
                                        <div>
                                            <div
                                                style={{
                                                    fontWeight: 600,
                                                    marginBottom: 3,
                                                    fontFamily: 'inherit',
                                                }}
                                            >
                                                {p.underlying_asset}{' '}
                                                {formatExpiry(p.expiry)}
                                            </div>
                                            <div
                                                style={{
                                                    fontSize: '0.68rem',
                                                    color: 'var(--text-muted)',
                                                }}
                                            >
                                                {p.status}
                                            </div>
                                        </div>
                                        <div
                                            style={{
                                                textAlign: 'center',
                                            }}
                                        >
                                            <span
                                                className={`predict-pos-dir ${p.is_up ? 'up' : 'dn'}`}
                                            >
                                                {dir}
                                            </span>
                                        </div>
                                        <div
                                            style={{
                                                textAlign: 'right',
                                                fontWeight: 700,
                                                fontFamily: 'Doto, monospace',
                                            }}
                                        >
                                            {formatStrikeUsd(p.strike)}
                                        </div>
                                        <div style={{ textAlign: 'right' }}>
                                            ${cover.toFixed(2)}
                                        </div>
                                        <div style={{ textAlign: 'right' }}>
                                            ${cost.toFixed(2)}
                                        </div>
                                        <div style={{ textAlign: 'right' }}>
                                            ${mark.toFixed(2)}
                                        </div>
                                        <div
                                            style={{
                                                textAlign: 'right',
                                                fontWeight: 700,
                                                color:
                                                    pnl >= 0
                                                        ? 'var(--yes)'
                                                        : 'var(--no)',
                                            }}
                                        >
                                            {pnl >= 0 ? '+' : ''}$
                                            {pnl.toFixed(2)}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
                );
            })}

            {/* ── SPOT MARKETS ───────────────────────────────────────── */}
            <div
                className="markets-header"
                style={{ marginTop: 32, marginBottom: 12 }}
            >
                <span className="markets-title">Spot markets</span>
            </div>

            <div className="stat-strip" style={{ marginBottom: 16 }}>
                <div className="stat-cell">
                    <div className="stat-cell-label">Open Positions</div>
                    <div className="stat-cell-value">{positions.length}</div>
                </div>
                <div className="stat-cell">
                    <div className="stat-cell-label">Est. Value</div>
                    <div className="stat-cell-value">
                        {totalSpotValue.toFixed(4)} SUI
                    </div>
                </div>
                <div className="stat-cell">
                    <div className="stat-cell-label">YES Holdings</div>
                    <div
                        className="stat-cell-value"
                        style={{ color: 'var(--yes)' }}
                    >
                        {totalYesValue.toFixed(4)} SUI
                    </div>
                </div>
                <div className="stat-cell">
                    <div className="stat-cell-label">NO Holdings</div>
                    <div
                        className="stat-cell-value"
                        style={{ color: 'var(--no)' }}
                    >
                        {totalNoValue.toFixed(4)} SUI
                    </div>
                </div>
            </div>

            {loading && (
                <div className="empty-state" style={{ paddingTop: 40 }}>
                    <div className="empty-title">Loading positions…</div>
                </div>
            )}

            {!loading && positions.length === 0 && (
                <div
                    className="empty-state"
                    style={{ padding: '24px 20px' }}
                >
                    <div
                        className="empty-icon"
                        style={{ marginBottom: 8 }}
                    >
                        <TrendingUp
                            size={36}
                            strokeWidth={1}
                            style={{ opacity: 0.4 }}
                        />
                    </div>
                    <div className="empty-title">
                        No open spot positions
                    </div>
                    <div className="empty-desc">
                        Buy YES or NO tokens on any market to get started
                    </div>
                </div>
            )}

            {!loading && positions.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns:
                                '1fr 100px 100px 100px 120px',
                            gap: 12,
                            padding: '8px 16px',
                            fontSize: '0.72rem',
                            color: 'var(--text-muted)',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            borderBottom: '1px solid var(--border-base)',
                        }}
                    >
                        <div>Market</div>
                        <div style={{ textAlign: 'right' }}>YES Bal</div>
                        <div style={{ textAlign: 'right' }}>NO Bal</div>
                        <div style={{ textAlign: 'right' }}>Price</div>
                        <div style={{ textAlign: 'right' }}>Est. Value</div>
                    </div>

                    {positions.map(({ market: m, yesBalance, noBalance }) => {
                        const posValue =
                            yesBalance * (m.yesPrice / 100) +
                            noBalance * (m.noPrice / 100);
                        const isResolved = m.status === 'Resolved';
                        return (
                            <div
                                key={m.id}
                                onClick={() =>
                                    navigate(`/markets/${m.objectId}`)
                                }
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns:
                                        '1fr 100px 100px 100px 120px',
                                    gap: 12,
                                    padding: '12px 16px',
                                    background: 'var(--bg-card)',
                                    border: '1px solid var(--border-base)',
                                    borderRadius: 10,
                                    cursor: 'pointer',
                                    alignItems: 'center',
                                    transition: 'border-color 0.15s',
                                }}
                                onMouseEnter={(e) =>
                                    (e.currentTarget.style.borderColor =
                                        'var(--border-strong)')
                                }
                                onMouseLeave={(e) =>
                                    (e.currentTarget.style.borderColor =
                                        'var(--border-base)')
                                }
                            >
                                <div>
                                    <div
                                        style={{
                                            fontSize: '0.88rem',
                                            fontWeight: 600,
                                            marginBottom: 4,
                                            lineHeight: 1.3,
                                        }}
                                    >
                                        {m.question}
                                    </div>
                                    <div
                                        style={{
                                            display: 'flex',
                                            gap: 6,
                                            alignItems: 'center',
                                        }}
                                    >
                                        <span
                                            className={`tag ${isResolved ? 'tag-resolved' : 'tag-active'}`}
                                            style={{ fontSize: '0.65rem' }}
                                        >
                                            {m.status}
                                        </span>
                                        {isResolved && m.outcome !== null && (
                                            <span
                                                style={{
                                                    fontSize: '0.72rem',
                                                    color: m.outcome
                                                        ? 'var(--yes)'
                                                        : 'var(--no)',
                                                    fontWeight: 600,
                                                }}
                                            >
                                                {m.outcome ? 'YES Won' : 'NO Won'}
                                            </span>
                                        )}
                                        <span
                                            style={{
                                                fontSize: '0.72rem',
                                                color: 'var(--text-muted)',
                                            }}
                                        >
                                            Vol {formatVol(m.volume)}
                                        </span>
                                    </div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    {yesBalance > 0.0001 ? (
                                        <span
                                            style={{
                                                color: 'var(--yes)',
                                                fontWeight: 600,
                                                fontSize: '0.88rem',
                                            }}
                                        >
                                            {yesBalance.toFixed(4)}
                                        </span>
                                    ) : (
                                        <span
                                            style={{
                                                color: 'var(--text-muted)',
                                            }}
                                        >
                                            —
                                        </span>
                                    )}
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    {noBalance > 0.0001 ? (
                                        <span
                                            style={{
                                                color: 'var(--no)',
                                                fontWeight: 600,
                                                fontSize: '0.88rem',
                                            }}
                                        >
                                            {noBalance.toFixed(4)}
                                        </span>
                                    ) : (
                                        <span
                                            style={{
                                                color: 'var(--text-muted)',
                                            }}
                                        >
                                            —
                                        </span>
                                    )}
                                </div>
                                <div
                                    style={{
                                        textAlign: 'right',
                                        fontSize: '0.88rem',
                                    }}
                                >
                                    <span style={{ color: 'var(--yes)' }}>
                                        {m.yesPrice}¢
                                    </span>
                                    <span
                                        style={{
                                            color: 'var(--text-muted)',
                                            margin: '0 4px',
                                        }}
                                    >
                                        /
                                    </span>
                                    <span style={{ color: 'var(--no)' }}>
                                        {m.noPrice}¢
                                    </span>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <div
                                        style={{
                                            fontWeight: 700,
                                            fontSize: '0.88rem',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'flex-end',
                                            gap: 4,
                                        }}
                                    >
                                        {posValue > 0 ? (
                                            <TrendingUp
                                                size={13}
                                                style={{
                                                    color: 'var(--yes)',
                                                }}
                                            />
                                        ) : (
                                            <TrendingDown
                                                size={13}
                                                style={{
                                                    color: 'var(--text-muted)',
                                                }}
                                            />
                                        )}
                                        {posValue.toFixed(4)} SUI
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
