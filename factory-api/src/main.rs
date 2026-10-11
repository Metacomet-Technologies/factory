use clap::Parser;
use factory_api::{AppState, fleet, router};
use std::{net::SocketAddr, path::PathBuf, time::Duration};

#[derive(Parser)]
struct Args {
    #[arg(long, env = "FACTORY_API_LISTEN", default_value = "0.0.0.0:8080")]
    listen: SocketAddr,
    #[arg(
        long,
        env = "FACTORY_API_METER_URL",
        default_value = "http://factory-gpu:11434"
    )]
    meter_url: String,
    #[arg(
        long,
        env = "FACTORY_API_DB_PATH",
        default_value = "/var/lib/factory-api/requests.db"
    )]
    db_path: PathBuf,
    #[arg(
        long,
        env = "FACTORY_API_PRICING_DB_PATH",
        default_value = "/var/lib/factory-api/pricing.db"
    )]
    pricing_db_path: PathBuf,
    #[arg(long, env = "FACTORY_API_SERVICES_CONFIG")]
    services_config: Option<PathBuf>,
    #[arg(
        long,
        env = "FACTORY_API_STATIC_DIR",
        default_value = "/var/lib/factory-api/kiosk"
    )]
    static_dir: PathBuf,
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "factory_api=info".into()),
        )
        .init();
    let args = Args::parse();
    let text = args
        .services_config
        .map(std::fs::read_to_string)
        .transpose()?;
    let mut config = fleet::Config::parse(text.as_deref().unwrap_or(fleet::DEFAULT_CONFIG))?;
    if text.is_none() {
        // Keep the embedded self-check correct when using a temporary listen port.
        for node in &mut config.nodes {
            if node.name == "factory-console" {
                for service in &mut node.services {
                    if service.name == "factory-api" {
                        service.target =
                            format!("http://127.0.0.1:{}/v1/health", args.listen.port());
                    }
                }
            }
        }
    }
    let mut state =
        AppState::new(args.meter_url, args.db_path, args.pricing_db_path, config).await?;
    state.static_dir = args.static_dir;
    state.check_clock().await;
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    let tasks = state.start_collectors();
    tracing::info!(listen=%args.listen, "factory-api listening");
    let shutdown = state.shutdown.clone();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let server = axum::serve(listener, router(state.clone()))
        .with_graceful_shutdown(shutdown.clone().cancelled_owned());
    let server = std::future::IntoFuture::into_future(server);
    tokio::pin!(server);
    let finished = tokio::select! {
        result = &mut server => { result?; true }
        _ = tokio::signal::ctrl_c() => false,
        _ = terminate.recv() => false,
    };
    shutdown.cancel();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(4900);
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    if !finished
        && tokio::time::timeout(Duration::from_secs(4), &mut server)
            .await
            .is_err()
    {
        tracing::warn!("HTTP drain deadline reached");
    }
    tokio::time::timeout_at(deadline, state.db.close()).await??;
    tracing::info!("database pool closed; shutdown complete");
    Ok(())
}
