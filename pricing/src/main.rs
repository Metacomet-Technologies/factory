use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use pricing::{DEFAULT_CONFIG, Store, parse_references, refresh_live};
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Reference model pricing for local-token spend avoided")]
struct Cli {
    #[arg(
        long,
        env = "PRICING_DB",
        default_value = "./pricing.db",
        global = true
    )]
    db: PathBuf,
    /// Use another reference TOML; defaults to the bundled references.toml.
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Refresh,
    Show,
    Confirm {
        family: String,
    },
    Cost {
        family: String,
        prompt_tokens: u64,
        output_tokens: u64,
        /// Unix seconds or RFC3339 with an explicit timezone.
        #[arg(long)]
        at: Option<String>,
    },
}

fn timestamp(text: &str) -> Result<i64> {
    if let Ok(value) = text.parse::<i64>() {
        ensure!(value >= 0, "timestamp must be nonnegative");
        return Ok(value);
    }
    let value = DateTime::parse_from_rfc3339(text)
        .context("expected Unix seconds or RFC3339 timestamp")?
        .timestamp();
    ensure!(value >= 0, "timestamp must be nonnegative");
    Ok(value)
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let config = cli.config.map(std::fs::read_to_string).transpose()?;
    let references = parse_references(config.as_deref().unwrap_or(DEFAULT_CONFIG))?;
    let mut store = Store::open(&cli.db)?;
    let now = Utc::now().timestamp();
    match cli.command {
        Command::Refresh => {
            let items = refresh_live(&mut store, &references, now)?;
            println!("{}", serde_json::to_string_pretty(&items)?);
        }
        Command::Show => {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "families": store.show(&references, now)?, "items": store.items()?
                }))?
            );
        }
        Command::Confirm { family } => {
            ensure!(
                references.iter().any(|r| r.name == family),
                "unknown family"
            );
            println!(
                "{}",
                serde_json::to_string_pretty(&store.confirm(&family, now)?)?
            );
        }
        Command::Cost {
            family,
            prompt_tokens,
            output_tokens,
            at,
        } => {
            let at = at.as_deref().map(timestamp).transpose()?.unwrap_or(now);
            println!(
                "{:.9} USD",
                store.cost(&family, prompt_tokens, output_tokens, at)?
            );
        }
    }
    Ok(())
}
