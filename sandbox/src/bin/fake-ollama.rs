use clap::Parser;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    port: u16,
    #[arg(long, default_value_t = 42)]
    seed: u64,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, args.port)).await?;
    axum::serve(listener, sandbox::fake::router(args.seed)).await?;
    Ok(())
}
