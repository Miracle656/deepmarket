use anyhow::Result;
use redis::{aio::MultiplexedConnection, AsyncCommands, Client as RedisClient};
use sqlx::{postgres::PgPoolOptions, PgPool};

#[derive(Clone)]
pub struct DbStore {
    pub pg_pool: PgPool,
    pub redis_conn: MultiplexedConnection,
}

impl DbStore {
    pub async fn new(database_url: &str, redis_url: &str) -> Result<Self> {
        let pg_pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS markets (
                market_id BIGINT PRIMARY KEY,
                question TEXT,
                resolution_time BIGINT,
                oracle_feed TEXT,
                status TEXT,
                outcome BOOLEAN,
                yes_pool_id TEXT,
                no_pool_id TEXT,
                token_package_id TEXT,
                volume BIGINT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )",
        )
        .execute(&pg_pool)
        .await?;

        // Add new columns to existing tables if they don't exist yet
        let _ = sqlx::query("ALTER TABLE markets ADD COLUMN IF NOT EXISTS token_package_id TEXT")
            .execute(&pg_pool)
            .await;
        let _ = sqlx::query("ALTER TABLE markets ADD COLUMN IF NOT EXISTS volume BIGINT DEFAULT 0")
            .execute(&pg_pool)
            .await;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS fills (
                id SERIAL PRIMARY KEY,
                market_id BIGINT,
                order_id TEXT,
                price BIGINT,
                qty BIGINT,
                tx_digest TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )",
        )
        .execute(&pg_pool)
        .await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS price_history (
                id SERIAL PRIMARY KEY,
                market_id BIGINT,
                yes_price INT,
                no_price INT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )",
        )
        .execute(&pg_pool)
        .await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS processed_events (
                event_id TEXT PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )",
        )
        .execute(&pg_pool)
        .await?;

        let client = RedisClient::open(redis_url)?;
        let redis_conn = client.get_multiplexed_async_connection().await?;

        Ok(Self {
            pg_pool,
            redis_conn,
        })
    }

    pub async fn save_fill(
        &self,
        market_id: u64,
        order_id: &str,
        price: u64,
        qty: u64,
        tx_digest: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO fills (market_id, order_id, price, qty, tx_digest) VALUES ($1, $2, $3, $4, $5)"
        )
        .bind(market_id as i64)
        .bind(order_id)
        .bind(price as i64)
        .bind(qty as i64)
        .bind(tx_digest)
        .execute(&self.pg_pool)
        .await?;

        // Update Redis hot path for latest fill
        let mut conn = self.redis_conn.clone();
        let key = format!("market:{}:latest_fill", market_id);
        let val = format!("{},{},{}", order_id, price, qty);
        let _: () = conn.hset("fills_cache", key, val).await?;

        Ok(())
    }

    pub async fn save_market(
        &self,
        market_id: u64,
        question: &str,
        resolution_time: u64,
        oracle_feed: &str,
        yes_pool_id: &str,
        no_pool_id: &str,
        token_package_id: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO markets (market_id, question, resolution_time, oracle_feed, status, yes_pool_id, no_pool_id, token_package_id)
             VALUES ($1, $2, $3, $4, 'Active', $5, $6, $7)
             ON CONFLICT (market_id) DO UPDATE SET
               question = $2,
               resolution_time = $3,
               oracle_feed = $4,
               yes_pool_id = $5,
               no_pool_id = $6,
               token_package_id = $7"
        )
        .bind(market_id as i64)
        .bind(question)
        .bind(resolution_time as i64)
        .bind(oracle_feed)
        .bind(yes_pool_id)
        .bind(no_pool_id)
        .bind(token_package_id)
        .execute(&self.pg_pool)
        .await?;
        Ok(())
    }

    pub async fn resolve_market_db(&self, market_id: u64, outcome: bool) -> Result<()> {
        sqlx::query("UPDATE markets SET status = 'Resolved', outcome = $1 WHERE market_id = $2")
            .bind(outcome)
            .bind(market_id as i64)
            .execute(&self.pg_pool)
            .await?;
        Ok(())
    }

    pub async fn save_price_point(
        &self,
        market_id: u64,
        yes_price: i32,
        no_price: i32,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO price_history (market_id, yes_price, no_price) VALUES ($1, $2, $3)",
        )
        .bind(market_id as i64)
        .bind(yes_price)
        .bind(no_price)
        .execute(&self.pg_pool)
        .await?;
        Ok(())
    }

    pub async fn is_event_processed(&self, event_id: &str) -> bool {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM processed_events WHERE event_id = $1)",
        )
        .bind(event_id)
        .fetch_one(&self.pg_pool)
        .await
        .unwrap_or(false)
    }

    pub async fn mark_event_processed(&self, event_id: &str) -> Result<()> {
        sqlx::query("INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(event_id)
            .execute(&self.pg_pool)
            .await?;
        Ok(())
    }

    pub async fn add_market_volume(&self, market_id: u64, amount: u64) -> Result<()> {
        sqlx::query("UPDATE markets SET volume = COALESCE(volume, 0) + $1 WHERE market_id = $2")
            .bind(amount as i64)
            .bind(market_id as i64)
            .execute(&self.pg_pool)
            .await?;
        Ok(())
    }

    /// Returns fills as (price, qty, tx_digest)
    pub async fn get_latest_fills(
        &self,
        market_id: u64,
        limit: i64,
    ) -> Result<Vec<(i64, i64, String)>> {
        let rows: Vec<(i64, i64, String)> = sqlx::query_as(
            "SELECT price, qty, tx_digest FROM fills WHERE market_id = $1 ORDER BY created_at DESC LIMIT $2"
        )
        .bind(market_id as i64)
        .bind(limit)
        .fetch_all(&self.pg_pool)
        .await?;
        Ok(rows)
    }

    pub async fn get_market_by_pool_id(&self, pool_id: &str) -> Result<Option<u64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT market_id FROM markets WHERE yes_pool_id = $1 OR no_pool_id = $1 LIMIT 1",
        )
        .bind(pool_id)
        .fetch_optional(&self.pg_pool)
        .await?;
        Ok(row.map(|(id,)| id as u64))
    }

    pub async fn get_token_package_id(&self, market_id: u64) -> Result<Option<String>> {
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT token_package_id FROM markets WHERE market_id = $1")
                .bind(market_id as i64)
                .fetch_optional(&self.pg_pool)
                .await?;
        Ok(row.and_then(|(pkg,)| pkg))
    }

    pub async fn get_last_processed_checkpoint(&self) -> Result<Option<u64>> {
        let mut conn = self.redis_conn.clone();
        let val: Option<String> = conn.get("last_processed_checkpoint").await?;
        if let Some(v) = val {
            Ok(Some(v.parse()?))
        } else {
            Ok(None)
        }
    }

    pub async fn set_last_processed_checkpoint(&self, seq: u64) -> Result<()> {
        let mut conn = self.redis_conn.clone();
        let _: () = conn
            .set("last_processed_checkpoint", seq.to_string())
            .await?;
        Ok(())
    }

    pub async fn update_order_state(
        &self,
        market_id: u64,
        order_id: &str,
        state: &str,
    ) -> Result<()> {
        let mut conn = self.redis_conn.clone();
        let key = format!("market:{}:orders", market_id);
        let _: () = conn.hset(key, order_id, state).await?;
        Ok(())
    }
}
