module deepmarket_contract::no_token {
    use sui::coin;

    #[allow(lint(duplicate_alias))]
    public struct NO_TOKEN has drop {}

    #[allow(deprecated_usage)]
    fun init(witness: NO_TOKEN, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency(
            witness,
            6, // decimals
            b"NO", // symbol
            b"No Token", // name
            b"Outcome token for NO", // description
            option::none(),
            ctx
        );
        sui::transfer::public_freeze_object(metadata);
        sui::transfer::public_transfer(treasury_cap, ctx.sender());
    }
}
