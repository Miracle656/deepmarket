module test_pkg::test_module {
    use sui::coin;
    use sui::tx_context::TxContext;

    public struct TEST_MODULE has drop {}
    public struct YES_TOKEN<phantom T> has drop {}

    fun init(otw: TEST_MODULE, ctx: &mut TxContext) {
        // Test if we can create currency for YES_TOKEN<TEST_MODULE>
        // YES_TOKEN<TEST_MODULE> has drop, so it satisfies the constraint.
        // But is it an OTW?
        let (treasury, metadata) = coin::create_currency(
            YES_TOKEN<TEST_MODULE> {},
            6,
            b"YES",
            b"Yes Token",
            b"",
            option::none(),
            ctx
        );
        sui::transfer::public_transfer(treasury, sui::tx_context::sender(ctx));
        sui::transfer::public_freeze_object(metadata);
    }
}
