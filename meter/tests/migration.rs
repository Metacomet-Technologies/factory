use meter::{db::Db, migrate::migrate};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use shared::{GpuSample, RequestRecord};
use std::{path::Path, process::Command, time::Duration};

const DDL: &str = include_str!("fixtures/legacy.sql");

fn legacy(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch(DDL).unwrap();
    db
}

fn record(id: i64) -> RequestRecord {
    RequestRecord {
        id: 0,
        ts: 1_791_676_800_000 + id,
        endpoint: "/api/chat".into(),
        model: Some("模型-é".into()),
        prompt_eval_count: Some(13),
        eval_count: Some(7),
        load_duration: Some(3),
        prompt_eval_duration: Some(101),
        eval_duration: Some(211),
        total_duration: Some(317),
        latency_ms: 0.125,
        status: 200,
        stream: true,
        client_ip: "192.0.2.1".into(),
        client_hostname: "synthetic".into(),
        ..Default::default()
    }
}

fn sample() -> GpuSample {
    GpuSample {
        ts: meter::now_ms(),
        index: 1,
        memory_used_mib: 301.5,
        memory_total_mib: 12288.0,
        utilization_percent: 73.0,
        temperature_c: -2.5,
        power_w: 71.25,
    }
}

fn cli(args: &[&std::ffi::OsStr]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_meter"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn cli_initialization_empty_conversion_dry_run_rerun_and_version_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("new.db");
    assert!(Db::open(&target).is_err());
    assert!(!target.exists());
    assert!(
        cli(&[
            "migrate".as_ref(),
            "--db".as_ref(),
            target.as_os_str(),
            "--dry-run".as_ref()
        ])
        .status
        .success()
    );
    assert!(!target.exists());
    std::fs::write(&target, []).unwrap();
    let result = cli(&["migrate".as_ref(), "--db".as_ref(), target.as_os_str()]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let db = Connection::open(&target).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let strict: Vec<(String,i64)> = db.prepare("SELECT name,strict FROM pragma_table_list WHERE name IN ('requests','gpu_samples','drop_episodes') ORDER BY name").unwrap()
        .query_map([], |r| Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(
        strict,
        [
            ("drop_episodes".into(), 1),
            ("gpu_samples".into(), 1),
            ("requests".into(), 1)
        ]
    );
    drop(db);
    let before = std::fs::read(&target).unwrap();
    assert!(
        !cli(&["migrate".as_ref(), "--db".as_ref(), target.as_os_str()])
            .status
            .success()
    );
    assert_eq!(std::fs::read(&target).unwrap(), before);
    let source = dir.path().join("legacy.db");
    drop(legacy(&source));
    let empty = dir.path().join("empty.db");
    let report = migrate(Some(&source), Some(&empty), false).unwrap();
    assert_eq!(report.verified_rows, 0);
    for version in [0, 2] {
        let db = Connection::open(&target).unwrap();
        db.pragma_update(None, "user_version", version).unwrap();
        drop(db);
        let before = std::fs::read(&target).unwrap();
        assert!(Db::open(&target).is_err());
        let output = cli(&[
            "--db-path".as_ref(),
            target.as_os_str(),
            "--listen".as_ref(),
            "127.0.0.1:0".as_ref(),
        ]);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("requires user_version=1"));
        assert_eq!(std::fs::read(&target).unwrap(), before);
    }
}

#[tokio::test]
async fn golden_wire_ids_nulls_tokens_and_sequence_survive_conversion() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("legacy.db");
        let db = legacy(&source);
        let mut records = Vec::new();
        for id in [3, 8, 19, 25] {
            let mut r = record(id);
            if id == 8 {
                r.prompt_eval_count = None;
                r.eval_count = None;
                r.status = 502;
                r.error = Some("synthetic upstream error".into());
            }
            if id == 19 {
                r.model = None;
                r.endpoint = "/api/version".into();
                r.stream = false;
            }
            if id == 25 {
                r.prompt_eval_count = Some(i64::MAX as u64);
                r.total_duration = Some(i64::MAX as u64);
                r.usage = Some(
                    json!({"prompt_tokens":13,"completion_tokens":7,"details":{"cached_tokens":2}}),
                );
            }
            db.execute(
                "INSERT INTO requests(id,record) VALUES (?1,?2)",
                params![id, serde_json::to_string(&r).unwrap()],
            )
            .unwrap();
            r.id = id;
            records.push(r);
        }
        let s = sample();
        db.execute(
            "INSERT INTO gpu_samples(id,ts,sample) VALUES (42,?1,?2)",
            params![s.ts, serde_json::to_string(&s).unwrap()],
        )
        .unwrap();
        drop(db);
        let before = std::fs::read(&source).unwrap();
        let target = dir.path().join("new.db");
        let report =
            serde_json::to_value(migrate(Some(&source), Some(&target), false).unwrap()).unwrap();
        assert_eq!(report["requests"]["id_sum"], "55");
        assert_eq!(report["requests"]["count"], 4);
        assert_eq!(
            report["requests"]["token_sums"]["prompt_eval_count"],
            "9223372036854775833"
        );
        assert_eq!(report["requests"]["null_counts"]["eval_count"], 1);
        assert_eq!(report["gpu_samples"]["sqlite_sequence"], 42);
        assert_eq!(std::fs::read(&source).unwrap(), before);
        let runtime = Db::open(&target).unwrap();
        let actual = runtime.requests(100, Some(0)).await.unwrap();
        for (mut actual, expected) in actual.into_iter().zip(records) {
            assert_eq!(actual.user_key, None);
            assert_eq!(actual.actor_kind.as_deref(), Some("unattributed"));
            actual.actor_kind = None;
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
        assert_eq!(
            serde_json::to_value(runtime.history(0).await.unwrap()).unwrap(),
            json!([s])
        );
        runtime
            .pool
            .write(&Default::default(), |db| {
                db.execute("DELETE FROM requests WHERE id=25", [])?;
                db.execute("DELETE FROM gpu_samples WHERE id=42", [])?;
                Ok(())
            })
            .await
            .unwrap();
        runtime.send(meter::db::Event::Request(Box::new(record(1))));
        runtime.send(meter::db::Event::Gpu(vec![s]));
        assert_eq!(runtime.requests(1, None).await.unwrap()[0].id, 26);
        assert_eq!(
            runtime
                .read(
                    |db| Ok(db.query_row("SELECT max(id) FROM gpu_samples", [], |r| r
                        .get::<_, i64>(0))?)
                )
                .await
                .unwrap(),
            43
        );
        runtime.close().await.unwrap();
    })
    .await
    .expect("golden migration timed out");
}

#[test]
fn strict_failures_list_ids_and_leave_no_target_or_sidecars() {
    for case in [
        "json",
        "unknown",
        "overflow",
        "null",
        "gpu-ts",
        "gpu-null",
        "gpu-unknown",
        "version",
        "schema",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("legacy.db");
        let db = legacy(&source);
        let mut r = serde_json::to_value(record(1)).unwrap();
        match case {
            "unknown" => r["surprise"] = true.into(),
            "overflow" => r["eval_duration"] = json!(i64::MAX as u64 + 1),
            "null" => r["endpoint"] = Value::Null,
            _ => (),
        }
        db.execute(
            "INSERT INTO requests(id,record) VALUES (17,?1),(29,?1)",
            [r.to_string()],
        )
        .unwrap();
        let s = sample();
        let mut gpu = serde_json::to_value(&s).unwrap();
        if case == "gpu-null" {
            gpu["memory_used_mib"] = Value::Null;
        }
        if case == "gpu-unknown" {
            gpu["unknown"] = true.into();
        }
        db.execute(
            "INSERT INTO gpu_samples(id,ts,sample) VALUES (71,?1,?2)",
            params![s.ts + i64::from(case == "gpu-ts"), gpu.to_string()],
        )
        .unwrap();
        if case == "version" {
            db.pragma_update(None, "user_version", 2).unwrap();
        }
        if case == "schema" {
            db.execute_batch("CREATE INDEX unrecognized ON requests(id)")
                .unwrap();
        }
        drop(db);
        if case == "json" {
            // Generated columns prevent normal invalid JSON INSERTs. Corrupt only
            // the synthetic payload bytes, retaining the captured schema exactly.
            let mut bytes = std::fs::read(&source).unwrap();
            let needle = r.to_string();
            let positions: Vec<_> = bytes
                .windows(needle.len())
                .enumerate()
                .filter_map(|(i, s)| (s == needle.as_bytes()).then_some(i))
                .collect();
            assert_eq!(positions.len(), 2);
            for i in positions {
                bytes[i] = b'!';
            }
            std::fs::write(&source, bytes).unwrap();
        }
        let before = std::fs::read(&source).unwrap();
        let target = dir.path().join("new.db");
        let error = match migrate(Some(&source), Some(&target), false) {
            Ok(_) => panic!("accepted {case}"),
            Err(e) => format!("{e:#}"),
        };
        if case.starts_with("gpu-") {
            assert!(error.contains("id=71"), "{error}");
        } else if !["version", "schema"].contains(&case) {
            assert!(
                error.contains("id=17") && error.contains("id=29"),
                "{error}"
            );
        }
        assert!(!target.exists(), "{case}");
        assert_eq!(std::fs::read(&source).unwrap(), before);
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "{case} left temporary files"
        );
    }
}

#[test]
fn schema_checks_reject_invalid_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v1.db");
    migrate(None, Some(&path), false).unwrap();
    let db = Connection::open(path).unwrap();
    db.execute("INSERT INTO requests(ts_ms,endpoint,latency_ms,status,stream,client_ip,client_hostname) VALUES (0,'/api/chat',0,200,0,'','')", []).unwrap();
    for assignment in [
        "ts_ms=-1",
        "endpoint=NULL",
        "status=99",
        "stream=2",
        "eval_count=-1",
        "eval_count='oops'",
        "load_duration_ns=-1",
        "usage_json='{'",
        "user_key=''",
        "actor_kind='alien'",
        "user_key='human-without-kind'",
        "actor_kind='human'",
    ] {
        assert!(
            db.execute(&format!("UPDATE requests SET {assignment}"), [])
                .is_err(),
            "{assignment}"
        );
    }
    for values in ["-1,2,0,0", "2,1,0,0", "1,2,-1,0", "1,2,0,-1", "NULL,2,0,0"] {
        assert!(db.execute(&format!("INSERT INTO drop_episodes(started_at_ms,ended_at_ms,dropped_requests,dropped_gpu_samples) VALUES ({values})"), []).is_err());
    }
}
