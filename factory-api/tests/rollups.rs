//! MET-205 request and spend rollups: usage over rollups plus a raw edge equals
//! an independent raw computation across asymmetric UTC windows, late rows,
//! restarts and failed batches; STRICT rejections; and the offline v5 -> v6
//! migration with its backup-gated rollback.
use anyhow::Result;
use factory_api::{costs, data, retention, rollups, types::Usage};
use factory_db::rollup::{DAY_MS, HOUR_MS};
use rusqlite::{Connection, params};
use std::{collections::BTreeMap, path::Path};

/// 2026-03-08T07:00:00Z: the America/New_York DST start, deliberately mid-fixture.
const DST: i64 = 1_772_953_200_000;
const ANCHOR: i64 = DST - 200 * DAY_MS;
const SPAN: i64 = 400 * DAY_MS;
const INFERENCE: [&str; 2] = ["/api/chat", "/v1/chat/completions"];

#[derive(Clone, Debug)]
struct Row {
    id: i64,
    ts: i64,
    endpoint: &'static str,
    model: Option<&'static str>,
    user: Option<&'static str>,
    actor: &'static str,
    prompt: Option<i64>,
    output: Option<i64>,
    load: Option<i64>,
    prompt_ns: Option<i64>,
    eval_ns: Option<i64>,
    total_ns: Option<i64>,
    latency_ms: f64,
}

fn lcg(id: i64) -> i64 {
    let x = (id as u64)
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    (x >> 17) as i64
}

/// Deterministic rows with random timestamps (so later IDs are often older),
/// exact hour/day/DST boundary rows, NULL vs zero tokens and durations, NULL,
/// empty and literal-"unattributed" identities, and a non-inference endpoint.
fn row(id: i64) -> Row {
    let ts = match id % 97 {
        0 => ANCHOR + (lcg(id) % 400) * DAY_MS,
        1 => ANCHOR + (lcg(id) % (400 * 24)) * HOUR_MS,
        2 => DST + (id % 3 - 1),
        _ => ANCHOR + lcg(id) % SPAN,
    };
    let (user, actor) = match id % 4 {
        0 => (None, "unattributed"),
        1 => (Some("u1"), "human"),
        2 => (Some("u2"), "agent"),
        _ => (Some("unattributed"), "human"),
    };
    let tokens = |m: i64, value: i64| match id % m {
        0 => None,
        1 => Some(0),
        _ => Some(value),
    };
    Row {
        id,
        ts,
        endpoint: match id % 11 {
            0 => "/api/ps",
            1..=3 => INFERENCE[1],
            _ => INFERENCE[0],
        },
        model: match id % 7 {
            0 => None,
            1 => Some(""),
            2 | 3 => Some("b"),
            _ => Some("a"),
        },
        user,
        actor,
        prompt: tokens(13, id % 1000 + 2),
        output: tokens(17, id % 500 + 2),
        load: (id % 19 != 0).then_some(id * 1000),
        prompt_ns: tokens(23, 1_000_000 + id * 37),
        eval_ns: tokens(29, 2_000_000 + (id % 113) * 1_000_003),
        total_ns: (id % 31 != 0).then_some((id * 12_345) % 9_000_000_000 + 100_000),
        latency_ms: (id % 5000) as f64 * 1.7 + 0.25,
    }
}

/// Status and cost per (request, family), computed without production code.
fn cost(id: i64, family: usize) -> (&'static str, Option<i64>) {
    match (id + family as i64) % 4 {
        0 | 1 => ("priced", Some(id * 3 + family as i64)),
        2 => ("estimated", Some(id * 5)),
        _ => ("unpriced", None),
    }
}

fn insert(db: &mut Connection, rows: &[Row], families: &[String]) -> Result<()> {
    let tx = db.transaction()?;
    for r in rows {
        tx.execute(
            "INSERT INTO requests(id,ts_ms,endpoint,model,prompt_eval_count,eval_count,load_duration_ns,
               prompt_eval_duration_ns,eval_duration_ns,total_duration_ns,latency_ms,status,stream,
               client_ip,client_hostname,user_key,actor_kind)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,200,0,'100.64.0.1','host',?12,?13)",
            params![
                r.id, r.ts, r.endpoint, r.model, r.prompt, r.output, r.load, r.prompt_ns,
                r.eval_ns, r.total_ns, r.latency_ms, r.user, r.actor
            ],
        )?;
        if !INFERENCE.contains(&r.endpoint) {
            continue;
        }
        for (i, family) in families.iter().enumerate() {
            let (status, nano) = cost(r.id, i);
            let priced = nano.is_some();
            tx.execute(
                "INSERT INTO request_costs VALUES(?1,?2,1,?3,?4,?5,?5,?6,?7,?7)",
                params![
                    r.id,
                    family,
                    status,
                    nano,
                    priced.then_some(1),
                    priced.then_some("reference/model"),
                    priced.then_some(1_000_000),
                ],
            )?;
        }
    }
    tx.execute(
        "UPDATE sync_state SET last_after_id=(SELECT MAX(id) FROM requests)",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Default)]
struct Expected {
    requests: usize,
    prompt: i64,
    output: i64,
    prompt_tps: Vec<f64>,
    generation_tps: Vec<f64>,
    latencies: Vec<f64>,
    load_ns: i64,
}

fn nearest(sorted: &[f64], p: f64) -> Option<f64> {
    let rank = (sorted.len() as f64 * p).ceil() as usize;
    sorted.get(rank.max(1) - 1).copied()
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn close(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0),
        (a, b) => a == b,
    }
}

/// Independent raw computation of one usage response.
fn check(usage: &Usage, rows: &[Row], families: &[String], since: i64, exact: bool) {
    let mut models = BTreeMap::<Option<&str>, Expected>::new();
    let mut spend = vec![(0i64, 0i64, 0usize); families.len()];
    let mut requests = 0;
    for r in rows
        .iter()
        .filter(|r| r.ts >= since && INFERENCE.contains(&r.endpoint))
    {
        requests += 1;
        let m = models.entry(r.model).or_default();
        m.requests += 1;
        m.prompt += r.prompt.unwrap_or(0);
        m.output += r.output.unwrap_or(0);
        m.load_ns += r.load.unwrap_or(0);
        if let (Some(t), Some(d)) = (r.prompt, r.prompt_ns.filter(|d| *d > 0)) {
            m.prompt_tps.push(t as f64 / (d as f64 / 1e9));
        }
        if let (Some(t), Some(d)) = (r.output, r.eval_ns.filter(|d| *d > 0)) {
            m.generation_tps.push(t as f64 / (d as f64 / 1e9));
        }
        m.latencies
            .push(r.total_ns.map_or(r.latency_ms, |ns| ns as f64 / 1e6));
        for (i, s) in spend.iter_mut().enumerate() {
            match cost(r.id, i) {
                ("priced", Some(n)) => {
                    s.0 += n;
                    s.2 += 1;
                }
                ("estimated", Some(n)) => {
                    s.1 += n;
                    s.2 += 1;
                }
                _ => {}
            }
        }
    }
    let label = format!("since={since} exact={exact}");
    assert_eq!(usage.percentiles_approximate, !exact, "{label}");
    assert_eq!(usage.totals.requests, requests, "{label}");
    assert_eq!(
        usage.totals.prompt_tokens as i64,
        models.values().map(|m| m.prompt).sum::<i64>(),
        "{label}"
    );
    assert_eq!(
        usage.totals.output_tokens as i64,
        models.values().map(|m| m.output).sum::<i64>(),
        "{label}"
    );
    assert_eq!(usage.models.len(), models.len(), "{label}");
    for (u, (model, m)) in usage.models.iter().zip(&mut models) {
        let label = format!("{label} model={model:?}");
        assert_eq!(u.model.as_deref(), *model, "{label}");
        assert_eq!(u.requests, m.requests, "{label}");
        assert_eq!(
            (u.prompt_tokens as i64, u.output_tokens as i64),
            (m.prompt, m.output),
            "{label}"
        );
        assert_eq!(u.total_load_ms, m.load_ns as f64 / 1e6, "{label}");
        // Mean of per-request ratios, never pooled tokens over pooled time.
        assert!(close(u.avg_prompt_tps, mean(&m.prompt_tps)), "{label}");
        assert!(close(u.avg_gen_tps, mean(&m.generation_tps)), "{label}");
        m.latencies.sort_by(f64::total_cmp);
        for (actual, p) in [(u.p50_latency_ms, 0.5), (u.p95_latency_ms, 0.95)] {
            let want = nearest(&m.latencies, p);
            if exact {
                assert_eq!(actual, want, "{label} p{p}");
            } else {
                // Fixed bins are at most 12.5% wide; the midpoint is within half.
                let (a, w) = (actual.unwrap(), want.unwrap());
                assert!(
                    (a - w).abs() <= 0.0625 * w + 1e-3,
                    "{label} p{p}: {a} vs {w}"
                );
            }
        }
    }
    for (i, family) in families.iter().enumerate() {
        let s = usage
            .spend_avoided
            .iter()
            .find(|s| &s.family == family)
            .unwrap();
        assert_eq!(s.usd, spend[i].0 as f64 / 1e9, "{label} {family}");
        assert_eq!(s.estimated_usd, spend[i].1 as f64 / 1e9, "{label} {family}");
        assert_eq!(
            s.unpriced_requests,
            requests - spend[i].2,
            "{label} {family}"
        );
    }
}

fn usage(db: &Connection, store: &pricing::Store, since: i64, exact: bool) -> Result<Usage> {
    let rows = data::usage_records(db, since, !exact, vec![])?;
    data::usage(store, "range".into(), rows)
}

/// Windows: unaligned, exact hour and day boundaries, a row's own timestamp
/// (inclusive) and one after it, around DST, and the whole history.
fn windows(rows: &[Row]) -> Vec<(i64, bool)> {
    let odd = ANCHOR + 137 * DAY_MS + 5 * HOUR_MS + 13 * 60_000 + 7;
    let mut windows = vec![
        (odd, true),
        (odd - odd % HOUR_MS, true),
        (odd - odd % DAY_MS, true),
        (rows[40].ts, true),
        (rows[40].ts + 1, true),
        (DST, true),
        (DST + 1, true),
        (DST - 2 * HOUR_MS - 1, true),
        (0, true),
        (odd, false),
        (DST - DST % DAY_MS, false),
        (0, false),
    ];
    windows.extend([3, 29, 30, 31].map(|d| (ANCHOR + SPAN - d * DAY_MS - 3 * HOUR_MS - 5, true)));
    windows
}

fn check_all(
    db: &Connection,
    store: &pricing::Store,
    rows: &[Row],
    families: &[String],
) -> Result<()> {
    for (since, exact) in windows(rows) {
        check(
            &usage(db, store, since, exact)?,
            rows,
            families,
            since,
            exact,
        );
    }
    Ok(())
}

fn scalar(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn rollups_plus_raw_edge_match_raw_across_windows_restarts_and_late_rows() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("requests.db");
    let pricing_path = temp.path().join("pricing.db");
    pricing::migrate(&pricing_path)?;
    let store = pricing::Store::open(&pricing_path)?;
    let families = costs::families()?;
    assert!(families.len() >= 2);
    let all: Vec<Row> = (1..=12_007).map(row).collect();
    let (early, late) = all.split_at(8_000);
    let mut db = data::open(&path)?;
    insert(&mut db, early, &families)?;
    // Before any verified rollup, usage reads every row raw.
    check_all(&db, &store, early, &families)?;
    assert_eq!(rollups::batch(&mut db, 1)?, rollups::Step::Rolled(5_000));
    check_all(&db, &store, early, &families)?;
    // Restart mid-backfill: a new connection resumes from the checkpoint.
    drop(db);
    let mut db = data::open(&path)?;
    let progress = rollups::run(&mut db, 2, rollups::BATCHES_PER_RUN)?;
    assert_eq!(
        (progress.rows, progress.caught_up, progress.verified),
        (3_000, true, true)
    );
    assert_eq!(scalar(&db, "SELECT last_id FROM rollup_state"), 8_000);
    check_all(&db, &store, early, &families)?;
    // Late arrivals: higher IDs, mostly older timestamps. Unrolled rows are
    // read raw even inside interior hours and days, never twice.
    insert(&mut db, late, &families)?;
    check_all(&db, &store, &all, &families)?;
    // A batch that fails before commit leaves aggregates and checkpoint intact.
    let before = scalar(&db, "SELECT SUM(requests) FROM request_daily");
    db.execute_batch(
        "CREATE TEMP TRIGGER fail BEFORE UPDATE ON rollup_state
         BEGIN SELECT RAISE(ABORT,'injected crash before checkpoint'); END",
    )?;
    let error = format!("{:#}", rollups::batch(&mut db, 3).unwrap_err());
    assert!(error.contains("injected crash"), "{error}");
    assert_eq!(
        scalar(&db, "SELECT SUM(requests) FROM request_daily"),
        before
    );
    assert_eq!(scalar(&db, "SELECT last_id FROM rollup_state"), 8_000);
    check_all(&db, &store, &all, &families)?;
    db.execute_batch("DROP TRIGGER fail")?;
    assert_eq!(rollups::batch(&mut db, 4)?, rollups::Step::Rolled(4_007));
    assert_eq!(rollups::batch(&mut db, 5)?, rollups::Step::CaughtUp);
    check_all(&db, &store, &all, &families)?;
    // Raw comparison: every bucket, dimension, family and status.
    let verified = rollups::verify(&db, 12_007)?;
    assert_eq!(verified.raw_requests, 12_007);
    assert_eq!(
        verified.dimension_keys as i64,
        scalar(
            &db,
            "SELECT COUNT(DISTINCT json_array(endpoint,model,user_key,actor_kind)) FROM requests"
        )
    );
    // NULL and "unattributed" identities, NULL and "" models stay distinct keys.
    assert_eq!(verified.dimension_keys, 3 * 4 * 4);
    assert_eq!(
        (verified.input_known, verified.output_known),
        (
            all.iter().filter(|r| r.prompt.is_some()).count() as i64,
            all.iter().filter(|r| r.output.is_some()).count() as i64
        )
    );
    assert!(all.iter().any(|r| r.prompt == Some(0)));
    for (i, family) in families.iter().enumerate() {
        let totals = &verified.families[family];
        let inference = all.iter().filter(|r| INFERENCE.contains(&r.endpoint));
        let want = |status: &str| {
            inference
                .clone()
                .filter(|r| cost(r.id, i).0 == status)
                .fold((0, 0), |(n, sum), r| {
                    (n + 1, sum + cost(r.id, i).1.unwrap_or(0))
                })
        };
        assert_eq!(
            (totals.priced_requests, totals.priced_nano_usd),
            want("priced")
        );
        assert_eq!(
            (totals.estimated_requests, totals.estimated_nano_usd),
            want("estimated")
        );
        assert_eq!(
            (totals.unpriced_requests, totals.unpriced_nano_usd),
            (want("unpriced").0, 0)
        );
    }
    // Hourly sums equal daily sums: the edge never overlaps the interior.
    assert_eq!(
        scalar(&db, "SELECT SUM(requests) FROM request_hourly"),
        scalar(&db, "SELECT SUM(requests) FROM request_daily")
    );
    assert_eq!(
        scalar(&db, "SELECT SUM(requests) FROM request_latency_hourly"),
        scalar(&db, "SELECT SUM(requests) FROM request_hourly")
    );
    Ok(())
}

/// Every public usage range at `now`, without the response time.
fn public_usage(
    db: &Connection,
    store: &pricing::Store,
    now: i64,
) -> Result<Vec<(i64, bool, serde_json::Value)>> {
    [1, 7, 30, 365]
        .into_iter()
        .map(|days| {
            let (since, exact) = (now - days * DAY_MS, days != 365);
            let mut value = serde_json::to_value(usage(db, store, since, exact)?)?;
            value.as_object_mut().unwrap().remove("generated_at_ms");
            Ok((since, exact, value))
        })
        .collect()
}

/// Prune to completion; returns the rows deleted, or the first refusal.
fn prune_all(db: &mut Connection, cutoff: i64) -> Result<std::result::Result<usize, String>> {
    let mut deleted = 0;
    loop {
        match retention::prune(db, cutoff)? {
            retention::Prune::Deleted(n) => {
                deleted += n;
                if n < retention::BATCH {
                    return Ok(Ok(deleted));
                }
            }
            retention::Prune::Nothing => return Ok(Ok(deleted)),
            retention::Prune::Refused(reason) => return Ok(Err(reason)),
        }
    }
}

#[test]
fn retention_gates_and_unchanged_usage_and_spend_after_pruning() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("requests.db");
    let pricing_path = temp.path().join("pricing.db");
    pricing::migrate(&pricing_path)?;
    let store = pricing::Store::open(&pricing_path)?;
    let families = costs::families()?;
    // The 400-day fixture ends at `now`; its first 35 days are expired.
    let now = ANCHOR + SPAN;
    let cutoff = now - retention::RETENTION_MS;
    let mut rows: Vec<Row> = (1..=8_000).map(row).collect();
    // Strict cutoff: exactly 365 days is kept, 365 days + 1 ms is pruned.
    rows[10].ts = cutoff;
    rows[11].ts = cutoff - 1;
    let mut db = data::open(&path)?;
    insert(&mut db, &rows, &families)?;
    let count = |db: &Connection| scalar(db, "SELECT COUNT(*) FROM requests");
    let refused = |db: &mut Connection| prune_all(db, cutoff).map(|r| r.unwrap_err());

    let reason = refused(&mut db)?;
    assert!(reason.starts_with("rollup unverified"), "{reason}");
    assert_eq!(rollups::batch(&mut db, 1)?, rollups::Step::Rolled(5_000));
    assert!(refused(&mut db)?.starts_with("rollup unverified"));
    assert!(rollups::run(&mut db, 2, rollups::BATCHES_PER_RUN)?.verified);

    // A late expired row above the checkpoint waits for the next rollup run.
    let late = Row {
        ts: cutoff - 5 * DAY_MS,
        endpoint: INFERENCE[0],
        ..row(8_001)
    };
    insert(&mut db, std::slice::from_ref(&late), &families)?;
    rows.push(late);
    assert_eq!(
        refused(&mut db)?,
        "rollup behind: expired request id 8001 is above the verified checkpoint 8000"
    );
    assert!(rollups::run(&mut db, 3, rollups::BATCHES_PER_RUN)?.caught_up);

    // Cost gates, one family at a time, then together.
    let family = &families[0];
    let set = |db: &Connection, sql: &str| {
        db.execute(
            &format!("UPDATE cost_backfill SET {sql} WHERE family=?1"),
            [family],
        )
        .unwrap()
    };
    set(&db, "completed_at_ms=NULL");
    assert_eq!(
        refused(&mut db)?,
        format!("backfill incomplete: {family} cost backfill has no completion time")
    );
    set(&db, "completed_at_ms=1,unpriced_from_id=12");
    let reason = refused(&mut db)?;
    assert!(
        reason.starts_with(&format!(
            "costs not frozen: {family} classifications through id "
        )),
        "{reason}"
    );
    // A walk still classifying expired IDs is not frozen either.
    set(&db, "unpriced_from_id=NULL,after_id=100,target_id=200");
    assert!(refused(&mut db)?.starts_with("costs not frozen"));
    // Pending work entirely above the expired IDs does not block.
    set(&db, "after_id=8001,target_id=9000,unpriced_from_id=8500");
    db.execute("UPDATE rollup_state SET verified_at_ms=NULL", [])?;
    let both = refused(&mut db)?;
    assert!(
        both.starts_with("rollup unverified") && !both.contains("costs not frozen"),
        "{both}"
    );
    db.execute("UPDATE rollup_state SET verified_at_ms=3", [])?;
    set(&db, "after_id=0,target_id=0,unpriced_from_id=NULL");
    assert_eq!(count(&db), 8_001);

    // Gates met: delete exactly the expired rows and their classifications.
    let before = public_usage(&db, &store, now)?;
    let costs_before = scalar(&db, "SELECT COUNT(*) FROM request_costs");
    let expired: Vec<&Row> = rows.iter().filter(|r| r.ts < cutoff).collect();
    assert!(!expired.is_empty());
    assert_eq!(prune_all(&mut db, cutoff)?, Ok(expired.len()));
    assert_eq!(count(&db), (rows.len() - expired.len()) as i64);
    let inference = expired
        .iter()
        .filter(|r| INFERENCE.contains(&r.endpoint))
        .count();
    assert_eq!(
        scalar(&db, "SELECT COUNT(*) FROM request_costs"),
        costs_before - (inference * families.len()) as i64
    );
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM requests WHERE id=11"), 1);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM requests WHERE id=12"), 0);
    // Rollups and spend rollups are untouched; every range's usage and spend
    // is identical and still matches the full raw history.
    assert_eq!(
        scalar(&db, "SELECT SUM(requests) FROM request_daily"),
        rows.len() as i64
    );
    let after = public_usage(&db, &store, now)?;
    assert_eq!(after, before);
    for (since, exact, _) in &after {
        check(
            &usage(&db, &store, *since, *exact)?,
            &rows,
            &families,
            *since,
            *exact,
        );
    }
    // Idempotent: nothing more is pruned on a rerun or after reopening.
    assert_eq!(
        retention::prune(&mut db, cutoff)?,
        retention::Prune::Nothing
    );
    drop(db);
    let mut db = data::open(&path)?;
    assert_eq!(
        retention::prune(&mut db, cutoff)?,
        retention::Prune::Nothing
    );
    assert_eq!(count(&db), (rows.len() - expired.len()) as i64);
    Ok(())
}

#[test]
fn strict_rollup_tables_reject_invalid_rows() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let db = data::open(&temp.path().join("requests.db"))?;
    let hour = 7 * HOUR_MS;
    let day = 3 * DAY_MS;
    let request = |table: &str, bucket: i64, key: &str, user: &str, actor: &str, n: &str| {
        format!(
            "INSERT INTO {table} VALUES({bucket},{key},'/api/chat','m',{user},'{actor}',{n},5,6,1,1,1.5,1,2.5,1,7,1)"
        )
    };
    let key = "json_array('/api/chat','m','u','human')";
    let valid = [
        request("request_hourly", hour, key, "'u'", "human", "2"),
        request("request_daily", day, key, "'u'", "human", "2"),
        format!("INSERT INTO request_latency_hourly VALUES({hour},{key},1,495,2)"),
        format!(
            "INSERT INTO spend_hourly VALUES({hour},'F',{key},'/api/chat','m','u','human',1,2,1,1,0)"
        ),
        format!(
            "INSERT INTO spend_daily VALUES({day},'F',{key},'/api/chat','m','u','human',1,2,1,1,0)"
        ),
        "INSERT INTO rollup_state VALUES('requests',0,0,NULL)".to_owned(),
    ];
    let spend_columns = "(bucket_ms,family,dimension_key,endpoint,model,user_key,actor_kind,priced_nano_usd,estimated_nano_usd,priced_requests,estimated_requests,unpriced_requests)";
    for sql in &valid {
        db.execute(sql, [])
            .map_err(|e| anyhow::anyhow!("{sql}: {e}"))?;
    }
    let other = "json_array('/api/chat','m','v','human')";
    for sql in [
        // Bucket alignment, nonnegative buckets and day width.
        request("request_hourly", hour + 1, other, "'v'", "human", "1"),
        request("request_hourly", -HOUR_MS, other, "'v'", "human", "1"),
        request("request_daily", day + HOUR_MS, other, "'v'", "human", "1"),
        // The key must equal json_array of the dimension columns.
        request("request_hourly", hour, key, "'v'", "human", "1"),
        request(
            "request_hourly",
            hour,
            "'[\"/api/chat\",\"m\",\"v\",\"human\"] '",
            "'v'",
            "human",
            "1",
        ),
        // Actor/user rule, nonnegative sums, STRICT types.
        request(
            "request_hourly",
            hour,
            "json_array('/api/chat','m',NULL,'human')",
            "NULL",
            "human",
            "1",
        ),
        request("request_hourly", hour, other, "'v'", "human", "-1"),
        request("request_hourly", hour, other, "'v'", "human", "'one'"),
        request("request_hourly", hour, other, "'v'", "human", "1.5"),
        // Histograms: known scheme, bins in range, positive counts, parent row.
        format!("INSERT INTO request_latency_hourly VALUES({hour},{key},1,496,1)"),
        format!("INSERT INTO request_latency_hourly VALUES({hour},{key},0,3,1)"),
        format!("INSERT INTO request_latency_hourly VALUES({hour},{key},1,3,0)"),
        format!("INSERT INTO request_latency_hourly VALUES({hour},{other},1,3,1)"),
        // Spend: nonnegative, parent request bucket, aligned.
        format!(
            "INSERT INTO spend_hourly{spend_columns} VALUES({hour},'G',{key},'/api/chat','m','u','human',-1,0,0,0,0)"
        ),
        format!(
            "INSERT INTO spend_hourly{spend_columns} VALUES({hour},'G',{other},'/api/chat','m','v','human',0,0,0,0,1)"
        ),
        format!(
            "INSERT INTO spend_daily{spend_columns} VALUES({hour},'G',{key},'/api/chat','m','u','human',0,0,0,0,1)"
        ),
        // Checkpoint: one API job, nonnegative IDs.
        "INSERT INTO rollup_state VALUES('gpu',0,0,NULL)".to_owned(),
        "UPDATE rollup_state SET last_id=-1".to_owned(),
        "UPDATE rollup_state SET verified_at_ms='soon'".to_owned(),
    ] {
        assert!(db.execute(&sql, []).is_err(), "accepted: {sql}");
    }
    for table in [
        "request_hourly",
        "request_daily",
        "request_latency_hourly",
        "request_latency_daily",
        "spend_hourly",
        "spend_daily",
        "rollup_state",
    ] {
        assert_eq!(
            scalar(
                &db,
                &format!("SELECT strict FROM pragma_table_list WHERE name='{table}'")
            ),
            1,
            "{table}"
        );
    }
    Ok(())
}

/// A v5 database as MET-204 leaves it in production: completed cost backfill,
/// priced and estimated classifications for two families, warnings, cursor
/// and other telemetry.
fn v5_fixture(path: &Path, families: &[String]) -> Result<Vec<Row>> {
    use factory_db::migrations::{Migration, checksum, run};
    let mut db = Connection::open(path)?;
    let sql = [
        include_str!("../src/ups_schema.sql"),
        include_str!("../src/devices_schema.sql"),
        include_str!("../src/network_schema.sql"),
        include_str!("../src/requests_v4.sql"),
        include_str!("../src/requests_v5.sql"),
    ];
    let manifest: Vec<_> = sql
        .iter()
        .enumerate()
        .map(|(i, sql)| Migration {
            version: i as u32 + 1,
            sql,
            checksum: checksum(sql),
        })
        .collect();
    run(&mut db, &manifest, None, |_, _| Ok(()), |_, _| Ok(()))?;
    costs::seed(&db, families, 1)?;
    let rows: Vec<Row> = (1..=6_101).map(row).collect();
    insert(&mut db, &rows, families)?;
    db.execute_batch(
        "UPDATE cost_backfill SET after_id=6101,target_id=6101,completed_at_ms=2;
         INSERT INTO warnings(message,first_seen_ms,last_seen_ms) VALUES('fixture warning',1,1);
         INSERT INTO ups_samples(ts_ms,energy_mwh,coverage_ms) VALUES(11,13,17);
         INSERT INTO device_samples(device_id,ts_ms,cpu_percent) VALUES('factory-gpu',19,23);
         ANALYZE;",
    )?;
    Ok(rows)
}

fn table_counts(path: &Path) -> Result<BTreeMap<String, i64>> {
    let db = Connection::open(path)?;
    let tables: Vec<String> = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    tables
        .into_iter()
        .map(|t| {
            Ok((
                t.clone(),
                scalar(&db, &format!("SELECT COUNT(*) FROM \"{t}\"")),
            ))
        })
        .collect()
}

#[test]
fn v5_fixture_migrates_backfills_verifies_and_rolls_back_from_backup() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("requests.db");
    let families = costs::families()?;
    let rows = v5_fixture(&path, &families)?;
    let before = table_counts(&path)?;
    assert_eq!(before["requests"], 6_101);
    // Runtime refuses v5; only the offline command migrates, after a backup.
    let error = data::open(&path).unwrap_err().to_string();
    assert!(error.contains("user_version=6, found 5"), "{error}");
    let backup = temp.path().join("backup.db");
    Connection::open(&path)?.execute_batch(&format!("VACUUM INTO '{}'", backup.display()))?;
    let mut reports = Vec::new();
    for _ in 0..2 {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_factory-api"))
            .args(["migrate", "--requests-db"])
            .arg(&path)
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout)?;
        let (first, json) = stdout.split_once('\n').unwrap();
        assert!(first.starts_with("requests user_version=6;"), "{first}");
        reports.push(serde_json::from_str::<serde_json::Value>(json)?);
    }
    // First run: two 5,000-row-max batches, then the published comparison.
    let report = &reports[0];
    assert_eq!(report["progress"]["batches"], 2);
    assert_eq!(report["progress"]["rows"], 6_101);
    assert_eq!(report["progress"]["verified"], true);
    assert_eq!(report["last_id"], 6_101);
    assert_eq!(report["comparison"]["raw_requests"], 6_101);
    // The rerun resumes at the checkpoint: no new batches, same comparison.
    assert_eq!(reports[1]["progress"]["batches"], 0);
    assert_eq!(reports[1]["comparison"], report["comparison"]);
    let after = table_counts(&path)?;
    for (table, count) in &before {
        assert_eq!(after[table], *count, "{table}");
    }
    assert_eq!(after["rollup_state"], 1);
    let db = data::open(&path)?;
    assert_eq!(scalar(&db, "PRAGMA user_version"), 6);
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM rollup_state WHERE last_id=6101 AND verified_at_ms IS NOT NULL"
        ),
        1
    );
    pricing::migrate(temp.path().join("pricing.db"))?;
    let store = pricing::Store::open(temp.path().join("pricing.db"))?;
    check_all(&db, &store, &rows, &families)?;
    drop(db);
    // Backup-gated rollback: restore the verified pre-migration snapshot.
    for suffix in ["-wal", "-shm", ""] {
        let file = format!("{}{suffix}", path.display());
        if Path::new(&file).exists() {
            std::fs::rename(&file, format!("{file}.displaced"))?;
        }
    }
    std::fs::copy(&backup, &path)?;
    assert_eq!(table_counts(&path)?, before);
    assert_eq!(scalar(&Connection::open(&path)?, "PRAGMA user_version"), 5);
    assert!(data::open(&path).is_err());
    Ok(())
}
