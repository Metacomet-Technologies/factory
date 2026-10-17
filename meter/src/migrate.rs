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
const SQL_V2: &str = include_str!("v2.sql");
pub const VERSION: i64 = 2;

fn manifest() -> [migrations::Migration<'static>; 2] {
    [
        migrations::Migration {
            version: 1,
            sql: SQL,
            checksum: 0x963424d2b374d530,
        },
        migrations::Migration {
            version: 2,
            sql: SQL_V2,
            checksum: 0xdefc08deaf53df27,
        },
    ]
}
// DDL-only capture, 2026-10-11; SHA256 e75e3e70fffa58d15832577345618cdde44e0630bab27af05eed4dbcfd8bf959.
const LEGACY: &str = include_str!("../tests/fixtures/legacy.sql");

pub fn require_current(db: &Connection) -> Result<()> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(
        version == VERSION,
        "meter requires user_version={VERSION}, found {version}; stop meter, take a verified backup, then run meter migrate --db <path> offline"
    );
    Ok(())
}

/// Read-only preflight of an existing typed database: v1 (to upgrade) or v2,
/// with exactly the schema this binary's migrations produce.
pub fn check_current(db: &Connection) -> Result<i64> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(
        version == 1 || version == VERSION,
        "typed meter user_version must be 1 or {VERSION}, found {version}"
    );
    let mut expected = Connection::open_in_memory()?;
    let manifest = manifest();
    migrations::run(
        &mut expected,
        &manifest[..version as usize],
        None,
        |_, _| Ok(()),
        |_, _| Ok(()),
    )?;
    // Daily PRAGMA optimize may already have created sqlite_stat1.
    if db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='sqlite_stat1')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        expected.execute_batch("ANALYZE")?;
    }
    ensure!(
        migrations::schema_fingerprint(db)? == migrations::schema_fingerprint(&expected)?,
        "meter v{version} schema fingerprint mismatch"
    );
    Ok(version)
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

/// Backfill result: every rollup table's row count and the aggregate-versus-raw
/// comparison that published the verified state.
#[derive(Serialize)]
pub struct RollupReport {
    pub batches: usize,
    pub rows: usize,
    pub elapsed_ms: u128,
    pub requests_last_id: i64,
    pub gpu_last_id: i64,
    pub tables: BTreeMap<String, i64>,
    pub raw_requests: i64,
    pub dimension_keys: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub input_known: i64,
    pub output_known: i64,
    pub gpu_samples: usize,
}

const TABLES: [&str; 9] = [
    "requests",
    "gpu_samples",
    "drop_episodes",
    "request_hourly",
    "request_daily",
    "request_latency_hourly",
    "request_latency_daily",
    "gpu_hourly",
    "rollup_state",
];

fn counts(db: &Connection, tables: &[&str]) -> Result<BTreeMap<String, i64>> {
    tables
        .iter()
        .map(|t| {
            Ok((
                (*t).into(),
                db.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))?,
            ))
        })
        .collect()
}

/// Resumable batched backfill to completion, then a repeat comparison for the
/// report. Each batch commits its aggregates and checkpoint together.
pub fn backfill(db: &mut Connection) -> Result<RollupReport> {
    let started = Instant::now();
    let (mut batches, mut rows) = (0, 0);
    loop {
        let progress = crate::rollup::run(db, crate::now_ms(), crate::rollup::BATCHES_PER_RUN)?;
        batches += progress.batches;
        rows += progress.rows;
        if progress.caught_up && progress.verified {
            break;
        }
    }
    let state = |job| -> Result<i64> {
        Ok(factory_db::rollup::state(db, job)?
            .context("rollup state missing")?
            .last_id)
    };
    let (requests_last_id, gpu_last_id) = (state("requests")?, state("gpu")?);
    let tx = db.transaction()?;
    let verified = factory_db::rollup::verify(&tx, requests_last_id, crate::rollup::TPS)?;
    let gpu_samples = crate::rollup::verify_gpu(&tx, gpu_last_id)?;
    let tables = counts(&tx, &TABLES)?;
    drop(tx);
    Ok(RollupReport {
        batches,
        rows,
        elapsed_ms: started.elapsed().as_millis(),
        requests_last_id,
        gpu_last_id,
        tables,
        raw_requests: verified.raw_requests,
        dimension_keys: verified.dimension_keys,
        input_tokens: verified.input_tokens,
        output_tokens: verified.output_tokens,
        input_known: verified.input_known,
        output_known: verified.output_known,
        gpu_samples,
    })
}

#[derive(Serialize)]
pub struct UpgradeReport {
    pub from: u32,
    pub to: u32,
    pub before: BTreeMap<String, i64>,
    pub after: BTreeMap<String, i64>,
    pub rollups: RollupReport,
}

/// In-place v1 -> v2 upgrade of a stopped, checkpointed, backed-up database.
/// Adds tables only; the file is never replaced and no existing row changes.
/// A rerun on v2 resumes the backfill without schema changes.
pub fn upgrade(path: &Path) -> Result<UpgradeReport> {
    let meta = std::fs::symlink_metadata(path)?;
    ensure!(
        meta.is_file() && meta.len() > 0,
        "--db must be an existing meter database"
    );
    check_current(&readonly(path)?)?;
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    factory_db::settings::apply(&db, false, 65_536)?;
    let before = counts(&db, &TABLES[..3])?;
    let report = migrations::run(
        &mut db,
        &manifest(),
        None,
        |_, _| Ok(()),
        |tx, _| {
            ensure!(
                counts(tx, &TABLES[..3])? == before,
                "migration changed telemetry row counts"
            );
            Ok(())
        },
    )?;
    let rollups = backfill(&mut db)?;
    let after = counts(&db, &TABLES[..3])?;
    ensure!(after == before, "backfill changed telemetry row counts");
    Ok(UpgradeReport {
        from: report.from,
        to: report.to,
        before,
        after,
        rollups,
    })
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
    let temporary = match destination {
        Some(path) => tempfile::NamedTempFile::new_in(
            path.parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?,
        None => tempfile::NamedTempFile::new_in(std::env::temp_dir())?,
    };
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
    db.run(&scope, Category::Setup, |db| migrations::run(db, &manifest(), None,
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
    // Rollups for a converted or new file are built by the runtime's startup
    // catch-up; only the in-place upgrade backfills offline.
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
