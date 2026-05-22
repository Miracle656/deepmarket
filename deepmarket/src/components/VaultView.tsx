// VaultView — dedicated page for the Predict LP vault (the maker side).
//
// Kept separate from /predict (the oracle list / taker side) so each surface
// stays focused — supplying liquidity and picking oracles are different jobs.

import { Layers } from 'lucide-react';
import VaultPanel from './VaultPanel';

export default function VaultView() {
    return (
        <div className="vault-view">
            <div className="predict-header">
                <div>
                    <div className="predict-eyebrow">
                        <Layers size={14} />
                        <span>DeepBook Predict · Vault</span>
                    </div>
                    <h1 className="predict-title">Provide liquidity · earn the premium</h1>
                    <p className="predict-sub">
                        Supply dUSDC to back every binary &amp; range position on Predict —
                        you're the counterparty, and you collect the premiums takers pay.
                        PLP shares accrue value as the vault profits.
                    </p>
                </div>
            </div>
            <VaultPanel />
        </div>
    );
}
