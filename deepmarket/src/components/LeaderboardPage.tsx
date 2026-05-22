// LeaderboardPage — settlement leaderboard: PredictManagers ranked by realized
// P&L (track idea "settlement leaderboards"). Your own managers are highlighted.

import { useEffect, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { Trophy, RefreshCw } from 'lucide-react';
import { getLeaderboard, type LeaderboardRow } from '../lib/predict';

const usd = (n: number) =>
    `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

export default function LeaderboardPage() {
    const account = useCurrentAccount();
    const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = () => {
        setBusy(true);
        setErr(null);
        getLeaderboard(60)
            .then(setRows)
            .catch((e) => setErr(e instanceof Error ? e.message : 'Failed to load leaderboard'))
            .finally(() => setBusy(false));
    };

    useEffect(() => {
        load();
        const id = setInterval(load, 60_000);
        return () => clearInterval(id);
    }, []);

    const me = account?.address.toLowerCase();

    return (
        <div className="lb-page">
            <div className="predict-header">
                <div>
                    <div className="predict-eyebrow">
                        <Trophy size={14} />
                        <span>DeepBook Predict · Leaderboard</span>
                    </div>
                    <h1 className="predict-title">Settlement leaderboard</h1>
                    <p className="predict-sub">
                        PredictManagers ranked by realized P&amp;L across all settled positions.
                    </p>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={load} disabled={busy}
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh
                </button>
            </div>

            {err && <div className="vs-empty" style={{ marginTop: 16 }}>{err}</div>}
            {!rows && !err && <div className="vs-empty" style={{ marginTop: 16 }}>Loading leaderboard…</div>}

            {rows && rows.length > 0 && (
                <div className="lb-table">
                    <div className="lb-head">
                        <span>#</span>
                        <span>Manager</span>
                        <span>Owner</span>
                        <span style={{ textAlign: 'right' }}>Realized P&amp;L</span>
                        <span style={{ textAlign: 'right' }}>Account value</span>
                        <span style={{ textAlign: 'right' }}>Open</span>
                    </div>
                    {rows.map((r, i) => {
                        const mine = me && r.owner.toLowerCase() === me;
                        return (
                            <div key={r.managerId} className={`lb-row ${mine ? 'lb-mine' : ''}`}>
                                <span className="lb-rank">{i + 1}</span>
                                <span className="lb-mono">{short(r.managerId)}</span>
                                <span className="lb-mono">{short(r.owner)}{mine ? ' (you)' : ''}</span>
                                <span style={{ textAlign: 'right', color: r.realizedPnl > 0 ? 'var(--yes)' : r.realizedPnl < 0 ? 'var(--no)' : 'inherit' }}>
                                    {usd(r.realizedPnl)}
                                </span>
                                <span style={{ textAlign: 'right' }}>{usd(r.accountValue)}</span>
                                <span style={{ textAlign: 'right' }}>{r.openPositions}</span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
