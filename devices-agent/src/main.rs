use anyhow::{Context, Result};
use clap::Parser;
use factory_devices_agent::{
    BUFFER_CAP, Collector, Sources, Timing, Token, Uploader, capabilities, locally_valid,
    new_session_id, now_ms, run,
};
use std::{io::IsTerminal, path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;
use tracing::info;

/// Read-only telemetry agent for factory-console (docs/devices-ingest.md).
#[derive(Parser)]
#[command(version)]
struct Args {
    /// factory-api base URL, for example https://factory-gpu.bearded-pompano.ts.net
    #[arg(long, required_unless_present = "discover")]
    api: Option<String>,
    /// Filesystem root for /proc, /sys and published status files (fixtures only).
    #[arg(long, default_value = "/")]
    root: PathBuf,
    /// Print this host's capability table from two samples and exit. No token, no upload.
    #[arg(long)]
    discover: bool,
}

/// The token comes only from systemd `LoadCredential=token:...`.
fn load_token() -> Result<Token> {
    let directory = std::env::var_os("CREDENTIALS_DIRECTORY").context(
        "CREDENTIALS_DIRECTORY is not set; run under systemd with LoadCredential=token:",
    )?;
    let text = std::fs::read_to_string(PathBuf::from(directory).join("token"))
        .context("credential `token` is not readable")?;
    Token::parse(&text).context("credential `token` is not an fdv1_ token")
}

fn discover(root: PathBuf) -> Result<()> {
    let mut collector = Collector::new(Sources::host(root), new_session_id()?);
    collector.sample(now_ms());
    std::thread::sleep(Duration::from_secs(1));
    let mut sample = collector.sample(now_ms());
    println!("source\tavailability\tdetail");
    for (path, availability, detail) in capabilities(&mut sample) {
        println!("{path}\t{availability:?}\t{}", detail.unwrap_or_default());
    }
    match locally_valid(&sample) {
        Ok(()) => println!("contract\tvalid\t"),
        Err((code, field)) => println!("contract\t{code}\t{}", field.unwrap_or_default()),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_ansi(std::io::stderr().is_terminal())
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "factory_devices_agent=info".into()),
        )
        .init();
    let args = Args::parse();
    if args.discover {
        return tokio::task::spawn_blocking(move || discover(args.root)).await?;
    }
    let api = args.api.expect("clap requires --api");
    let uploader = Uploader::new(&api, load_token()?, Timing::default())?;
    let collector = Collector::new(Sources::host(args.root), new_session_id()?);
    let shutdown = CancellationToken::new();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let signal = shutdown.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = terminate.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
        signal.cancel();
    });
    let summary = run(collector, uploader, BUFFER_CAP, shutdown).await;
    info!(
        sampled = summary.sampled,
        accepted = summary.accepted,
        rejected = summary.rejected,
        evicted = summary.evicted,
        discarded = summary.discarded_on_exit,
        "agent stopped; buffered samples are not kept across restarts"
    );
    anyhow::ensure!(!summary.collector_failed, "collector failed");
    Ok(())
}
