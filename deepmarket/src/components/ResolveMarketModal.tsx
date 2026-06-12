import { useState, useEffect } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction, useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { CONFIG, type Market } from '../lib/config';
import { useToast } from '../lib/toast';

interface Props {
    market: Market;
    onClose: () => void;
    onResolved: (id: number, outcome: boolean) => void;
}

export default function ResolveMarketModal({ market, onClose, onResolved }: Props) {
    const acct = useCurrentAccount();
    const suiClient = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();
    const { toast } = useToast();
    const [outcome, setOutcome] = useState<boolean | null>(null);
    const [loading, setLoading] = useState(false);
    const [adminCapId, setAdminCapId] = useState<string | null>(null);

    // Verify the connected wallet owns the AdminCap. We check the known
    // AdminCap object directly rather than filtering by StructType — the cap's
    // type is defined by the package's *original* id (e.g. 0x6d968a48…), which
    // differs from CONFIG.PACKAGE_ID after upgrades, so a type filter on
    // PACKAGE_ID silently matches nothing.
    useEffect(() => {
        if (!acct) { setAdminCapId(null); return; }
        suiClient
            .getObject({ id: CONFIG.ADMIN_CAP_OBJECT_ID, options: { showOwner: true } })
            .then(res => {
                const owner = res.data?.owner;
                const addr = owner && typeof owner === 'object' && 'AddressOwner' in owner
                    ? (owner as { AddressOwner: string }).AddressOwner : null;
                setAdminCapId(addr === acct.address ? CONFIG.ADMIN_CAP_OBJECT_ID : null);
            })
            .catch(() => setAdminCapId(null));
    }, [acct, suiClient]);

    const handleResolve = async () => {
        if (!acct) return toast('error', 'Connect wallet first');
        if (outcome === null) return toast('error', 'Select an outcome');
        if (!adminCapId) return toast('error', 'No AdminCap found in your wallet');

        const yesType = `${market.tokenPackageId}::yes_market::YES_MARKET`;
        const noType  = `${market.tokenPackageId}::no_market::NO_MARKET`;

        setLoading(true);
        try {
            const tx = new Transaction();
            tx.setSender(acct.address);
            tx.moveCall({
                target: `${CONFIG.PACKAGE_ID}::market_factory::resolve_market`,
                arguments: [
                    tx.object(adminCapId),
                    tx.object(CONFIG.MARKET_REGISTRY),
                    tx.pure.u64(market.id),
                    tx.pure.bool(outcome),
                ],
                typeArguments: [CONFIG.SUI_TYPE, yesType, noType],
            });
            await signAndExec({ transaction: tx });
            toast('success', `Market resolved → ${outcome ? 'YES' : 'NO'}`);
            onResolved(market.id, outcome!);
            onClose();
        } catch (e: any) {
            toast('error', 'Resolution failed', e.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
            <div className="modal">
                <div className="modal-header">
                    <span className="modal-title">Resolve Market</span>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>

                <div style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>Market #{market.id}</div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>{market.question}</div>
                </div>

                {!adminCapId && (
                    <div className="alert alert-warning" style={{ marginBottom: 12 }}>
                        You don't have admin rights. No AdminCap found in your wallet.
                    </div>
                )}

                <div className="alert alert-warning">
                    This is irreversible. Winning token holders will be able to redeem 1:1 for SUI.
                </div>

                <div className="form-label" style={{ marginBottom: 8 }}>Winning Outcome</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                    <div className={`resolve-option yes ${outcome === true ? 'selected' : ''}`} onClick={() => setOutcome(true)}>
                        <span>●</span> YES wins — YES token holders redeem 1:1
                    </div>
                    <div className={`resolve-option no ${outcome === false ? 'selected' : ''}`} onClick={() => setOutcome(false)}>
                        <span>●</span> NO wins — NO token holders redeem 1:1
                    </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-ghost btn-full" onClick={onClose}>Cancel</button>
                    <button
                        className={`btn btn-full ${outcome === true ? 'btn-yes' : outcome === false ? 'btn-no' : 'btn-primary'}`}
                        onClick={handleResolve}
                        disabled={loading || outcome === null || !adminCapId}
                    >
                        {loading ? 'Resolving…' : 'Confirm Resolution'}
                    </button>
                </div>
            </div>
        </div>
    );
}
