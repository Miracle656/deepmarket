// VaultPanel — the LP / maker side of DeepBook Predict.
//
// Supply dUSDC into the shared Predict vault to earn the premiums option
// takers pay; withdraw by burning PLP shares at the live share price. This is
// the counterparty side of every binary/range position minted on /predict.

import { useCallback, useEffect, useState } from 'react';
import {
    useCurrentAccount,
    useSuiClient,
    useSignAndExecuteTransaction,
} from '@mysten/dapp-kit';
import { RefreshCw, TrendingUp } from 'lucide-react';
import { CONFIG } from '../lib/config';
import {
    getVaultStats,
    getLpPosition,
    getUnsettledExposedOracles,
    listTradeableOracles,
    type VaultStats,
    type LpPosition,
} from '../lib/predict';
import { buildSupplyTx, buildWithdrawLpTx } from '../lib/predict-tx';

const usd = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function VaultPanel() {
    const account = useCurrentAccount();
    const sui = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();

    const [stats, setStats] = useState<VaultStats | null>(null);
    const [lp, setLp] = useState<LpPosition | null>(null);
    const [walletDusdc, setWalletDusdc] = useState(0);

    const [tab, setTab] = useState<'supply' | 'withdraw'>('supply');
    const [amount, setAmount] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const load = useCallback(async () => {
        const s = await getVaultStats(sui);
        setStats(s);
        if (account) {
            const [p, bal] = await Promise.all([
                getLpPosition(sui, account.address, s),
                sui
                    .getBalance({ owner: account.address, coinType: CONFIG.PREDICT_DUSDC_TYPE })
                    .catch(() => ({ totalBalance: '0' })),
            ]);
            setLp(p);
            setWalletDusdc(Number(bal.totalBalance) / 10 ** CONFIG.DUSDC_DECIMALS);
        } else {
            setLp(null);
            setWalletDusdc(0);
        }
    }, [sui, account]);

    useEffect(() => {
        load();
        const id = setInterval(load, 30_000);
        return () => clearInterval(id);
    }, [load]);

    // supply/withdraw assert the vault MTM is fresh — refresh the live exposed
    // oracles in the same PTB. (Expired-but-unsettled oracles can't be
    // refreshed; we skip them and let the keeper settle them.)
    const liveExposedOracles = useCallback(async (): Promise<string[]> => {
        const exposed = await getUnsettledExposedOracles(sui);
        if (exposed.length === 0) return [];
        const oracles = await listTradeableOracles().catch(() => []);
        const live = new Set(
            oracles
                .filter((o) => o.status === 'active' || o.status === 'pending')
                .map((o) => o.oracle_id.toLowerCase())
        );
        return exposed.filter((id) => live.has(id.toLowerCase()));
    }, [sui]);

    const reset = () => {
        setAmount('');
        setMsg(null);
        setErr(null);
    };

    const onSupply = async () => {
        if (!account) return;
        const v = parseFloat(amount);
        if (!(v > 0)) {
            setErr('Enter an amount');
            return;
        }
        setBusy(true);
        setErr(null);
        setMsg(null);
        try {
            const raw = BigInt(Math.floor(v * 10 ** CONFIG.DUSDC_DECIMALS));
            const refresh = await liveExposedOracles();
            const tx = buildSupplyTx(raw, account.address, refresh);
            const res = await signAndExec({ transaction: tx });
            await sui.waitForTransaction({ digest: res.digest, options: { showEffects: true } });
            setMsg(`Supplied ${usd(v)} → vault`);
            setAmount('');
            await load();
        } catch (e) {
            setErr(e instanceof Error ? e.message : 'Supply failed');
        } finally {
            setBusy(false);
        }
    };

    const onWithdraw = async () => {
        if (!account || !lp || !stats) return;
        const v = parseFloat(amount);
        if (!(v > 0)) {
            setErr('Enter an amount');
            return;
        }
        setBusy(true);
        setErr(null);
        setMsg(null);
        try {
            // Withdraw all when the amount ~= position value, else convert
            // dUSDC → shares at the live share price.
            let shares: bigint;
            if (v >= lp.valueUsd * 0.999) {
                shares = BigInt(lp.shares);
            } else {
                const usdRaw = v * 10 ** CONFIG.DUSDC_DECIMALS;
                const computed = Math.floor((usdRaw * stats.totalShares) / stats.vaultValueRaw);
                shares = BigInt(Math.min(computed, lp.shares));
            }
            if (shares <= 0n) {
                setErr('Nothing to withdraw');
                setBusy(false);
                return;
            }
            const refresh = await liveExposedOracles();
            const tx = buildWithdrawLpTx(shares, account.address, refresh);
            const res = await signAndExec({ transaction: tx });
            await sui.waitForTransaction({ digest: res.digest, options: { showEffects: true } });
            setMsg(`Withdrew ${usd(v)} from vault`);
            setAmount('');
            await load();
        } catch (e) {
            setErr(e instanceof Error ? e.message : 'Withdraw failed');
        } finally {
            setBusy(false);
        }
    };

    const utilization =
        stats && stats.tvl > 0 ? (stats.totalMaxPayout / stats.tvl) * 100 : 0;
    const max = tab === 'supply' ? walletDusdc : lp?.valueUsd ?? 0;

    return (
        <div className="vault-panel">
            <div className="vault-head">
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={load}
                    title="Refresh vault stats"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}
                >
                    <RefreshCw size={13} />
                </button>
            </div>

            {/* Net asset value — the live mark-to-market headline.
                NAV = vault assets (balance) − holders' open MTM liability. */}
            <div className="vault-nav">
                <div className="vault-nav-label">Net asset value · live</div>
                <div className="vault-nav-value">
                    {stats ? usd(stats.vaultValue) : '—'}
                </div>
                {stats && (
                    <div className="vault-nav-breakdown">
                        <span>TVL {usd(stats.tvl)}</span>
                        <span className="vault-muted">−</span>
                        <span>MTM liability {usd(stats.totalMtm)}</span>
                    </div>
                )}
                {stats && stats.totalShares > 0 && (
                    <div className="vault-nav-share">
                        <span className="vault-muted">PLP share price</span>
                        <span className="vault-nav-share-val">
                            ${stats.sharePrice.toFixed(4)}
                        </span>
                        <span
                            className={
                                stats.sharePrice >= 1
                                    ? 'vault-nav-up'
                                    : 'vault-nav-down'
                            }
                        >
                            {stats.sharePrice >= 1 ? '+' : ''}
                            {((stats.sharePrice - 1) * 100).toFixed(2)}% vs par
                        </span>
                    </div>
                )}
            </div>

            {/* Vault stats */}
            <div className="vault-stats">
                <Stat label="Vault TVL" value={stats ? usd(stats.tvl) : '—'} />
                <Stat label="Available" value={stats ? usd(stats.available) : '—'} />
                <Stat
                    label="Utilization"
                    value={stats ? `${utilization.toFixed(1)}%` : '—'}
                />
            </div>

            {/* Your position */}
            <div className="vault-yours">
                <div className="vault-yours-h">
                    <TrendingUp size={13} /> Your position
                </div>
                <div className="vault-yours-row">
                    <span>{lp && lp.shares > 0 ? usd(lp.valueUsd) : usd(0)}</span>
                    <span className="vault-muted">
                        {lp && lp.shares > 0
                            ? `${(lp.shares / 10 ** CONFIG.DUSDC_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 })} PLP`
                            : 'no shares yet'}
                    </span>
                </div>
            </div>

            {/* Supply / Withdraw */}
            <div className="vault-tabs">
                <button
                    className={`vault-tab ${tab === 'supply' ? 'active' : ''}`}
                    onClick={() => {
                        setTab('supply');
                        reset();
                    }}
                >
                    Supply
                </button>
                <button
                    className={`vault-tab ${tab === 'withdraw' ? 'active' : ''}`}
                    onClick={() => {
                        setTab('withdraw');
                        reset();
                    }}
                >
                    Withdraw
                </button>
            </div>

            <div className="vault-form">
                <div className="vault-input-row">
                    <input
                        className="input"
                        type="number"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        disabled={busy || !account}
                    />
                    <span className="vault-ccy">dUSDC</span>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setAmount(String(max))}
                        disabled={busy || !account || max <= 0}
                    >
                        Max
                    </button>
                </div>
                <div className="vault-avail">
                    {tab === 'supply'
                        ? `Wallet: ${usd(walletDusdc)}`
                        : `Withdrawable: ${usd(lp?.valueUsd ?? 0)}`}
                </div>

                {!account ? (
                    <div className="vault-note">Connect a wallet to provide liquidity.</div>
                ) : (
                    <button
                        className={`btn ${tab === 'supply' ? 'btn-yes' : 'btn-ghost'}`}
                        style={{ width: '100%', marginTop: 8 }}
                        onClick={tab === 'supply' ? onSupply : onWithdraw}
                        disabled={busy}
                    >
                        {busy ? 'Confirming…' : tab === 'supply' ? 'Supply liquidity' : 'Withdraw'}
                    </button>
                )}

                {msg && <div className="vault-ok">{msg}</div>}
                {err && <div className="vault-err">{err}</div>}
            </div>
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="vault-stat">
            <div className="vault-stat-label">{label}</div>
            <div className="vault-stat-value">{value}</div>
        </div>
    );
}
