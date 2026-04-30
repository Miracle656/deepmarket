mod db;
mod indexer;
mod api;
pub mod builder;

use anyhow::Result;
use sui_sdk::SuiClientBuilder;
use db::DbStore;

#[tokio::main]
async fn main() -> Result<()> {
    println!("Starting prediction market indexer...");
    dotenvy::dotenv().ok();

    let pg_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://localhost/deepmarket".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_string());
    let sui_rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".to_string());

    let db_store = DbStore::new(&pg_url, &redis_url).await.expect("Failed to connect to DBs");

    let sui_client = SuiClientBuilder::default()
        .build(&sui_rpc_url)
        .await?;

    let db_clone = db_store.clone();
    tokio::spawn(async move {
        println!("Starting checkpoint waterfall loop...");
        if let Err(e) = indexer::run_indexer(sui_client, db_clone).await {
            eprintln!("Indexer error: {:?}", e);
        }
    });

    let app = api::build_router(db_store, sui_rpc_url).await;
    let listener = tokio::net::TcpListener::bind("[::]:3000").await?;
    println!("API server listening on 0.0.0.0:3000");

    axum::serve(listener, app).await?;

    Ok(())
}
