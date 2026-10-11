use clap::Parser;
use factory_api::{AppState, fleet, router};
use std::{net::SocketAddr, path::PathBuf};

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
    let state = AppState::new(args.meter_url, args.db_path, args.pricing_db_path, config).await?;
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    let tasks = state.start_collectors();
    tracing::info!(listen=%args.listen, "factory-api listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => (), _ = terminate.recv() => () }
        })
        .await?;
    for task in tasks {
        task.abort();
    }
    Ok(())
}
