use crate::db::DbStore;
use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;
use sui_sdk::rpc_types::{EventFilter, SuiEvent, SuiObjectDataOptions};
use sui_sdk::types::base_types::{ObjectID, SequenceNumber, SuiAddress};
use sui_sdk::types::digests::TransactionDigest;
use sui_sdk::types::event::EventID;
use sui_sdk::types::object::Owner;
use sui_sdk::types::programmable_transaction_builder::ProgrammableTransactionBuilder;
use sui_sdk::types::transaction::{ObjectArg, SharedObjectMutability, TransactionKind};
use sui_sdk::types::{Identifier, TypeTag};
use sui_sdk::SuiClient;

// DeepBook V3 emits OrderFilled as
// `0xfb28c4cb…::order_info::OrderFilled` — from the implementation
// package's `order_info` module, NOT the canonical call package or the
// `pool` module.
const DEEPBOOK_EVENT_PKG: &str =
    "0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982";

// Canonical DeepBook CALL package — moveCall / devInspect targets use THIS,
// not the type-defining 0xfb28c4cb… package. (See memory deepbook_v3_quirks.)
const DEEPBOOK_CALL_PKG: &str =
    "0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c";

// Snapshot live pool mid-prices every N loop ticks (5s each → ~60s). This is
// what gives the chart movement between fills: it records P(YES) as the order
// book shifts, not only when a trade executes.
const SNAPSHOT_EVERY_TICKS: u64 = 12;

// Redis key holding the ascending cursor (`<digest>:<seq>`) into the global
// DeepBook `order_info` event stream. Forward-only: seeded to the tip on the
// very first run so we never walk testnet's enormous historical backlog.
const DEEPBOOK_FILL_CURSOR_KEY: &str = "cursor:deepbook_fills";

// Set once the one-time BACKFILL_TX_DIGESTS ingest has run.
const BACKFILL_DONE_KEY: &str = "backfill:done";

// Cap pages walked per tick so a burst of activity can't wedge the 5s loop —
// it just resumes from the persisted cursor next tick.
const MAX_FILL_PAGES_PER_TICK: usize = 10;

#[derive(Deserialize, Debug)]
struct MarketCreatedEvent {
    market_id: String,
    question: String,
    resolution_time: String,
    oracle_feed: String,
    yes_pool_id: Option<String>,
    no_pool_id: Option<String>,
    token_package_id: Option<String>,
}

#[derive(Deserialize, Debug)]
struct ResolvedEvent {
    market_id: String,
    outcome: bool,
}

#[derive(Deserialize, Debug)]
struct MintedEvent {
    market_id: String,
    amount: String,
    #[allow(dead_code)]
    user: String,
}

#[derive(Deserialize, Debug)]
struct OrderFilledEvent {
    pool_id: Option<String>,
    base_quantity: Option<String>,
    quote_quantity: Option<String>,
    taker_order_id: Option<String>,
    /// 1e9-scaled SUI-per-share. For a YES/SUI pool this IS P(YES).
    price: Option<String>,
}

/// True for a pool id that points at a real on-chain object. Rejects the
/// empty string and the all-zero address that skip-pools markets carry
/// (`register_custom_market` records `0x0` when a market has no DeepBook
/// pool) — those have no order book to read.
fn is_real_pool(id: &str) -> bool {
    let hex = id.strip_prefix("0x").unwrap_or(id);
    !hex.is_empty() && hex.bytes().any(|b| b != b'0')
}

/// `<digest>:<event_seq>` — our compact, parseable encoding of an `EventID`
/// for the Redis cursor (EventID has no FromStr of its own).
fn encode_event_id(id: &EventID) -> String {
    format!("{}:{}", id.tx_digest, id.event_seq)
}

fn decode_event_id(s: &str) -> Option<EventID> {
    let (digest, seq) = s.rsplit_once(':')?;
    Some(EventID {
        tx_digest: digest.parse().ok()?,
        event_seq: seq.parse().ok()?,
    })
}

pub async fn run_indexer(sui_client: SuiClient, db: DbStore) -> Result<()> {
    println!("Indexer loop started...");

    let package_id_str = std::env::var("PACKAGE_ID").expect("PACKAGE_ID env var not set");

    // Start from last processed checkpoint to avoid re-processing on restart
    let _last_cp = db.get_last_processed_checkpoint().await.unwrap_or(None);

    let mut tick: u64 = 0;
    loop {
        // Poll our contract events
        let filter = EventFilter::MoveEventModule {
            package: package_id_str.parse()?,
            module: "market_factory".parse()?,
        };

        match sui_client
            .event_api()
            .query_events(filter, None, None, true)
            .await
        {
            Ok(events_page) => {
                let len = events_page.data.len();
                if len > 0 {
                    println!("Fetched {} market_factory events from testnet", len);
                }
                for event in events_page.data {
                    let event_id = format!("{}-{}", event.id.tx_digest, event.id.event_seq);
                    if db.is_event_processed(&event_id).await {
                        continue;
                    }

                    let type_str = event.type_.to_string();

                    if type_str.contains("MarketCreatedEvent") {
                        match serde_json::from_value::<MarketCreatedEvent>(event.parsed_json) {
                            Ok(parsed) => {
                                println!("MarketCreatedEvent: market_id={}", parsed.market_id);
                                let market_id: u64 = parsed.market_id.parse().unwrap_or_default();
                                let token_pkg = parsed.token_package_id.as_deref().unwrap_or("");
                                db.save_market(
                                    market_id,
                                    &parsed.question,
                                    parsed.resolution_time.parse().unwrap_or_default(),
                                    &parsed.oracle_feed,
                                    parsed.yes_pool_id.as_deref().unwrap_or(""),
                                    parsed.no_pool_id.as_deref().unwrap_or(""),
                                    token_pkg,
                                )
                                .await?;
                                db.save_price_point(market_id, 50, 50).await?;
                            }
                            Err(e) => eprintln!("Failed to parse MarketCreatedEvent: {e}"),
                        }
                    } else if type_str.contains("ResolvedEvent") {
                        match serde_json::from_value::<ResolvedEvent>(event.parsed_json) {
                            Ok(parsed) => {
                                let market_id: u64 = parsed.market_id.parse().unwrap_or_default();
                                println!("ResolvedEvent: market_id={}", market_id);
                                db.resolve_market_db(market_id, parsed.outcome).await?;
                                let (y, n) = if parsed.outcome { (100, 0) } else { (0, 100) };
                                db.save_price_point(market_id, y, n).await?;
                            }
                            Err(e) => eprintln!("Failed to parse ResolvedEvent: {e}"),
                        }
                    } else if type_str.contains("MintedEvent") {
                        match serde_json::from_value::<MintedEvent>(event.parsed_json) {
                            Ok(parsed) => {
                                let market_id: u64 = parsed.market_id.parse().unwrap_or_default();
                                let amount: u64 = parsed.amount.parse().unwrap_or_default();
                                // Minting is collateral issuance, NOT trade
                                // volume. Volume now accrues only from real
                                // DeepBook fills (quote traded). Log only.
                                println!("MintedEvent: market_id={}, amount={}", market_id, amount);
                            }
                            Err(e) => eprintln!("Failed to parse MintedEvent: {e}"),
                        }
                    }

                    db.mark_event_processed(&event_id).await.ok();
                }
            }
            Err(e) => eprintln!("Failed to query market_factory events: {e}"),
        }

        // ---- DeepBook fills -------------------------------------------------
        // Public testnet fullnodes do NOT serve queryTransactionBlocks object
        // filters (ChangedObject / InputObject return 0), so a per-pool tx
        // scan is impossible. queryEvents on the order_info MODULE does work —
        // it's the global DeepBook fill firehose. We make it usable by
        // matching each fill's pool_id against our own pools and walking the
        // stream with a persisted, tip-seeded ascending cursor.
        if let Err(e) = index_deepbook_fills(&sui_client, &db).await {
            eprintln!("DeepBook fill indexing failed: {e}");
        }

        // Live mid-price snapshots — the chart's between-trades movement.
        if tick % SNAPSHOT_EVERY_TICKS == 0 {
            if let Err(e) = snapshot_pool_prices(&sui_client, &db).await {
                eprintln!("Pool price snapshot failed: {e}");
            }
        }
        tick = tick.wrapping_add(1);

        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Record P(YES) for every market's YES pool from its live order-book mid,
/// so the chart shows movement as the book shifts (not just on fills).
async fn snapshot_pool_prices(sui_client: &SuiClient, db: &DbStore) -> Result<()> {
    for (mid, yes, _no) in db.get_markets_with_pools().await? {
        let Some(pool) = yes.filter(|s| is_real_pool(s)) else {
            continue;
        };
        if let Some(yes_p) = pool_mid_yes_pct(sui_client, &pool).await {
            db.save_price_point(mid as u64, yes_p, 100 - yes_p).await.ok();
            println!("Snapshot: market={mid} pool={pool} yes%={yes_p}");
        }
        // None → one-sided/empty book or RPC hiccup: just skip this tick.
    }
    Ok(())
}

/// devInspect `pool::mid_price<Base, Quote>(pool, clock)` and return P(YES)%.
/// Returns None when the book is one-sided (mid_price aborts) or on any RPC
/// error — callers treat that as "no snapshot this tick".
async fn pool_mid_yes_pct(sui_client: &SuiClient, pool_id: &str) -> Option<i32> {
    let pool_obj: ObjectID = pool_id.parse().ok()?;

    // The pool object's own type carries its <Base, Quote> generics and its
    // shared-version — everything we need to build the call, no guessing of
    // per-market token type names.
    let resp = sui_client
        .read_api()
        .get_object_with_options(
            pool_obj,
            SuiObjectDataOptions::new().with_type().with_owner(),
        )
        .await
        .ok()?;
    let data = resp.data?;
    let (base_tag, quote_tag) = parse_pool_type_args(&data.type_.as_ref()?.to_string())?;
    let initial_shared_version = match data.owner? {
        Owner::Shared {
            initial_shared_version,
        } => initial_shared_version,
        _ => return None,
    };

    let mut ptb = ProgrammableTransactionBuilder::new();
    let pool_arg = ptb
        .obj(ObjectArg::SharedObject {
            id: pool_obj,
            initial_shared_version,
            mutability: SharedObjectMutability::Immutable,
        })
        .ok()?;
    let clock_arg = ptb
        .obj(ObjectArg::SharedObject {
            id: ObjectID::from_hex_literal("0x6").ok()?,
            initial_shared_version: SequenceNumber::from_u64(1),
            mutability: SharedObjectMutability::Immutable,
        })
        .ok()?;
    ptb.programmable_move_call(
        ObjectID::from_hex_literal(DEEPBOOK_CALL_PKG).ok()?,
        Identifier::new("pool").ok()?,
        Identifier::new("mid_price").ok()?,
        vec![base_tag, quote_tag],
        vec![pool_arg, clock_arg],
    );
    let tx_kind = TransactionKind::ProgrammableTransaction(ptb.finish());

    let res = sui_client
        .read_api()
        .dev_inspect_transaction_block(SuiAddress::ZERO, tx_kind, None, None, None)
        .await
        .ok()?;
    if res.error.is_some() {
        return None; // mid_price aborts on a one-sided book
    }
    let (bytes, _tag) = res.results?.first()?.return_values.first()?.clone();
    if bytes.len() < 8 {
        return None;
    }
    // 1e9-scaled SUI per share → P(YES)%. mid / 1e9 * 100 = mid / 1e7.
    let mid_raw = u64::from_le_bytes(bytes[..8].try_into().ok()?);
    Some(((mid_raw / 10_000_000) as i32).clamp(0, 100))
}

/// Pull the two type arguments out of a DeepBook pool's type string,
/// e.g. `…::pool::Pool<0x..::yes_token::YES_TOKEN, 0x2::sui::SUI>`.
fn parse_pool_type_args(type_str: &str) -> Option<(TypeTag, TypeTag)> {
    let lt = type_str.find('<')?;
    let gt = type_str.rfind('>')?;
    let inner = &type_str[lt + 1..gt];

    // Split on the top-level comma (depth 0) so nested generics stay intact.
    let mut depth = 0i32;
    let mut comma = None;
    for (i, c) in inner.char_indices() {
        match c {
            '<' => depth += 1,
            '>' => depth -= 1,
            ',' if depth == 0 => {
                comma = Some(i);
                break;
            }
            _ => {}
        }
    }
    let i = comma?;
    let base = TypeTag::from_str(inner[..i].trim()).ok()?;
    let quote = TypeTag::from_str(inner[i + 1..].trim()).ok()?;
    Some((base, quote))
}

/// Ingest DeepBook `OrderFilled` events into fills / price history / volume:
/// a one-time backfill of known digests, then a forward walk of the global
/// `order_info` stream from a tip-seeded cursor.
async fn index_deepbook_fills(sui_client: &SuiClient, db: &DbStore) -> Result<()> {
    // pool_id -> (market_id, is_yes_pool). Only the YES pool's fill price is
    // P(YES); the NO pool contributes volume only.
    let mut pool_map: HashMap<String, (u64, bool)> = HashMap::new();
    for (mid, yes, no) in db.get_markets_with_pools().await? {
        let mid = mid as u64;
        if let Some(p) = yes.filter(|s| is_real_pool(s)) {
            pool_map.insert(p, (mid, true));
        }
        if let Some(p) = no.filter(|s| is_real_pool(s)) {
            pool_map.insert(p, (mid, false));
        }
    }
    if pool_map.is_empty() {
        return Ok(());
    }

    // One-time backfill of explicitly listed historical trade digests. Lets us
    // seed known demo trades that are too deep in the stream to walk back to.
    if db.get_pool_cursor(BACKFILL_DONE_KEY).await.is_none() {
        if let Ok(digests) = std::env::var("BACKFILL_TX_DIGESTS") {
            for d in digests.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                let td: TransactionDigest = match d.parse() {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("Bad BACKFILL_TX_DIGESTS entry {d}: {e}");
                        continue;
                    }
                };
                match sui_client
                    .event_api()
                    .query_events(EventFilter::Transaction(td), None, None, false)
                    .await
                {
                    Ok(page) => {
                        for ev in &page.data {
                            process_fill_event(db, &pool_map, ev).await;
                        }
                    }
                    Err(e) => eprintln!("Backfill query for {d} failed: {e}"),
                }
            }
        }
        db.set_pool_cursor(BACKFILL_DONE_KEY, "1").await.ok();
    }

    let module_filter = EventFilter::MoveEventModule {
        package: DEEPBOOK_EVENT_PKG.parse()?,
        module: "order_info".parse()?,
    };

    // First run: seed the cursor to the current tip so we skip the giant
    // historical backlog and only ingest fills from now on.
    let Some(cursor_str) = db.get_pool_cursor(DEEPBOOK_FILL_CURSOR_KEY).await else {
        if let Ok(page) = sui_client
            .event_api()
            .query_events(module_filter, None, Some(1), true)
            .await
        {
            if let Some(tip) = page.data.first().map(|e| e.id.clone()) {
                db.set_pool_cursor(DEEPBOOK_FILL_CURSOR_KEY, &encode_event_id(&tip))
                    .await
                    .ok();
                println!("Seeded DeepBook fill cursor to tip {}", encode_event_id(&tip));
            }
        }
        return Ok(());
    };

    // Forward walk: ascending from the cursor (exclusive), page by page.
    let mut cursor = decode_event_id(&cursor_str);
    for _ in 0..MAX_FILL_PAGES_PER_TICK {
        let page = match sui_client
            .event_api()
            .query_events(module_filter.clone(), cursor.clone(), Some(50), false)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("order_info forward query failed: {e}");
                break;
            }
        };
        if page.data.is_empty() {
            break;
        }
        for ev in &page.data {
            process_fill_event(db, &pool_map, ev).await;
        }
        cursor = page.next_cursor;
        if let Some(c) = &cursor {
            db.set_pool_cursor(DEEPBOOK_FILL_CURSOR_KEY, &encode_event_id(c))
                .await
                .ok();
        }
        if !page.has_next_page {
            break;
        }
    }

    Ok(())
}

/// Persist one `OrderFilled` event if it belongs to one of our pools. Deduped
/// by `processed_events`; non-matching pools are skipped without marking, so
/// the dedup table doesn't fill with every DeepBook trade on testnet.
async fn process_fill_event(
    db: &DbStore,
    pool_map: &HashMap<String, (u64, bool)>,
    event: &SuiEvent,
) {
    let type_str = event.type_.to_string();
    if !type_str.contains(DEEPBOOK_EVENT_PKG) || !type_str.contains("order_info::OrderFilled") {
        return;
    }

    let fill: OrderFilledEvent = match serde_json::from_value(event.parsed_json.clone()) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Failed to parse OrderFilledEvent: {e}");
            return;
        }
    };

    let Some(pool_id) = fill.pool_id.as_deref() else {
        return;
    };
    let Some(&(market_id, is_yes)) = pool_map.get(pool_id) else {
        return; // not one of our pools
    };

    let fill_event_id = format!("{}-{}", event.id.tx_digest, event.id.event_seq);
    if db.is_event_processed(&fill_event_id).await {
        return;
    }

    let base_qty: u64 = fill
        .base_quantity
        .as_deref()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    let quote_qty: u64 = fill
        .quote_quantity
        .as_deref()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    let price_raw: u64 = fill.price.as_deref().unwrap_or("0").parse().unwrap_or(0);
    if base_qty == 0 || price_raw == 0 {
        return;
    }

    // price is 1e9-scaled SUI-per-share; for a YES/SUI pool that IS P(YES).
    // yes% = price / 1e9 * 100 = price / 1e7.
    let yes_p = ((price_raw / 10_000_000) as i32).clamp(0, 100);
    let tx_digest = event.id.tx_digest.to_string();
    let order_id = fill.taker_order_id.as_deref().unwrap_or(&tx_digest);

    db.save_fill(market_id, order_id, yes_p as u64, base_qty, &tx_digest)
        .await
        .ok();
    if is_yes {
        db.save_price_point(market_id, yes_p, 100 - yes_p).await.ok();
    }
    db.add_market_volume(market_id, quote_qty).await.ok();
    db.mark_event_processed(&fill_event_id).await.ok();

    println!(
        "Fill: market={market_id} pool={pool_id} yes%={yes_p} base={base_qty} quote={quote_qty}"
    );
}
