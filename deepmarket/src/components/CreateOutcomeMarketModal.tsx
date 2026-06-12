import { useState } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction, useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { Plus, X } from 'lucide-react';
import { useToast } from '../lib/toast';
import { compileOutcomeMarket } from '../lib/api';
import { CONFIG } from '../lib/config';
import { TICK_SIZE, LOT_SIZE, MIN_SIZE } from '../lib/outcomeTrade';

interface Props {
    onCreated: (marketObjectId: string, question: string) => void;
    onClose: () => void;
}

const MIN_OUTCOMES = 2;
const MAX_OUTCOMES = 64;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000000000000000000000000000';

// World-Cup default seeds the form so the common case is one click away.
const DEFAULT_OUTCOMES = ['Spain', 'France', 'England', 'Argentina'];

const STEP_LABELS = [
    'Compiling outcome tokens…',  // step 1
    'Publishing token package…',  // step 2
    'Opening DeepBook pools…',    // step 3 (only when order books enabled)
    'Creating market on-chain…',  // step 4 (or 3 without pools)
];

export default function CreateOutcomeMarketModal({ onCreated, onClose }: Props) {
    const acct = useCurrentAccount();
    const suiClient = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();
    const { toast } = useToast();

    const [question, setQuestion] = useState('Who wins the 2026 FIFA World Cup?');
    const [outcomes, setOutcomes] = useState<string[]>(DEFAULT_OUTCOMES);
    const [oracle, setOracle] = useState('');
    const [days, setDays] = useState('30');
    const [pools, setPools] = useState(false);
    const [loading, setLoading] = useState(false);
    const [step, setStep] = useState(0); // 0 = idle, 1-4 = active

    const setOutcomeAt = (i: number, v: string) =>
        setOutcomes(prev => prev.map((o, idx) => (idx === i ? v : o)));

    const addOutcome = () =>
        setOutcomes(prev => (prev.length < MAX_OUTCOMES ? [...prev, ''] : prev));

    const removeOutcome = (i: number) =>
        setOutcomes(prev => (prev.length > MIN_OUTCOMES ? prev.filter((_, idx) => idx !== i) : prev));

    const handleCreate = async () => {
        if (!acct) return toast('error', 'Connect your wallet first');
        if (!question.trim()) return toast('error', 'Enter a market question');

        const names = outcomes.map(o => o.trim()).filter(Boolean);
        if (names.length < MIN_OUTCOMES) return toast('error', `Need at least ${MIN_OUTCOMES} outcomes`);
        if (new Set(names.map(n => n.toLowerCase())).size !== names.length)
            return toast('error', 'Outcome names must be unique');

        const n = names.length;
        const resolutionTime = Date.now() + parseInt(days) * 86_400_000;
        const oracleAddr = oracle.trim() || ZERO_ADDR;

        setLoading(true);
        try {
            // ── Step 1: Compile N outcome-token modules ──────────────────────
            setStep(1);
            toast('info', 'Step 1/3', 'Compiling outcome tokens…');
            const { modules, dependencies } = await compileOutcomeMarket(question.trim(), names);

            // ── Step 2: Publish the token package ────────────────────────────
            setStep(2);
            toast('info', 'Step 2/3', 'Publishing token package…');

            const publishTx = new Transaction();
            publishTx.setSender(acct.address);
            const upgradeCap = publishTx.publish({ modules, dependencies });
            publishTx.transferObjects([upgradeCap], publishTx.pure.address(ZERO_ADDR));

            const pub = await signAndExec({ transaction: publishTx });
            const pubRes = await suiClient.waitForTransaction({
                digest: pub.digest,
                options: { showObjectChanges: true },
            });

            // Harvest the package id and each outcome's TreasuryCap (by index).
            // Token modules are named outcome_0 … outcome_{n-1}, so the cap's
            // inner type contains `::outcome_{i}::OUTCOME_{i}` — that's how we
            // map each cap back to its outcome index deterministically.
            let packageId = '';
            const capIdByIdx: (string | undefined)[] = new Array(n).fill(undefined);
            const capTypeByIdx: (string | undefined)[] = new Array(n).fill(undefined);

            for (const ch of pubRes.objectChanges ?? []) {
                if (ch.type === 'published') {
                    packageId = ch.packageId;
                }
                if (ch.type === 'created' && ch.objectType.startsWith('0x2::coin::TreasuryCap<')) {
                    const inner = ch.objectType.match(/<(.+)>/)?.[1] ?? '';
                    const m = inner.match(/::outcome_(\d+)::OUTCOME_\d+/);
                    if (m) {
                        const idx = parseInt(m[1]);
                        if (idx >= 0 && idx < n) {
                            capIdByIdx[idx] = ch.objectId;
                            capTypeByIdx[idx] = inner;
                        }
                    }
                }
            }

            if (!packageId) throw new Error('Could not extract packageId from publish effects');
            for (let i = 0; i < n; i++) {
                if (!capIdByIdx[i] || !capTypeByIdx[i])
                    throw new Error(`Missing TreasuryCap for outcome ${i} (${names[i]})`);
            }

            toast('info', 'Package published', `${packageId.slice(0, 16)}…`);

            // ── Step 3 (optional): open one DeepBook pool per outcome ────────
            // base = outcome token, quote = SUI. 500 DEEP creation fee each.
            const poolIdByIdx: string[] = new Array(n).fill(ZERO_ADDR);
            if (pools) {
                setStep(3);
                toast('info', 'Step 3/4', `Opening ${n} DeepBook pools…`);

                if (!CONFIG.DEEPBOOK_PACKAGE_ID || !CONFIG.DEEPBOOK_REGISTRY_ID || !CONFIG.DEEP_TOKEN_TYPE) {
                    throw new Error('DeepBook is not configured (registry / DEEP type missing)');
                }

                const need = CONFIG.DEEP_POOL_FEE * BigInt(n);
                const deepCoins = await suiClient.getCoins({ owner: acct.address, coinType: CONFIG.DEEP_TOKEN_TYPE });
                const totalDeep = deepCoins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
                if (totalDeep < need) {
                    throw new Error(
                        `Need ${need / CONFIG.DEEP_SCALAR} DEEP (${CONFIG.DEEP_POOL_FEE / CONFIG.DEEP_SCALAR} × ${n} pools); ` +
                        `wallet has ${totalDeep / CONFIG.DEEP_SCALAR} DEEP.`
                    );
                }

                const poolTx = new Transaction();
                poolTx.setSender(acct.address);
                // Consolidate DEEP into one coin, then split one 500-DEEP fee per pool.
                const deepRefs = deepCoins.data.map(c => poolTx.object(c.coinObjectId));
                const deepPrimary = deepRefs[0];
                if (deepRefs.length > 1) poolTx.mergeCoins(deepPrimary, deepRefs.slice(1));

                for (let i = 0; i < n; i++) {
                    const [fee] = poolTx.splitCoins(deepPrimary, [poolTx.pure.u64(CONFIG.DEEP_POOL_FEE)]);
                    poolTx.moveCall({
                        target: `${CONFIG.DEEPBOOK_PACKAGE_ID}::pool::create_permissionless_pool`,
                        typeArguments: [capTypeByIdx[i]!, CONFIG.SUI_TYPE],
                        arguments: [
                            poolTx.object(CONFIG.DEEPBOOK_REGISTRY_ID),
                            poolTx.pure.u64(TICK_SIZE),
                            poolTx.pure.u64(LOT_SIZE),
                            poolTx.pure.u64(MIN_SIZE),
                            fee,
                        ],
                    });
                }

                const poolPub = await signAndExec({ transaction: poolTx });
                const poolRes = await suiClient.waitForTransaction({
                    digest: poolPub.digest,
                    options: { showObjectChanges: true },
                });

                for (const ch of poolRes.objectChanges ?? []) {
                    if (ch.type === 'created' && 'objectType' in ch && ch.objectType.includes('::pool::Pool<')) {
                        for (let i = 0; i < n; i++) {
                            if (poolIdByIdx[i] === ZERO_ADDR && ch.objectType.includes(`::outcome_${i}::OUTCOME_${i}`)) {
                                poolIdByIdx[i] = ch.objectId;
                                break;
                            }
                        }
                    }
                }
                const opened = poolIdByIdx.filter(p => p !== ZERO_ADDR).length;
                if (opened !== n) throw new Error(`Opened ${opened}/${n} pools — could not match all pool ids`);
                toast('info', 'Pools opened', `${n} order books live`);
            }

            // ── Step 4 (or 3 without pools): create_market → add_outcome×N → share ──
            setStep(4);
            toast('info', pools ? 'Step 4/4' : 'Step 3/3', 'Creating market on-chain…');

            const tx = new Transaction();
            tx.setSender(acct.address);

            const market = tx.moveCall({
                target: `${CONFIG.OUTCOME_PACKAGE_ID}::outcome_market::create_market`,
                typeArguments: [CONFIG.SUI_TYPE],
                arguments: [
                    tx.pure.string(question.trim()),
                    tx.pure.vector('string', names),
                    tx.pure.u8(n),
                    tx.pure.u64(resolutionTime),
                    tx.pure.address(oracleAddr),
                    tx.pure.address(packageId),
                ],
            });

            for (let i = 0; i < n; i++) {
                tx.moveCall({
                    target: `${CONFIG.OUTCOME_PACKAGE_ID}::outcome_market::add_outcome`,
                    typeArguments: [CONFIG.SUI_TYPE, capTypeByIdx[i]!],
                    arguments: [
                        market,
                        tx.pure.u8(i),
                        tx.object(capIdByIdx[i]!),
                        tx.pure.address(poolIdByIdx[i]), // pool id, or 0x0 if order books disabled
                    ],
                });
            }

            tx.moveCall({
                target: `${CONFIG.OUTCOME_PACKAGE_ID}::outcome_market::share_market`,
                typeArguments: [CONFIG.SUI_TYPE],
                arguments: [market],
            });

            const createRes = await signAndExec({ transaction: tx });
            const finalRes = await suiClient.waitForTransaction({
                digest: createRes.digest,
                options: { showObjectChanges: true, showEvents: true },
            });

            // Pull the shared OutcomeMarket's object id from effects.
            let marketObjectId = '';
            for (const ch of finalRes.objectChanges ?? []) {
                if (
                    ch.type === 'created' &&
                    'objectType' in ch &&
                    ch.objectType.includes('::outcome_market::OutcomeMarket<')
                ) {
                    marketObjectId = ch.objectId;
                    break;
                }
            }

            toast('success', 'Multi-outcome market live!', `${n} outcomes · ${marketObjectId.slice(0, 16)}…`);
            onCreated(marketObjectId, question.trim());
            onClose();
        } catch (e: any) {
            console.error(e);
            toast('error', 'Market creation failed', e.message);
        } finally {
            setLoading(false);
            setStep(0);
        }
    };

    const stepLabel = step > 0 ? STEP_LABELS[step - 1] : '';
    const totalSteps = pools ? 4 : 3;
    // Without pools the flow skips step 3, jumping 2→4; show it as "3/3".
    const displayStep = !pools && step === 4 ? 3 : step;

    return (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
            <div className="modal">
                <div className="modal-header">
                    <span className="modal-title">Create Multi-Outcome Market</span>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>

                {step > 0 && (
                    <div className="alert alert-info" style={{ marginBottom: 12 }}>
                        Step {displayStep}/{totalSteps}: {stepLabel}
                    </div>
                )}

                <div className="alert alert-info">
                    <span>
                        Stake SUI on an outcome to <strong>mint that outcome's token</strong> 1:1;
                        after resolution, winning tokens <strong>redeem for a pro-rata share of the
                        whole pool</strong>. This core flow needs <strong>no DEEP</strong>. Enabling
                        order books below opens a DeepBook pool per outcome so the tokens also trade
                        on a live order book (costs {pools ? '500 DEEP × ' + (outcomes.filter(o => o.trim()).length || 0) + ' outcomes' : '500 DEEP per outcome'}).
                    </span>
                </div>

                <div className="form-group">
                    <label className="form-label">Market Question</label>
                    <textarea
                        className="form-textarea"
                        placeholder="Who wins the 2026 FIFA World Cup?"
                        value={question}
                        onChange={e => setQuestion(e.target.value)}
                    />
                </div>

                <div className="form-group">
                    <label className="form-label">
                        Outcomes ({outcomes.length}) — {MIN_OUTCOMES}–{MAX_OUTCOMES}
                    </label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {outcomes.map((o, i) => (
                            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <span style={{
                                    fontSize: '0.7rem', color: 'var(--text-muted)',
                                    width: 18, textAlign: 'right', flexShrink: 0,
                                }}>{i}</span>
                                <input
                                    className="form-input"
                                    placeholder={`Outcome ${i + 1}`}
                                    value={o}
                                    onChange={e => setOutcomeAt(i, e.target.value)}
                                    style={{ flex: 1 }}
                                />
                                <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => removeOutcome(i)}
                                    disabled={outcomes.length <= MIN_OUTCOMES}
                                    title="Remove outcome"
                                    style={{ padding: '6px 8px', flexShrink: 0 }}
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        ))}
                    </div>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={addOutcome}
                        disabled={outcomes.length >= MAX_OUTCOMES}
                        style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                        <Plus size={14} /> Add outcome
                    </button>
                </div>

                <div className="form-group">
                    <label className="form-label">Resolution (days from now)</label>
                    <input
                        className="form-input"
                        type="number"
                        min="1"
                        max="3650"
                        value={days}
                        onChange={e => setDays(e.target.value)}
                    />
                </div>

                <div className="form-group">
                    <label className="form-label">Oracle Address (optional)</label>
                    <input
                        className="form-input"
                        placeholder="0x… (leave empty — sports resolve via admin)"
                        value={oracle}
                        onChange={e => setOracle(e.target.value)}
                    />
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: '0.82rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <input
                        type="checkbox"
                        checked={pools}
                        onChange={e => setPools(e.target.checked)}
                    />
                    Enable DeepBook order-book trading
                    <span style={{ color: 'var(--text-muted)' }}>
                        ({500 * (outcomes.filter(o => o.trim()).length || 0)} DEEP)
                    </span>
                </label>

                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-ghost btn-full" onClick={onClose}>Cancel</button>
                    <button
                        className="btn btn-primary btn-full"
                        onClick={handleCreate}
                        disabled={loading || !question.trim()}
                    >
                        {loading ? stepLabel || 'Creating…' : 'Create Market'}
                    </button>
                </div>
            </div>
        </div>
    );
}
