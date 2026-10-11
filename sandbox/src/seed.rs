use meter::db::{Db, Event};
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
    let query = |sql: &str| db.query(sql.into());
    anyhow::ensure!(
        query("SELECT id,record FROM requests LIMIT 1")
            .await
            .map_err(anyhow::Error::msg)?
            .as_array()
            .unwrap()
            .is_empty(),
        "seed requires an empty request database"
    );
    query("BEGIN IMMEDIATE").await.map_err(anyhow::Error::msg)?;
    let gaps = [7, 31, 97].into_iter().filter(|id| *id < rows).count();
    for index in 0..rows + gaps {
        db.send(Event::Request(Box::new(record(
            seed,
            index,
            rows + gaps,
            days,
            end_ms,
        ))));
        if index.is_multiple_of(100) {
            // Meter owns GPU retention; use the same write path, including its pruning.
            let ts = record(seed, index, rows + gaps, days, end_ms).ts;
            db.send(Event::Gpu(vec![GpuSample {
                ts,
                index: 0,
                memory_used_mib: 9255.0,
                memory_total_mib: 12288.0,
                utilization_percent: 65.0,
                temperature_c: 62.0,
                power_w: 135.5,
            }]));
        }
        // Bound the writer queue, and surface write failures before adding more rows.
        if index.is_multiple_of(1000) {
            query("SELECT id,record FROM requests LIMIT 0")
                .await
                .map_err(anyhow::Error::msg)?;
        }
    }
    // Fixture-only deletions create holes; all inserts and schema belong to meter.
    for id in [7, 31, 97].into_iter().filter(|id| *id < rows) {
        db.query(format!(
            "DELETE FROM requests WHERE id = {id} RETURNING id,record"
        ))
        .await
        .map_err(anyhow::Error::msg)?;
    }
    query("COMMIT").await.map_err(anyhow::Error::msg)?;
    Ok(())
}
