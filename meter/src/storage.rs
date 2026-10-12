//! Typed storage and wire reconstruction shared by runtime and offline conversion.
use anyhow::{Result, ensure};
use rusqlite::{Connection, Row, params};
use shared::{GpuSample, RequestRecord};

pub const REQUEST_COLUMNS: &str = "id,ts_ms,endpoint,model,prompt_eval_count,eval_count,load_duration_ns,prompt_eval_duration_ns,eval_duration_ns,total_duration_ns,usage_json,latency_ms,status,stream,error,client_ip,client_hostname,user_key,actor_kind";
pub const GPU_COLUMNS: &str =
    "id,ts_ms,gpu_index,memory_used_mib,memory_total_mib,utilization_percent,temperature_c,power_w";

pub fn insert_request(db: &Connection, id: Option<i64>, r: &RequestRecord) -> Result<()> {
    ensure!(r.latency_ms.is_finite(), "nonfinite latency_ms");
    let integer = |value: Option<u64>| -> Result<Option<i64>> {
        value.map(i64::try_from).transpose().map_err(Into::into)
    };
    db.prepare_cached(&format!("INSERT INTO requests({REQUEST_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)"))?
        .execute(params![id,r.ts,r.endpoint,r.model,integer(r.prompt_eval_count)?,integer(r.eval_count)?,
            integer(r.load_duration)?,integer(r.prompt_eval_duration)?,integer(r.eval_duration)?,integer(r.total_duration)?,
            r.usage.as_ref().map(serde_json::to_string).transpose()?,r.latency_ms,r.status,r.stream,r.error,
            r.client_ip,r.client_hostname,r.user_key,r.actor_kind.as_deref().unwrap_or("unattributed")])?;
    Ok(())
}

pub fn request(row: &Row<'_>) -> rusqlite::Result<RequestRecord> {
    let usage: Option<String> = row.get(10)?;
    let usage = usage
        .map(|s| {
            serde_json::from_str(&s).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    10,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })
        .transpose()?;
    let unsigned = |column| -> rusqlite::Result<Option<u64>> {
        row.get::<_, Option<i64>>(column)?
            .map(|v| {
                u64::try_from(v).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, v))
            })
            .transpose()
    };
    Ok(RequestRecord {
        id: row.get(0)?,
        ts: row.get(1)?,
        endpoint: row.get(2)?,
        model: row.get(3)?,
        prompt_eval_count: unsigned(4)?,
        eval_count: unsigned(5)?,
        load_duration: unsigned(6)?,
        prompt_eval_duration: unsigned(7)?,
        eval_duration: unsigned(8)?,
        total_duration: unsigned(9)?,
        usage,
        latency_ms: row.get(11)?,
        status: row.get(12)?,
        stream: row.get(13)?,
        error: row.get(14)?,
        client_ip: row.get(15)?,
        client_hostname: row.get(16)?,
        user_key: row.get(17)?,
        actor_kind: row.get(18)?,
    })
}

pub fn insert_gpu(db: &Connection, id: Option<i64>, s: &GpuSample) -> Result<()> {
    ensure!(
        [
            s.memory_used_mib,
            s.memory_total_mib,
            s.utilization_percent,
            s.temperature_c,
            s.power_w
        ]
        .iter()
        .all(|v| v.is_finite()),
        "nonfinite GPU value"
    );
    db.prepare_cached(&format!(
        "INSERT INTO gpu_samples({GPU_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
    ))?
    .execute(params![
        id,
        s.ts,
        s.index,
        s.memory_used_mib,
        s.memory_total_mib,
        s.utilization_percent,
        s.temperature_c,
        s.power_w
    ])?;
    Ok(())
}

pub fn gpu(row: &Row<'_>) -> rusqlite::Result<GpuSample> {
    Ok(GpuSample {
        ts: row.get(1)?,
        index: row.get(2)?,
        memory_used_mib: row.get(3)?,
        memory_total_mib: row.get(4)?,
        utilization_percent: row.get(5)?,
        temperature_c: row.get(6)?,
        power_w: row.get(7)?,
    })
}
