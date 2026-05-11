import { useState } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction, useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useToast } from '../lib/toast';
import { compileMarket } from '../lib/api';
import { CONFIG } from '../lib/config';
import { useMessagingClient } from '../contexts/MessagingClientContext';
import { marketUuidFor } from '../lib/messaging';

interface Props {
    onCreated: (question: string, resolutionTime: number, oracle: string) => void;
    onClose: () => void;
}

const TICK_SIZE = 1_000n;
const LOT_SIZE  = 1_000_000n;
const MIN_SIZE  = 1_000_000n;

const STEP_LABELS = [
    'Compiling token contracts…',   // step 1
    'Publishing token package…',    // step 2
    'Creating DeepBook pools…',     // step 3
    'Registering market…',          // step 4
];

export default function CreateMarketModal({ onCreated, onClose }: Props) {
    const acct = useCurrentAccount();
    const suiClient = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();
    const messagingClient = useMessagingClient();
    const { toast } = useToast();

    const [question, setQuestion]   = useState('');
    const [oracle, setOracle]       = useState('');
    const [days, setDays]           = useState('30');
    const [loading, setLoading]     = useState(false);
    const [step, setStep]           = useState(0); // 0 = idle, 1-4 = active
    const [skipPools, setSkipPools] = useState(true);

    const handleCreate = async () => {
        if (!acct) return toast('error', 'Connect your wallet first');
        if (!question.trim()) return toast('error', 'Enter a market question');

        const resolutionTime = Date.now() + parseInt(days) * 86_400_000;
        const oracleAddr = oracle || '0x0000000000000000000000000000000000000000';

        setLoading(true);
        try {
            // ── Step 1: Compile ──────────────────────────────────────────────────
            setStep(1);
            toast('info', 'Step 1/3', 'Compiling token contracts…');
            const { modules, dependencies } = await compileMarket(question.trim());

            // ── Step 2: Publish token package ────────────────────────────────────
            setStep(2);
            toast('info', 'Step 2/3', 'Publishing token package…');

            const publishTx = new Transaction();
            publishTx.setSender(acct.address);
            const upgradeCap = publishTx.publish({ modules, dependencies });
            publishTx.transferObjects(
                [upgradeCap],
                publishTx.pure.address('0x0000000000000000000000000000000000000000')
            );

            const pub1 = await signAndExec({ transaction: publishTx });
            const pub1Res = await suiClient.waitForTransaction({
                digest: pub1.digest,
                options: { showObjectChanges: true },
            });

            let packageId = '';
            let yesCapId  = '';
            let noCapId   = '';
            let yesType   = '';
            let noType    = '';

            for (const ch of pub1Res.objectChanges ?? []) {
                if (ch.type === 'published') {
                    packageId = ch.packageId;
                }
                if (
                    ch.type === 'created' &&
                    ch.objectType.startsWith('0x2::coin::TreasuryCap<')
                ) {
                    if (ch.objectType.includes('::yes_market::YES_MARKET')) {
                        yesCapId = ch.objectId;
                        yesType  = ch.objectType.match(/<(.+)>/)?.[1] ?? '';
                    } else if (ch.objectType.includes('::no_market::NO_MARKET')) {
                        noCapId = ch.objectId;
                        noType  = ch.objectType.match(/<(.+)>/)?.[1] ?? '';
                    }
                }
            }

            if (!packageId) throw new Error('Could not extract packageId from publish transaction effects');
            if (!yesCapId || !noCapId) throw new Error('TreasuryCaps not found in publish effects');

            toast('info', 'Package published', `${packageId.slice(0, 16)}…`);

            let yesPoolId = '';
            let noPoolId  = '';

            if (!skipPools && CONFIG.DEEPBOOK_PACKAGE_ID && CONFIG.DEEPBOOK_REGISTRY_ID && CONFIG.DEEP_TOKEN_TYPE) {
                // ── Step 3: Create DeepBook pools ─────────────────────────────────
                setStep(3);
                toast('info', 'Step 3/3 (part 1)', 'Creating DeepBook pools…');

                const deepCoins = await suiClient.getCoins({ owner: acct.address, coinType: CONFIG.DEEP_TOKEN_TYPE });
                const deepCoin  = deepCoins.data.find(c => BigInt(c.balance) >= CONFIG.DEEP_POOL_FEE * 2n);
                if (!deepCoin) {
                    const needed = CONFIG.DEEP_POOL_FEE * 2n / CONFIG.DEEP_SCALAR;
                    throw new Error(
                        `You need ${needed} DEEP tokens (${CONFIG.DEEP_POOL_FEE / CONFIG.DEEP_SCALAR} DEEP × 2 pools) to create DeepBook pools. ` +
                        `Claim testnet DEEP at: https://deepbook.xyz/faucet or ask in the DeepBook Discord.`
                    );
                }

                const suiType = CONFIG.SUI_TYPE;
                const poolTx  = new Transaction();
                poolTx.setSender(acct.address);

                const [deepForYes] = poolTx.splitCoins(poolTx.object(deepCoin.coinObjectId), [poolTx.pure.u64(CONFIG.DEEP_POOL_FEE)]);
                const [deepForNo]  = poolTx.splitCoins(poolTx.object(deepCoin.coinObjectId), [poolTx.pure.u64(CONFIG.DEEP_POOL_FEE)]);

                const yesPool = poolTx.moveCall({
                    target: `${CONFIG.DEEPBOOK_PACKAGE_ID}::pool::create_pool`,
                    typeArguments: [yesType, suiType],
                    arguments: [
                        poolTx.object(CONFIG.DEEPBOOK_REGISTRY_ID),
                        poolTx.pure.u64(TICK_SIZE),
                        poolTx.pure.u64(LOT_SIZE),
                        poolTx.pure.u64(MIN_SIZE),
                        poolTx.pure.bool(false),
                        poolTx.pure.bool(false),
                        deepForYes,
                        poolTx.object(CONFIG.CLOCK),
                    ],
                });
                poolTx.moveCall({
                    target: '0x2::transfer::public_share_object',
                    typeArguments: [`${CONFIG.DEEPBOOK_PACKAGE_ID}::pool::Pool<${yesType},${suiType}>`],
                    arguments: [yesPool],
                });

                const noPool = poolTx.moveCall({
                    target: `${CONFIG.DEEPBOOK_PACKAGE_ID}::pool::create_pool`,
                    typeArguments: [noType, suiType],
                    arguments: [
                        poolTx.object(CONFIG.DEEPBOOK_REGISTRY_ID),
                        poolTx.pure.u64(TICK_SIZE),
                        poolTx.pure.u64(LOT_SIZE),
                        poolTx.pure.u64(MIN_SIZE),
                        poolTx.pure.bool(false),
                        poolTx.pure.bool(false),
                        deepForNo,
                        poolTx.object(CONFIG.CLOCK),
                    ],
                });
                poolTx.moveCall({
                    target: '0x2::transfer::public_share_object',
                    typeArguments: [`${CONFIG.DEEPBOOK_PACKAGE_ID}::pool::Pool<${noType},${suiType}>`],
                    arguments: [noPool],
                });

                const pub2 = await signAndExec({ transaction: poolTx });
                const pub2Res = await suiClient.waitForTransaction({
                    digest: pub2.digest,
                    options: { showObjectChanges: true },
                });

                // Extract pool IDs from created shared objects
                for (const ch of pub2Res.objectChanges ?? []) {
                    if (ch.type === 'created') {
                        const t = 'objectType' in ch ? ch.objectType : '';
                        if (t.includes('pool::Pool<') && t.includes(yesType)) {
                            yesPoolId = ch.objectId;
                        } else if (t.includes('pool::Pool<') && t.includes(noType)) {
                            noPoolId = ch.objectId;
                        }
                    }
                }

                if (!yesPoolId || !noPoolId) {
                    throw new Error('Could not extract pool IDs from pool creation effects');
                }
            }

            // ── Step 4 (or 3 without DeepBook): Register market ─────────────────
            setStep(4);
            toast('info', `Step 3/3`, 'Registering market on-chain…');

            const suiType  = CONFIG.SUI_TYPE;
            const registerTx = new Transaction();
            registerTx.setSender(acct.address);

            registerTx.moveCall({
                target: `${CONFIG.PACKAGE_ID}::market_factory::register_custom_market`,
                typeArguments: [suiType, yesType, noType],
                arguments: [
                    registerTx.object(CONFIG.MARKET_REGISTRY),
                    registerTx.object(yesCapId),
                    registerTx.object(noCapId),
                    registerTx.pure.string(question.trim()),
                    registerTx.pure.u64(resolutionTime),
                    registerTx.pure.address(oracleAddr),
                    registerTx.pure.address(yesPoolId || '0x0000000000000000000000000000000000000000000000000000000000000000'),
                    registerTx.pure.address(noPoolId  || '0x0000000000000000000000000000000000000000000000000000000000000000'),
                    registerTx.pure.address(packageId),
                ],
            });

            const regResult = await signAndExec({ transaction: registerTx });

            // Pull the freshly assigned market_id from MarketCreatedEvent so we
            // can derive a deterministic chat UUID for the market.
            let createdMarketId: string | null = null;
            try {
                const regRes = await suiClient.waitForTransaction({
                    digest: regResult.digest,
                    options: { showEvents: true },
                });
                for (const ev of regRes.events ?? []) {
                    const t = (ev as { type?: string }).type ?? '';
                    if (t.endsWith('::MarketCreatedEvent')) {
                        const parsed = (ev as { parsedJson?: { market_id?: string | number } })
                            .parsedJson;
                        if (parsed?.market_id !== undefined) {
                            createdMarketId = String(parsed.market_id);
                            break;
                        }
                    }
                }
            } catch {
                // best-effort; fall through without chat
            }

            // Best-effort chat group creation. Failure here does NOT fail the
            // overall market creation flow — the user can still create the
            // chat from the market detail page later.
            if (createdMarketId && messagingClient) {
                try {
                    toast('info', 'Creating chat…', 'Setting up the discussion group');
                    const chatUuid = marketUuidFor(createdMarketId);
                    const chatTx = new Transaction();
                    await messagingClient.messaging.call.createAndShareGroup({
                        uuid: chatUuid,
                        name: question.trim().slice(0, 80),
                    })(chatTx);
                    await signAndExec({ transaction: chatTx });
                    toast('success', 'Market + chat live!', `Package: ${packageId.slice(0, 16)}…`);
                } catch (chatErr) {
                    console.warn('Chat creation failed (non-fatal):', chatErr);
                    toast(
                        'success',
                        'Market live, chat skipped',
                        'You can create the chat from the market page.'
                    );
                }
            } else {
                toast('success', 'Market live on Sui Testnet!', `Package: ${packageId.slice(0, 16)}…`);
            }

            onCreated(question.trim(), resolutionTime, oracleAddr);
            onClose();
        } catch (e: any) {
            console.error(e);
            toast('error', 'Market creation failed', e.message);
        } finally {
            setLoading(false);
            setStep(0);
        }
    };

    // Wallet steps: publish (step2), pools (step3), register (step4)
    // We show "1/3, 2/3, 3/3" for wallet steps
    const walletStep = step >= 2 ? step - 1 : 0;
    const stepLabel  = step > 0 ? STEP_LABELS[step - 1] : '';

    return (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
            <div className="modal">
                <div className="modal-header">
                    <span className="modal-title">Create New Market</span>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>

                {step > 0 && (
                    <div className="alert alert-info" style={{ marginBottom: 12 }}>
                        {step === 1 ? 'Compiling…' : `Step ${walletStep}/3: `}{stepLabel}
                    </div>
                )}

                <div className="alert alert-info">
                    <span>
                        {skipPools
                            ? <>Markets created without pools support <strong>mint, resolve, redeem</strong> — and <strong>per-market chat</strong>. Skip pools while iterating; turn them on for the demo market.</>
                            : <>Full creation requires <strong>1000 DEEP</strong> testnet tokens (500 DEEP × 2 pools). Make sure your wallet has them before continuing — pool creation cannot be retried with insufficient DEEP.</>
                        }
                    </span>
                </div>

                <div className="form-group">
                    <label className="form-label">Market Question</label>
                    <textarea
                        className="form-textarea"
                        placeholder="Will Bitcoin exceed $150K by end of 2026?"
                        value={question}
                        onChange={e => setQuestion(e.target.value)}
                    />
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
                        placeholder="0x… (leave empty for manual resolution)"
                        value={oracle}
                        onChange={e => setOracle(e.target.value)}
                    />
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: '0.82rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <input
                        type="checkbox"
                        checked={!skipPools}
                        onChange={e => setSkipPools(!e.target.checked)}
                    />
                    Enable DeepBook order-book trading (requires 1000 DEEP testnet tokens)
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
