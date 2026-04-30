module deepmarket_contract::yes_token {
    use sui::coin;

    public struct YES_TOKEN has drop {}

    #[allow(deprecated_usage)]
    fun init(witness: YES_TOKEN, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency(
            witness,
            6, // decimals
            b"YES", // symbol
            b"Yes Token", // name
            b"Outcome token for YES", // description
            option::none(),
            ctx
        );
        sui::transfer::public_freeze_object(metadata);
        sui::transfer::public_transfer(treasury_cap, ctx.sender());
    }
}
