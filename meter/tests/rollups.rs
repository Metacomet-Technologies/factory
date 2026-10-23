//! MET-205 meter rollups: stats over rollups plus a raw edge equal an
//! independent raw computation across asymmetric windows, late rows, restarts
//! and a failed batch; GPU hourly summaries, gated pruning and history; STRICT
//! rejections; and the in-place v1 -> v2 upgrade with backup-gated rollback.
use meter::{db::Db, rollup};
use rusqlite::{Connection, params};
use serde_json::Value;
use shared::{GpuSample, ModelStats, RequestRecord};
use std::{collections::BTreeMap, path::Path, process::Command};

const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

fn lcg(id: i64) -> i64 {
    let x = (id as u64)
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    (x >> 17) as i64
}

/// Random timestamps over 400 days before `now` (later IDs are often older),
/// exact hour/day boundaries, NULL vs zero tokens/durations and identities.
fn record(id: i64, now: i64) -> RequestRecord {
    let anchor = now - 400 * DAY;
    let ts = match id % 97 {
        0 => anchor + (lcg(id) % 400) * DAY,
        1 => anchor + (lcg(id) % (400 * 24)) * HOUR,
        _ => anchor + lcg(id) % (400 * DAY),
    };
    let tokens = |m: i64, value: i64| match id % m {
        0 => None,
        1 => Some(0),
        _ => Some(value as u64),
    };
    let (user, actor) = match id % 3 {
        0 => (None, None),
        1 => (Some("u1"), Some("human")),
        _ => (Some("u2"), Some("agent")),
    };
    RequestRecord {
        id,
        ts,
        endpoint: if id % 5 == 0 {
            "/api/tags"
        } else {
            "/api/chat"
        }
        .into(),
        model: match id % 7 {
            0 => None,
            1 => Some(String::new()),
            2 | 3 => Some("b".into()),
            _ => Some("a".into()),
        },
        prompt_eval_count: tokens(13, id % 1000 + 2),
        eval_count: tokens(17, id % 500 + 2),
        load_duration: (id % 19 != 0).then_some(id as u64 * 1000),
        prompt_eval_duration: tokens(23, 1_000_000 + id * 37),
        eval_duration: tokens(29, 2_000_000 + (id % 113) * 1_000_003),
        total_duration: (id % 31 != 0).then_some(((id * 12_345) % 9_000_000_000 + 100_000) as u64),
        latency_ms: (id % 5000) as f64 * 1.7 + 0.25,
        status: 200,
        client_ip: "192.0.2.1".into(),
        client_hostname: "fixture".into(),
        user_key: user.map(Into::into),
        actor_kind: actor.map(Into::into),
        ..Default::default()
    }
}

fn nearest(sorted: &[f64], p: f64) -> f64 {
    let rank = (sorted.len() as f64 * p).ceil() as usize;
    sorted[rank.max(1) - 1]
}

fn close(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0),
        (a, b) => a == b,
    }
}

/// Independent raw computation of `/meter/stats` (all endpoints).
fn check(
    stats: &[ModelStats],
    rows: &[RequestRecord],
    since: i64,
    model: Option<&str>,
    exact: bool,
) {
    #[derive(Default)]
    struct Want {
        requests: usize,
        input: u64,
        output: u64,
        prompt: Vec<f64>,
        generation: Vec<f64>,
        latencies: Vec<f64>,
    }
    let rate = |t: Option<u64>, d: Option<u64>| match (t, d) {
        (Some(t), Some(d)) if d > 0 => Some(t as f64 * 1e9 / d as f64),
        _ => None,
    };
    let mut want = BTreeMap::<Option<&str>, Want>::new();
    for r in rows
        .iter()
        .filter(|r| r.ts >= since && model.is_none_or(|m| r.model.as_deref() == Some(m)))
    {
        let w = want.entry(r.model.as_deref()).or_default();
        w.requests += 1;
        w.input += r.prompt_eval_count.unwrap_or(0);
        w.output += r.eval_count.unwrap_or(0);
        w.prompt
            .extend(rate(r.prompt_eval_count, r.prompt_eval_duration));
        w.generation.extend(rate(r.eval_count, r.eval_duration));
        w.latencies
            .push(r.total_duration.map_or(r.latency_ms, |ns| ns as f64 / 1e6));
    }
    let label = format!("since={since} model={model:?} exact={exact}");
    assert_eq!(stats.len(), want.len(), "{label}");
    let mean = |v: &[f64]| (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64);
    for (s, (model, w)) in stats.iter().zip(&mut want) {
        let label = format!("{label} {model:?}");
        assert_eq!(s.model.as_deref(), *model, "{label}");
        assert_eq!(
            (s.requests, s.input_tokens, s.output_tokens),
            (w.requests, w.input, w.output),
            "{label}"
        );
        assert!(
            close(s.avg_prompt_tokens_per_second, mean(&w.prompt)),
            "{label}"
        );
        assert!(
            close(s.avg_generation_tokens_per_second, mean(&w.generation)),
            "{label}"
        );
        assert_eq!(s.percentiles_approximate, !exact, "{label}");
        w.latencies.sort_by(f64::total_cmp);
        for (actual, p) in [
            (s.p50_total_latency_ms, 0.5),
            (s.p95_total_latency_ms, 0.95),
        ] {
            let expected = nearest(&w.latencies, p);
            if exact {
                assert_eq!(actual, expected, "{label} p{p}");
            } else {
                assert!(
                    (actual - expected).abs() <= 0.0625 * expected + 1e-3,
                    "{label} p{p}: {actual} vs {expected}"
                );
            }
        }
    }
}

async fn check_all(db: &Db, rows: &[RequestRecord], now: i64) {
    let odd = now - 137 * DAY - 5 * HOUR - 13 * 60_000 - 7;
    for (since, model, exact) in [
        (now - DAY, None, true),
        (now - 7 * DAY, Some("b"), true),
        (now - 30 * DAY, None, true),
        (now - 30 * DAY, Some(""), true),
        (odd, None, true),
        (odd - odd % HOUR, None, true),
        (odd - odd % DAY, Some("a"), true),
        (rows[40].ts, None, true),
        (rows[40].ts + 1, None, true),
        (0, None, true),
        (now - 365 * DAY, None, false),
        (now - 365 * DAY, Some("b"), false),
    ] {
        let stats = db.stats(since, model.map(Into::into), exact).await.unwrap();
        check(&stats, rows, since, model, exact);
    }
}

fn open(path: &Path) -> Db {
    meter::migrate::migrate(None, Some(path), false).unwrap();
    Db::open(path).unwrap()
}

fn scalar(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn connection(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    db
}

#[tokio::test]
async fn request_rollups_plus_raw_edge_match_raw_across_restarts_and_late_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meter.db");
    let now = meter::now_ms();
    let all: Vec<_> = (1..=12_007).map(|id| record(id, now)).collect();
    let (early, late) = all.split_at(8_000);
    let db = open(&path);
    db.import(early.to_vec(), vec![]).await.unwrap();
    check_all(&db, early, now).await;
    db.close().await.unwrap();
    // One committed batch, then a restart: stats stay raw until verified.
    let mut raw = connection(&path);
    assert_eq!(rollup::request_batch(&mut raw, 1).unwrap(), 5_000);
    drop(raw);
    let db = Db::open(&path).unwrap();
    check_all(&db, early, now).await;
    let progress = db.rollups().await.unwrap();
    assert!(progress.caught_up && progress.verified, "{progress:?}");
    assert_eq!(db.maintenance().status, "ok");
    check_all(&db, early, now).await;
    // Late arrivals with higher IDs and older timestamps read raw, once.
    db.import(late.to_vec(), vec![]).await.unwrap();
    check_all(&db, &all, now).await;
    db.close().await.unwrap();
    // A batch failing before commit changes neither aggregates nor checkpoint.
    let mut raw = connection(&path);
    let before = scalar(&raw, "SELECT SUM(requests) FROM request_hourly");
    raw.execute_batch(
        "CREATE TEMP TRIGGER fail BEFORE UPDATE ON rollup_state
         BEGIN SELECT RAISE(ABORT,'injected crash before checkpoint'); END",
    )
    .unwrap();
    let error = format!("{:#}", rollup::request_batch(&mut raw, 2).unwrap_err());
    assert!(error.contains("injected crash"), "{error}");
    assert_eq!(
        scalar(&raw, "SELECT SUM(requests) FROM request_hourly"),
        before
    );
    assert_eq!(
        scalar(
            &raw,
            "SELECT last_id FROM rollup_state WHERE job='requests'"
        ),
        8_000
    );
    drop(raw);
    let db = Db::open(&path).unwrap();
    check_all(&db, &all, now).await;
    let progress = db.rollups().await.unwrap();
    assert_eq!((progress.rows, progress.caught_up), (4_007, true));
    check_all(&db, &all, now).await;
    db.close().await.unwrap();
    let raw = connection(&path);
    let verified = factory_db::rollup::verify(&raw, 12_007, rollup::TPS).unwrap();
    assert_eq!(verified.raw_requests, 12_007);
    // NULL and "" models, NULL identities stay distinct: 2 x 4 x 3 keys.
    assert_eq!(verified.dimension_keys, 24);
    assert_eq!(
        verified.input_known,
        all.iter().filter(|r| r.prompt_eval_count.is_some()).count() as i64
    );
    assert_eq!(
        scalar(&raw, "SELECT SUM(requests) FROM request_daily"),
        12_007
    );
}

fn sample(i: i64, now: i64) -> GpuSample {
    // Ten days of samples in random order, three GPUs, repeated timestamps.
    let ts = now - lcg(i) % (10 * DAY) / 1000 * 1000;
    GpuSample {
        ts,
        index: (i % 3) as u32,
        memory_used_mib: (i % 977) as f64 + 0.5,
        memory_total_mib: 24_576.0,
        utilization_percent: (i % 101) as f64,
        temperature_c: 30.0 + (i % 41) as f64 / 4.0,
        power_w: 50.0 + (i % 251) as f64 * 1.25,
    }
}

#[tokio::test]
async fn gpu_hourly_summaries_history_and_gated_pruning() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meter.db");
    let now = meter::now_ms();
    let cutoff = now - 7 * DAY;
    let mut samples: Vec<_> = (1..=7_001).map(|i| sample(i, now)).collect();
    // Equal timestamps on one GPU: the higher ID is the hour's last sample.
    let tie = rollup_floor(now - 9 * DAY) + 1_000;
    for value in [1.0, 2.0] {
        samples.push(GpuSample {
            ts: tie,
            index: 7,
            memory_used_mib: value,
            ..sample(0, now)
        });
    }
    // Strict pruning boundary.
    for ts in [cutoff - 1, cutoff, cutoff + 1] {
        samples.push(GpuSample {
            ts,
            ..sample(5, now)
        });
    }
    let db = open(&path);
    db.import(vec![], samples.clone()).await.unwrap();
    // Unverified: nothing older than seven days is pruned, history is raw.
    let unrolled = db.history_at(now - 30 * DAY, now).await.unwrap();
    assert_eq!(unrolled.len(), samples.len());
    assert!(unrolled.iter().all(|p| p.samples.is_none()));
    let progress = db.rollups().await.unwrap();
    assert!(progress.caught_up && progress.verified, "{progress:?}");
    db.close().await.unwrap();
    // Independent hourly summaries; IDs follow import order.
    let raw = connection(&path);
    let mut want = BTreeMap::<(i64, u32), (i64, [f64; 3], (i64, usize))>::new();
    for (id, s) in samples.iter().enumerate() {
        let w = want.entry((rollup_floor(s.ts), s.index)).or_insert((
            0,
            [0.0, f64::MAX, f64::MIN],
            (i64::MIN, 0),
        ));
        w.0 += 1;
        w.1[0] += s.power_w;
        w.1[1] = w.1[1].min(s.power_w);
        w.1[2] = w.1[2].max(s.power_w);
        if (s.ts, id) >= w.2 {
            w.2 = (s.ts, id);
        }
    }
    assert_eq!(
        scalar(&raw, "SELECT COUNT(*) FROM gpu_hourly"),
        want.len() as i64
    );
    for ((bucket, index), (n, power, (last_ts, last))) in &want {
        let row: (i64, f64, f64, f64, f64, i64, f64) = raw
            .query_row(
                "SELECT samples,power_w_sum,power_w_min,power_w_max,power_w_last,last_sample_ms,memory_used_mib_last FROM gpu_hourly WHERE bucket_ms=?1 AND gpu_index=?2",
                params![bucket, index],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .unwrap();
        assert_eq!(row.0, *n);
        assert!((row.1 - power[0]).abs() < 1e-6, "{row:?} {power:?}");
        assert_eq!((row.2, row.3), (power[1], power[2]));
        assert_eq!((row.4, row.5), (samples[*last].power_w, *last_ts));
        assert_eq!(row.6, samples[*last].memory_used_mib);
    }
    let tie_last: f64 = raw
        .query_row(
            "SELECT memory_used_mib_last FROM gpu_hourly WHERE bucket_ms=?1 AND gpu_index=7",
            [rollup_floor(tie)],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tie_last, 2.0);
    // An old sample above the checkpoint must survive pruning until rolled up.
    let last = scalar(&raw, "SELECT last_id FROM rollup_state WHERE job='gpu'");
    raw.execute(
        "INSERT INTO gpu_samples(ts_ms,gpu_index,memory_used_mib,memory_total_mib,utilization_percent,temperature_c,power_w) VALUES(?1,0,1,2,3,4,5)",
        [cutoff - 1],
    )
    .unwrap();
    let at = |ts: i64| {
        scalar(
            &raw,
            &format!("SELECT COUNT(*) FROM gpu_samples WHERE ts_ms={ts}"),
        )
    };
    assert_eq!((at(cutoff - 1), at(cutoff), at(cutoff + 1)), (2, 1, 1));
    let eligible = scalar(
        &raw,
        &format!("SELECT COUNT(*) FROM gpu_samples WHERE ts_ms<{cutoff} AND id<={last}"),
    );
    assert!(eligible > 1000);
    assert_eq!(rollup::prune_gpu(&raw, now).unwrap() as i64, eligible);
    assert_eq!((at(cutoff - 1), at(cutoff), at(cutoff + 1)), (1, 1, 1));
    assert_eq!(
        scalar(
            &raw,
            &format!("SELECT COUNT(*) FROM gpu_samples WHERE ts_ms<{cutoff} AND id>{last}")
        ),
        1
    );
    // Re-verification compares the whole hours raw retention still covers.
    assert!(rollup::verify_gpu(&raw, last).unwrap() > 0);
    drop(raw);
    // History after pruning: hourly means before the first whole raw hour,
    // raw samples from it, plus the unrolled old sample; nothing twice.
    let db = Db::open(&path).unwrap();
    let since = now - 30 * DAY;
    let history = db.history_at(since, now).await.unwrap();
    let boundary = rollup_ceil(now - 7 * DAY);
    let first = rollup_floor(since);
    let hours = want
        .keys()
        .filter(|(bucket, _)| *bucket >= first && *bucket < boundary)
        .count();
    let hourly: Vec<_> = history.iter().filter(|p| p.samples.is_some()).collect();
    assert_eq!(hourly.len(), hours);
    assert!(
        hourly
            .iter()
            .all(|p| p.sample.ts < boundary && p.sample.ts % HOUR == 0)
    );
    assert_eq!(
        hourly
            .iter()
            .map(|p| p.samples.unwrap() as usize)
            .sum::<usize>(),
        samples
            .iter()
            .filter(|s| rollup_floor(s.ts) >= first && s.ts < boundary)
            .count()
    );
    let raw_points: Vec<_> = history.iter().filter(|p| p.samples.is_none()).collect();
    assert_eq!(
        raw_points.len(),
        samples.iter().filter(|s| s.ts >= boundary).count() + 1
    );
    assert_eq!(
        raw_points.iter().filter(|p| p.sample.ts < boundary).count(),
        1
    );
    db.close().await.unwrap();
}

/// A 7d history request resolves from its own request time: it stays raw even
/// after the clock has moved past the seven-day boundary before the read.
#[tokio::test]
async fn seven_day_history_uses_the_request_time_not_the_read_time() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meter.db");
    // Request time 5 s in the past, with a cutoff that is not hour-aligned.
    let mut now = meter::now_ms() - 5_000;
    if (now - 7 * DAY) % HOUR == 0 {
        now -= 7;
    }
    let cutoff = now - 7 * DAY;
    assert_ne!(cutoff % HOUR, 0);
    let at = |ts: i64, power_w: f64| GpuSample {
        ts,
        power_w,
        ..sample(5, now)
    };
    let samples = vec![
        at(now - 10 * DAY, 10.0),
        at(cutoff - 1, 20.0),
        at(cutoff, 30.0),
        at(cutoff + 1, 40.0),
    ];
    let mut db = open(&path);
    db.import(vec![], samples).await.unwrap();
    let progress = db.rollups().await.unwrap();
    assert!(progress.caught_up && progress.verified, "{progress:?}");
    // The read happens after the boundary moved past `cutoff`; resolving from the
    // read time would return the hour as a rollup instead of raw samples.
    assert!(meter::now_ms() - 7 * DAY > cutoff);
    let scope = factory_db::Scope::recording();
    db.scope = Some(scope.clone());
    let week = db.history_at(cutoff, now).await.unwrap();
    assert_eq!(scope.counts().data, 1);
    let points: Vec<_> = week
        .iter()
        .map(|p| (p.sample.ts, p.samples, p.sample.power_w))
        .collect();
    assert_eq!(points, [(cutoff, None, 30.0), (cutoff + 1, None, 40.0)]);
    // Longer ranges keep hourly means before the first whole raw hour, and
    // every sample appears exactly once.
    let scope = factory_db::Scope::recording();
    db.scope = Some(scope.clone());
    let month = db.history_at(now - 30 * DAY, now).await.unwrap();
    assert_eq!(scope.counts().data, 2);
    let boundary = rollup_ceil(cutoff);
    let points: Vec<_> = month.iter().map(|p| (p.sample.ts, p.samples)).collect();
    assert_eq!(
        points,
        [
            (rollup_floor(now - 10 * DAY), Some(1)),
            (rollup_floor(cutoff), Some(3)),
        ]
    );
    assert!(month.iter().all(|p| p.sample.ts < boundary));
    assert_eq!(month[1].sample.power_w, 30.0);
    db.close().await.unwrap();
}

/// Every public stats range, with and without a model filter.
async fn public_stats(db: &Db, now: i64) -> Vec<(i64, Option<&'static str>, bool, Value)> {
    let mut out = vec![];
    for (days, model) in [
        (1, None),
        (7, Some("b")),
        (30, None),
        (30, Some("")),
        (365, None),
        (365, Some("b")),
    ] {
        let since = now - days * DAY;
        let exact = days != 365;
        let stats = db.stats(since, model.map(Into::into), exact).await.unwrap();
        out.push((since, model, exact, serde_json::to_value(stats).unwrap()));
    }
    out
}

#[tokio::test]
async fn request_retention_prunes_only_verified_rows_older_than_365_days() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meter.db");
    let now = meter::now_ms();
    let cutoff = now - 365 * DAY;
    // 400 days of history (later IDs are often older), with half the rows in
    // the last 35 expired days so pruning needs several batches.
    let mut rows: Vec<_> = (1..=8_000)
        .map(|id| RequestRecord {
            ts: if id % 2 == 0 {
                cutoff - 1 - lcg(id) % (35 * DAY)
            } else {
                record(id, now).ts
            },
            ..record(id, now)
        })
        .collect();
    // Strict cutoff: exactly 365 days is kept, 365 days + 1 ms is pruned.
    rows[10].ts = cutoff;
    rows[11].ts = cutoff - 1;
    let db = open(&path);
    db.import(rows.clone(), vec![]).await.unwrap();
    let retention = || db.maintenance().retention;

    // Unverified rollup: refuse, even with one batch committed.
    assert_eq!(db.retain(now).await.unwrap(), 0);
    assert_eq!(retention().status, "skipped");
    assert!(retention().detail.unwrap().starts_with("rollup unverified"));
    assert_eq!(retention().skipped_since_ms, Some(now));
    let mut raw = connection(&path);
    assert_eq!(rollup::request_batch(&mut raw, 1).unwrap(), 5_000);
    drop(raw);
    assert_eq!(db.retain(now + 1).await.unwrap(), 0);
    assert!(retention().detail.unwrap().starts_with("rollup unverified"));
    let progress = db.rollups().await.unwrap();
    assert!(progress.caught_up && progress.verified, "{progress:?}");

    // A late row older than the cutoff but above the checkpoint blocks the job.
    let late = RequestRecord {
        ts: cutoff - 5 * DAY,
        ..record(8_001, now)
    };
    db.import(vec![late.clone()], vec![]).await.unwrap();
    rows.push(late);
    assert_eq!(db.retain(now + 2).await.unwrap(), 0);
    let skipped = retention();
    assert_eq!(skipped.status, "skipped");
    assert_eq!(
        skipped.detail.as_deref(),
        Some("rollup behind: expired request id 8001 is above the verified checkpoint 8000")
    );
    // The streak keeps its first skip time for the 24-hour alert.
    assert_eq!(skipped.skipped_since_ms, Some(now));
    let raw = connection(&path);
    assert_eq!(scalar(&raw, "SELECT COUNT(*) FROM requests"), 8_001);
    let before = public_stats(&db, now).await;
    assert!(db.rollups().await.unwrap().verified);

    // Gates met: bounded batches delete exactly the expired rows.
    let expired: Vec<i64> = rows
        .iter()
        .filter(|r| r.ts < cutoff)
        .map(|r| r.id)
        .collect();
    assert!(
        expired.len() > 2 * rollup::PRUNE_BATCH
            && !expired.len().is_multiple_of(rollup::PRUNE_BATCH)
    );
    let scope = factory_db::Scope::recording();
    let mut scoped = db.clone();
    scoped.scope = Some(scope.clone());
    assert_eq!(scoped.retain(now).await.unwrap(), expired.len() as u64);
    // Per batch: expired-ID read, rollup state, DELETE; then one MIN(id) read.
    let batches = expired.len().div_ceil(rollup::PRUNE_BATCH);
    assert_eq!(scope.counts().data, 3 * batches + 1);
    let ok = retention();
    assert_eq!((ok.status.as_str(), ok.detail), ("ok", None));
    assert_eq!(ok.pruned_rows, expired.len() as u64);
    assert_eq!((ok.pruned_at_ms, ok.cutoff_ms), (Some(now), Some(cutoff)));
    assert_eq!(ok.skipped_since_ms, None);
    let kept: Vec<_> = rows.iter().filter(|r| r.ts >= cutoff).collect();
    assert_eq!(ok.oldest_retained_id, kept.iter().map(|r| r.id).min());
    assert_eq!(
        scalar(&raw, "SELECT COUNT(*) FROM requests"),
        kept.len() as i64
    );
    assert_eq!(scalar(&raw, "SELECT COUNT(*) FROM requests WHERE id=11"), 1);
    assert_eq!(scalar(&raw, "SELECT COUNT(*) FROM requests WHERE id=12"), 0);
    // Rollups keep everything; every public range is unchanged and still
    // matches an independent computation over the full history.
    assert_eq!(
        scalar(&raw, "SELECT SUM(requests) FROM request_daily"),
        rows.len() as i64
    );
    let after = public_stats(&db, now).await;
    assert_eq!(after, before);
    for (since, model, exact, _) in &after {
        let stats = db
            .stats(*since, model.map(Into::into), *exact)
            .await
            .unwrap();
        check(&stats, &rows, *since, *model, *exact);
    }
    // The cursor page reports the same oldest ID.
    let (page, oldest) = db.requests_page(10, Some(0)).await.unwrap();
    assert_eq!(oldest, ok.oldest_retained_id);
    assert_eq!(page[0].id, oldest.unwrap());

    // Idempotent: a second run and a restart prune nothing more.
    assert_eq!(db.retain(now).await.unwrap(), 0);
    db.close().await.unwrap();
    let db = Db::open(&path).unwrap();
    assert_eq!(db.retain(now).await.unwrap(), 0);
    assert_eq!(db.maintenance().retention.status, "ok");
    assert_eq!(
        scalar(&raw, "SELECT COUNT(*) FROM requests"),
        kept.len() as i64
    );

    // A failed prune deletes nothing and is reported.
    let later = now + 30 * DAY;
    let newly: i64 = kept.iter().filter(|r| r.ts < later - 365 * DAY).count() as i64;
    assert!(newly > 0);
    raw.execute_batch(
        "CREATE TRIGGER fail_prune BEFORE DELETE ON requests BEGIN SELECT RAISE(ABORT,'injected prune failure'); END",
    )
    .unwrap();
    let error = format!("{:#}", db.retain(later).await.unwrap_err());
    assert!(error.contains("injected prune failure"), "{error}");
    let failed = db.maintenance().retention;
    assert_eq!(failed.status, "failed");
    assert!(failed.detail.unwrap().contains("injected prune failure"));
    assert_eq!(failed.skipped_since_ms, Some(later));
    assert_eq!(
        scalar(&raw, "SELECT COUNT(*) FROM requests"),
        kept.len() as i64
    );
    raw.execute_batch("DROP TRIGGER fail_prune").unwrap();
    assert_eq!(db.retain(later).await.unwrap(), newly as u64);
    db.close().await.unwrap();
}

fn rollup_floor(ts: i64) -> i64 {
    ts - ts.rem_euclid(HOUR)
}

fn rollup_ceil(ts: i64) -> i64 {
    let floor = rollup_floor(ts);
    if floor == ts { floor } else { floor + HOUR }
}

#[test]
fn strict_meter_rollup_tables_reject_invalid_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meter.db");
    drop(open(&path));
    let db = connection(&path);
    let metrics = "1,1,1,1, 2,2,2,2, 3,3,3,3, 4,4,4,4, 5,5,5,5";
    db.execute(
        &format!(
            "INSERT INTO gpu_hourly VALUES({HOUR},0,1,{},{metrics})",
            HOUR + 5
        ),
        [],
    )
    .unwrap();
    db.execute("INSERT INTO rollup_state VALUES('gpu',0,0,NULL)", [])
        .unwrap();
    for sql in [
        format!("INSERT INTO gpu_hourly VALUES({},1,1,{},{metrics})", HOUR + 1, HOUR + 5),
        format!("INSERT INTO gpu_hourly VALUES({HOUR},-1,1,{},{metrics})", HOUR + 5),
        format!("INSERT INTO gpu_hourly VALUES({HOUR},1,0,{},{metrics})", HOUR + 5),
        format!("INSERT INTO gpu_hourly VALUES({HOUR},1,1,{},{metrics})", 2 * HOUR),
        format!("INSERT INTO gpu_hourly VALUES({HOUR},1,1,{},{metrics})", HOUR - 1),
        format!("INSERT INTO gpu_hourly VALUES({HOUR},1,'one',{},{metrics})", HOUR + 5),
        format!("INSERT INTO gpu_hourly VALUES({HOUR},1,1,{},'x',{})", HOUR + 5, &metrics[2..]),
        "INSERT INTO request_hourly VALUES(1,json_array('/api/chat','m',NULL,'unattributed'),'/api/chat','m',NULL,'unattributed',1,0,0,0,0,0,0,0,0,0,0)".into(),
        format!("INSERT INTO request_hourly VALUES({HOUR},json_array('/api/chat','m',NULL,'unattributed'),'/api/chat','n',NULL,'unattributed',1,0,0,0,0,0,0,0,0,0,0)"),
        format!("INSERT INTO request_hourly VALUES({HOUR},json_array('/api/chat','m',NULL,'unattributed'),'/api/chat','m',NULL,'unattributed',1,0,0,2,0,0,0,0,0,0,0)"),
        "INSERT INTO rollup_state VALUES('pricing',0,0,NULL)".into(),
        "UPDATE rollup_state SET last_id=-1".into(),
    ] {
        assert!(db.execute(&sql, []).is_err(), "accepted: {sql}");
    }
}

fn v1(path: &Path, now: i64) -> (Vec<RequestRecord>, i64) {
    use factory_db::migrations::{Migration, checksum, run};
    let mut db = Connection::open(path).unwrap();
    let sql = include_str!("../src/v1.sql");
    run(
        &mut db,
        &[Migration {
            version: 1,
            sql,
            checksum: checksum(sql),
        }],
        None,
        |_, _| Ok(()),
        |_, _| Ok(()),
    )
    .unwrap();
    assert_eq!(checksum(sql), 0x963424d2b374d530);
    drop(db);
    let rows: Vec<_> = (1..=5_503).map(|id| record(id, now)).collect();
    let samples: Vec<_> = (1..=2_011).map(|i| sample(i, now)).collect();
    // Rows as a v1 runtime wrote them.
    let db = Connection::open(path).unwrap();
    for r in &rows {
        db.execute(
            "INSERT INTO requests(id,ts_ms,endpoint,model,prompt_eval_count,eval_count,load_duration_ns,prompt_eval_duration_ns,eval_duration_ns,total_duration_ns,latency_ms,status,stream,client_ip,client_hostname,user_key,actor_kind)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,200,0,'192.0.2.1','fixture',?12,COALESCE(?13,'unattributed'))",
            params![
                r.id, r.ts, r.endpoint, r.model,
                r.prompt_eval_count.map(|v| v as i64), r.eval_count.map(|v| v as i64),
                r.load_duration.map(|v| v as i64), r.prompt_eval_duration.map(|v| v as i64),
                r.eval_duration.map(|v| v as i64), r.total_duration.map(|v| v as i64),
                r.latency_ms, r.user_key, r.actor_kind
            ],
        )
        .unwrap();
    }
    for s in &samples {
        db.execute(
            "INSERT INTO gpu_samples(ts_ms,gpu_index,memory_used_mib,memory_total_mib,utilization_percent,temperature_c,power_w) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![s.ts, s.index, s.memory_used_mib, s.memory_total_mib, s.utilization_percent, s.temperature_c, s.power_w],
        )
        .unwrap();
    }
    db.execute_batch("INSERT INTO drop_episodes(started_at_ms,ended_at_ms,dropped_requests,dropped_gpu_samples) VALUES(1,2,3,4); ANALYZE;")
        .unwrap();
    (rows, samples.len() as i64)
}

fn counts(path: &Path) -> BTreeMap<String, i64> {
    let db = Connection::open(path).unwrap();
    let tables: Vec<String> = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    tables
        .into_iter()
        .map(|t| {
            let n = scalar(&db, &format!("SELECT COUNT(*) FROM \"{t}\""));
            (t, n)
        })
        .collect()
}

#[tokio::test]
async fn v1_fixture_upgrades_in_place_backfills_and_rolls_back_from_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meter.db");
    let now = meter::now_ms();
    let (rows, gpu) = v1(&path, now);
    let samples_min = (1..=2_011).map(|i| sample(i, now).ts).min().unwrap();
    let before = counts(&path);
    assert_eq!((before["requests"], before["gpu_samples"]), (5_503, gpu));
    let error = Db::open(&path).err().unwrap().to_string();
    assert!(error.contains("requires user_version=2"), "{error}");
    let check = Command::new(env!("CARGO_BIN_EXE_meter"))
        .args(["migrate", "--check-only", "--db"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        check.status.success(),
        "{}",
        String::from_utf8_lossy(&check.stderr)
    );
    assert_eq!(counts(&path), before);
    let backup = dir.path().join("backup.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch(&format!("VACUUM INTO '{}'", backup.display()))
        .unwrap();
    let inode = std::fs::metadata(&path).unwrap();
    let mut reports = Vec::new();
    for _ in 0..2 {
        let output = Command::new(env!("CARGO_BIN_EXE_meter"))
            .args(["migrate", "--db"])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        reports.push(serde_json::from_slice::<Value>(&output.stdout).unwrap());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().ino(),
            inode.ino(),
            "file replaced"
        );
    }
    let report = &reports[0];
    assert_eq!(
        (report["from"].as_u64(), report["to"].as_u64()),
        (Some(1), Some(2))
    );
    assert_eq!(report["before"], report["after"]);
    assert_eq!(report["rollups"]["raw_requests"], 5_503);
    // Compared from the first whole hour of retained raw samples.
    let first = rollup_ceil(samples_min);
    assert_eq!(
        report["rollups"]["gpu_samples"],
        (1..=2_011).filter(|i| sample(*i, now).ts >= first).count()
    );
    assert_eq!(report["rollups"]["batches"], 3);
    assert_eq!(
        (
            reports[1]["from"].as_u64(),
            reports[1]["rollups"]["batches"].as_u64()
        ),
        (Some(2), Some(0))
    );
    let after = counts(&path);
    for (table, n) in &before {
        assert_eq!(after[table], *n, "{table}");
    }
    assert_eq!(after["rollup_state"], 2);
    let db = Db::open(&path).unwrap();
    check_all(&db, &rows, now).await;
    db.close().await.unwrap();
    // Backup-gated rollback: restore the pre-upgrade snapshot.
    for suffix in ["-wal", "-shm", ""] {
        let file = format!("{}{suffix}", path.display());
        if Path::new(&file).exists() {
            std::fs::rename(&file, format!("{file}.displaced")).unwrap();
        }
    }
    std::fs::copy(&backup, &path).unwrap();
    assert_eq!(counts(&path), before);
    assert_eq!(
        scalar(&Connection::open(&path).unwrap(), "PRAGMA user_version"),
        1
    );
    assert!(Db::open(&path).is_err());
}
