use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use chrono;
use crate::db::DbStore;

use tower_http::cors::{Any, CorsLayer};

pub struct AppState {
    pub db: DbStore,
    pub sui_rpc_url: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MarketInfo {
    market_id: i64,
    question: Option<String>,
    resolution_time: Option<i64>,
    oracle_feed: Option<String>,
    status: Option<String>,
    outcome: Option<bool>,
    yes_pool_id: Option<String>,
    no_pool_id: Option<String>,
    token_package_id: Option<String>,
    volume: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct PricePoint {
    yes_price: i32,
    no_price: i32,
    timestamp: chrono::NaiveDateTime,
}

#[derive(Deserialize)]
pub struct CompileRequest {
    pub market_name: String,
}

pub async fn build_router(db: DbStore, sui_rpc_url: String) -> Router {
    let shared_state = Arc::new(AppState { db, sui_rpc_url });

    let cors = CorsLayer::new()
        .allow_methods(Any)
        .allow_origin(Any)
        .allow_headers(Any);

    Router::new()
        .route("/markets", get(get_markets))
        .route("/markets/:id/orderbook", get(get_orderbook))
        .route("/markets/:id/positions/:address", get(get_positions))
        .route("/markets/:id/history", get(get_price_history))
        .route("/api/compile-market", post(compile_market))
        .with_state(shared_state)
        .layer(cors)
}

async fn compile_market(Json(payload): Json<CompileRequest>) -> Json<serde_json::Value> {
    match crate::builder::build_market_package(&payload.market_name).await {
        Ok(result) => Json(json!({
            "success": true,
            "modules": result.modules,
            "dependencies": result.dependencies
        })),
        Err(e) => Json(json!({
            "success": false,
            "error": e.to_string()
        }))
    }
}

async fn get_markets(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let markets: Vec<MarketInfo> = sqlx::query_as("SELECT * FROM markets ORDER BY market_id DESC")
        .fetch_all(&state.db.pg_pool)
        .await
        .unwrap_or_default();

    Json(json!({ "markets": markets }))
}

async fn get_price_history(
    State(state): State<Arc<AppState>>,
    Path(id): Path<u64>,
) -> Json<serde_json::Value> {
    let history: Vec<PricePoint> = sqlx::query_as(
        "SELECT yes_price, no_price, timestamp FROM price_history
         WHERE market_id = $1 ORDER BY timestamp ASC"
    )
    .bind(id as i64)
    .fetch_all(&state.db.pg_pool)
    .await
    .unwrap_or_default();

    Json(json!({ "market_id": id, "history": history }))
}

async fn get_orderbook(
    State(state): State<Arc<AppState>>,
    Path(id): Path<u64>,
) -> Json<serde_json::Value> {
    match state.db.get_latest_fills(id, 20).await {
        Ok(fills) => {
            let entries: Vec<serde_json::Value> = fills
                .into_iter()
                .map(|(price, qty, digest)| json!({ "price": price, "qty": qty, "digest": digest }))
                .collect();
            Json(json!({
                "market_id": id,
                "fills": entries
            }))
        }
        Err(e) => Json(json!({ "market_id": id, "fills": [], "error": e.to_string() })),
    }
}

async fn get_positions(
    State(state): State<Arc<AppState>>,
    Path((id, address)): Path<(u64, String)>,
) -> Json<serde_json::Value> {
    // Look up token_package_id for this market
    let token_pkg = match state.db.get_token_package_id(id).await {
        Ok(Some(pkg)) => pkg,
        _ => {
            return Json(json!({
                "market_id": id,
                "address": address,
                "yes_balance": 0,
                "no_balance": 0,
                "error": "token_package_id not found"
            }));
        }
    };

    let yes_type = format!("{}::yes_market::YES_MARKET", token_pkg);
    let no_type = format!("{}::no_market::NO_MARKET", token_pkg);

    let client = reqwest::Client::new();

    let yes_balance = query_sui_balance(&client, &state.sui_rpc_url, &address, &yes_type).await;
    let no_balance = query_sui_balance(&client, &state.sui_rpc_url, &address, &no_type).await;

    Json(json!({
        "market_id": id,
        "address": address,
        "yes_balance": yes_balance,
        "no_balance": no_balance,
    }))
}

async fn query_sui_balance(
    client: &reqwest::Client,
    rpc_url: &str,
    address: &str,
    coin_type: &str,
) -> u64 {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "suix_getBalance",
        "params": [address, coin_type]
    });

    match client.post(rpc_url).json(&body).send().await {
        Ok(resp) => {
            match resp.json::<serde_json::Value>().await {
                Ok(v) => {
                    v["result"]["totalBalance"]
                        .as_str()
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(0)
                }
                Err(_) => 0,
            }
        }
        Err(_) => 0,
    }
}
