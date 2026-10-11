use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    db_path: PathBuf,
    #[arg(long, default_value_t = 42)]
    seed: u64,
    #[arg(long, default_value_t = 100_000)]
    rows: usize,
    #[arg(long, default_value_t = 30)]
    days: u32,
    /// Fixed default for byte-identical fixtures; launcher supplies today's UTC midnight.
    #[arg(long, default_value_t = 1_791_676_800_000)]
    end_ms: i64,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    // Refuse existing files, including symlinks, rather than risking a live database.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args.db_path)?;
    let db = meter::db::Db::open(&args.db_path)?;
    sandbox::seed::seed(&db, args.seed, args.rows, args.days, args.end_ms).await?;
    println!(
        "seeded {} requests; seed={}, days={}, end_ms={}",
        args.rows, args.seed, args.days, args.end_ms
    );
    Ok(())
}
