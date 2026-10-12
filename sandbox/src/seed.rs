use meter::db::Db;
use shared::{GpuSample, RequestRecord};

pub fn record(seed: u64, index: usize, rows: usize, days: u32, end_ms: i64) -> RequestRecord {
    let hash = crate::fingerprint(seed, &(index as u64).to_le_bytes());
    // Groups of 20 in a 100 ms burst, separated by quiet periods across the window.
    let groups = rows.div_ceil(20).max(1) as i64;
    let ts = end_ms - i64::from(days) * 86_400_000
        + (index / 20) as i64 * (i64::from(days) * 86_400_000 / groups)
        + (index % 20) as i64 * 5;
    let endpoint = [
        "/api/chat",
        "/api/generate",
        "/v1/chat/completions",
        "/api/version",
    ][index % 4];
    let missing = index.is_multiple_of(11) || endpoint == "/api/version";
    let error = if index.is_multiple_of(29) {
        Some("synthetic HTTP 500")
    } else if index.is_multiple_of(17) {
        Some("response stream interrupted")
    } else {
        None
    };
    let prompt = 20 + hash % 2000;
    let output = 8 + (hash >> 8) % 200;
    RequestRecord {
        ts,
        endpoint: endpoint.into(),
        model: (endpoint != "/api/version").then(|| crate::MODELS[index % 3].into()),
        prompt_eval_count: (!missing).then_some(prompt),
        eval_count: (!missing).then_some(output),
        load_duration: (!missing).then_some(10_000_000),
        prompt_eval_duration: (!missing).then_some(prompt * 1_000_000),
        eval_duration: (!missing).then_some(output * 20_000_000),
        total_duration: (!missing).then_some(10_000_000 + prompt * 1_000_000 + output * 20_000_000),
        latency_ms: 10.0 + prompt as f64 + output as f64 * 20.0,
        status: if index.is_multiple_of(29) { 500 } else { 200 },
        stream: !index.is_multiple_of(3),
        error: error.map(str::to_owned),
        client_ip: format!("192.0.2.{}", 1 + index % 2),
        client_hostname: ["dgarbs51-synthetic", "david-synthetic"][index % 2].into(),
        ..Default::default()
    }
}

pub async fn seed(db: &Db, seed: u64, rows: usize, days: u32, end_ms: i64) -> anyhow::Result<()> {
    anyhow::ensure!((1..=1_000_000).contains(&rows), "rows must be 1..1000000");
    anyhow::ensure!((1..=365).contains(&days), "days must be 1..365");
    anyhow::ensure!(
        (31_536_000_000..=4_102_444_800_000).contains(&end_ms),
        "end-ms out of range"
    );
    anyhow::ensure!(
        db.requests(1, None).await?.is_empty(),
        "seed requires an empty request database"
    );
    let gaps = [7, 31, 97].into_iter().filter(|id| *id < rows).count();
    let mut requests = Vec::new();
    let mut samples = Vec::new();
    for index in 0..rows + gaps {
        let mut row = record(seed, index, rows + gaps, days, end_ms);
        row.id = index as i64 + 1;
        if ![7, 31, 97]
            .into_iter()
            .filter(|id| *id < rows)
            .any(|id| id as i64 == row.id)
        {
            requests.push(row);
        }
        if index.is_multiple_of(100) {
            // Meter owns GPU retention; use the same write path, including its pruning.
            let ts = record(seed, index, rows + gaps, days, end_ms).ts;
            samples.push(GpuSample {
                ts,
                index: 0,
                memory_used_mib: 9255.0,
                memory_total_mib: 12288.0,
                utilization_percent: 65.0,
                temperature_c: 62.0,
                power_w: 135.5,
            });
        }
    }
    db.import(requests, samples).await?;
    Ok(())
}

/// Fixture-only v0 creation from the audited DDL, never a meter runtime path.
pub fn legacy(
    path: &std::path::Path,
    seed: u64,
    rows: usize,
    days: u32,
    end_ms: i64,
    bad: bool,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        (1..=1_000_000).contains(&rows) && (1..=365).contains(&days),
        "invalid fixture size"
    );
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let mut db = meter::db::Connection::open(path)?;
    db.execute_batch(include_str!("../../meter/tests/fixtures/legacy.sql"))?;
    let tx = db.transaction()?;
    let gaps = [7, 31, 97].into_iter().filter(|id| *id < rows).count();
    for index in 0..rows + gaps {
        let id = index as i64 + 1;
        let r = record(seed, index, rows + gaps, days, end_ms);
        if ![7, 31, 97]
            .into_iter()
            .filter(|gap| *gap < rows)
            .any(|gap| gap as i64 == id)
        {
            let mut value = serde_json::to_value(&r)?;
            if bad && index == 0 {
                value["unknown_field"] = true.into();
            }
            tx.execute(
                "INSERT INTO requests(id,record) VALUES (?1,?2)",
                (id, value.to_string()),
            )?;
        }
        if index.is_multiple_of(100) && r.ts >= meter::now_ms() - 7 * 86_400_000 {
            let sample = GpuSample {
                ts: r.ts,
                index: 0,
                memory_used_mib: 9255.0,
                memory_total_mib: 12288.0,
                utilization_percent: 65.0,
                temperature_c: 62.0,
                power_w: 135.5,
            };
            tx.execute(
                "INSERT INTO gpu_samples(id,ts,sample) VALUES (?1,?2,?3)",
                (id, r.ts, serde_json::to_string(&sample)?),
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}
