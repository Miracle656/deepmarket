// PredictDetailPage — single oracle's market detail with full mint flow.
//
// Sidebar state machine:
//   - no wallet           → connect prompt
//   - no manager + no qty → init manager prompt (deferred until first mint)
//   - balance < cost      → deposit auto-bundled into mint PTB
//   - balance >= cost     → mint only
//
// All three lifecycle steps (init, deposit, mint) ride one PTB on first use.
// Repeat mints are one-tx as long as manager balance covers the position cost.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
    useCurrentAccount,
    useSuiClient,
    useSignAndExecuteTransaction,
} from '@mysten/dapp-kit';
import { bcs } from '@mysten/sui/bcs';
import {
    ArrowLeft,
    RefreshCw,
    AlertCircle,
    TrendingUp,
    TrendingDown,
    Lock,
    Activity,
    Coins,
    Loader2,
    CheckCircle2,
    Wallet,
} from 'lucide-react';
import {
    getOracleState,
    getManagerSummary,
    getManagerPositions,
    getCachedManagerId,
    setCachedManagerId,
    findManagerByOwner,
    extractManagerIdFromChanges,
    validateManagerId,
    formatStrikeUsd,
    formatExpiry,
    statusColor,
    type OracleState,
    type ManagerSummary,
    type Position,
} from '../lib/predict';
import {
    buildCreateManagerTx,
    buildDepositMintTx,
    buildDepositMintRangeTx,
    buildPreviewTx,
    buildRangePreviewTx,
    buildRedeemTx,
    buildWithdrawTx,
} from '../lib/predict-tx';
import { CONFIG } from '../lib/config';
import PredictChart from './PredictChart';
import VolSurfaceChart from './VolSurfaceChart';
import CandleChart from './CandleChart';
import TradeTape from './TradeTape';

const FLOAT_SCALING = 1_000_000_000n;
const STRIKE_RADIUS = 5; // show ±5 ticks around the rounded spot
const PREVIEW_DEBOUNCE_MS = 350;

interface PredictDetailPageProps {
    theme: 'dark' | 'light';
}

export default function PredictDetailPage({ theme }: PredictDetailPageProps) {
    const { oracleId } = useParams<{ oracleId: string }>();
    const navigate = useNavigate();
    const account = useCurrentAccount();
    const sui = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();

    const [state, setState] = useState<OracleState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dusdc, setDusdc] = useState<bigint | null>(null);
    const [managerId, setManagerId] = useState<string | null>(null);
    const [manager, setManager] = useState<ManagerSummary | null>(null);
    const [positions, setPositions] = useState<Position[]>([]);

    // chart view: price line / SVI vol smile / candles / trade tape
    const [chartView, setChartView] = useState<'price' | 'smile' | 'candles' | 'trades'>('price');

    // user inputs
    const [mode, setMode] = useState<'binary' | 'range'>('binary');
    const [selectedStrike, setSelectedStrike] = useState<bigint | null>(null);
    const [lowerStrike, setLowerStrike] = useState<bigint | null>(null);
    const [higherStrike, setHigherStrike] = useState<bigint | null>(null);
    const [isUp, setIsUp] = useState(true);
    const [maxPayoutUsd, setMaxPayoutUsd] = useState('5');

    // preview + status
    const [preview, setPreview] = useState<{ cost: bigint; payout: bigint } | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [txMsg, setTxMsg] = useState<string | null>(null);

    // ── load oracle state ───────────────────────────────────────────────
    useEffect(() => {
        if (!oracleId) return;
        let cancelled = false;
        (async () => {
            try {
                const s = await getOracleState(oracleId);
                if (!cancelled) setState(s);
            } catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [oracleId]);

    // ── load wallet dUSDC ────────────────────────────────────────────────
    useEffect(() => {
        if (!account?.address) {
            setDusdc(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const balance = await sui.getBalance({
                    owner: account.address,
                    coinType: CONFIG.PREDICT_DUSDC_TYPE,
                });
                if (!cancelled) setDusdc(BigInt(balance.totalBalance));
            } catch {
                if (!cancelled) setDusdc(0n);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [account?.address, sui]);

    // ── load + validate PredictManager (cache → server-by-owner fallback)
    useEffect(() => {
        if (!account?.address) {
            setManagerId(null);
            setManager(null);
            setPositions([]);
            return;
        }
        let cancelled = false;
        (async () => {
            const cached = getCachedManagerId(account.address);
            let id: string | null = null;
            if (cached) {
                id = await validateManagerId(account.address, cached);
            }
            if (!id) {
                id = await findManagerByOwner(account.address);
                if (id) setCachedManagerId(account.address, id);
            }
            if (cancelled) return;
            setManagerId(id);
            if (id) {
                try {
                    const [s, p] = await Promise.all([
                        getManagerSummary(id),
                        getManagerPositions(id).catch(() => [] as Position[]),
                    ]);
                    if (!cancelled) {
                        setManager(s);
                        setPositions(p);
                    }
                } catch {
                    /* indexer may lag — keep id, refresh later */
                }
            } else {
                setManager(null);
                setPositions([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [account?.address]);

    // ── strike grid: 11 ticks around the rounded spot ────────────────────
    const strikes = useMemo<bigint[]>(() => {
        if (!state) return [];
        const minStrike = BigInt(state.oracle.min_strike);
        const tick = BigInt(state.oracle.tick_size);
        const spot = state.latest_price?.spot
            ? BigInt(Math.round(state.latest_price.spot))
            : minStrike + tick * 50n;
        // round to nearest tick at or above min_strike
        const rel = spot >= minStrike ? spot - minStrike : 0n;
        const idxCenter = rel / tick;
        const start =
            idxCenter > BigInt(STRIKE_RADIUS) ? idxCenter - BigInt(STRIKE_RADIUS) : 0n;
        const out: bigint[] = [];
        for (let i = 0; i <= STRIKE_RADIUS * 2; i++) {
            out.push(minStrike + (start + BigInt(i)) * tick);
        }
        return out;
    }, [state]);

    // default strikes to centred grid positions when the grid changes
    useEffect(() => {
        if (strikes.length === 0) return;
        const mid = Math.floor(strikes.length / 2);
        if (selectedStrike === null) setSelectedStrike(strikes[mid]);
        if (lowerStrike === null)
            setLowerStrike(strikes[Math.max(0, mid - 1)]);
        if (higherStrike === null)
            setHigherStrike(strikes[Math.min(strikes.length - 1, mid + 1)]);
    }, [strikes, selectedStrike, lowerStrike, higherStrike]);

    // quantity in dUSDC base units (1_000_000 = $1 max payout)
    const quantity = useMemo(() => {
        const v = parseFloat(maxPayoutUsd);
        if (!Number.isFinite(v) || v <= 0) return 0n;
        return BigInt(Math.floor(v * 10 ** CONFIG.DUSDC_DECIMALS));
    }, [maxPayoutUsd]);

    // ── live price preview via devInspect ────────────────────────────────
    const isRangeValid =
        lowerStrike !== null &&
        higherStrike !== null &&
        lowerStrike < higherStrike;

    const previewKey = useMemo(() => {
        if (!state || !account?.address || quantity <= 0n) return null;
        if (mode === 'binary') {
            return selectedStrike !== null
                ? `B|${state.oracle.oracle_id}|${selectedStrike}|${isUp}|${quantity}`
                : null;
        }
        return isRangeValid
            ? `R|${state.oracle.oracle_id}|${lowerStrike}|${higherStrike}|${quantity}`
            : null;
    }, [
        mode,
        state,
        selectedStrike,
        lowerStrike,
        higherStrike,
        isRangeValid,
        isUp,
        quantity,
        account?.address,
    ]);
    const previewTimer = useRef<number | null>(null);

    useEffect(() => {
        if (!previewKey) {
            setPreview(null);
            return;
        }
        if (!state || !account?.address) return;
        setPreviewLoading(true);
        if (previewTimer.current !== null) {
            window.clearTimeout(previewTimer.current);
        }
        previewTimer.current = window.setTimeout(async () => {
            try {
                let tx;
                if (mode === 'binary') {
                    if (selectedStrike === null) return;
                    tx = buildPreviewTx({
                        oracleId: state.oracle.oracle_id,
                        expiry: state.oracle.expiry,
                        strike: Number(selectedStrike),
                        isUp,
                        quantity,
                    });
                } else {
                    if (!isRangeValid) return;
                    tx = buildRangePreviewTx({
                        oracleId: state.oracle.oracle_id,
                        expiry: state.oracle.expiry,
                        lowerStrike: Number(lowerStrike),
                        higherStrike: Number(higherStrike),
                        quantity,
                    });
                }
                const result = await sui.devInspectTransactionBlock({
                    sender: account.address,
                    transactionBlock: tx,
                });
                const ret = result.results?.[1]?.returnValues;
                if (ret && ret.length >= 2) {
                    const cost = bcs.u64().parse(new Uint8Array(ret[0][0]));
                    const payout = bcs.u64().parse(new Uint8Array(ret[1][0]));
                    setPreview({ cost: BigInt(cost), payout: BigInt(payout) });
                } else {
                    setPreview(null);
                }
            } catch (e) {
                console.warn('preview failed', e);
                setPreview(null);
            } finally {
                setPreviewLoading(false);
            }
        }, PREVIEW_DEBOUNCE_MS);
        return () => {
            if (previewTimer.current !== null) {
                window.clearTimeout(previewTimer.current);
            }
        };
    }, [
        previewKey,
        mode,
        state,
        account?.address,
        selectedStrike,
        lowerStrike,
        higherStrike,
        isRangeValid,
        isUp,
        quantity,
        sui,
    ]);

    // ── mint flow ────────────────────────────────────────────────────────
    const managerBalance = manager?.trading_balance
        ? BigInt(manager.trading_balance)
        : 0n;
    const requiredCost = preview?.cost ?? quantity;
    const depositAmount =
        managerBalance >= requiredCost ? 0n : requiredCost - managerBalance;
    const walletDusdc = dusdc ?? 0n;
    const inputsValid =
        mode === 'binary' ? selectedStrike !== null : isRangeValid;
    const canMint =
        !!account &&
        !!state &&
        inputsValid &&
        quantity > 0n &&
        walletDusdc >= depositAmount &&
        !busy;

    const onMint = async () => {
        if (!state || !account || !inputsValid) return;
        setBusy(true);
        setTxMsg(null);
        try {
            // Step 1 (one-time): create + share the PredictManager.
            // Deployed `predict::create_manager` shares internally and returns
            // only an ID, so we cannot compose this into the mint PTB.
            let activeManagerId = managerId;
            if (!activeManagerId) {
                const initRes = await signAndExec({
                    transaction: buildCreateManagerTx(),
                });
                const initTx = await sui.waitForTransaction({
                    digest: initRes.digest,
                    options: { showObjectChanges: true, showEffects: true },
                });
                const newId = extractManagerIdFromChanges(initTx.objectChanges);
                if (!newId) {
                    throw new Error(
                        'Manager created but object id not found in tx effects.'
                    );
                }
                activeManagerId = newId;
                setManagerId(newId);
                setCachedManagerId(account.address, newId);
            }

            // Step 2: deposit (if needed) + mint (binary or range) in one PTB.
            const tx =
                mode === 'binary'
                    ? buildDepositMintTx({
                          managerId: activeManagerId,
                          oracleId: state.oracle.oracle_id,
                          expiry: state.oracle.expiry,
                          strike: Number(selectedStrike),
                          isUp,
                          quantity,
                          depositAmount,
                      })
                    : buildDepositMintRangeTx({
                          managerId: activeManagerId,
                          oracleId: state.oracle.oracle_id,
                          expiry: state.oracle.expiry,
                          lowerStrike: Number(lowerStrike),
                          higherStrike: Number(higherStrike),
                          quantity,
                          depositAmount,
                      });
            const res = await signAndExec({ transaction: tx });
            await sui.waitForTransaction({
                digest: res.digest,
                options: { showEffects: true },
            });

            // Refresh wallet + manager summary + positions
            const [balance, mgr, pos] = await Promise.all([
                sui
                    .getBalance({
                        owner: account.address,
                        coinType: CONFIG.PREDICT_DUSDC_TYPE,
                    })
                    .then((b) => BigInt(b.totalBalance))
                    .catch(() => walletDusdc),
                getManagerSummary(activeManagerId).catch(() => null),
                getManagerPositions(activeManagerId).catch(
                    () => [] as Position[]
                ),
            ]);
            setDusdc(balance);
            if (mgr) setManager(mgr);
            setPositions(pos);
            setTxMsg(`Position minted · ${res.digest.slice(0, 10)}…`);
        } catch (e) {
            console.error(e);
            setTxMsg(
                'Mint failed: ' + (e instanceof Error ? e.message : String(e))
            );
        } finally {
            setBusy(false);
        }
    };

    if (!oracleId) return null;

    const dusdcDisplay =
        dusdc === null
            ? '—'
            : (Number(dusdc) / 10 ** CONFIG.DUSDC_DECIMALS).toLocaleString(
                  'en-US',
                  { minimumFractionDigits: 2, maximumFractionDigits: 2 }
              );
    const managerDusdc =
        (Number(managerBalance) / 10 ** CONFIG.DUSDC_DECIMALS).toLocaleString(
            'en-US',
            { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        );

    return (
        <div className="predict-page">
            <button
                className="btn btn-ghost btn-sm"
                onClick={() => navigate('/predict')}
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}
            >
                <ArrowLeft size={14} /> All oracles
            </button>

            {error && (
                <div className="alert alert-error">
                    <AlertCircle size={14} style={{ marginRight: 8 }} />
                    {error}
                </div>
            )}

            {!state && !error && (
                <div className="predict-empty">
                    <RefreshCw size={28} className="spin" />
                    <div>Loading oracle state…</div>
                </div>
            )}

            {state && (
                <div className="predict-detail-layout">
                    {/* LEFT — oracle data */}
                    <div className="predict-detail-main">
                        <div className="predict-eyebrow">
                            <TrendingUp size={14} />
                            <span>{state.oracle.underlying_asset} · DeepBook Predict</span>
                        </div>
                        <h1 className="predict-title" style={{ fontSize: 32 }}>
                            {state.oracle.underlying_asset} expiring{' '}
                            {formatExpiry(state.oracle.expiry)}
                        </h1>
                        <div
                            className="predict-card-status"
                            style={{
                                color: statusColor(state.oracle.status),
                                fontSize: 13,
                                marginTop: 4,
                            }}
                        >
                            {state.oracle.status}
                        </div>

                        <div className="pchart-tabs" style={{ marginTop: 20 }}>
                            {([
                                ['price', 'Price'],
                                ['smile', 'Vol Smile'],
                                ['candles', 'Candles'],
                                ['trades', 'Trades'],
                            ] as const).map(([k, label]) => (
                                <button
                                    key={k}
                                    className={`pchart-tab ${chartView === k ? 'active' : ''}`}
                                    onClick={() => setChartView(k)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        <div style={{ marginTop: 12 }}>
                            {chartView === 'price' && (
                                <PredictChart
                                    oracleId={state.oracle.oracle_id}
                                    theme={theme}
                                    mode={mode}
                                    selectedStrike={selectedStrike}
                                    isUp={isUp}
                                    lowerStrike={lowerStrike}
                                    higherStrike={higherStrike}
                                    settlementPrice={state.oracle.settlement_price ?? null}
                                    expiry={state.oracle.expiry}
                                />
                            )}
                            {chartView === 'smile' && <VolSurfaceChart state={state} />}
                            {chartView === 'candles' && (
                                <CandleChart
                                    symbol={state.oracle.underlying_asset || 'BTC'}
                                    theme={theme}
                                />
                            )}
                            {chartView === 'trades' && (
                                <TradeTape oracleId={state.oracle.oracle_id} />
                            )}
                        </div>

                        <div className="predict-stats" style={{ marginTop: 24 }}>
                            <StatCard
                                label="Spot"
                                value={
                                    state.latest_price
                                        ? formatStrikeUsd(state.latest_price.spot)
                                        : '—'
                                }
                                accent="blue"
                            />
                            <StatCard
                                label="Forward"
                                value={
                                    state.latest_price
                                        ? formatStrikeUsd(state.latest_price.forward)
                                        : '—'
                                }
                            />
                            <StatCard
                                label="Settlement"
                                value={
                                    state.oracle.settlement_price
                                        ? formatStrikeUsd(state.oracle.settlement_price)
                                        : 'pending'
                                }
                            />
                            <StatCard
                                label="Min strike"
                                value={formatStrikeUsd(state.oracle.min_strike)}
                            />
                            <StatCard
                                label="Tick size"
                                value={formatStrikeUsd(state.oracle.tick_size)}
                            />
                            <StatCard
                                label="Activated"
                                value={
                                    state.oracle.activated_at
                                        ? new Date(state.oracle.activated_at).toLocaleTimeString()
                                        : '—'
                                }
                            />
                        </div>

                        {state.latest_svi && (
                            <div className="predict-svi">
                                <div className="predict-section-h" style={{ marginTop: 28 }}>
                                    <Activity size={14} />
                                    <span>Vol surface (SVI)</span>
                                </div>
                                <div className="predict-svi-grid">
                                    <SviStat label="a" value={state.latest_svi.a} />
                                    <SviStat label="b" value={state.latest_svi.b} />
                                    <SviStat
                                        label="ρ"
                                        value={state.latest_svi.rho}
                                        negative={state.latest_svi.rho_negative}
                                    />
                                    <SviStat
                                        label="m"
                                        value={state.latest_svi.m}
                                        negative={state.latest_svi.m_negative}
                                    />
                                    <SviStat label="σ" value={state.latest_svi.sigma} />
                                </div>
                            </div>
                        )}

                        <details className="predict-debug">
                            <summary>Raw oracle state (debug)</summary>
                            <pre>{JSON.stringify(state, null, 2)}</pre>
                        </details>
                    </div>

                    {/* RIGHT — mint sidebar */}
                    <aside className="predict-detail-side">
                        {account && managerId && (
                            <ManagerStatusCard
                                walletDusdc={dusdcDisplay}
                                managerBalance={managerDusdc}
                                onWithdraw={async () => {
                                    if (!account || !managerId || !manager)
                                        return;
                                    const amount = BigInt(
                                        manager.trading_balance ?? 0
                                    );
                                    if (amount <= 0n) return;
                                    setBusy(true);
                                    setTxMsg(null);
                                    try {
                                        const tx = buildWithdrawTx(
                                            managerId,
                                            amount,
                                            account.address
                                        );
                                        const res = await signAndExec({
                                            transaction: tx,
                                        });
                                        await sui.waitForTransaction({
                                            digest: res.digest,
                                            options: { showEffects: true },
                                        });
                                        const [bal, mgr] = await Promise.all([
                                            sui
                                                .getBalance({
                                                    owner: account.address,
                                                    coinType:
                                                        CONFIG.PREDICT_DUSDC_TYPE,
                                                })
                                                .then((b) =>
                                                    BigInt(b.totalBalance)
                                                )
                                                .catch(() => walletDusdc),
                                            getManagerSummary(
                                                managerId
                                            ).catch(() => null),
                                        ]);
                                        setDusdc(bal);
                                        if (mgr) setManager(mgr);
                                        setTxMsg(
                                            `Withdrew to wallet · ${res.digest.slice(0, 10)}…`
                                        );
                                    } catch (e) {
                                        console.error(e);
                                        setTxMsg(
                                            'Withdraw failed: ' +
                                                (e instanceof Error
                                                    ? e.message
                                                    : String(e))
                                        );
                                    } finally {
                                        setBusy(false);
                                    }
                                }}
                                busy={busy}
                                hasBalance={managerBalance > 0n}
                            />
                        )}

                        <div className="predict-section-h">
                            <Lock size={14} />
                            <span>Mint a binary position</span>
                        </div>

                        {!account ? (
                            <div className="predict-mint-card">
                                <div
                                    className="alert alert-info"
                                    style={{ fontSize: 13, lineHeight: 1.6 }}
                                >
                                    Connect a wallet to mint UP/DOWN positions
                                    on this oracle.
                                </div>
                            </div>
                        ) : state.oracle.status !== 'active' ? (
                            <div className="predict-mint-card">
                                <div
                                    className="alert alert-info"
                                    style={{ fontSize: 13, lineHeight: 1.6 }}
                                >
                                    Oracle is{' '}
                                    <strong>{state.oracle.status}</strong> —
                                    minting is disabled. Only{' '}
                                    <code>active</code> oracles accept new
                                    positions.
                                </div>
                            </div>
                        ) : (
                            <div className="predict-mint-card">
                                {/* MODE TOGGLE — Binary vs Range */}
                                <div className="predict-mode-toggle">
                                    <button
                                        type="button"
                                        className={`predict-mode-btn ${mode === 'binary' ? 'active' : ''}`}
                                        onClick={() => setMode('binary')}
                                    >
                                        Binary
                                    </button>
                                    <button
                                        type="button"
                                        className={`predict-mode-btn ${mode === 'range' ? 'active' : ''}`}
                                        onClick={() => setMode('range')}
                                    >
                                        Range
                                    </button>
                                </div>

                                {mode === 'binary' ? (
                                    <>
                                        {/* DIRECTION TOGGLE */}
                                        <div
                                            className="predict-dir-toggle"
                                            style={{ marginTop: 12 }}
                                        >
                                            <button
                                                type="button"
                                                className={`predict-dir-btn predict-dir-up ${isUp ? 'active' : ''}`}
                                                onClick={() => setIsUp(true)}
                                            >
                                                <TrendingUp size={14} /> UP
                                            </button>
                                            <button
                                                type="button"
                                                className={`predict-dir-btn predict-dir-dn ${!isUp ? 'active' : ''}`}
                                                onClick={() => setIsUp(false)}
                                            >
                                                <TrendingDown size={14} />{' '}
                                                DOWN
                                            </button>
                                        </div>

                                        <div
                                            className="predict-mint-label"
                                            style={{ marginTop: 14 }}
                                        >
                                            Strike
                                        </div>
                                        <div className="predict-strike-grid">
                                            {strikes.map((s) => (
                                                <button
                                                    type="button"
                                                    key={s.toString()}
                                                    className={`predict-strike-cell ${selectedStrike === s ? 'active' : ''}`}
                                                    onClick={() =>
                                                        setSelectedStrike(s)
                                                    }
                                                >
                                                    {formatStrikeUsd(
                                                        Number(s)
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div
                                            className="predict-mint-label"
                                            style={{ marginTop: 14 }}
                                        >
                                            Lower strike
                                        </div>
                                        <div className="predict-strike-grid">
                                            {strikes.map((s) => {
                                                const disabled =
                                                    higherStrike !== null &&
                                                    s >= higherStrike;
                                                return (
                                                    <button
                                                        type="button"
                                                        key={`lo-${s.toString()}`}
                                                        className={`predict-strike-cell ${lowerStrike === s ? 'active' : ''}`}
                                                        disabled={disabled}
                                                        style={{
                                                            opacity: disabled
                                                                ? 0.35
                                                                : 1,
                                                        }}
                                                        onClick={() =>
                                                            setLowerStrike(s)
                                                        }
                                                    >
                                                        {formatStrikeUsd(
                                                            Number(s)
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>

                                        <div
                                            className="predict-mint-label"
                                            style={{ marginTop: 12 }}
                                        >
                                            Higher strike
                                        </div>
                                        <div className="predict-strike-grid">
                                            {strikes.map((s) => {
                                                const disabled =
                                                    lowerStrike !== null &&
                                                    s <= lowerStrike;
                                                return (
                                                    <button
                                                        type="button"
                                                        key={`hi-${s.toString()}`}
                                                        className={`predict-strike-cell ${higherStrike === s ? 'active' : ''}`}
                                                        disabled={disabled}
                                                        style={{
                                                            opacity: disabled
                                                                ? 0.35
                                                                : 1,
                                                        }}
                                                        onClick={() =>
                                                            setHigherStrike(s)
                                                        }
                                                    >
                                                        {formatStrikeUsd(
                                                            Number(s)
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>

                                        {!isRangeValid && (
                                            <div
                                                style={{
                                                    fontSize: 11,
                                                    color: 'var(--no)',
                                                    fontFamily:
                                                        'Space Mono, monospace',
                                                    marginTop: 8,
                                                }}
                                            >
                                                Higher strike must be greater
                                                than lower strike.
                                            </div>
                                        )}
                                    </>
                                )}

                                {/* QUANTITY */}
                                <div
                                    className="predict-mint-label"
                                    style={{ marginTop: 14 }}
                                >
                                    Max payout (USD)
                                </div>
                                <div className="predict-qty-row">
                                    {['1', '5', '10', '25'].map((p) => (
                                        <button
                                            type="button"
                                            key={p}
                                            className={`predict-qty-chip ${maxPayoutUsd === p ? 'active' : ''}`}
                                            onClick={() => setMaxPayoutUsd(p)}
                                        >
                                            ${p}
                                        </button>
                                    ))}
                                    <input
                                        className="predict-qty-input"
                                        inputMode="decimal"
                                        value={maxPayoutUsd}
                                        onChange={(e) =>
                                            setMaxPayoutUsd(e.target.value)
                                        }
                                        placeholder="custom"
                                    />
                                </div>

                                {/* PREVIEW */}
                                <div
                                    className="predict-preview"
                                    style={{ marginTop: 14 }}
                                >
                                    <PreviewRow
                                        label="Cost"
                                        value={
                                            preview
                                                ? `$${(Number(preview.cost) / 10 ** CONFIG.DUSDC_DECIMALS).toFixed(4)}`
                                                : previewLoading
                                                  ? '…'
                                                  : '—'
                                        }
                                    />
                                    <PreviewRow
                                        label="If right (max)"
                                        value={`$${(Number(quantity) / 10 ** CONFIG.DUSDC_DECIMALS).toFixed(2)}`}
                                    />
                                    <PreviewRow
                                        label="Implied prob"
                                        value={
                                            preview && quantity > 0n
                                                ? `${((Number(preview.cost) / Number(quantity)) * 100).toFixed(1)}%`
                                                : '—'
                                        }
                                    />
                                </div>

                                {/* BALANCES */}
                                <div
                                    className="predict-balances"
                                    style={{ marginTop: 14 }}
                                >
                                    <BalanceRow
                                        icon={<Wallet size={12} />}
                                        label="Wallet"
                                        value={`${dusdcDisplay} dUSDC`}
                                    />
                                    <BalanceRow
                                        icon={<Coins size={12} />}
                                        label="Manager"
                                        value={
                                            managerId
                                                ? `${managerDusdc} dUSDC`
                                                : 'not initialized'
                                        }
                                    />
                                    {depositAmount > 0n && (
                                        <BalanceRow
                                            label="Will deposit"
                                            value={`+${(Number(depositAmount) / 10 ** CONFIG.DUSDC_DECIMALS).toFixed(2)} dUSDC`}
                                            highlight
                                        />
                                    )}
                                </div>

                                {/* INSUFFICIENT */}
                                {walletDusdc < depositAmount && (
                                    <div
                                        className="alert alert-error"
                                        style={{
                                            marginTop: 12,
                                            fontSize: 12,
                                            lineHeight: 1.5,
                                        }}
                                    >
                                        Wallet has only ${dusdcDisplay} dUSDC —
                                        needs $
                                        {(
                                            Number(depositAmount) /
                                            10 ** CONFIG.DUSDC_DECIMALS
                                        ).toFixed(2)}{' '}
                                        for this position.
                                    </div>
                                )}

                                {/* ACTION */}
                                <button
                                    className="btn btn-primary btn-full"
                                    style={{ marginTop: 12 }}
                                    disabled={!canMint}
                                    onClick={onMint}
                                >
                                    {busy ? (
                                        <>
                                            <Loader2
                                                size={14}
                                                className="spin"
                                                style={{ marginRight: 6 }}
                                            />
                                            Minting…
                                        </>
                                    ) : !managerId ? (
                                        'Init manager · then mint (2 sigs)'
                                    ) : depositAmount > 0n ? (
                                        mode === 'range'
                                            ? 'Deposit & mint range'
                                            : 'Deposit & mint'
                                    ) : mode === 'range' ? (
                                        'Mint range'
                                    ) : (
                                        `Mint ${isUp ? 'UP' : 'DOWN'}`
                                    )}
                                </button>

                                {txMsg && (
                                    <div
                                        className={`alert ${!txMsg.includes('failed') ? 'alert-success' : 'alert-error'}`}
                                        style={{
                                            marginTop: 10,
                                            fontSize: 12,
                                            lineHeight: 1.5,
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 6,
                                        }}
                                    >
                                        {!txMsg.includes('failed') ? (
                                            <CheckCircle2 size={12} />
                                        ) : (
                                            <AlertCircle size={12} />
                                        )}
                                        <span>{txMsg}</span>
                                    </div>
                                )}
                            </div>
                        )}

                        {managerId && positions.length > 0 && (
                            <PositionsPanel
                                positions={positions}
                                currentOracleId={state.oracle.oracle_id}
                                onRedeem={async (p) => {
                                    if (!account || !managerId) return;
                                    setBusy(true);
                                    setTxMsg(null);
                                    try {
                                        const tx = buildRedeemTx({
                                            managerId,
                                            oracleId: p.oracle_id,
                                            expiry: p.expiry,
                                            strike: p.strike,
                                            isUp: p.is_up,
                                            quantity: BigInt(p.open_quantity),
                                        });
                                        const res = await signAndExec({
                                            transaction: tx,
                                        });
                                        await sui.waitForTransaction({
                                            digest: res.digest,
                                            options: { showEffects: true },
                                        });
                                        const [mgr, pos] = await Promise.all([
                                            getManagerSummary(managerId).catch(
                                                () => null
                                            ),
                                            getManagerPositions(
                                                managerId
                                            ).catch(() => [] as Position[]),
                                        ]);
                                        if (mgr) setManager(mgr);
                                        setPositions(pos);
                                        setTxMsg(
                                            `Position redeemed · ${res.digest.slice(0, 10)}…`
                                        );
                                    } catch (e) {
                                        console.error(e);
                                        setTxMsg(
                                            'Redeem failed: ' +
                                                (e instanceof Error
                                                    ? e.message
                                                    : String(e))
                                        );
                                    } finally {
                                        setBusy(false);
                                    }
                                }}
                                busy={busy}
                            />
                        )}
                    </aside>
                </div>
            )}
        </div>
    );
}

function ManagerStatusCard({
    walletDusdc,
    managerBalance,
    onWithdraw,
    busy,
    hasBalance,
}: {
    walletDusdc: string;
    managerBalance: string;
    onWithdraw: () => Promise<void>;
    busy: boolean;
    hasBalance: boolean;
}) {
    return (
        <>
            <div className="predict-section-h">
                <Coins size={14} />
                <span>Your DeepBook Predict balance</span>
            </div>
            <div className="predict-mint-card">
                <div className="predict-balances">
                    <BalanceRow
                        icon={<Wallet size={12} />}
                        label="Wallet"
                        value={`${walletDusdc} dUSDC`}
                    />
                    <BalanceRow
                        icon={<Coins size={12} />}
                        label="Manager"
                        value={`${managerBalance} dUSDC`}
                        highlight={hasBalance}
                    />
                </div>
                <button
                    type="button"
                    className="predict-pos-redeem sell"
                    style={{ marginTop: 12 }}
                    disabled={busy || !hasBalance}
                    onClick={onWithdraw}
                >
                    {hasBalance
                        ? `Withdraw $${managerBalance} → wallet`
                        : 'Manager empty'}
                </button>
            </div>
        </>
    );
}

function PositionsPanel({
    positions,
    currentOracleId,
    onRedeem,
    busy,
}: {
    positions: Position[];
    currentOracleId: string;
    onRedeem: (p: Position) => Promise<void>;
    busy: boolean;
}) {
    const onThis = positions.filter(
        (p) => p.oracle_id === currentOracleId && p.open_quantity > 0
    );
    const others = positions.filter(
        (p) => p.oracle_id !== currentOracleId && p.open_quantity > 0
    );
    return (
        <>
            <div className="predict-section-h" style={{ marginTop: 24 }}>
                <Coins size={14} />
                <span>Your positions</span>
            </div>
            <div className="predict-mint-card">
                {onThis.length === 0 && others.length === 0 && (
                    <div
                        style={{
                            color: 'var(--text-muted)',
                            fontSize: 12,
                            padding: '6px 0',
                        }}
                    >
                        No open positions yet.
                    </div>
                )}
                {onThis.length > 0 && (
                    <div className="predict-pos-section">
                        <div className="predict-pos-section-h">This oracle</div>
                        {onThis.map((p) => (
                            <PositionRow
                                key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                                p={p}
                                onRedeem={onRedeem}
                                busy={busy}
                            />
                        ))}
                    </div>
                )}
                {others.length > 0 && (
                    <div className="predict-pos-section">
                        <div className="predict-pos-section-h">Other oracles</div>
                        {others.slice(0, 5).map((p) => (
                            <PositionRow
                                key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                                p={p}
                                muted
                            />
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}

function PositionRow({
    p,
    muted,
    onRedeem,
    busy,
}: {
    p: Position;
    muted?: boolean;
    onRedeem?: (p: Position) => Promise<void>;
    busy?: boolean;
}) {
    const qty = p.open_quantity / 10 ** CONFIG.DUSDC_DECIMALS;
    const cost = p.open_cost_basis / 10 ** CONFIG.DUSDC_DECIMALS;
    const mark = p.mark_value / 10 ** CONFIG.DUSDC_DECIMALS;
    const pnl = p.unrealized_pnl / 10 ** CONFIG.DUSDC_DECIMALS;
    const status = p.status as string;
    const isLost = status === 'lost';
    const isWinnable = status === 'won' || status === 'redeemable';
    const redeemLabel = isWinnable
        ? `★ Claim $${mark.toFixed(2)}`
        : isLost
          ? 'Clear position'
          : `Sell · $${mark.toFixed(2)}`;
    const redeemVariant = isWinnable ? 'win' : isLost ? 'clear' : 'sell';
    return (
        <div className={`predict-pos-row ${muted ? 'muted' : ''}`}>
            <div className="predict-pos-strike">
                <span className={`predict-pos-dir ${p.is_up ? 'up' : 'dn'}`}>
                    {p.is_up ? 'UP' : 'DN'}
                </span>
                {formatStrikeUsd(p.strike)}
                <span
                    style={{
                        fontFamily: 'Space Mono, monospace',
                        fontSize: 10,
                        color: 'var(--text-muted)',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        marginLeft: 'auto',
                    }}
                >
                    {p.status}
                </span>
            </div>
            <div className="predict-pos-meta">
                <span>${qty.toFixed(2)} cover</span>
                <span>cost ${cost.toFixed(2)}</span>
                <span>mark ${mark.toFixed(2)}</span>
                <span
                    className="predict-pos-pnl"
                    style={{ color: pnl >= 0 ? 'var(--yes)' : 'var(--no)' }}
                >
                    {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                </span>
            </div>
            {onRedeem && (
                <button
                    type="button"
                    className={`predict-pos-redeem ${redeemVariant}`}
                    disabled={busy}
                    onClick={() => onRedeem(p)}
                >
                    {redeemLabel}
                </button>
            )}
        </div>
    );
}

function StatCard({
    label,
    value,
    accent,
}: {
    label: string;
    value: string;
    accent?: 'blue' | 'rose';
}) {
    return (
        <div className={`predict-stat ${accent ? `accent-${accent}` : ''}`}>
            <div className="predict-stat-label">{label}</div>
            <div className="predict-stat-value">{value}</div>
        </div>
    );
}

function SviStat({
    label,
    value,
    negative,
}: {
    label: string;
    value: number;
    negative?: boolean;
}) {
    const formatted = (negative ? '−' : '') + value.toLocaleString();
    return (
        <div className="predict-svi-cell">
            <div className="predict-svi-label">{label}</div>
            <div className="predict-svi-value">{formatted}</div>
        </div>
    );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="predict-preview-row">
            <span className="predict-preview-label">{label}</span>
            <span className="predict-preview-value">{value}</span>
        </div>
    );
}

function BalanceRow({
    icon,
    label,
    value,
    highlight,
}: {
    icon?: React.ReactNode;
    label: string;
    value: string;
    highlight?: boolean;
}) {
    return (
        <div className={`predict-bal-row ${highlight ? 'highlight' : ''}`}>
            <span className="predict-bal-label">
                {icon} {label}
            </span>
            <span className="predict-bal-value">{value}</span>
        </div>
    );
}

// Suppress unused warnings — kept for future use.
void Link;
void FLOAT_SCALING;
