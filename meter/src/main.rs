use clap::Parser;
use std::{net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(about = "Transparent Ollama metering proxy")]
struct Config {
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "meter=info".into()),
        )
        .init();
    let config = Config::parse();
    let uri: axum::http::Uri = config.upstream.parse()?;
    if uri.scheme_str() != Some("http")
        || uri.authority().is_none()
        || uri.path() != "/"
        || uri.query().is_some()
    {
        return Err("upstream must be an http:// origin without path or query".into());
    }
    let db = meter::db::Db::open(&config.db_path)?;
    let state = meter::AppState::new(config.upstream, db.clone());
    state.start_telemetry(config.gpu_sample_interval);
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
    // The query is a FIFO barrier: completed requests are committed before exit.
    db.query("SELECT id,record FROM requests LIMIT 0".into())
        .await?;
    Ok(())
}
