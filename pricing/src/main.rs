use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use pricing::{DEFAULT_CONFIG, Store, fetch_from, parse_references};
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
    #[arg(long, env = "PRICING_OPENROUTER_FEED_URL", default_value = pricing::OPENROUTER_URL, value_parser = pricing::feed_url, global = true)]
    openrouter_feed_url: String,
    #[arg(long, env = "PRICING_LITELLM_FEED_URL", default_value = pricing::LITELLM_URL, value_parser = pricing::feed_url, global = true)]
    litellm_feed_url: String,
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
        #[arg(long, conflicts_with = "at_ms")]
        at: Option<String>,
        /// Unix milliseconds, without magnitude-based unit guessing.
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        at_ms: Option<i64>,
    },
}

fn timestamp(text: &str) -> Result<i64> {
    if let Ok(value) = text.parse::<i64>() {
        ensure!(value >= 0, "timestamp must be nonnegative");
        return value.checked_mul(1000).context("timestamp overflow");
    }
    let value = DateTime::parse_from_rfc3339(text)
        .context("expected Unix seconds or RFC3339 timestamp")?
        .timestamp_millis();
    ensure!(value >= 0, "timestamp must be nonnegative");
    Ok(value)
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    eprintln!(
        "pricing feeds: openrouter={} litellm={}",
        pricing::feed_url_for_log(&cli.openrouter_feed_url),
        pricing::feed_url_for_log(&cli.litellm_feed_url)
    );
    let config = cli.config.map(std::fs::read_to_string).transpose()?;
    let references = parse_references(config.as_deref().unwrap_or(DEFAULT_CONFIG))?;
    pricing::verify_path(&cli.db)?;
    let pool = factory_db::Pool::open_sync(
        cli.db,
        factory_db::Config::default(),
        |db, _| Store::from_connection(db),
        Store::connection,
    )?;
    let scope = factory_db::Scope::default();
    let now = Utc::now().timestamp_millis();
    match cli.command {
        Command::Refresh => {
            let (primary, secondary, items) =
                fetch_from(now, &cli.openrouter_feed_url, &cli.litellm_feed_url)?;
            let items = pool.write_sync(&scope, move |store| {
                store.refresh(&references, &primary, &secondary, now, items)
            })?;
            println!("{}", serde_json::to_string_pretty(&items)?);
        }
        Command::Show => {
            let view = pool.read_sync(&scope, move |store| {
                Ok(serde_json::json!({
                    "families": store.show(&references, now)?, "items": store.items()?
                }))
            })?;
            println!("{}", serde_json::to_string_pretty(&view)?);
        }
        Command::Confirm { family } => {
            ensure!(
                references.iter().any(|r| r.name == family),
                "unknown family"
            );
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &pool.write_sync(&scope, move |store| store.confirm(&family, now))?
                )?
            );
        }
        Command::Cost {
            family,
            prompt_tokens,
            output_tokens,
            at,
            at_ms,
        } => {
            let at = at_ms
                .or(at.as_deref().map(timestamp).transpose()?)
                .unwrap_or(now);
            println!(
                "{:.9} USD",
                pool.read_sync(&scope, move |store| store.cost(
                    &family,
                    prompt_tokens,
                    output_tokens,
                    at
                ))?
                .display_usd()
            );
        }
    }
    pool.close_sync()
}
