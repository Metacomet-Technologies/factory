use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use factory_ups_control::{Config, Control, migration_lock, store::Store};
use std::{net::SocketAddr, path::PathBuf, time::Duration};

#[derive(Parser)]
#[command(about = "Allowlisted NUT control; credentials only from systemd LoadCredential")]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8090")]
    listen: SocketAddr,
    #[arg(long, default_value = "127.0.0.1:3493")]
    nut_addr: SocketAddr,
    #[arg(long, default_value = "/var/lib/factory-ups-control/audit.db")]
    db_path: PathBuf,
    #[arg(long, default_value_t = 0)]
    trusted_peer_uid: u32,
    #[arg(
        long,
        default_value = "DGarbs51@github,metacometdave@github",
        value_delimiter = ','
    )]
    allowed_logins: Vec<String>,
    #[arg(long, default_value = "https://slack.com/api/chat.postMessage")]
    slack_url: String,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    Migrate,
    Selftest {
        #[arg(long, required = true)]
        scheduled: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    // No component fingerprint contract: the release identity alone.
    shared::exit_if_build_info("");
    let args = Args::parse();
    if matches!(args.command, Some(Command::Migrate)) {
        let _lock = migration_lock(&args.db_path)?;
        let store = Store::open(args.db_path, true).await?;
        store.0.close().await?;
        return Ok(());
    }
    let _daemon = if args.command.is_none() {
        Some(migration_lock(&args.db_path)?)
    } else {
        None
    };
    let control = Control::open(Config {
        db_path: args.db_path,
        listen: args.listen,
        nut_addr: args.nut_addr,
        trusted_peer_uid: args.trusted_peer_uid,
        allowed_logins: args.allowed_logins,
        hostname: std::fs::read_to_string("/proc/sys/kernel/hostname")?
            .trim()
            .into(),
        boot_id: std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?
            .trim()
            .into(),
        credential_dir: std::env::var_os("CREDENTIALS_DIRECTORY")
            .context("CREDENTIALS_DIRECTORY required")?
            .into(),
        slack_url: args.slack_url,
    })
    .await?;
    if matches!(args.command, Some(Command::Selftest { .. })) {
        let uptime: f64 = std::fs::read_to_string("/proc/uptime")?
            .split_whitespace()
            .next()
            .context("missing uptime")?
            .parse()?;
        let result = control.selftest(uptime).await;
        println!(
            "Scheduled UPS quick test: {}",
            if result.is_ok() {
                "executed (tracking SUCCESS); follow ups.test.result for battery-test completion"
            } else {
                "refused or failed; see audit"
            }
        );
        control.store.0.close().await?;
        result?;
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    let notifications = control.clone();
    tokio::spawn(async move {
        loop {
            if notifications.flush_notifications().await.is_err() {
                eprintln!("audit notification worker failed");
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
    axum::serve(
        listener,
        control
            .router()
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
