mod api;
pub mod builder;
mod db;
mod indexer;

use anyhow::Result;
use db::DbStore;
use sui_sdk::SuiClientBuilder;

#[tokio::main]
async fn main() -> Result<()> {
    println!("Starting prediction market indexer...");
    dotenvy::dotenv().ok();

    let pg_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://localhost/deepmarket".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_string());
    let sui_rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".to_string());

    let db_store = DbStore::new(&pg_url, &redis_url)
        .await
        .expect("Failed to connect to DBs");

    let sui_client = SuiClientBuilder::default().build(&sui_rpc_url).await?;

    let db_clone = db_store.clone();
    tokio::spawn(async move {
        println!("Starting checkpoint waterfall loop...");
        if let Err(e) = indexer::run_indexer(sui_client, db_clone).await {
            eprintln!("Indexer error: {:?}", e);
        }
    });

    let app = api::build_router(db_store, sui_rpc_url).await;

    // Honor Render's injected PORT (defaults to 3000 for local docker-compose).
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000);
    let bind = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    println!("API server listening on {}", bind);

    axum::serve(listener, app).await?;

    Ok(())
}
