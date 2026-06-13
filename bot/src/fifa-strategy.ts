// FIFA / multi-outcome autonomous strategy. One tick evaluates every chat with
// fifaStrategyEnabled and performs ONE action on the outcome market with the
// user's custodial wallet: stake (parimutuel), market-make / take on the
// DeepBook order book, claim filled balances, or redeem after resolution.
//
// Brain is per-user: 'rule' (cheap heuristic) or 'llm' (Claude reasons each
// tick). Every action is DM'd to the user and written to MemWal.

import type { Telegraf } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from './config.js';
import { getSuiClient } from './sui.js';
import { listAll, patchSubscription, type Subscription } from './store.js';
import { getUserKeypair } from './user-wallet.js';
import { isAgentAvailable } from './agent.js';
import { isMemWalAvailable, recallText, rememberText } from './memwal.js';
import {
    readFifaMarket,
    poolMidPct,
    getBalanceManagerId,
    walletBalances,
    outcomeCoinType,
    isZeroPool,
    buildStakeTx,
    buildNewBalanceManagerTx,
    buildSyncDeepPriceTx,
    buildLimitOrderTx,
    buildClaimTx,
    buildRedeemTx,
    type FifaMarket,
} from './fifa.js';

type Action =
    | { kind: 'stake'; idx: number; sui: number; reason: string }
    | { kind: 'bid' | 'ask'; idx: number; price: number; qty: number; reason: string }
    | { kind: 'claim'; idx: number; reason: string }
    | { kind: 'redeem'; idx: number; reason: string }
    | { kind: 'setup'; reason: string }
    | { kind: 'hold'; reason: string };

interface TickCtx {
    market: FifaMarket;
    mids: (number | null)[];
    sui: number;
    deep: number;
    managerId: string | null;
    tokenBal: number[]; // per-outcome wallet token balance
}

const clampPrice = (p: number) => Math.min(0.97, Math.max(0.03, p));

function pooledOutcomes(m: FifaMarket): number[] {
    return m.pools.map((p, i) => (isZeroPool(p) ? -1 : i)).filter((i) => i >= 0);
}

// ── Rule brain: cheap, deterministic-ish market-making / staking ──────────
function ruleDecide(ctx: TickCtx): Action {
    const m = ctx.market;
    if (m.status === 1) {
        const w = m.winner ?? 0;
        if (ctx.tokenBal[w] && ctx.tokenBal[w]! > 0) return { kind: 'redeem', idx: w, reason: 'market resolved — redeem winning tokens' };
        return { kind: 'hold', reason: 'resolved; no winning tokens to redeem' };
    }
    const pooled = pooledOutcomes(m);
    const canTrade = !!ctx.managerId && ctx.deep >= 1;

    // No BalanceManager yet but funded with DEEP → bootstrap trading first.
    if (!ctx.managerId && ctx.deep >= 1 && pooled.length > 0) {
        return { kind: 'setup', reason: 'create DeepBook account + prime pools' };
    }

    if (canTrade && pooled.length > 0) {
        const idx = pooled[Math.floor(Math.random() * pooled.length)]!;
        const mid = (ctx.mids[idx] ?? 50) / 100;
        // Alternate side by coin flip; ask only if we hold tokens, else bid.
        const wantAsk = Math.random() < 0.5 && (ctx.tokenBal[idx] ?? 0) >= 1;
        if (wantAsk) return { kind: 'ask', idx, price: clampPrice(mid + 0.03), qty: 1, reason: `quote ask ~${Math.round((mid + 0.03) * 100)}¢ on ${m.outcomeNames[idx]}` };
        return { kind: 'bid', idx, price: clampPrice(mid - 0.03), qty: 1, reason: `quote bid ~${Math.round((mid - 0.03) * 100)}¢ on ${m.outcomeNames[idx]}` };
    }

    // Fallback: parimutuel stake (SUI-only). Back the cheapest pooled outcome,
    // or just the lowest-staked one, to keep the book balanced.
    if (ctx.sui > CONFIG.FIFA_QTY_SUI + 0.2) {
        let idx = 0;
        if (pooled.length > 0) {
            idx = pooled.reduce((lo, i) => ((ctx.mids[i] ?? 50) < (ctx.mids[lo] ?? 50) ? i : lo), pooled[0]!);
        } else {
            // lowest staked
            idx = m.totalStaked.reduce((lo, v, i) => (v < m.totalStaked[lo]! ? i : lo), 0);
        }
        return { kind: 'stake', idx, sui: CONFIG.FIFA_QTY_SUI, reason: `stake ${CONFIG.FIFA_QTY_SUI} SUI on ${m.outcomeNames[idx]}` };
    }
    return { kind: 'hold', reason: 'insufficient balance to act' };
}

// ── LLM brain: Claude picks one action ────────────────────────────────────
let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
    if (!CONFIG.ANTHROPIC_API_KEY) return null;
    if (!anthropic) anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
    return anthropic;
}

async function llmDecide(ctx: TickCtx, chatId: number): Promise<Action> {
    const c = getAnthropic();
    if (!c) return ruleDecide(ctx);
    const m = ctx.market;
    const memCtx = isMemWalAvailable()
        ? (await recallText(`FIFA market making ${m.question}`, 4)).join('\n')
        : '';
    const outcomes = m.outcomeNames
        .map((n, i) => `  ${i}: ${n} — book ${ctx.mids[i] ?? '—'}% · staked ${(Number(m.totalStaked[i] ?? 0n) / 1e9).toFixed(1)} SUI · pool ${isZeroPool(m.pools[i]!) ? 'no' : 'yes'} · myTokens ${(ctx.tokenBal[i] ?? 0).toFixed(2)}`)
        .join('\n');
    const prompt =
        `You are an autonomous market-maker on a multi-outcome prediction market.\n` +
        `Question: ${m.question}\nStatus: ${m.status === 1 ? 'RESOLVED winner=' + m.winner : 'active'}\n` +
        `Your wallet: ${ctx.sui.toFixed(2)} SUI, ${ctx.deep.toFixed(1)} DEEP, DeepBook account: ${ctx.managerId ? 'yes' : 'no'}\n` +
        `Outcomes:\n${outcomes}\n` +
        (memCtx ? `\nRelevant past memories:\n${memCtx}\n` : '') +
        `\nPrice = SUI per token = implied probability (0–1). To trade the order book you need a DeepBook account + DEEP.\n` +
        `Reply with ONE JSON object only, no prose. Schema:\n` +
        `{"kind":"stake|bid|ask|claim|redeem|setup|hold","idx":<outcome index>,"sui":<for stake>,"price":<0-1 for bid/ask>,"qty":<tokens for bid/ask>,"reason":"short"}\n` +
        `Keep sizes small (sui<=${CONFIG.FIFA_QTY_SUI}, qty<=2). Prefer making a tight two-sided book. If you can't trade the book, stake.`;
    try {
        const resp = await c.messages.create({
            model: CONFIG.AGENT_MODEL,
            max_tokens: 300,
            messages: [{ role: 'user', content: prompt }],
        });
        const text = resp.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text')?.text ?? '';
        const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
        const a = JSON.parse(json) as Partial<Action> & { idx?: number; sui?: number; price?: number; qty?: number };
        const idx = Math.max(0, Math.min(m.n - 1, Number(a.idx ?? 0)));
        switch (a.kind) {
            case 'stake': return { kind: 'stake', idx, sui: Math.min(CONFIG.FIFA_QTY_SUI, Number(a.sui ?? CONFIG.FIFA_QTY_SUI)), reason: a.reason ?? 'llm stake' };
            case 'bid': return { kind: 'bid', idx, price: clampPrice(Number(a.price ?? 0.5)), qty: Math.min(2, Number(a.qty ?? 1)), reason: a.reason ?? 'llm bid' };
            case 'ask': return { kind: 'ask', idx, price: clampPrice(Number(a.price ?? 0.5)), qty: Math.min(2, Number(a.qty ?? 1)), reason: a.reason ?? 'llm ask' };
            case 'claim': return { kind: 'claim', idx, reason: a.reason ?? 'llm claim' };
            case 'redeem': return { kind: 'redeem', idx, reason: a.reason ?? 'llm redeem' };
            case 'setup': return { kind: 'setup', reason: a.reason ?? 'llm setup' };
            default: return { kind: 'hold', reason: a.reason ?? 'llm hold' };
        }
    } catch (e) {
        console.warn(`[fifa] llm decide failed for ${chatId}, falling back to rule:`, e instanceof Error ? e.message : e);
        return ruleDecide(ctx);
    }
}

// ── Execute one action ────────────────────────────────────────────────────
async function execute(chatId: number, sub: Subscription, ctx: TickCtx, a: Action): Promise<{ msg: string; digest?: string }> {
    const kp = await getUserKeypair(chatId);
    if (!kp) return { msg: 'no wallet' };
    const sender = sub.botWalletAddr!;
    const c = getSuiClient();
    const m = ctx.market;
    const sign = async (tx: any) => {
        const r = await c.signAndExecuteTransaction({ signer: kp, transaction: tx });
        await c.waitForTransaction({ digest: r.digest });
        return r.digest as string;
    };

    if (a.kind === 'stake') {
        const tx = buildStakeTx(sender, m, a.idx, BigInt(Math.floor(a.sui * 1e9)));
        const d = await sign(tx);
        return { msg: `🟢 Staked ${a.sui} SUI on *${m.outcomeNames[a.idx]}*`, digest: d };
    }
    if (a.kind === 'setup') {
        // 1) create BalanceManager, 2) sync DEEP price on each pooled outcome.
        await sign(buildNewBalanceManagerTx(sender));
        const mgr = await getBalanceManagerId(sender);
        if (mgr) {
            await patchSubscription(chatId, { fifaManagerId: mgr });
            for (const i of pooledOutcomes(m)) {
                const tx = await buildSyncDeepPriceTx(sender, m.pools[i]!);
                if (tx) { try { await sign(tx); } catch { /* already primed */ } }
            }
        }
        return { msg: '⚡ DeepBook account created + pools primed — trading next tick' };
    }
    if (a.kind === 'bid' || a.kind === 'ask') {
        if (!ctx.managerId) return { msg: 'no DeepBook account yet' };
        let qty = a.qty;
        if (a.kind === 'ask') {
            // An ask deposits outcome tokens as collateral. If the wallet holds
            // none (e.g. its tokens are already locked in a resting ask), mint
            // some by staking now and sell on a later tick — never try to sell
            // tokens it doesn't have (that aborts with InsufficientCoinBalance).
            const have = Math.floor(ctx.tokenBal[a.idx] ?? 0);
            if (have < 1) {
                const stakeTx = buildStakeTx(sender, m, a.idx, BigInt(Math.floor(CONFIG.FIFA_QTY_SUI * 1e9)));
                const d = await sign(stakeTx);
                return { msg: `🟢 Staked ${CONFIG.FIFA_QTY_SUI} SUI on *${m.outcomeNames[a.idx]}* (building inventory before asking)`, digest: d };
            }
            qty = Math.min(a.qty, have);
        }
        const tx = await buildLimitOrderTx(sender, ctx.managerId, m.pools[a.idx]!, a.kind === 'bid', a.price, qty);
        if (!tx) return { msg: `skipped ${a.kind} (insufficient collateral/DEEP)` };
        const d = await sign(tx);
        return { msg: `${a.kind === 'bid' ? '🔵 Bid' : '🔴 Ask'} ${qty} *${m.outcomeNames[a.idx]}* @ ${Math.round(a.price * 100)}¢`, digest: d };
    }
    if (a.kind === 'claim') {
        if (!ctx.managerId) return { msg: 'no DeepBook account' };
        const tx = await buildClaimTx(sender, ctx.managerId, m.pools[a.idx]!);
        if (!tx) return { msg: 'nothing to claim' };
        const d = await sign(tx);
        return { msg: `💰 Claimed filled balances on *${m.outcomeNames[a.idx]}*`, digest: d };
    }
    if (a.kind === 'redeem') {
        const tx = await buildRedeemTx(sender, m, a.idx);
        if (!tx) return { msg: 'no winning tokens to redeem' };
        const d = await sign(tx);
        return { msg: `🏆 Redeemed *${m.outcomeNames[a.idx]}* winning tokens`, digest: d };
    }
    return { msg: 'hold' };
}

// ── Per-user tick ──────────────────────────────────────────────────────────
async function tickUser(bot: Telegraf, chatId: number, sub: Subscription): Promise<void> {
    const market = await readFifaMarket();
    if (!market) return;
    const sender = sub.botWalletAddr!;
    const mode: 'llm' | 'rule' = sub.fifaAgentMode === 'llm' && isAgentAvailable() ? 'llm' : 'rule';

    // Gather context.
    const mids = await Promise.all(market.pools.map((p) => poolMidPct(p)));
    const base = await walletBalances(sender);
    const managerId = sub.fifaManagerId ?? (await getBalanceManagerId(sender));
    if (managerId && managerId !== sub.fifaManagerId) await patchSubscription(chatId, { fifaManagerId: managerId });
    const tokenBal = await Promise.all(
        market.outcomeNames.map((_, i) =>
            walletBalances(sender, outcomeCoinType(market.tokenPackageId, i)).then((b) => b.token)
        )
    );
    const ctx: TickCtx = { market, mids, sui: base.sui, deep: base.deep, managerId, tokenBal };

    const action = mode === 'llm' ? await llmDecide(ctx, chatId) : ruleDecide(ctx);

    let outcome = action.reason;
    let result: { msg: string; digest?: string } = { msg: action.reason };
    if (action.kind !== 'hold') {
        try {
            result = await execute(chatId, sub, ctx, action);
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            outcome = `error: ${err.slice(0, 80)}`;
            await pushTrade(chatId, sub, { ts: Date.now(), action: action.kind, error: err.slice(0, 120) });
            await bot.telegram.sendMessage(chatId, `⚠️ FIFA bot: ${action.kind} failed — ${err.slice(0, 140)}`).catch(() => {});
            await patchSubscription(chatId, { fifaLastCheckAt: Date.now(), fifaLastOutcome: outcome });
            return;
        }
    }

    // Record + notify.
    await patchSubscription(chatId, { fifaLastCheckAt: Date.now(), fifaLastOutcome: result.msg });
    if (action.kind !== 'hold') {
        const oName = 'idx' in action ? market.outcomeNames[(action as any).idx] : undefined;
        await pushTrade(chatId, sub, { ts: Date.now(), action: action.kind, outcome: oName, detail: action.reason, digest: result.digest });
        const explorer = result.digest ? `\n[tx ↗](https://suiscan.xyz/testnet/tx/${result.digest})` : '';
        await bot.telegram
            .sendMessage(chatId, `🤖 *FIFA bot* (${mode === 'llm' ? '🧠 Claude' : '📐 rule'})\n${result.msg}\n_${action.reason}_${explorer}`, { parse_mode: 'Markdown' })
            .catch(() => {});
        if (isMemWalAvailable()) {
            void rememberText(`[${new Date().toISOString().slice(0, 16)}] FIFA "${market.question}": ${result.msg}. ${action.reason}`);
        }
    }
}

async function pushTrade(chatId: number, sub: Subscription, t: NonNullable<Subscription['fifaTrades']>[number]): Promise<void> {
    const arr = (sub.fifaTrades ?? []).slice(-19);
    arr.push(t);
    await patchSubscription(chatId, { fifaTrades: arr });
}

export async function runFifaTick(bot: Telegraf): Promise<void> {
    const subs = listAll().filter((s) => s.fifaStrategyEnabled && s.botWalletKey);
    for (const sub of subs) {
        try {
            await tickUser(bot, sub.chatId, sub);
        } catch (e) {
            console.warn(`[fifa] tick failed for ${sub.chatId}:`, e instanceof Error ? e.message : e);
        }
    }
}

export function startFifaLoop(bot: Telegraf): () => void {
    const tick = () => void runFifaTick(bot).catch((e) => console.warn('[fifa] loop error:', e));
    void tick();
    const id = setInterval(tick, CONFIG.FIFA_TICK_MS);
    return () => clearInterval(id);
}
