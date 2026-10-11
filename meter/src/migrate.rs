//! Offline, new-file conversion. Never open the source for writing.
use crate::storage;
use anyhow::{Context, Result, ensure};
use factory_db::{Category, Scope, Tracked, migrations};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use shared::{GpuSample, RequestRecord};
use std::{collections::BTreeMap, path::Path, time::Instant};

const SQL: &str = include_str!("v1.sql");
// DDL-only capture, 2026-10-11; SHA256 e75e3e70fffa58d15832577345618cdde44e0630bab27af05eed4dbcfd8bf959.
const LEGACY: &str = include_str!("../tests/fixtures/legacy.sql");

pub fn require_v1(db: &Connection) -> Result<()> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(
        version == 1,
        "meter requires user_version=1, found {version}; run meter migrate offline"
    );
    Ok(())
}

pub fn check_legacy(db: &Connection) -> Result<()> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(
        version == 0,
        "legacy user_version must be 0, found {version}"
    );
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(LEGACY)?;
    ensure!(
        migrations::schema_fingerprint(db)? == migrations::schema_fingerprint(&expected)?,
        "legacy schema fingerprint mismatch"
    );
    Ok(())
}

pub fn readonly(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?)
}

/// Offline conversion requires a stopped, checkpointed source. Immutable reads
/// must never hide committed WAL data or create sidecars in the preserved source.
fn immutable(path: &Path) -> Result<Connection> {
    let path = path.canonicalize()?;
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    match std::fs::metadata(&wal) {
        Ok(meta) => ensure!(
            meta.is_file() && meta.len() == 0,
            "legacy WAL is non-empty; stop meter and checkpoint before migration"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    // Encode the entire absolute filename, including ?, #, % and non-UTF8 bytes;
    // none of the filename may become URI parameters.
    let filename: String = path
        .as_os_str()
        .as_encoded_bytes()
        .iter()
        .map(|byte| format!("%{byte:02X}"))
        .collect();
    Ok(Connection::open_with_flags(
        format!("file:{filename}?mode=ro&immutable=1"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )?)
}

#[derive(Default, Serialize)]
pub struct TableReport {
    count: u64,
    id_min: Option<i64>,
    id_max: Option<i64>,
    #[serde(serialize_with = "decimal")]
    id_sum: i128,
    sqlite_sequence: i64,
    ts_min_ms: Option<i64>,
    ts_max_ms: Option<i64>,
    null_counts: BTreeMap<String, u64>,
    token_sums: BTreeMap<String, String>,
}

fn decimal<S: serde::Serializer>(n: &i128, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&n.to_string())
}

impl TableReport {
    fn new(columns: &str) -> Self {
        Self {
            null_counts: columns.split(',').map(|c| (c.into(), 0)).collect(),
            token_sums: ["prompt_eval_count", "eval_count"]
                .into_iter()
                .filter(|c| columns.split(',').any(|column| column == *c))
                .map(|c| (c.into(), "0".into()))
                .collect(),
            ..Default::default()
        }
    }

    fn add(&mut self, id: i64, ts: i64, value: &Value) {
        self.count += 1;
        self.id_min = Some(self.id_min.map_or(id, |v| v.min(id)));
        self.id_max = Some(self.id_max.map_or(id, |v| v.max(id)));
        self.id_sum += i128::from(id);
        self.ts_min_ms = Some(self.ts_min_ms.map_or(ts, |v| v.min(ts)));
        self.ts_max_ms = Some(self.ts_max_ms.map_or(ts, |v| v.max(ts)));
        for (column, count) in &mut self.null_counts {
            let wire = match column.as_str() {
                "ts_ms" => "ts",
                "gpu_index" => "index",
                "usage_json" => "usage",
                name => name.strip_suffix("_ns").unwrap_or(name),
            };
            // IDs come from SQL, not the legacy JSON's placeholder ID.
            *count += u64::from(column != "id" && value[wire].is_null());
        }
        for name in ["prompt_eval_count", "eval_count"] {
            if value.get(name).is_some() {
                let sum = self
                    .token_sums
                    .entry(name.into())
                    .or_insert_with(|| "0".into());
                *sum = (sum.parse::<u128>().unwrap()
                    + u128::from(value[name].as_u64().unwrap_or(0)))
                .to_string();
            }
        }
    }
}

#[derive(Serialize)]
pub struct Report {
    pub requests: TableReport,
    pub gpu_samples: TableReport,
    pub verified_rows: u64,
    pub elapsed_ms: u128,
    pub dry_run: bool,
}

fn strict<T: serde::de::DeserializeOwned + Serialize>(text: &str, allowed: &[&str]) -> Result<T> {
    let value: Value = serde_json::from_str(text).context("invalid JSON")?;
    let object = value.as_object().context("expected JSON object")?;
    let unknown: Vec<_> = object
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .collect();
    ensure!(unknown.is_empty(), "unknown JSON keys: {unknown:?}");
    serde_json::from_value(value).context("invalid typed value or NULL into NOT NULL")
}

fn wire(mut value: Value) -> Value {
    let object = value.as_object_mut().unwrap();
    for key in ["id", "user_key", "actor_kind"] {
        object.remove(key);
    }
    value
}

fn copy(legacy: &Connection, db: &Connection, report: &mut Report) -> Result<()> {
    let mut errors = Vec::new();
    let mut request_rows = legacy.prepare("SELECT id,record FROM requests ORDER BY id")?;
    let mut rows = request_rows.query([])?;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let result = (|| -> Result<()> {
            let text: String = row.get(1)?;
            let old: RequestRecord = strict(
                &text,
                &[
                    "id",
                    "ts",
                    "endpoint",
                    "model",
                    "prompt_eval_count",
                    "eval_count",
                    "load_duration",
                    "prompt_eval_duration",
                    "eval_duration",
                    "total_duration",
                    "usage",
                    "latency_ms",
                    "status",
                    "stream",
                    "error",
                    "client_ip",
                    "client_hostname",
                ],
            )?;
            storage::insert_request(db, Some(id), &old)?;
            let new = db.query_row(
                &format!(
                    "SELECT {} FROM requests WHERE id=?1",
                    storage::REQUEST_COLUMNS
                ),
                [id],
                storage::request,
            )?;
            ensure!(
                wire(serde_json::to_value(&old)?) == wire(serde_json::to_value(&new)?),
                "wire mismatch"
            );
            report
                .requests
                .add(id, old.ts, &serde_json::to_value(&new)?);
            Ok(())
        })();
        if let Err(error) = result {
            errors.push(format!("requests id={id}: {error:#}"));
        }
    }
    let mut gpu_rows = legacy.prepare("SELECT id,ts,sample FROM gpu_samples ORDER BY id")?;
    let mut rows = gpu_rows.query([])?;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let result = (|| -> Result<()> {
            let text: String = row.get(2)?;
            let old: GpuSample = strict(
                &text,
                &[
                    "ts",
                    "index",
                    "memory_used_mib",
                    "memory_total_mib",
                    "utilization_percent",
                    "temperature_c",
                    "power_w",
                ],
            )?;
            ensure!(
                row.get::<_, i64>(1)? == old.ts,
                "GPU SQL ts differs from sample ts"
            );
            storage::insert_gpu(db, Some(id), &old)?;
            let new = db.query_row(
                &format!(
                    "SELECT {} FROM gpu_samples WHERE id=?1",
                    storage::GPU_COLUMNS
                ),
                [id],
                storage::gpu,
            )?;
            ensure!(
                serde_json::to_value(&old)? == serde_json::to_value(&new)?,
                "wire mismatch"
            );
            report
                .gpu_samples
                .add(id, old.ts, &serde_json::to_value(&old)?);
            Ok(())
        })();
        if let Err(error) = result {
            errors.push(format!("gpu_samples id={id}: {error:#}"));
        }
    }
    ensure!(
        errors.is_empty(),
        "conversion refused:\n{}",
        errors.join("\n")
    );
    Ok(())
}

fn empty_target(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => ensure!(
            meta.is_file() && meta.len() == 0,
            "--db exists and is not an empty regular file"
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        ensure!(
            !Path::new(&sidecar).try_exists()?,
            "--db has a sidecar; refuse replacement"
        );
    }
    Ok(())
}

/// The CLI and tests share exactly this runner. No schema creation in runtime opens.
pub fn migrate(legacy: Option<&Path>, destination: Option<&Path>, dry_run: bool) -> Result<Report> {
    let started = Instant::now();
    ensure!(
        dry_run || destination.is_some(),
        "--db is required without --dry-run"
    );
    if let Some(path) = destination {
        empty_target(path)?;
    }
    let mut source = legacy
        .map(|path| {
            if dry_run {
                readonly(path)
            } else {
                immutable(path)
            }
        })
        .transpose()?;
    let source = source.as_mut().map(Connection::transaction).transpose()?;
    if let Some(source) = &source {
        check_legacy(source)?;
    }
    let parent = destination
        .and_then(Path::parent)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut db = Tracked::new(Connection::open(temporary.path())?, |c| c)?;
    let scope = Scope::default();
    let mut report = Report {
        requests: TableReport::new(storage::REQUEST_COLUMNS),
        gpu_samples: TableReport::new(storage::GPU_COLUMNS),
        verified_rows: 0,
        elapsed_ms: 0,
        dry_run,
    };
    db.run(&scope, Category::Setup, |db| {
        factory_db::settings::apply(db, false, 65_536)
    })?;
    db.run(&scope, Category::Setup, |db| migrations::run(db, &[migrations::Migration { version: 1, sql: SQL, checksum: 0x963424d2b374d530 }], None,
        |_, _| Ok(()), |db, _| {
            if let Some(source) = &source { copy(source, db, &mut report)?; }
            for (table, stats) in [("requests", &mut report.requests), ("gpu_samples", &mut report.gpu_samples)] {
                // Also create an explicit zero high-water mark for empty tables.
                db.execute("INSERT INTO sqlite_sequence(name,seq) SELECT ?1,0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name=?1)", [table])?;
                stats.sqlite_sequence = db.query_row("SELECT seq FROM sqlite_sequence WHERE name=?1", [table], |r| r.get(0))?;
                ensure!(stats.sqlite_sequence >= stats.id_max.unwrap_or(0), "{table}: sequence below maximum ID");
                let count: i64 = db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
                ensure!(u64::try_from(count)? == stats.count, "{table}: count mismatch");
            }
            Ok(())
        }))?;
    drop(db); // Close/checkpoint WAL before publishing the single new file.
    temporary.as_file().sync_all()?;
    if !dry_run {
        let path = destination.unwrap();
        empty_target(path)?;
        if path.exists() {
            temporary.persist(path).map_err(|e| e.error)?;
        } else {
            temporary.persist_noclobber(path).map_err(|e| e.error)?;
        }
    }
    report.verified_rows = report.requests.count + report.gpu_samples.count;
    report.elapsed_ms = started.elapsed().as_millis();
    Ok(report)
}
