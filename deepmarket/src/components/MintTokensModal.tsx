import { useState } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction, useCurrentAccount } from '@mysten/dapp-kit';
import { CONFIG, type Market } from '../lib/config';
import { useToast } from '../lib/toast';

interface Props {
    market: Market;
    onClose: () => void;
}

export default function MintTokensModal({ market, onClose }: Props) {
    const acct = useCurrentAccount();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();
    const { toast } = useToast();

    const [amount, setAmount] = useState('10');
    const [loading, setLoading] = useState(false);

    const handleMint = async () => {
        if (!acct) return toast('error', 'Wallet not connected');
        if (!CONFIG.PACKAGE_ID) return toast('error', 'Package ID not set');
        if (!CONFIG.MARKET_REGISTRY) return toast('error', 'Market registry not configured');

        const yesType = `${market.tokenPackageId}::yes_market::YES_MARKET`;
        const noType  = `${market.tokenPackageId}::no_market::NO_MARKET`;

        setLoading(true);
        try {
            const tx = new Transaction();
            tx.setSender(acct.address);

            const amountMist = BigInt(Math.round(parseFloat(amount) * 1_000_000_000));
            const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);

            tx.moveCall({
                target: `${CONFIG.PACKAGE_ID}::market_factory::mint_outcome_tokens`,
                arguments: [
                    tx.object(CONFIG.MARKET_REGISTRY),
                    tx.pure.u64(market.id),
                    paymentCoin,
                ],
                typeArguments: [CONFIG.SUI_TYPE, yesType, noType],
            });

            await signAndExec({ transaction: tx });
            toast('success', 'Tokens minted!', `You received ${amount} YES + ${amount} NO tokens`);
            onClose();
        } catch (e: any) {
            toast('error', 'Minting failed', e.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
            <div className="modal">
                <div className="modal-header">
                    <h2 className="modal-title">Mint Outcome Tokens</h2>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>

                <div className="card" style={{ marginBottom: 20, background: 'var(--bg-card2)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Market #{market.id}</div>
                    <div style={{ fontWeight: 600 }}>{market.question}</div>
                </div>

                <div className="alert alert-info">
                    Deposit SUI to receive equal amounts of YES and NO tokens. Winning tokens redeem 1:1 for SUI after resolution.
                </div>

                <div className="form-group">
                    <label className="form-label">Amount (SUI)</label>
                    <input
                        className="form-input"
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={amount}
                        onChange={e => setAmount(e.target.value)}
                    />
                    <div style={{ marginTop: 6, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        You will receive {amount} YES tokens + {amount} NO tokens
                    </div>
                </div>

                <div className="outcome-toggle" style={{ marginBottom: 0, pointerEvents: 'none', opacity: 0.7 }}>
                    <div className="outcome-option yes selected">YES × {amount}</div>
                    <div className="outcome-option no selected">NO × {amount}</div>
                </div>

                <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
                    <button className="btn btn-ghost btn-full" onClick={onClose}>Cancel</button>
                    <button
                        className="btn btn-primary btn-full"
                        onClick={handleMint}
                        disabled={loading || parseFloat(amount) <= 0}
                    >
                        {loading ? 'Minting…' : 'Mint Tokens'}
                    </button>
                </div>
            </div>
        </div>
    );
}
