/// AgentCap — on-chain policy object + audit log for the DeepMarket agent.
///
/// **What this is.** A Sui object the user signs once to authorize a bot
/// address (the `agent`) to trade on their behalf within stated limits.
/// The cap holds the *policy snapshot* (daily spend cap, expiry, allowed
/// oracles, revoked flag); the *audit trail* is the stream of
/// `AgentDecisionMade` events emitted every time the agent acts.
///
/// **Enforcement model.** Compile-time enforcement only applies to entry
/// points that actually accept an `AgentCap` (our Spot markets are the
/// target — Phase 5.3). For third-party packages like DeepBook Predict
/// that we cannot modify, the bot reads the cap before each decision and
/// software-policies the limits. Revocation is honored on-chain: the
/// bot's `record_decision` call aborts when `revoked == true`, so a
/// malicious bot cannot post a fake audit entry after the user revokes.
///
/// **spent_today.** Not stored. Computed off-chain by replaying the
/// `AgentDecisionMade` events emitted today by this cap_id. Keeps the
/// cap object immutable except for owner-driven revoke / update — no
/// concurrent-write races with the agent's record_decision calls.
module deepmarket_contract::agent_cap {
    use sui::clock::Clock;
    use sui::event;

    // ─── Errors ────────────────────────────────────────────────────────

    const ENotOwner: u64 = 1;
    const ENotAgent: u64 = 2;
    const ECapRevoked: u64 = 3;
    const ECapExpired: u64 = 4;
    const EOracleNotAllowed: u64 = 5;

    // ─── Cap object ────────────────────────────────────────────────────

    /// On-chain authorization for `agent` to trade up to `daily_spend_cap_usd`
    /// per day until `expires_at_ms`, with optional oracle allowlist.
    /// `daily_spend_cap_usd` is in dUSDC base units (1e6 = $1).
    public struct AgentCap has key, store {
        id: UID,
        /// The end user — only `owner` can revoke or update the cap.
        owner: address,
        /// The bot address — only `agent` can call `record_decision`.
        agent: address,
        /// Max USD of new cover per UTC day, in dUSDC base units.
        daily_spend_cap_usd: u64,
        /// Cap expires at this absolute ms timestamp.
        expires_at_ms: u64,
        /// If non-empty, the agent may only act on these oracle ids.
        /// Empty = unrestricted.
        allowed_oracles: vector<ID>,
        /// Owner-set kill switch. When true, record_decision aborts.
        revoked: bool,
        /// When the cap was minted, ms.
        created_at_ms: u64,
    }

    // ─── Events ────────────────────────────────────────────────────────

    public struct AgentCapCreated has copy, drop {
        cap_id: ID,
        owner: address,
        agent: address,
        daily_spend_cap_usd: u64,
        expires_at_ms: u64,
        allowed_oracle_count: u64,
        ts_ms: u64,
    }

    /// Emitted by `record_decision`. The off-chain audit trail.
    /// `rationale_hash` is a content-addressable digest of the agent's
    /// rationale string (kept off-chain in MemWal); 32 bytes max.
    public struct AgentDecisionMade has copy, drop {
        cap_id: ID,
        owner: address,
        agent: address,
        oracle_id: ID,
        /// true = mint a new position, false = pass / cancel
        is_mint: bool,
        /// when is_mint=true: UP direction. Ignored when is_mint=false.
        direction_up: bool,
        /// Strike price in raw on-chain units (1e9 = $1).
        strike: u64,
        /// Cover size in dUSDC base units (1e6 = $1).
        cover_usd: u64,
        /// First 32 bytes of sha256(agent_rationale).
        rationale_hash: vector<u8>,
        ts_ms: u64,
    }

    public struct AgentCapRevoked has copy, drop {
        cap_id: ID,
        owner: address,
        ts_ms: u64,
    }

    public struct AgentCapUpdated has copy, drop {
        cap_id: ID,
        new_daily_spend_cap_usd: u64,
        new_expires_at_ms: u64,
        ts_ms: u64,
    }

    // ─── Mint / revoke / update ────────────────────────────────────────

    /// Mint a fresh cap. The cap is a **shared object** so the agent
    /// address can reference it in `record_decision` txs — but every
    /// mutating path (`revoke`, `update`) asserts `ctx.sender() == owner`,
    /// so sharing does not weaken access control. The agent never holds
    /// custody of the authorization; to revoke, the user signs a tx that
    /// flips `revoked` to true.
    public fun create(
        agent: address,
        daily_spend_cap_usd: u64,
        expires_at_ms: u64,
        allowed_oracles: vector<ID>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock.timestamp_ms();
        let cap = AgentCap {
            id: object::new(ctx),
            owner: ctx.sender(),
            agent,
            daily_spend_cap_usd,
            expires_at_ms,
            allowed_oracles,
            revoked: false,
            created_at_ms: now,
        };
        let cap_id = object::id(&cap);
        event::emit(AgentCapCreated {
            cap_id,
            owner: cap.owner,
            agent: cap.agent,
            daily_spend_cap_usd,
            expires_at_ms,
            allowed_oracle_count: cap.allowed_oracles.length(),
            ts_ms: now,
        });
        transfer::share_object(cap);
    }

    public fun revoke(
        cap: &mut AgentCap,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == cap.owner, ENotOwner);
        cap.revoked = true;
        event::emit(AgentCapRevoked {
            cap_id: object::id(cap),
            owner: cap.owner,
            ts_ms: clock.timestamp_ms(),
        });
    }

    public fun update(
        cap: &mut AgentCap,
        new_daily_spend_cap_usd: u64,
        new_expires_at_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == cap.owner, ENotOwner);
        cap.daily_spend_cap_usd = new_daily_spend_cap_usd;
        cap.expires_at_ms = new_expires_at_ms;
        event::emit(AgentCapUpdated {
            cap_id: object::id(cap),
            new_daily_spend_cap_usd,
            new_expires_at_ms,
            ts_ms: clock.timestamp_ms(),
        });
    }

    // ─── Agent action recording ────────────────────────────────────────

    /// Called by the agent on every decision tick. Emits an audit event;
    /// also asserts the cap is still valid so a revoked agent literally
    /// cannot post a fake "I'm still authorized" entry to the log.
    ///
    /// Off-chain, the agent + auditors replay these events to enforce
    /// the daily spend cap.
    public fun record_decision(
        cap: &AgentCap,
        oracle_id: ID,
        is_mint: bool,
        direction_up: bool,
        strike: u64,
        cover_usd: u64,
        rationale_hash: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock.timestamp_ms();
        assert!(ctx.sender() == cap.agent, ENotAgent);
        assert!(!cap.revoked, ECapRevoked);
        assert!(now <= cap.expires_at_ms, ECapExpired);
        if (cap.allowed_oracles.length() > 0) {
            assert!(cap.allowed_oracles.contains(&oracle_id), EOracleNotAllowed);
        };
        event::emit(AgentDecisionMade {
            cap_id: object::id(cap),
            owner: cap.owner,
            agent: cap.agent,
            oracle_id,
            is_mint,
            direction_up,
            strike,
            cover_usd,
            rationale_hash,
            ts_ms: now,
        });
    }

    // ─── Read accessors ────────────────────────────────────────────────

    public fun owner(cap: &AgentCap): address { cap.owner }
    public fun agent(cap: &AgentCap): address { cap.agent }
    public fun daily_spend_cap_usd(cap: &AgentCap): u64 { cap.daily_spend_cap_usd }
    public fun expires_at_ms(cap: &AgentCap): u64 { cap.expires_at_ms }
    public fun is_revoked(cap: &AgentCap): bool { cap.revoked }
    public fun created_at_ms(cap: &AgentCap): u64 { cap.created_at_ms }

    /// True iff the cap is still usable right now.
    public fun is_active(cap: &AgentCap, clock: &Clock): bool {
        !cap.revoked && clock.timestamp_ms() <= cap.expires_at_ms
    }
}
