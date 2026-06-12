/// outcome_market — multi-outcome prediction markets with **any** number of
/// tradable outcomes (tokenized parimutuel).
///
/// **What this is.** The binary `market_factory` lets you bet YES/NO. This
/// module generalizes that to a market with `n` mutually-exclusive, each
/// individually tradable on its own DeepBook order book — e.g. "Who wins the
/// 2026 World Cup?" with {Spain, France, England, Argentina}, or a 3-horse or
/// 32-team market. One generic contract serves every `n`.
///
/// **Why this shape, not a fixed `MarketData4`.** Move generics are
/// monomorphic: a struct can't hold a runtime-variable number of distinct coin
/// types (you can't put `TreasuryCap<Spain>` and `TreasuryCap<France>` in one
/// `vector`). So instead of naming the outcome types on the struct, each
/// outcome's `TreasuryCap` is stored as a **dynamic field keyed by index**.
/// Every `buy` / `redeem` call names only the *one* coin type it touches, so
/// the arity limit never bites and `n` is free.
///
/// **Economic model (tokenized parimutuel).** You stake `Q` on a single
/// outcome and receive that outcome's token 1:1 (tradable on DeepBook — its
/// price is the market's implied probability). The vault accumulates every
/// stake. After the admin resolves to the winning index, each winning token
/// redeems for a **pro-rata share of the entire pool**:
/// `payout = amount * vault / winning_supply`. That ratio is invariant under
/// redemption, so every winning token is worth exactly `vault0 / supply0` and
/// the vault drains to (near) zero. Losing tokens are worthless.
///
/// **Resolution.** Sports outcomes have no price oracle → resolution is by the
/// protocol `AdminCap`. Price markets ("will BTC close above $X") resolve via
/// Pyth in the binary factory; that does not apply to a discrete winner.
module deepmarket_contract::outcome_market {
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::balance::{Self, Balance};
    use sui::dynamic_field;
    use sui::event;
    use std::string::String;

    use deepmarket_contract::market_factory::AdminCap;

    // ─── Constants / errors ──────────────────────────────────────────────

    const STATUS_ACTIVE: u8 = 0;
    const STATUS_RESOLVED: u8 = 1;

    const MIN_OUTCOMES: u8 = 2;
    const MAX_OUTCOMES: u8 = 64; // sane ceiling (e.g. 32-team bracket + buffer)

    const E_MARKET_NOT_ACTIVE: u64 = 1;
    const E_MARKET_NOT_RESOLVED: u64 = 2;
    const E_INVALID_WINNER: u64 = 3;
    const E_NOT_WINNER: u64 = 4;
    const E_BAD_OUTCOME_COUNT: u64 = 5;
    const E_BAD_NAMES_LEN: u64 = 6;
    const E_OUT_OF_RANGE: u64 = 7;
    const E_NOT_SEQUENTIAL: u64 = 8;
    const E_NOT_READY: u64 = 9;
    const E_ALREADY_READY: u64 = 10;

    // ─── Dynamic-field key for an outcome's treasury ─────────────────────

    /// Keys the per-outcome `TreasuryCap<T>` stored on the market's `id`.
    /// The value type is monomorphized per `add_outcome` call site, which is
    /// how heterogeneous treasuries live under one object.
    public struct OutcomeTreasury has copy, drop, store { idx: u8 }

    // ─── Shared market object ────────────────────────────────────────────

    public struct OutcomeMarket<phantom Q> has key {
        id: UID,
        question: String,
        /// Human labels for outcomes 0..n-1 (e.g. ["Spain","France",...]).
        outcome_names: vector<String>,
        /// Number of outcomes.
        n: u8,
        resolution_time: u64,
        oracle_feed: address,
        status: u8,
        /// Set once on resolution: 0..n-1 = winning outcome index.
        winner: Option<u8>,
        /// The whole pool. Winners split this pro-rata; losers get nothing.
        vault: Balance<Q>,
        /// Per-outcome cumulative stake (== that outcome's token supply at
        /// mint time). Kept for UI odds; redemption math reads live supply.
        total_staked: vector<u64>,
        /// DeepBook pool id per outcome (0x0 until/unless a book is opened).
        pools: vector<ID>,
        /// How many outcome treasuries have been attached so far.
        registered: u8,
        /// False until `share_market` seals the market; gates buy/redeem.
        ready: bool,
        token_package_id: address,
    }

    // ─── Events ──────────────────────────────────────────────────────────

    public struct OutcomeMarketCreated has copy, drop {
        market_id: ID,
        question: String,
        outcome_names: vector<String>,
        n: u8,
        resolution_time: u64,
        oracle_feed: address,
        token_package_id: address,
        pools: vector<ID>,
    }

    public struct OutcomeBought has copy, drop {
        market_id: ID,
        outcome: u8,
        amount: u64,
        user: address,
    }

    public struct OutcomeResolved has copy, drop {
        market_id: ID,
        winner: u8,
    }

    public struct OutcomeRedeemed has copy, drop {
        market_id: ID,
        outcome: u8,
        token_amount: u64,
        payout: u64,
        user: address,
    }

    // ─── Creation (3-phase, executed atomically in one PTB) ──────────────
    //
    // 1. create_market         → returns an unsealed OutcomeMarket<Q>
    // 2. add_outcome (×n)       → attach each outcome's TreasuryCap + pool id
    // 3. share_market           → assert all n attached, seal, share, emit
    //
    // The treasuries can't be passed in one call (heterogeneous types), so the
    // creator's PTB threads the in-flight object through n `add_outcome`s
    // before sharing it.

    /// Phase 1. Create an unsealed market with `n` outcomes. Not yet usable
    /// until every outcome is registered and `share_market` is called.
    public fun create_market<Q>(
        question: String,
        outcome_names: vector<String>,
        n: u8,
        resolution_time: u64,
        oracle_feed: address,
        token_package_id: address,
        ctx: &mut TxContext,
    ): OutcomeMarket<Q> {
        assert!(n >= MIN_OUTCOMES && n <= MAX_OUTCOMES, E_BAD_OUTCOME_COUNT);
        assert!(vector::length(&outcome_names) == (n as u64), E_BAD_NAMES_LEN);

        let mut total_staked = vector::empty<u64>();
        let mut pools = vector::empty<ID>();
        let zero_id = object::id_from_address(@0x0);
        let mut i = 0u64;
        while (i < (n as u64)) {
            vector::push_back(&mut total_staked, 0);
            vector::push_back(&mut pools, zero_id);
            i = i + 1;
        };

        OutcomeMarket<Q> {
            id: object::new(ctx),
            question,
            outcome_names,
            n,
            resolution_time,
            oracle_feed,
            status: STATUS_ACTIVE,
            winner: option::none(),
            vault: balance::zero<Q>(),
            total_staked,
            pools,
            registered: 0,
            ready: false,
            token_package_id,
        }
    }

    /// Phase 2. Attach outcome `idx`'s treasury and DeepBook pool id. Must be
    /// called in order (idx 0, 1, 2, …) until all `n` are registered.
    public fun add_outcome<Q, T>(
        market: &mut OutcomeMarket<Q>,
        idx: u8,
        treasury: TreasuryCap<T>,
        pool_addr: address,
    ) {
        assert!(!market.ready, E_ALREADY_READY);
        assert!(idx < market.n, E_OUT_OF_RANGE);
        assert!(idx == market.registered, E_NOT_SEQUENTIAL);

        dynamic_field::add(&mut market.id, OutcomeTreasury { idx }, treasury);
        let slot = vector::borrow_mut(&mut market.pools, idx as u64);
        *slot = object::id_from_address(pool_addr);
        market.registered = market.registered + 1;
    }

    /// Phase 3. Seal the fully-registered market and share it.
    public fun share_market<Q>(mut market: OutcomeMarket<Q>) {
        assert!(market.registered == market.n, E_BAD_OUTCOME_COUNT);
        market.ready = true;

        event::emit(OutcomeMarketCreated {
            market_id: object::id(&market),
            question: market.question,
            outcome_names: market.outcome_names,
            n: market.n,
            resolution_time: market.resolution_time,
            oracle_feed: market.oracle_feed,
            token_package_id: market.token_package_id,
            pools: market.pools,
        });

        transfer::share_object(market);
    }

    // ─── Buy (stake on one outcome) ──────────────────────────────────────

    /// Stake `value(payment)` of `Q` on outcome `idx` and receive that many
    /// outcome tokens. `T` must be outcome `idx`'s coin type — passing a
    /// mismatched (idx, T) aborts in the dynamic-field lookup, so you can
    /// never mint the wrong outcome's token.
    public fun buy<Q, T>(
        market: &mut OutcomeMarket<Q>,
        idx: u8,
        payment: Coin<Q>,
        ctx: &mut TxContext,
    ) {
        assert!(market.ready, E_NOT_READY);
        assert!(market.status == STATUS_ACTIVE, E_MARKET_NOT_ACTIVE);
        assert!(idx < market.n, E_OUT_OF_RANGE);

        let amount = coin::value(&payment);
        let treasury: &mut TreasuryCap<T> =
            dynamic_field::borrow_mut(&mut market.id, OutcomeTreasury { idx });
        let token = coin::mint(treasury, amount, ctx);

        balance::join(&mut market.vault, coin::into_balance(payment));
        let slot = vector::borrow_mut(&mut market.total_staked, idx as u64);
        *slot = *slot + amount;

        let user = ctx.sender();
        transfer::public_transfer(token, user);
        event::emit(OutcomeBought { market_id: object::id(market), outcome: idx, amount, user });
    }

    // ─── Resolution (AdminCap) ───────────────────────────────────────────

    public fun resolve<Q>(
        _admin: &AdminCap,
        market: &mut OutcomeMarket<Q>,
        winner: u8,
        _ctx: &mut TxContext,
    ) {
        assert!(market.status == STATUS_ACTIVE, E_MARKET_NOT_ACTIVE);
        assert!(winner < market.n, E_INVALID_WINNER);
        market.status = STATUS_RESOLVED;
        option::fill(&mut market.winner, winner);
        event::emit(OutcomeResolved { market_id: object::id(market), winner });
    }

    // ─── Redemption (pro-rata) ───────────────────────────────────────────

    /// Burn `token` (the winning outcome `idx`) and receive a pro-rata share
    /// of the pool: `amount * vault / winning_supply`. The ratio is invariant
    /// across redemptions, so order doesn't matter and the vault drains fully
    /// (minus integer-division dust on the final claim).
    public fun redeem<Q, T>(
        market: &mut OutcomeMarket<Q>,
        idx: u8,
        token: Coin<T>,
        ctx: &mut TxContext,
    ) {
        assert!(market.status == STATUS_RESOLVED, E_MARKET_NOT_RESOLVED);
        assert!(*option::borrow(&market.winner) == idx, E_NOT_WINNER);

        let amount = coin::value(&token);
        let vault_val = balance::value(&market.vault);

        let treasury: &mut TreasuryCap<T> =
            dynamic_field::borrow_mut(&mut market.id, OutcomeTreasury { idx });
        let supply = coin::total_supply(treasury); // pre-burn; includes `amount`
        coin::burn(treasury, token);

        // payout = amount * vault_val / supply, computed in u128 to avoid overflow.
        let payout = (((amount as u128) * (vault_val as u128)) / (supply as u128)) as u64;
        let coin_out = coin::take(&mut market.vault, payout, ctx);
        let user = ctx.sender();
        transfer::public_transfer(coin_out, user);

        event::emit(OutcomeRedeemed {
            market_id: object::id(market),
            outcome: idx,
            token_amount: amount,
            payout,
            user,
        });
    }

    // ─── Views ───────────────────────────────────────────────────────────

    public fun status<Q>(m: &OutcomeMarket<Q>): u8 { m.status }
    public fun outcome_count<Q>(m: &OutcomeMarket<Q>): u8 { m.n }
    public fun is_ready<Q>(m: &OutcomeMarket<Q>): bool { m.ready }
    public fun winner<Q>(m: &OutcomeMarket<Q>): Option<u8> { m.winner }
    public fun vault_value<Q>(m: &OutcomeMarket<Q>): u64 { balance::value(&m.vault) }
    public fun total_staked<Q>(m: &OutcomeMarket<Q>): vector<u64> { m.total_staked }
    public fun pools<Q>(m: &OutcomeMarket<Q>): vector<ID> { m.pools }
    public fun outcome_names<Q>(m: &OutcomeMarket<Q>): vector<String> { m.outcome_names }
}
