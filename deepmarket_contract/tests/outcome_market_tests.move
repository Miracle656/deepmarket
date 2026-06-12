#[test_only]
module deepmarket_contract::outcome_market_tests {
    use sui::test_scenario::{Self as ts};
    use sui::coin::{Self, Coin};
    use std::string;

    use deepmarket_contract::outcome_market::{Self as om, OutcomeMarket};
    use deepmarket_contract::market_factory;

    // Test coin types: the quote and three outcome tokens.
    public struct QUOTE has drop {}
    public struct SPAIN has drop {}
    public struct FRANCE has drop {}
    public struct ENGLAND has drop {}

    const ADMIN: address = @0xAD;
    const U1: address = @0xA1;
    const U2: address = @0xA2;
    const U3: address = @0xA3;

    fun names(): vector<string::String> {
        let mut v = vector::empty<string::String>();
        vector::push_back(&mut v, string::utf8(b"Spain"));
        vector::push_back(&mut v, string::utf8(b"France"));
        vector::push_back(&mut v, string::utf8(b"England"));
        v
    }

    /// Create, register all three outcomes, and share a market.
    fun create_three_outcome_market(sc: &mut ts::Scenario) {
        let ctx = ts::ctx(sc);
        let mut market = om::create_market<QUOTE>(
            string::utf8(b"Who wins the 2026 World Cup?"),
            names(),
            3,
            0,           // resolution_time
            @0xCAFE,     // oracle_feed
            @0x0,        // token_package_id
            ctx,
        );
        let t0 = coin::create_treasury_cap_for_testing<SPAIN>(ctx);
        let t1 = coin::create_treasury_cap_for_testing<FRANCE>(ctx);
        let t2 = coin::create_treasury_cap_for_testing<ENGLAND>(ctx);
        om::add_outcome<QUOTE, SPAIN>(&mut market, 0, t0, @0x0);
        om::add_outcome<QUOTE, FRANCE>(&mut market, 1, t1, @0x0);
        om::add_outcome<QUOTE, ENGLAND>(&mut market, 2, t2, @0x0);
        om::share_market(market);
    }

    fun buy_as<T: drop>(sc: &mut ts::Scenario, who: address, idx: u8, amount: u64) {
        ts::next_tx(sc, who);
        let mut market = ts::take_shared<OutcomeMarket<QUOTE>>(sc);
        let ctx = ts::ctx(sc);
        let pay = coin::mint_for_testing<QUOTE>(amount, ctx);
        om::buy<QUOTE, T>(&mut market, idx, pay, ctx);
        ts::return_shared(market);
    }

    #[test]
    fun parimutuel_payout_is_prorata() {
        let mut sc = ts::begin(ADMIN);
        create_three_outcome_market(&mut sc);

        // Stakes: Spain gets 100 + 300 = 400, France gets 200. Pool = 600.
        buy_as<SPAIN>(&mut sc, U1, 0, 100);
        buy_as<SPAIN>(&mut sc, U2, 0, 300);
        buy_as<FRANCE>(&mut sc, U3, 1, 200);

        // Admin resolves Spain (index 0).
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut market = ts::take_shared<OutcomeMarket<QUOTE>>(&sc);
            let ctx = ts::ctx(&mut sc);
            let admin = market_factory::admin_cap_for_testing(ctx);
            om::resolve<QUOTE>(&admin, &mut market, 0, ctx);
            assert!(om::vault_value(&market) == 600, 100);
            transfer::public_transfer(admin, ADMIN);
            ts::return_shared(market);
        };

        // U1 redeems 100 Spain -> 100 * 600/400 = 150.
        ts::next_tx(&mut sc, U1);
        {
            let mut market = ts::take_shared<OutcomeMarket<QUOTE>>(&sc);
            let token = ts::take_from_sender<Coin<SPAIN>>(&sc);
            let ctx = ts::ctx(&mut sc);
            om::redeem<QUOTE, SPAIN>(&mut market, 0, token, ctx);
            ts::return_shared(market);
        };
        ts::next_tx(&mut sc, U1);
        {
            let payout = ts::take_from_sender<Coin<QUOTE>>(&sc);
            assert!(coin::value(&payout) == 150, 101);
            coin::burn_for_testing(payout);
        };

        // U2 redeems 300 Spain -> 300 * 450/300 = 450, draining the pool.
        ts::next_tx(&mut sc, U2);
        {
            let mut market = ts::take_shared<OutcomeMarket<QUOTE>>(&sc);
            let token = ts::take_from_sender<Coin<SPAIN>>(&sc);
            let ctx = ts::ctx(&mut sc);
            om::redeem<QUOTE, SPAIN>(&mut market, 0, token, ctx);
            assert!(om::vault_value(&market) == 0, 102);
            ts::return_shared(market);
        };
        ts::next_tx(&mut sc, U2);
        {
            let payout = ts::take_from_sender<Coin<QUOTE>>(&sc);
            assert!(coin::value(&payout) == 450, 103);
            coin::burn_for_testing(payout);
        };

        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = 4, location = deepmarket_contract::outcome_market)]
    fun losing_token_cannot_redeem() {
        let mut sc = ts::begin(ADMIN);
        create_three_outcome_market(&mut sc);

        buy_as<SPAIN>(&mut sc, U1, 0, 100);
        buy_as<FRANCE>(&mut sc, U3, 1, 200);

        // Resolve Spain (0); France is a loser.
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut market = ts::take_shared<OutcomeMarket<QUOTE>>(&sc);
            let ctx = ts::ctx(&mut sc);
            let admin = market_factory::admin_cap_for_testing(ctx);
            om::resolve<QUOTE>(&admin, &mut market, 0, ctx);
            transfer::public_transfer(admin, ADMIN);
            ts::return_shared(market);
        };

        // U3 tries to redeem the losing France token -> aborts E_NOT_WINNER (4).
        ts::next_tx(&mut sc, U3);
        {
            let mut market = ts::take_shared<OutcomeMarket<QUOTE>>(&sc);
            let token = ts::take_from_sender<Coin<FRANCE>>(&sc);
            let ctx = ts::ctx(&mut sc);
            om::redeem<QUOTE, FRANCE>(&mut market, 1, token, ctx);
            ts::return_shared(market);
        };

        ts::end(sc);
    }
}
