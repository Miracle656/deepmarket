import { useState } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction, useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { CONFIG, type Market } from '../lib/config';
import { useToast } from '../lib/toast';

interface Props {
    market: Market;
    onClose: () => void;
    onMint: () => void;
    onResolve: () => void;
}

export default function MarketDetailModal({ market, onClose, onMint, onResolve }: Props) {
    const acct = useCurrentAccount();
    const suiClient = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();
    const { toast } = useToast();

    const [redeemSide, setRedeemSide] = useState<'yes' | 'no'>('yes');
    const [redeemLoading, setRedeemLoading] = useState(false);

    const handleRedeem = async () => {
        if (!acct) return toast('error', 'Wallet not connected');

        const yesType = `${market.tokenPackageId}::yes_market::YES_MARKET`;
        const noType  = `${market.tokenPackageId}::no_market::NO_MARKET`;
        const coinType = redeemSide === 'yes' ? yesType : noType;

        setRedeemLoading(true);
        try {
            // Find user's token objects of the winning type
            const coins = await suiClient.getOwnedObjects({
                owner: acct.address,
                filter: { StructType: `0x2::coin::Coin<${coinType}>` },
                options: { showType: true },
            });

            const tokenObj = coins.data?.[0]?.data?.objectId;
            if (!tokenObj) {
                toast('error', 'No tokens found', `You don't hold any ${redeemSide.toUpperCase()} tokens for this market.`);
                return;
            }

            const tx = new Transaction();
            tx.setSender(acct.address);
            const fn = redeemSide === 'yes' ? 'redeem_yes' : 'redeem_no';
            tx.moveCall({
                target: `${CONFIG.PACKAGE_ID}::market_factory::${fn}`,
                arguments: [
                    tx.object(CONFIG.MARKET_REGISTRY),
                    tx.pure.u64(market.id),
                    tx.object(tokenObj),
                ],
                typeArguments: [CONFIG.SUI_TYPE, yesType, noType],
            });
            await signAndExec({ transaction: tx });
            toast('success', 'Redeemed!', `Your ${redeemSide.toUpperCase()} tokens were exchanged for SUI.`);
            onClose();
        } catch (e: any) {
            toast('error', 'Redemption failed', e.message);
        } finally {
            setRedeemLoading(false);
        }
    };

    const formatDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const formatVol = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v}`;

    return (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
            <div className="modal" style={{ maxWidth: 600 }}>
                <div className="modal-header">
                    <h2 className="modal-title">Market Details</h2>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>

                <div style={{ marginBottom: 24 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <span className="market-id">Market #{market.id}</span>
                        <span className={`market-status status-${market.status.toLowerCase()}`}>{market.status}</span>
                    </div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 700, lineHeight: 1.4 }}>{market.question}</div>
                    <div style={{ marginTop: 8, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                        Resolves: {formatDate(market.resolutionTime)} · Volume: {formatVol(market.volume)}
                    </div>
                </div>

                <div className="market-prices" style={{ marginBottom: 16 }}>
                    <div className="price-chip yes">
                        <div className="price-chip-label">YES</div>
                        <div className="price-chip-value">{market.yesPrice}¢</div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{market.yesPrice}% chance</div>
                    </div>
                    <div className="price-chip no">
                        <div className="price-chip-label">NO</div>
                        <div className="price-chip-value">{market.noPrice}¢</div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{market.noPrice}% chance</div>
                    </div>
                </div>

                <div className="probability-bar" style={{ marginBottom: 24 }}>
                    <div className="probability-fill" style={{ width: `${market.yesPrice}%` }} />
                </div>

                <div style={{ marginBottom: 24, padding: 14, background: 'var(--bg-card2)', borderRadius: 10, fontSize: '0.8rem' }}>
                    <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Oracle / Admin</div>
                    <div className="font-mono truncate" style={{ color: 'var(--text-dim)' }}>{market.oracleFeed}</div>
                </div>

                {market.status === 'Active' && (
                    <div>
                        <div className="divider" />
                        <div style={{ fontWeight: 600, marginBottom: 12 }}>Actions</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                            <button className="btn btn-yes" onClick={() => { onClose(); onMint(); }}>Mint Tokens</button>
                            <button className="btn btn-ghost" onClick={() => { onClose(); onResolve(); }}>Resolve</button>
                        </div>
                    </div>
                )}

                {market.status === 'Resolved' && (
                    <div>
                        <div className="divider" />
                        <div style={{ fontWeight: 600, marginBottom: 12 }}>
                            Redeem Winning Tokens
                            {market.outcome !== null && (
                                <span style={{ marginLeft: 8, fontSize: '0.85rem', color: market.outcome ? 'var(--yes-color)' : 'var(--no-color)' }}>
                                    ({market.outcome ? 'YES' : 'NO'} won)
                                </span>
                            )}
                        </div>

                        {market.outcome !== null && (
                            <div className={`alert ${market.outcome ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 16 }}>
                                {market.outcome ? 'YES' : 'NO'} tokens won this market! Redeem them for SUI.
                            </div>
                        )}

                        <div className="outcome-toggle" style={{ marginBottom: 14 }}>
                            <div
                                className={`outcome-option yes ${redeemSide === 'yes' ? 'selected' : ''}`}
                                onClick={() => setRedeemSide('yes')}
                                style={{ opacity: market.outcome === false ? 0.4 : 1 }}
                            >
                                YES tokens
                            </div>
                            <div
                                className={`outcome-option no ${redeemSide === 'no' ? 'selected' : ''}`}
                                onClick={() => setRedeemSide('no')}
                                style={{ opacity: market.outcome === true ? 0.4 : 1 }}
                            >
                                NO tokens
                            </div>
                        </div>

                        <button
                            className="btn btn-primary btn-full"
                            onClick={handleRedeem}
                            disabled={redeemLoading || (market.outcome !== null && ((redeemSide === 'yes' && !market.outcome) || (redeemSide === 'no' && market.outcome)))}
                        >
                            {redeemLoading ? 'Redeeming…' : `Redeem ${redeemSide.toUpperCase()} Tokens`}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
