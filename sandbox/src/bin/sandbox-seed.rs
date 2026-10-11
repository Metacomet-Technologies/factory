use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    db_path: PathBuf,
    /// Create the captured v0 fixture for an explicit meter conversion.
    #[arg(long)]
    legacy: bool,
    #[arg(long, requires = "legacy")]
    bad_row: bool,
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
    if args.legacy {
        sandbox::seed::legacy(
            &args.db_path,
            args.seed,
            args.rows,
            args.days,
            args.end_ms,
            args.bad_row,
        )?;
    } else {
        anyhow::ensure!(!args.db_path.try_exists()?, "seed requires a new path");
        let meter = std::env::current_exe()?.with_file_name("meter");
        anyhow::ensure!(
            tokio::process::Command::new(meter)
                .arg("migrate")
                .arg("--db")
                .arg(&args.db_path)
                .status()
                .await?
                .success(),
            "meter initialization failed"
        );
        let path = args.db_path.clone();
        let db = tokio::task::spawn_blocking(move || meter::db::Db::open(&path)).await??;
        sandbox::seed::seed(&db, args.seed, args.rows, args.days, args.end_ms).await?;
        db.close().await?;
    }
    println!(
        "seeded {} requests; seed={}, days={}, end_ms={}",
        args.rows, args.seed, args.days, args.end_ms
    );
    Ok(())
}
