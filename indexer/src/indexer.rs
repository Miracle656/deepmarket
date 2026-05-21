use crate::db::DbStore;
use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;
use sui_sdk::rpc_types::{EventFilter, SuiEvent};
use sui_sdk::types::digests::TransactionDigest;
use sui_sdk::types::event::EventID;
use sui_sdk::SuiClient;

// DeepBook V3 emits OrderFilled as
// `0xfb28c4cb…::order_info::OrderFilled` — from the implementation
// package's `order_info` module, NOT the canonical call package or the
// `pool` module.
const DEEPBOOK_EVENT_PKG: &str =
    "0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982";

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

        tokio::time::sleep(Duration::from_secs(5)).await;
    }
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
