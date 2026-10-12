use clap::{Parser, Subcommand};
use std::{net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(version, about = "Transparent Ollama metering proxy")]
struct Config {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long, env = "METER_LISTEN", default_value = "0.0.0.0:11434")]
    listen: SocketAddr,
    #[arg(long, env = "METER_UPSTREAM", default_value = "http://127.0.0.1:11435")]
    upstream: String,
    #[arg(
        long,
        env = "METER_DB_PATH",
        default_value = "/srv/factory/meter/meter.db"
    )]
    db_path: PathBuf,
    #[arg(long, env = "METER_GPU_SAMPLE_INTERVAL", default_value = "15", value_parser = clap::value_parser!(u64).range(1..))]
    gpu_sample_interval: u64,
}

#[derive(Subcommand)]
enum Command {
    /// Initialize a database or convert a stopped, checkpointed legacy file offline.
    Migrate {
        #[arg(long)]
        legacy: Option<PathBuf>,
        #[arg(long)]
        db: Option<PathBuf>,
        /// Validate with WAL-aware reads as the DB owner; discard temporary output.
        #[arg(long, conflicts_with = "check_only")]
        dry_run: bool,
        /// WAL-aware schema/version preflight as the DB owner. Copies no rows.
        #[arg(long, requires = "legacy", conflicts_with = "db")]
        check_only: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "meter=info".into()),
        )
        .init();
    let config = Config::parse();
    if let Some(Command::Migrate {
        legacy,
        db,
        dry_run,
        check_only,
    }) = config.command
    {
        return tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            if check_only {
                meter::migrate::check_legacy(&meter::migrate::readonly(
                    legacy.as_deref().unwrap(),
                )?)?;
                println!("legacy user_version=0; captured schema fingerprint verified");
            } else {
                let report = meter::migrate::migrate(legacy.as_deref(), db.as_deref(), dry_run)?;
                println!("{}", serde_json::to_string_pretty(&report)?);
            }
            Ok(())
        })
        .await?;
    }
    let uri: axum::http::Uri = config.upstream.parse()?;
    if uri.scheme_str() != Some("http")
        || uri.authority().is_none()
        || uri.path() != "/"
        || uri.query().is_some()
    {
        anyhow::bail!("upstream must be an http:// origin without path or query");
    }
    let shutdown_path = config.db_path.clone();
    let db = tokio::task::spawn_blocking(move || meter::db::Db::open(&config.db_path)).await??;
    let state = meter::AppState::new(config.upstream, db.clone());
    let telemetry = state.start_telemetry(config.gpu_sample_interval);
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(listen = %listener.local_addr()?, "meter listening");
    axum::serve(
        listener,
        meter::router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    })
    .await?;
    telemetry.abort();
    let _ = telemetry.await;
    db.close().await?;
    // Pool closes can finish with a read-only connection, which cannot perform
    // SQLite's last-connection checkpoint. All admitted writes are drained now.
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = rusqlite::Connection::open_with_flags(
            shutdown_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
        )?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        let (busy, frames, checkpointed): (i64, i64, i64) =
            db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
        anyhow::ensure!(
            busy == 0 && frames == checkpointed,
            "shutdown checkpoint incomplete: {busy}|{frames}|{checkpointed}"
        );
        Ok(())
    })
    .await??;
    Ok(())
}
