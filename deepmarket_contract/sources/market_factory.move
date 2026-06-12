module deepmarket_contract::market_factory {
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::event;
    use std::string::String;
    use sui::balance::{Self, Balance};
    use sui::dynamic_field;

    // ─── Capability ────────────────────────────────────────────────────────────

    public struct AdminCap has key, store {
        id: UID,
    }

    // ─── Shared state ──────────────────────────────────────────────────────────

    public struct MarketRegistry<phantom Q> has key {
        id: UID,
        market_counter: u64,
    }

    public struct MarketData<phantom Q, phantom Y, phantom N> has store {
        market_id: u64,
        question: String,
        resolution_time: u64,
        oracle_feed: address,
        status: u8, // 0 = Active, 1 = Resolved
        outcome: option::Option<bool>, // true = YES won, false = NO won
        vault: Balance<Q>,
        yes_pool_id: ID,
        no_pool_id: ID,
        token_package_id: address,
        yes_treasury: TreasuryCap<Y>,
        no_treasury: TreasuryCap<N>,
    }

    // ─── Events ────────────────────────────────────────────────────────────────

    public struct MarketCreatedEvent has copy, drop {
        market_id: u64,
        question: String,
        resolution_time: u64,
        oracle_feed: address,
        yes_pool_id: ID,
        no_pool_id: ID,
        token_package_id: address,
    }

    public struct MintedEvent has copy, drop {
        market_id: u64,
        amount: u64,
        user: address,
    }

    public struct ResolvedEvent has copy, drop {
        market_id: u64,
        outcome: bool,
    }

    public struct RedeemedEvent has copy, drop {
        market_id: u64,
        amount: u64,
        user: address,
        outcome_token: bool, // true for YES, false for NO
    }

    // ─── Constants ─────────────────────────────────────────────────────────────

    const STATUS_ACTIVE: u8 = 0;
    const STATUS_RESOLVED: u8 = 1;

    const E_MARKET_NOT_ACTIVE: u64 = 1;
    const E_MARKET_NOT_RESOLVED: u64 = 2;
    const E_INVALID_OUTCOME: u64 = 3;

    // ─── Module initializer ────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        let admin_cap = AdminCap { id: object::new(ctx) };
        transfer::transfer(admin_cap, ctx.sender());
    }

    #[test_only]
    /// Mint an `AdminCap` for unit tests in this package (e.g. `outcome_market`).
    public fun admin_cap_for_testing(ctx: &mut TxContext): AdminCap {
        AdminCap { id: object::new(ctx) }
    }

    // ─── Registry ──────────────────────────────────────────────────────────────

    public fun init_registry<Q>(ctx: &mut TxContext) {
        let registry = MarketRegistry<Q> {
            id: object::new(ctx),
            market_counter: 0,
        };
        transfer::share_object(registry);
    }

    // ─── Market creation ───────────────────────────────────────────────────────

    public fun register_custom_market<Q, Y, N>(
        registry: &mut MarketRegistry<Q>,
        yes_treasury: TreasuryCap<Y>,
        no_treasury: TreasuryCap<N>,
        question: String,
        resolution_time: u64,
        oracle_feed: address,
        yes_pool_addr: address,
        no_pool_addr: address,
        token_package_id: address,
        _ctx: &mut TxContext
    ) {
        let yes_pool_id = object::id_from_address(yes_pool_addr);
        let no_pool_id  = object::id_from_address(no_pool_addr);
        let market_id = registry.market_counter;
        registry.market_counter = market_id + 1;

        let market_data = MarketData<Q, Y, N> {
            market_id,
            question,
            resolution_time,
            oracle_feed,
            status: STATUS_ACTIVE,
            outcome: option::none(),
            vault: balance::zero<Q>(),
            yes_pool_id,
            no_pool_id,
            token_package_id,
            yes_treasury,
            no_treasury,
        };

        dynamic_field::add(&mut registry.id, market_id, market_data);

        event::emit(MarketCreatedEvent {
            market_id,
            question,
            resolution_time,
            oracle_feed,
            yes_pool_id,
            no_pool_id,
            token_package_id,
        });
    }

    // ─── Minting ───────────────────────────────────────────────────────────────

    /// Deposit exactly value(payment) Q coins and receive equal YES + NO tokens.
    public fun mint_outcome_tokens<Q, Y, N>(
        registry: &mut MarketRegistry<Q>,
        market_id: u64,
        payment: Coin<Q>,
        ctx: &mut TxContext
    ) {
        let market: &mut MarketData<Q, Y, N> = dynamic_field::borrow_mut(&mut registry.id, market_id);
        assert!(market.status == STATUS_ACTIVE, E_MARKET_NOT_ACTIVE);

        let amount = coin::value(&payment);
        let yes_coin = coin::mint(&mut market.yes_treasury, amount, ctx);
        let no_coin = coin::mint(&mut market.no_treasury, amount, ctx);

        balance::join(&mut market.vault, coin::into_balance(payment));

        transfer::public_transfer(yes_coin, ctx.sender());
        transfer::public_transfer(no_coin, ctx.sender());

        event::emit(MintedEvent {
            market_id,
            amount,
            user: ctx.sender(),
        });
    }

    // ─── Resolution ────────────────────────────────────────────────────────────

    /// Only the holder of AdminCap can resolve a market.
    public fun resolve_market<Q, Y, N>(
        _admin: &AdminCap,
        registry: &mut MarketRegistry<Q>,
        market_id: u64,
        outcome: bool,
        _ctx: &mut TxContext
    ) {
        let market: &mut MarketData<Q, Y, N> = dynamic_field::borrow_mut(&mut registry.id, market_id);
        assert!(market.status == STATUS_ACTIVE, E_MARKET_NOT_ACTIVE);
        market.status = STATUS_RESOLVED;
        option::fill(&mut market.outcome, outcome);

        event::emit(ResolvedEvent { market_id, outcome });
    }

    // ─── Redemption ────────────────────────────────────────────────────────────

    public fun redeem_yes<Q, Y, N>(
        registry: &mut MarketRegistry<Q>,
        market_id: u64,
        token: Coin<Y>,
        ctx: &mut TxContext
    ) {
        let market: &mut MarketData<Q, Y, N> = dynamic_field::borrow_mut(&mut registry.id, market_id);
        assert!(market.status == STATUS_RESOLVED, E_MARKET_NOT_RESOLVED);
        assert!(*option::borrow(&market.outcome) == true, E_INVALID_OUTCOME);

        let amount = coin::value(&token);
        coin::burn(&mut market.yes_treasury, token);

        let payout = coin::take(&mut market.vault, amount, ctx);
        transfer::public_transfer(payout, ctx.sender());

        event::emit(RedeemedEvent {
            market_id,
            amount,
            user: ctx.sender(),
            outcome_token: true,
        });
    }

    public fun redeem_no<Q, Y, N>(
        registry: &mut MarketRegistry<Q>,
        market_id: u64,
        token: Coin<N>,
        ctx: &mut TxContext
    ) {
        let market: &mut MarketData<Q, Y, N> = dynamic_field::borrow_mut(&mut registry.id, market_id);
        assert!(market.status == STATUS_RESOLVED, E_MARKET_NOT_RESOLVED);
        assert!(*option::borrow(&market.outcome) == false, E_INVALID_OUTCOME);

        let amount = coin::value(&token);
        coin::burn(&mut market.no_treasury, token);

        let payout = coin::take(&mut market.vault, amount, ctx);
        transfer::public_transfer(payout, ctx.sender());

        event::emit(RedeemedEvent {
            market_id,
            amount,
            user: ctx.sender(),
            outcome_token: false,
        });
    }
}
