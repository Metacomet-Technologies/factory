use crate::{AppState, db::Event, now_ms};
use serde_json::Value;
use shared::GpuSample;
use std::collections::HashMap;
use tokio::process::Command;

pub async fn gpu() -> Result<Vec<GpuSample>, String> {
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), Command::new("nvidia-smi")
        .args(["--query-gpu=index,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw", "--format=csv,noheader,nounits"])
        .kill_on_drop(true).output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| {
            let numbers = line
                .split(',')
                .map(|s| s.trim().parse::<f64>().map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, _>>()?;
            if numbers.len() != 6 {
                return Err("unexpected nvidia-smi output".into());
            }
            Ok(GpuSample {
                ts: now_ms(),
                index: numbers[0] as u32,
                memory_used_mib: numbers[1],
                memory_total_mib: numbers[2],
                utilization_percent: numbers[3],
                temperature_c: numbers[4],
                power_w: numbers[5],
            })
        })
        .collect()
}

pub async fn refresh_hosts(state: &AppState) -> Result<(), String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        Command::new("tailscale")
            .args(["status", "--json"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let mut hosts = HashMap::new();
    for peer in value["Peer"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.values())
        .chain(std::iter::once(&value["Self"]))
    {
        if let (Some(name), Some(ips)) =
            (peer["HostName"].as_str(), peer["TailscaleIPs"].as_array())
        {
            for ip in ips.iter().filter_map(Value::as_str) {
                hosts.insert(ip.to_owned(), name.to_owned());
            }
        }
    }
    *state.hosts.write().unwrap() = hosts;
    Ok(())
}

pub fn start(state: AppState, seconds: u64) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut samples = tokio::time::interval(std::time::Duration::from_secs(seconds));
        let mut hosts = tokio::time::interval(std::time::Duration::from_secs(300));
        let mut maintenance = tokio::time::interval(std::time::Duration::from_secs(300));
        let mut optimized = std::time::Instant::now();
        loop {
            tokio::select! {
                _ = samples.tick() => match gpu().await {
                    Ok(samples) => state.db.send(Event::Gpu(samples)),
                    Err(error) => {
                        tracing::warn!(%error, "GPU sampling failed");
                        state.db.send(Event::Gpu(Vec::new()));
                    },
                },
                _ = hosts.tick() => if let Err(error) = refresh_hosts(&state).await { tracing::warn!(%error, "Tailscale refresh failed"); },
                _ = maintenance.tick() => {
                    // Startup catch-up (first tick is immediate), then every five minutes.
                    let _ = state.db.rollups().await;
                    let optimize = optimized.elapsed().as_secs() >= 86_400;
                    match state.db.maintain(optimize).await {
                        Ok(()) if optimize => optimized = std::time::Instant::now(),
                        Ok(()) => (),
                        Err(error) => tracing::warn!(%error, "SQLite maintenance failed"),
                    }
                }
            }
        }
    })
}
