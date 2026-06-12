use serde::{Deserialize, Serialize};
use std::fs;
use std::process::Command;
use tokio::fs as tfs;

#[derive(Serialize, Deserialize, Debug)]
pub struct CompileResult {
    pub modules: Vec<String>,
    pub dependencies: Vec<String>,
}

#[derive(Deserialize, Debug)]
struct SuiBuildOutput {
    modules: Vec<String>,
    dependencies: Vec<String>,
}

/// Helper to sanitize a string into a valid Move identifier
fn sanitize_name(name: &str) -> String {
    let mut safe = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            safe.push(c.to_ascii_lowercase());
        } else {
            safe.push('_');
        }
    }
    // Cannot start with a number
    if safe.starts_with(|c: char| c.is_ascii_digit()) {
        safe = format!("m_{}", safe);
    }
    safe
}

/// Derive a short, uppercase, alphanumeric coin symbol from a display name.
/// e.g. "Argentina" -> "ARGEN", "Côte d'Ivoire" -> "CTEDI".
fn symbol_from_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if s.is_empty() {
        s = "OUTCOME".to_string();
    }
    s.chars().take(8).collect()
}

/// Build a per-market token package for a multi-outcome market: one OTW coin
/// module per outcome (`outcome_0 … outcome_{n-1}`, witness `OUTCOME_0` …),
/// each a 9-decimal `Coin`. The frontend publishes the result, takes the N
/// `TreasuryCap`s + package id, optionally opens a DeepBook pool per outcome,
/// then calls `outcome_market::create_market` + `add_outcome` ×N + `share`.
pub async fn build_outcome_market_package(
    market_name: &str,
    outcomes: &[String],
) -> anyhow::Result<CompileResult> {
    if outcomes.len() < 2 {
        anyhow::bail!("a multi-outcome market needs at least 2 outcomes");
    }
    if outcomes.len() > 64 {
        anyhow::bail!("too many outcomes (max 64)");
    }

    let safe_name = sanitize_name(market_name);

    let temp_dir = std::env::temp_dir().join(format!("deepmarket_om_{}", safe_name));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)?;
    }
    fs::create_dir_all(temp_dir.join("sources"))?;

    let move_toml = format!(
        r#"[package]
name = "{safe_name}"
version = "0.0.1"
edition = "2024.beta"

[dependencies]
Sui = {{ git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "testnet-v1.72.1" }}

[addresses]
{safe_name} = "0x0"
"#
    );
    tfs::write(temp_dir.join("Move.toml"), move_toml).await?;

    // One OTW coin module per outcome. The witness type must be the module
    // name uppercased (Sui one-time-witness convention).
    for (i, outcome) in outcomes.iter().enumerate() {
        let module = format!("outcome_{i}");
        let witness = format!("OUTCOME_{i}");
        let symbol = symbol_from_name(outcome);
        // Escape any embedded quotes/backslashes in the display name for the
        // Move byte-string literal.
        let display = outcome.replace('\\', "").replace('"', "");
        let code = format!(
            r#"module {safe_name}::{module} {{
    use sui::coin;
    use std::option;

    public struct {witness} has drop {{}}

    #[allow(deprecated_usage)]
    fun init(otw: {witness}, ctx: &mut sui::tx_context::TxContext) {{
        let (treasury, metadata) = coin::create_currency(otw, 9, b"{symbol}", b"{display}", b"", option::none(), ctx);
        sui::transfer::public_freeze_object(metadata);
        sui::transfer::public_transfer(treasury, sui::tx_context::sender(ctx));
    }}
}}
"#
        );
        tfs::write(
            temp_dir.join("sources").join(format!("{module}.move")),
            code,
        )
        .await?;
    }

    compile_dir(&temp_dir).await
}

pub async fn build_market_package(market_name: &str) -> anyhow::Result<CompileResult> {
    let safe_name = sanitize_name(market_name);

    // 1. Create a unique temporary directory
    let temp_dir = std::env::temp_dir().join(format!("deepmarket_{}", safe_name));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)?;
    }
    fs::create_dir_all(temp_dir.join("sources"))?;

    // 2. Write Move.toml
    // The generated token modules only use sui::coin — no dependency on deepmarket_contract.
    // Including deepmarket_contract as both a local dependency (address = 0x0) and in [addresses]
    // (address = deployed_id) causes a "conflicting assignments" compilation error.
    let move_toml = format!(
        r#"[package]
name = "{safe_name}"
version = "0.0.1"
edition = "2024.beta"

[dependencies]
Sui = {{ git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "testnet-v1.60.0" }}

[addresses]
{safe_name} = "0x0"
"#
    );
    tfs::write(temp_dir.join("Move.toml"), move_toml).await?;

    // Per-market coin display names so the *wallet* can tell one market's YES/NO
    // token from another's. The Move struct/type is already unique per market
    // (fresh package id), but every market used the same symbol "YES" / name
    // "Yes Token", so Slush showed them all identically. We bake a short, safe
    // slice of the question into the coin's display name (e.g. "YES · Will
    // Arsenal win…"). Symbol stays short; only quotes/backslashes need escaping
    // for the Move byte-string literal.
    let label: String = market_name
        .chars()
        .take(28)
        .collect::<String>()
        .replace('\\', "")
        .replace('"', "");
    let yes_display = format!("YES · {label}");
    let no_display = format!("NO · {label}");

    // 3. Write sources/yes_market.move and no_market.move
    let yes_code = format!(
        r#"module {safe_name}::yes_market {{
    use sui::coin;
    use std::option;

    public struct YES_MARKET has drop {{}}

    #[allow(deprecated_usage)]
    fun init(otw: YES_MARKET, ctx: &mut sui::tx_context::TxContext) {{
        let (treasury, metadata) = coin::create_currency(otw, 9, b"YES", b"{yes_display}", b"", option::none(), ctx);
        sui::transfer::public_freeze_object(metadata);
        sui::transfer::public_transfer(treasury, sui::tx_context::sender(ctx));
    }}
}}
"#
    );
    tfs::write(temp_dir.join("sources").join("yes_market.move"), yes_code).await?;

    let no_code = format!(
        r#"module {safe_name}::no_market {{
    use sui::coin;
    use std::option;

    public struct NO_MARKET has drop {{}}

    #[allow(deprecated_usage)]
    fun init(otw: NO_MARKET, ctx: &mut sui::tx_context::TxContext) {{
        let (treasury, metadata) = coin::create_currency(otw, 9, b"NO", b"{no_display}", b"", option::none(), ctx);
        sui::transfer::public_freeze_object(metadata);
        sui::transfer::public_transfer(treasury, sui::tx_context::sender(ctx));
    }}
}}
"#
    );
    tfs::write(temp_dir.join("sources").join("no_market.move"), no_code).await?;

    compile_dir(&temp_dir).await
}

/// Run `sui move build --dump-bytecode-as-base64` on `temp_dir` via WSL and
/// parse the emitted modules/dependencies.
///
/// The configured / working Sui CLI lives inside WSL (e.g. ~/.local/bin/sui),
/// so we invoke it through `wsl` routed via `bash -lc "..."` (a login shell)
/// so `~/.bashrc` / `~/.profile` is sourced and `~/.local/bin` ends up on PATH
/// — otherwise `wsl --cd <path> sui ...` exits 127 ("sui: command not found").
/// `--cd` accepts a Windows path; WSL translates it to /mnt/c/... for us.
async fn compile_dir(temp_dir: &std::path::Path) -> anyhow::Result<CompileResult> {
    let temp_dir_str = temp_dir.to_string_lossy().to_string();
    let output = tokio::task::spawn_blocking(move || {
        Command::new("wsl")
            .arg("--cd")
            .arg(&temp_dir_str)
            .arg("--")
            .arg("bash")
            .arg("-lc")
            .arg("sui move build --dump-bytecode-as-base64")
            .output()
    })
    .await??;

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let stderr_str = String::from_utf8_lossy(&output.stderr);

    // Write debug output to a log file in the OS temp dir
    let log_path = std::env::temp_dir().join("sui_build_error.log");
    let log_content = format!("STDOUT:\n{}\n\nSTDERR:\n{}", stdout_str, stderr_str);
    let _ = fs::write(&log_path, log_content);

    if !output.status.success() {
        anyhow::bail!(
            "Compilation failed (status {}): check {:?} for details.",
            output.status,
            log_path
        );
    }

    // Extract the JSON object from stdout (may have leading warnings/text)
    let json_start = stdout_str.find('{').unwrap_or(0);
    let json_str = &stdout_str[json_start..];

    let build_output: SuiBuildOutput = serde_json::from_str(json_str)?;

    Ok(CompileResult {
        modules: build_output.modules,
        dependencies: build_output.dependencies,
    })
}
