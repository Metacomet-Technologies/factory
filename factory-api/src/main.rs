use clap::{Parser, Subcommand};
use factory_api::{AppState, alerts, devices, fleet, network, router};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    time::Duration,
};

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long, env = "FACTORY_API_LISTEN", default_value = "127.0.0.1:8080")]
    listen: SocketAddr,
    #[arg(long, env = "FACTORY_API_UPS_ADDR", default_value = "127.0.0.1:3493")]
    ups_addr: String,
    #[arg(long, env = "FACTORY_API_UPS_NAME", default_value = "cyberpower")]
    ups_name: String,
    #[arg(
        long,
        env = "FACTORY_API_METER_URL",
        default_value = "http://127.0.0.1:11434"
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
    #[arg(long, env = "FACTORY_API_OPENROUTER_FEED_URL", default_value = pricing::OPENROUTER_URL, value_parser = pricing::feed_url)]
    openrouter_feed_url: String,
    #[arg(long, env = "FACTORY_API_LITELLM_FEED_URL", default_value = pricing::LITELLM_URL, value_parser = pricing::feed_url)]
    litellm_feed_url: String,
    #[arg(long, env = "FACTORY_API_DISABLE_PRICING_COLLECTOR", value_parser = clap::builder::BoolishValueParser::new(), action = clap::ArgAction::SetTrue)]
    disable_pricing_collector: bool,
    #[arg(long, env = "FACTORY_API_SERVICES_CONFIG")]
    services_config: Option<PathBuf>,
    #[arg(
        long,
        env = "FACTORY_API_USAGE_SNAPSHOT",
        default_value = "/var/lib/factory-usage/usage.json"
    )]
    usage_snapshot: PathBuf,
    #[arg(
        long,
        env = "FACTORY_API_USAGE_TRIGGER",
        default_value = "/var/lib/factory-usage-trigger/request"
    )]
    usage_trigger: PathBuf,
    #[arg(
        long,
        env = "FACTORY_API_STATIC_DIR",
        default_value = "/var/lib/factory-api/kiosk"
    )]
    static_dir: PathBuf,
    #[arg(
        long,
        env = "FACTORY_API_ALERTS_STATE",
        default_value = "/var/lib/factory-api/alerts.json"
    )]
    alerts_state: PathBuf,
    #[arg(long, env = "FACTORY_ALERTS_CHANNEL", default_value = alerts::DEFAULT_CHANNEL)]
    alerts_channel: String,
    #[arg(long, env = "FACTORY_ALERTS_SLACK_URL", default_value = alerts::DEFAULT_SLACK_URL, value_parser = alerts::slack_url)]
    alerts_slack_url: String,
    #[arg(long, env = "FACTORY_API_BACKUP_STATUS", default_value = alerts::DEFAULT_BACKUP_STATUS)]
    backup_status: PathBuf,
    #[arg(long, env = "FACTORY_DEVICES_ROOT", default_value = "/")]
    devices_root: PathBuf,
    #[arg(long, env = "FACTORY_API_REBOOT_STATUS", default_value = devices::DEFAULT_REBOOT_STATUS)]
    reboot_status: PathBuf,
    #[arg(long, env = "FACTORY_API_NETWORK_WAN_TARGETS", value_delimiter = ',', default_value = network::DEFAULT_WAN_TARGETS)]
    network_wan_targets: Vec<IpAddr>,
    #[arg(long, env = "FACTORY_API_NETWORK_DNS_NAME", default_value = network::DEFAULT_DNS_NAME)]
    network_dns_name: String,
    #[arg(long, env = "FACTORY_API_NETWORK_TAILNET_TARGET", default_value = network::DEFAULT_TAILNET_TARGET)]
    network_tailnet_target: String,
    #[arg(long, env = "FACTORY_API_NETWORK_ROUTE_TABLE", default_value = network::DEFAULT_ROUTE_TABLE)]
    network_route_table: PathBuf,
}

#[derive(Subcommand)]
enum Command {
    /// Create an empty pricing v1 database. Never converts a legacy file.
    Migrate {
        #[arg(long)]
        pricing_db: PathBuf,
    },
    /// Post one Slack test alert plus a threaded reply, then exit.
    AlertTest,
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
    let alerts_config = alerts::Config {
        state_path: Some(args.alerts_state.clone()),
        channel: args.alerts_channel.clone(),
        slack_url: args.alerts_slack_url.clone(),
        token: alerts::Token::from_credentials(
            std::env::var_os("CREDENTIALS_DIRECTORY")
                .map(PathBuf::from)
                .as_deref(),
        ),
    };
    if let Some(Command::AlertTest) = args.command {
        let ts = alerts::send_test(&alerts_config).await?;
        println!("posted Slack test alert ts={ts} with a threaded reply");
        return Ok(());
    }
    if let Some(Command::Migrate { pricing_db }) = args.command {
        let report = pricing::migrate(&pricing_db)?;
        let db = rusqlite::Connection::open_with_flags(
            &pricing_db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let tables = db
            .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        println!(
            "pricing user_version={}; tables: {}",
            report.to,
            tables.join(", ")
        );
        return Ok(());
    }
    let network = network::NetworkConfig::new(
        args.network_route_table,
        args.network_wan_targets,
        args.network_dns_name,
        args.network_tailnet_target,
    )?;
    let text = args
        .services_config
        .map(std::fs::read_to_string)
        .transpose()?;
    let mut config = fleet::Config::parse(text.as_deref().unwrap_or(fleet::DEFAULT_CONFIG))?;
    if text.is_none() {
        // Keep the embedded self-check correct when using a temporary listen port.
        for node in &mut config.nodes {
            if node.name == "factory-gpu" {
                for service in &mut node.services {
                    match service.name.as_str() {
                        "factory-api" => {
                            service.target =
                                format!("http://127.0.0.1:{}/v1/health", args.listen.port());
                        }
                        "kiosk-static" => {
                            service.target =
                                format!("http://127.0.0.1:{}/version.json", args.listen.port());
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    tracing::info!(
        openrouter = %pricing::feed_url_for_log(&args.openrouter_feed_url),
        litellm = %pricing::feed_url_for_log(&args.litellm_feed_url),
        collector_disabled = args.disable_pricing_collector,
        "pricing feeds"
    );
    let mut state =
        AppState::new(args.meter_url, args.db_path, args.pricing_db_path, config).await?;
    state.static_dir = args.static_dir;
    state.ups_addr = args.ups_addr;
    state.ups_name = args.ups_name;
    state.usage_snapshot = args.usage_snapshot;
    state.usage_trigger = args.usage_trigger;
    state.pricing_sources = [args.openrouter_feed_url, args.litellm_feed_url];
    state.disable_pricing_collector = args.disable_pricing_collector;
    state.backup_status = args.backup_status;
    state.devices_root = args.devices_root;
    state.reboot_status = args.reboot_status;
    if state.devices_root != std::path::Path::new("/") {
        if state.backup_status == std::path::Path::new(alerts::DEFAULT_BACKUP_STATUS) {
            state.backup_status = state
                .devices_root
                .join("var/lib/factory-backup-status/status.json");
        }
        if state.reboot_status == std::path::Path::new(devices::DEFAULT_REBOOT_STATUS) {
            state.reboot_status = state
                .devices_root
                .join("var/lib/factory-reboot/status.json");
        }
    }
    state.network = network.targets().into();
    if alerts_config.token.is_some() {
        tracing::info!(channel = %alerts_config.channel, "alerts: Slack token loaded; posting enabled");
    } else {
        tracing::info!("alerts: Slack token absent; alerts are evaluated and logged, never posted");
    }
    state.alerts = std::sync::Arc::new(alerts::Alerting::new(alerts_config));
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
