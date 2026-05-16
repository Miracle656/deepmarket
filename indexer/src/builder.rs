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

    // 3. Write sources/yes_market.move and no_market.move
    let yes_code = format!(
        r#"module {safe_name}::yes_market {{
    use sui::coin;
    use std::option;

    public struct YES_MARKET has drop {{}}

    #[allow(deprecated_usage)]
    fun init(otw: YES_MARKET, ctx: &mut sui::tx_context::TxContext) {{
        let (treasury, metadata) = coin::create_currency(otw, 9, b"YES", b"Yes Token", b"", option::none(), ctx);
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
        let (treasury, metadata) = coin::create_currency(otw, 9, b"NO", b"No Token", b"", option::none(), ctx);
        sui::transfer::public_freeze_object(metadata);
        sui::transfer::public_transfer(treasury, sui::tx_context::sender(ctx));
    }}
}}
"#
    );
    tfs::write(temp_dir.join("sources").join("no_market.move"), no_code).await?;

    // 4. Run `sui move build --dump-bytecode-as-base64` via WSL
    let temp_dir_str = temp_dir.to_string_lossy().to_string();
    let output = tokio::task::spawn_blocking(move || {
        Command::new("wsl")
            .arg("--cd")
            .arg(&temp_dir_str)
            .arg("sui")
            .arg("move")
            .arg("build")
            .arg("--dump-bytecode-as-base64")
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
