use std::time::Duration;
use sui_sdk::SuiClient;
use anyhow::Result;
use serde::Deserialize;
use sui_sdk::rpc_types::EventFilter;
use crate::db::DbStore;

const DEEPBOOK_PKG: &str = "0x2c68443db9e8c813b194010c11040a3ce59f47e4eb97a2ec805371505dad7459";

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

        match sui_client.event_api().query_events(filter, None, None, true).await {
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
                                ).await?;
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
                                println!("MintedEvent: market_id={}, amount={}", market_id, amount);
                                db.add_market_volume(market_id, amount).await?;
                            }
                            Err(e) => eprintln!("Failed to parse MintedEvent: {e}"),
                        }
                    }

                    db.mark_event_processed(&event_id).await.ok();
                }
            }
            Err(e) => eprintln!("Failed to query market_factory events: {e}"),
        }

        // Poll DeepBook fill events
        if let Ok(deepbook_pkg) = DEEPBOOK_PKG.parse() {
            let fill_filter = EventFilter::MoveEventModule {
                package: deepbook_pkg,
                module: "pool".parse()?,
            };

            match sui_client.event_api().query_events(fill_filter, None, Some(50), true).await {
                Ok(events_page) => {
                    for event in events_page.data {
                        let fill_event_id = format!("{}-{}", event.id.tx_digest, event.id.event_seq);
                        if db.is_event_processed(&fill_event_id).await {
                            continue;
                        }
                        let type_str = event.type_.to_string();
                        if !type_str.contains("OrderFilled") {
                            continue;
                        }
                        match serde_json::from_value::<OrderFilledEvent>(event.parsed_json) {
                            Ok(fill) => {
                                let pool_id = fill.pool_id.as_deref().unwrap_or("");
                                if pool_id.is_empty() {
                                    continue;
                                }
                                let base_qty: u64 = fill.base_quantity.as_deref().unwrap_or("0").parse().unwrap_or(0);
                                let quote_qty: u64 = fill.quote_quantity.as_deref().unwrap_or("0").parse().unwrap_or(0);
                                if base_qty == 0 {
                                    continue;
                                }
                                // Price as yes_price (0-100 scale): quote/base * 100 at 1e9 units
                                let price = quote_qty * 100 / base_qty;
                                let tx_digest = event.id.tx_digest.to_string();
                                let order_id = fill.taker_order_id.as_deref().unwrap_or(&tx_digest);

                                if let Ok(Some(market_id)) = db.get_market_by_pool_id(pool_id).await {
                                    db.save_fill(market_id, order_id, price, base_qty, &tx_digest).await.ok();
                                    // Save as yes_price (clamped 0-100)
                                    let yes_p = (price as i32).clamp(0, 100);
                                    db.save_price_point(market_id, yes_p, 100 - yes_p).await.ok();
                                }
                                db.mark_event_processed(&fill_event_id).await.ok();
                            }
                            Err(e) => eprintln!("Failed to parse OrderFilledEvent: {e}"),
                        }
                    }
                }
                Err(e) => eprintln!("Failed to query DeepBook fill events: {e}"),
            }
        }

        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
