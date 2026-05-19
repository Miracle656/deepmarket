import { useState, useEffect, useCallback } from 'react';
import { BarChart2 } from 'lucide-react';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { testnetPackageIds } from '@mysten/deepbook-v3';
import { CONFIG, type Market } from '../lib/config';
import { useToast } from '../lib/toast';
import { getUserBalanceManager } from '../lib/accountModule';

interface Props {
    market: Market | null;
}

export default function TradeSidebar({ market }: Props) {
    const acct = useCurrentAccount();
    const suiClient = useSuiClient();
    const { mutateAsync: signAndExec } = useSignAndExecuteTransaction();
    const { toast } = useToast();

    const [mode, setMode] = useState<'buy' | 'sell'>('buy');
    // 'limit' is the default: a fresh CLOB market has an empty book, so a
    // market order fills nothing. Limit orders are what create liquidity.
    const [orderKind, setOrderKind] = useState<'market' | 'limit'>('limit');
    const [limitPrice, setLimitPrice] = useState('');
    const [outcome, setOutcome] = useState<'yes' | 'no'>('yes');
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [managerId, setManagerId] = useState<string | null>(null);
    const [suiBalance, setSuiBalance] = useState(0);
    const [yesBalance, setYesBalance] = useState(0);
    const [noBalance, setNoBalance] = useState(0);

    // Fetch BalanceManager
    useEffect(() => {
        if (!acct) return;
        getUserBalanceManager(suiClient, acct.address).then(setManagerId).catch(console.error);
    }, [acct, suiClient]);

    // Fetch wallet balances
    const refreshBalances = useCallback(async () => {
        if (!acct) return;
        try {
            const suiBal = await suiClient.getBalance({ owner: acct.address, coinType: '0x2::sui::SUI' });
            setSuiBalance(Number(suiBal.totalBalance) / 1e9);
        } catch { /* ignore */ }
        if (!market?.tokenPackageId) return;
        try {
            const yesBal = await suiClient.getBalance({
                owner: acct.address,
                coinType: `${market.tokenPackageId}::yes_market::YES_MARKET`,
            });
            // YES/NO outcome tokens are 6-decimal (1e6), not 9 like SUI.
            setYesBalance(Number(yesBal.totalBalance) / 1e6);
        } catch { setYesBalance(0); }
        try {
            const noBal = await suiClient.getBalance({
                owner: acct.address,
                coinType: `${market.tokenPackageId}::no_market::NO_MARKET`,
            });
            setNoBalance(Number(noBal.totalBalance) / 1e6);
        } catch { setNoBalance(0); }
    }, [acct, suiClient, market?.tokenPackageId]);

    useEffect(() => {
        refreshBalances();
    }, [refreshBalances]);

    // Derived calculations
    const price = outcome === 'yes'
        ? (market?.yesPrice ?? 50) / 100
        : (market?.noPrice ?? 50) / 100;
    const numAmount = parseFloat(amount) || 0;

    // Buy: spend SUI → receive shares. Sell: sell shares → receive SUI.
    const sharesDisplay = numAmount > 0
        ? (mode === 'buy' ? numAmount / price : numAmount).toFixed(4)
        : '—';
    const suiDisplay = numAmount > 0
        ? (mode === 'buy' ? numAmount : numAmount * price).toFixed(4)
        : '—';
    const maxProfit = mode === 'buy' && numAmount > 0
        ? (numAmount / price - numAmount).toFixed(4)
        : '—';

    const displayBalance = mode === 'buy'
        ? suiBalance
        : (outcome === 'yes' ? yesBalance : noBalance);

    const setPct = (pct: number) =>
        setAmount((displayBalance * pct / 100).toFixed(4));

    // Resolve pool type args from network
    const getPoolTypes = async (poolId: string) => {
        const poolObj = await suiClient.getObject({ id: poolId, options: { showType: true } });
        const match = poolObj.data?.type?.match(/<(.+),\s*(.+)>/);
        if (!match) throw new Error('Could not determine pool type from network');
        return { baseCoinType: match[1], quoteCoinType: match[2] };
    };

    const handleCreateManager = async () => {
        if (!acct) return toast('error', 'Connect your wallet first');
        try {
            setLoading(true);
            const tx = new Transaction();
            // DeepBook V3 `balance_manager::new(ctx): BalanceManager` — returns
            // a fresh owned BalanceManager. The old `create_balance_manager`
            // doesn't exist on the deployed package (FunctionNotFound).
            // TxContext is auto-injected by Sui; no explicit args.
            const manager = tx.moveCall({
                target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::new`,
                arguments: [],
            });
            tx.transferObjects([manager], acct.address);
            await signAndExec({ transaction: tx });
            toast('success', 'DeepBook account created');
            // Poll a few times — the new owned object can take a moment to
            // be visible to getOwnedObjects after the tx is finalized.
            for (let i = 0; i < 6; i++) {
                await new Promise((r) => setTimeout(r, 2000));
                if (!acct) break;
                const id = await getUserBalanceManager(suiClient, acct.address);
                if (id) { setManagerId(id); break; }
            }
        } catch (e: any) {
            toast('error', 'Failed to create DeepBook account', e.message);
        } finally {
            setLoading(false);
        }
    };

    const handleBuy = async () => {
        if (!acct || !market || !managerId) return;
        const poolId = outcome === 'yes' ? market.yesPoolId : market.noPoolId;
        if (!poolId || /^0x0+$/.test(poolId)) return toast('error', 'Market pools not configured');

        const amountMist = BigInt(Math.round(numAmount * 1_000_000_000));
        const sharesQuantityMist = BigInt(Math.round((numAmount / price) * 1_000_000_000));

        const { baseCoinType, quoteCoinType } = await getPoolTypes(poolId);

        const tx = new Transaction();
        tx.setSender(acct.address);

        const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
        tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
            arguments: [tx.object(managerId), coin],
            typeArguments: [quoteCoinType],
        });
        const tradeProof = tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(managerId)],
        });
        tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::pool::place_market_order`,
            arguments: [
                tx.object(poolId),
                tx.object(managerId),
                tradeProof,
                tx.pure.u64(0),
                tx.pure.u8(0),
                tx.pure.u64(sharesQuantityMist),
                tx.pure.bool(true),
                tx.pure.bool(false),
                tx.object('0x6'),
            ],
            typeArguments: [baseCoinType, quoteCoinType],
        });
        const baseOut = tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::withdraw_all`,
            arguments: [tx.object(managerId)],
            typeArguments: [baseCoinType],
        });
        tx.transferObjects([baseOut], acct.address);

        await signAndExec({ transaction: tx });
        toast('success', `Bought ${outcome.toUpperCase()} tokens`, `~${sharesDisplay} shares`);
        setAmount('');
        setTimeout(refreshBalances, 3000);
    };

    const handleSell = async () => {
        if (!acct || !market || !managerId) return;
        const poolId = outcome === 'yes' ? market.yesPoolId : market.noPoolId;
        if (!poolId || /^0x0+$/.test(poolId)) return toast('error', 'Market pools not configured');
        if (!market.tokenPackageId) return toast('error', 'Token package unknown');

        const { baseCoinType, quoteCoinType } = await getPoolTypes(poolId);
        const sellQuantityMist = BigInt(Math.round(numAmount * 1_000_000_000));

        const coins = await suiClient.getCoins({ owner: acct.address, coinType: baseCoinType });
        if (coins.data.length === 0) return toast('error', `No ${outcome.toUpperCase()} tokens to sell`);

        const tx = new Transaction();
        tx.setSender(acct.address);

        // Merge and split exact sell amount
        const coinRefs = coins.data.map(c => tx.object(c.coinObjectId));
        const primary = coinRefs[0];
        if (coinRefs.length > 1) tx.mergeCoins(primary, coinRefs.slice(1));
        const [sellCoin] = tx.splitCoins(primary, [tx.pure.u64(sellQuantityMist)]);

        tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
            arguments: [tx.object(managerId), sellCoin],
            typeArguments: [baseCoinType],
        });
        const tradeProof = tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(managerId)],
        });
        tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::pool::place_market_order`,
            arguments: [
                tx.object(poolId),
                tx.object(managerId),
                tradeProof,
                tx.pure.u64(0),
                tx.pure.u8(0),
                tx.pure.u64(sellQuantityMist),
                tx.pure.bool(false), // isBid=false → selling base for quote
                tx.pure.bool(false),
                tx.object('0x6'),
            ],
            typeArguments: [baseCoinType, quoteCoinType],
        });
        // Withdraw SUI (quote) proceeds
        const quoteOut = tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::withdraw_all`,
            arguments: [tx.object(managerId)],
            typeArguments: [quoteCoinType],
        });
        tx.transferObjects([quoteOut], acct.address);
        // Return any unsold base tokens
        const baseRemainder = tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::withdraw_all`,
            arguments: [tx.object(managerId)],
            typeArguments: [baseCoinType],
        });
        tx.transferObjects([baseRemainder], acct.address);

        await signAndExec({ transaction: tx });
        toast('success', `Sold ${outcome.toUpperCase()} tokens`, `~${suiDisplay} SUI received`);
        setAmount('');
        setTimeout(refreshBalances, 3000);
    };

    const handleRedeem = async () => {
        if (!acct || !market) return;
        if (!market.tokenPackageId) return toast('error', 'Token package unknown');

        const isYes = outcome === 'yes';
        const coinType = `${market.tokenPackageId}::${isYes ? 'yes_market::YES_MARKET' : 'no_market::NO_MARKET'}`;
        const yesType = `${market.tokenPackageId}::yes_market::YES_MARKET`;
        const noType = `${market.tokenPackageId}::no_market::NO_MARKET`;

        const coins = await suiClient.getCoins({ owner: acct.address, coinType });
        if (coins.data.length === 0) return toast('error', `No ${outcome.toUpperCase()} tokens to redeem`);

        const tx = new Transaction();
        tx.setSender(acct.address);

        const coinRefs = coins.data.map(c => tx.object(c.coinObjectId));
        const primary = coinRefs[0];
        if (coinRefs.length > 1) tx.mergeCoins(primary, coinRefs.slice(1));

        tx.moveCall({
            target: `${CONFIG.PACKAGE_ID}::market_factory::${isYes ? 'redeem_yes' : 'redeem_no'}`,
            arguments: [
                tx.object(CONFIG.MARKET_REGISTRY),
                tx.pure.u64(market.id),
                primary,
            ],
            typeArguments: [CONFIG.SUI_TYPE, yesType, noType],
        });

        await signAndExec({ transaction: tx });
        toast('success', `Redeemed ${outcome.toUpperCase()} tokens for SUI`);
        setAmount('');
        setTimeout(refreshBalances, 3000);
    };

    // ── Limit order ───────────────────────────────────────────────────
    // Posts a resting order on the DeepBook book (the only way to create
    // liquidity on a fresh market). Scaling is taken verbatim from the
    // official @mysten/deepbook-v3 SDK:
    //   inputPrice    = round(price * FLOAT_SCALAR * quoteScalar / baseScalar)
    //   inputQuantity = round(qty * baseScalar)
    // YES/NO base = 6 decimals (scalar 1e6), SUI quote = 9 (scalar 1e9),
    // FLOAT_SCALAR = 1e9  →  inputPrice = price * 1e12, inputQty = qty * 1e6.
    const handleLimitOrder = async () => {
        if (!acct || !market || !managerId) return;
        const poolId = outcome === 'yes' ? market.yesPoolId : market.noPoolId;
        if (!poolId || /^0x0+$/.test(poolId)) return toast('error', 'Market pools not configured');
        if (!market.tokenPackageId) return toast('error', 'Token package unknown');

        const px = parseFloat(limitPrice);
        const qty = numAmount; // shares (base)
        if (!(px > 0) || !(qty > 0)) return toast('error', 'Enter a price and quantity');
        if (px >= 1) return toast('error', 'Price must be between 0 and 1 (YES + NO = 1 SUI)');

        const FLOAT_SCALAR = 1e9;
        const baseScalar = 1e6;   // YES/NO 6-decimal
        const quoteScalar = 1e9;  // SUI 9-decimal
        const MAX_TIMESTAMP = 1844674407370955161n;

        const inputPrice = BigInt(Math.round(px * FLOAT_SCALAR * quoteScalar / baseScalar));
        const inputQuantity = BigInt(Math.round(qty * baseScalar));
        const isBid = mode === 'buy';

        const { baseCoinType, quoteCoinType } = await getPoolTypes(poolId);

        const tx = new Transaction();
        tx.setSender(acct.address);

        // Collateralise the order in the BalanceManager:
        //  - BID (buy):  deposit QUOTE (SUI) = price * qty
        //  - ASK (sell): deposit BASE (qty YES/NO tokens)
        if (isBid) {
            const quoteMist = BigInt(Math.round(px * qty * 1e9));
            const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(quoteMist)]);
            tx.moveCall({
                target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
                arguments: [tx.object(managerId), c],
                typeArguments: [quoteCoinType],
            });
        } else {
            const coins = await suiClient.getCoins({ owner: acct.address, coinType: baseCoinType });
            if (coins.data.length === 0) return toast('error', `No ${outcome.toUpperCase()} tokens to post`);
            const refs = coins.data.map(c => tx.object(c.coinObjectId));
            const primary = refs[0];
            if (refs.length > 1) tx.mergeCoins(primary, refs.slice(1));
            const [baseIn] = tx.splitCoins(primary, [tx.pure.u64(inputQuantity)]);
            tx.moveCall({
                target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
                arguments: [tx.object(managerId), baseIn],
                typeArguments: [baseCoinType],
            });
        }

        const tradeProof = tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(managerId)],
        });

        tx.moveCall({
            target: `${testnetPackageIds.DEEPBOOK_PACKAGE_ID}::pool::place_limit_order`,
            arguments: [
                tx.object(poolId),
                tx.object(managerId),
                tradeProof,
                tx.pure.u64(Date.now()),  // client_order_id
                tx.pure.u8(0),            // order_type: NO_RESTRICTION (GTC)
                tx.pure.u8(0),            // self_matching_option: ALLOWED
                tx.pure.u64(inputPrice),
                tx.pure.u64(inputQuantity),
                tx.pure.bool(isBid),
                tx.pure.bool(false),      // pay_with_deep=false (resting maker; no DEEP)
                tx.pure.u64(MAX_TIMESTAMP),
                tx.object('0x6'),         // clock
            ],
            typeArguments: [baseCoinType, quoteCoinType],
        });
        // NOTE: no withdraw_all — the deposited collateral must stay in the
        // BalanceManager to back the resting order. Filled proceeds are
        // reclaimed separately (idle-balance withdraw — separate feature).

        await signAndExec({ transaction: tx });
        toast(
            'success',
            `${isBid ? 'Bid' : 'Ask'} posted`,
            `${qty} ${outcome.toUpperCase()} @ ${px} SUI — resting on the book`
        );
        setAmount('');
        setLimitPrice('');
        setTimeout(refreshBalances, 3000);
    };

    const handleTrade = async () => {
        if (!acct) return toast('error', 'Connect your wallet first');
        if (!market) return;
        if (!numAmount) return toast('error', 'Enter an amount');

        setLoading(true);
        try {
            if (market.status === 'Resolved') {
                await handleRedeem();
            } else if (orderKind === 'limit') {
                await handleLimitOrder();
            } else if (mode === 'buy') {
                await handleBuy();
            } else {
                await handleSell();
            }
        } catch (e: any) {
            console.error(e);
            toast('error', 'Trade failed', e.message || 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    if (!market) {
        return (
            <div className="trade-sidebar">
                <div className="empty-state" style={{ padding: '60px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: 0.6 }}>
                    <BarChart2 size={48} strokeWidth={1} style={{ marginBottom: 16 }} />
                    <div className="empty-title">Select a market</div>
                    <div className="empty-desc">Click any market to start trading</div>
                </div>
            </div>
        );
    }

    const isResolved = market.status === 'Resolved';
    const balLabel = mode === 'buy' ? 'SUI' : (outcome === 'yes' ? 'YES' : 'NO');

    return (
        <div className="trade-sidebar">
            <div className="sidebar-inner">
                <div className="sidebar-market-name">{market.question}</div>

                {/* Buy / Sell tabs — hidden for resolved markets */}
                {!isResolved && (
                    <div className="trade-mode-tabs">
                        <button className={`trade-mode-tab buy ${mode === 'buy' ? 'active' : ''}`} onClick={() => { setMode('buy'); setAmount(''); }}>Buy</button>
                        <button className={`trade-mode-tab sell ${mode === 'sell' ? 'active' : ''}`} onClick={() => { setMode('sell'); setAmount(''); }}>Sell</button>
                    </div>
                )}

                {/* Order kind: Limit (post a resting order) vs Market (take existing) */}
                {!isResolved && (
                    <div className="trade-mode-tabs" style={{ marginTop: 8 }}>
                        <button
                            className={`trade-mode-tab ${orderKind === 'limit' ? 'active' : ''}`}
                            onClick={() => { setOrderKind('limit'); setAmount(''); }}
                            title="Post a resting order at your price. Creates liquidity. Required on an empty book."
                        >Limit</button>
                        <button
                            className={`trade-mode-tab ${orderKind === 'market' ? 'active' : ''}`}
                            onClick={() => { setOrderKind('market'); setAmount(''); }}
                            title="Fill instantly against existing orders. Does nothing if the book is empty."
                        >Market</button>
                    </div>
                )}

                {/* YES / NO pills */}
                <div className="outcome-pills">
                    <div className={`outcome-pill yes ${outcome === 'yes' ? 'selected' : ''}`} onClick={() => { setOutcome('yes'); setAmount(''); }}>
                        <div className="outcome-pill-label">YES</div>
                        <div className="outcome-pill-price">{market.yesPrice}¢</div>
                        <div className="outcome-pill-pct">{market.yesPrice}% chance</div>
                    </div>
                    <div className={`outcome-pill no ${outcome === 'no' ? 'selected' : ''}`} onClick={() => { setOutcome('no'); setAmount(''); }}>
                        <div className="outcome-pill-label">NO</div>
                        <div className="outcome-pill-price">{market.noPrice}¢</div>
                        <div className="outcome-pill-pct">{market.noPrice}% chance</div>
                    </div>
                </div>

                {/* Limit price (limit orders only) */}
                {!isResolved && orderKind === 'limit' && (
                    <>
                        <div className="amount-label-row">
                            <span className="field-label">Price (SUI per share)</span>
                            <span className="balance-hint">0 – 1 · YES+NO = 1</span>
                        </div>
                        <div className="amount-input-wrap">
                            <span className="amount-input-symbol">SUI</span>
                            <input
                                className="amount-input"
                                type="number"
                                placeholder="0.50"
                                value={limitPrice}
                                onChange={e => setLimitPrice(e.target.value)}
                                min="0"
                                max="1"
                                step="0.01"
                            />
                        </div>
                    </>
                )}

                {/* Amount input */}
                <div className="amount-label-row">
                    <span className="field-label">
                        {isResolved
                            ? 'Tokens to Redeem'
                            : orderKind === 'limit'
                                ? 'Quantity (shares)'
                                : mode === 'buy' ? 'Amount (SUI)' : 'Shares to Sell'}
                    </span>
                    <span className="balance-hint">
                        Bal: {displayBalance > 0 ? displayBalance.toFixed(4) : '0'} {balLabel}
                    </span>
                </div>
                <div className="amount-input-wrap">
                    <span className="amount-input-symbol">
                        {orderKind === 'limit' && !isResolved
                            ? 'SHARES'
                            : mode === 'sell' && !isResolved ? 'SHARES' : 'SUI'}
                    </span>
                    <input
                        className="amount-input"
                        type="number"
                        placeholder="0.00"
                        value={amount}
                        onChange={e => setAmount(e.target.value)}
                        min="0"
                        step="0.0001"
                    />
                </div>

                {/* % shortcuts */}
                <div className="pct-shortcuts">
                    {[25, 50, 75, 100].map(p => (
                        <button key={p} className="pct-btn" onClick={() => setPct(p)}>{p}%</button>
                    ))}
                </div>

                {/* Summary */}
                <div className="trade-summary">
                    <div className="trade-summary-row">
                        <span className="trade-summary-key">Price</span>
                        <span className="trade-summary-val">{(price * 100).toFixed(0)}¢</span>
                    </div>
                    {isResolved ? (
                        <div className="trade-summary-row">
                            <span className="trade-summary-key">Outcome</span>
                            <span className={`trade-summary-val ${market.outcome ? 'green' : 'red'}`}>
                                {market.outcome ? 'YES Won' : 'NO Won'}
                            </span>
                        </div>
                    ) : mode === 'buy' ? (
                        <>
                            <div className="trade-summary-row">
                                <span className="trade-summary-key">Shares</span>
                                <span className="trade-summary-val">{sharesDisplay}</span>
                            </div>
                            <div className="trade-summary-row">
                                <span className="trade-summary-key">Payout if {outcome.toUpperCase()} wins</span>
                                <span className={`trade-summary-val ${outcome === 'yes' ? 'green' : 'red'}`}>{sharesDisplay} SUI</span>
                            </div>
                            <div className="trade-summary-row">
                                <span className="trade-summary-key">Max profit</span>
                                <span className="trade-summary-val green">{maxProfit} SUI</span>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="trade-summary-row">
                                <span className="trade-summary-key">Shares selling</span>
                                <span className="trade-summary-val">{numAmount > 0 ? numAmount.toFixed(4) : '—'}</span>
                            </div>
                            <div className="trade-summary-row">
                                <span className="trade-summary-key">SUI received</span>
                                <span className="trade-summary-val green">{suiDisplay} SUI</span>
                            </div>
                        </>
                    )}
                </div>

                {/* CTA */}
                {!managerId && !isResolved ? (
                    <button className="trade-cta neutral" onClick={handleCreateManager} disabled={loading || !acct}>
                        {loading ? 'Initializing…' : 'Initialize DeepBook Account'}
                    </button>
                ) : (
                    <button
                        className={`trade-cta ${outcome}`}
                        onClick={handleTrade}
                        disabled={loading || !numAmount || !acct || (orderKind === 'limit' && !isResolved && !(parseFloat(limitPrice) > 0))}
                    >
                        {loading
                            ? 'Submitting…'
                            : isResolved
                                ? `Redeem ${outcome.toUpperCase()} Tokens`
                                : orderKind === 'limit'
                                    ? `Post ${mode === 'buy' ? 'Bid' : 'Ask'} · ${outcome.toUpperCase()}`
                                    : `${mode === 'buy' ? 'Buy' : 'Sell'} ${outcome.toUpperCase()}`}
                    </button>
                )}

                <div className="trade-disclaimer">
                    Trades finalize on Sui testnet.
                    {!acct && <> <strong>Connect wallet</strong> to trade.</>}
                </div>
            </div>

            {/* Market info */}
            <div className="sidebar-section">
                <div className="sidebar-section-title">Market Info</div>
                <div className="info-row">
                    <span className="info-row-key">Status</span>
                    <span className={`info-row-val ${market.status === 'Active' ? 'yes' : 'no'}`}>{market.status}</span>
                </div>
                <div className="info-row">
                    <span className="info-row-key">Resolves</span>
                    <span className="info-row-val">{new Date(market.resolutionTime).toLocaleDateString()}</span>
                </div>
                <div className="info-row">
                    <span className="info-row-key">Volume</span>
                    <span className="info-row-val">{market.volume >= 1000 ? `$${(market.volume / 1000).toFixed(1)}K` : `$${market.volume}`}</span>
                </div>
                <div className="info-row">
                    <span className="info-row-key">Market ID</span>
                    <span className="info-row-val">#{market.id}</span>
                </div>
                {isResolved && market.outcome !== null && (
                    <div className="info-row">
                        <span className="info-row-key">Outcome</span>
                        <span className={`info-row-val ${market.outcome ? 'yes' : 'no'}`}>{market.outcome ? 'YES' : 'NO'}</span>
                    </div>
                )}
                {acct && (
                    <>
                        <div className="info-row" style={{ marginTop: 8 }}>
                            <span className="info-row-key">YES balance</span>
                            <span className="info-row-val">{yesBalance.toFixed(4)}</span>
                        </div>
                        <div className="info-row">
                            <span className="info-row-key">NO balance</span>
                            <span className="info-row-val">{noBalance.toFixed(4)}</span>
                        </div>
                    </>
                )}
                <div className="info-row" style={{ marginTop: 4 }}>
                    <span className="info-row-key">Explorer</span>
                    <a
                        className="info-row-val link"
                        href={`https://suiscan.xyz/testnet/object/${CONFIG.PACKAGE_ID}`}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        View contract ↗
                    </a>
                </div>
            </div>
        </div>
    );
}
