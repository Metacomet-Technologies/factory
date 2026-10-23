//! MET-204 frozen request costs: event-time provenance, immutability, failure
//! handling, resumable backfill, budgets/plans and the v4 -> v5 migration.
use anyhow::Result;
use axum::{Json, Router, extract::Query, routing::get};
use factory_api::{
    AppState,
    costs::{self, Status},
    data, fleet, now_ms, rollups,
};
use factory_db::{Category, Scope, Tracked, rollup};
use rusqlite::Connection;
use shared::RequestRecord;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, RwLock, atomic::Ordering},
};

const SONNET: &str = "Claude Sonnet";
const GPT: &str = "ChatGPT mid-tier";
const SONNET_MODEL: &str = "anthropic/claude-sonnet-5.5";
const GPT_MODEL: &str = "openai/gpt-5.6-sol";

fn model(id: &str, input: i64, output: i64) -> pricing::Model {
    pricing::Model {
        model_id: id.into(),
        input_micro_usd_per_mtok: input,
        output_micro_usd_per_mtok: output,
        released_at_ms: Some(1),
    }
}

fn references() -> Vec<pricing::Reference> {
    pricing::parse_references(pricing::DEFAULT_CONFIG).unwrap()
}

/// Both sources carry the same rates, as in a healthy refresh.
fn refresh(store: &mut pricing::Store, at: i64, sonnet: (i64, i64), gpt: (i64, i64)) -> Result<()> {
    let models = [
        model(SONNET_MODEL, sonnet.0, sonnet.1),
        model(GPT_MODEL, gpt.0, gpt.1),
    ];
    store.refresh(&references(), &models, &models, at, vec![])?;
    Ok(())
}

fn scalar(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn snapshot_id(
    store: &pricing::Store,
    fetched: i64,
    refresh: i64,
    source: &str,
    model: &str,
) -> i64 {
    store
        .connection()
        .query_row(
            "SELECT p.id FROM price_snapshots p JOIN refreshes r ON r.id=p.refresh_id
             WHERE p.fetched_at_ms=?1 AND p.source=?3 AND p.model_id=?4
             ORDER BY r.id LIMIT 1 OFFSET ?2",
            rusqlite::params![fetched, refresh, source, model],
            |r| r.get(0),
        )
        .unwrap()
}

fn selection_id(store: &pricing::Store, family: &str) -> i64 {
    store
        .connection()
        .query_row(
            "SELECT id FROM reference_selection WHERE family=?1 AND confirmed=1 ORDER BY id LIMIT 1",
            [family],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn asymmetric_event_time_boundaries_ties_and_token_nulls() -> Result<()> {
    let mut store = pricing::Store::in_memory()?;
    let refs = references();
    // At 100, LiteLLM disagrees; OpenRouter wins the same-refresh source tie.
    store.refresh(
        &refs,
        &[
            model(SONNET_MODEL, 2_000_000, 7_000_000),
            model(GPT_MODEL, 1_000_000, 4_000_000),
        ],
        &[
            model(SONNET_MODEL, 3_000_000, 9_000_000),
            model(GPT_MODEL, 1_500_000, 5_000_000),
        ],
        100,
        vec![],
    )?;
    store.confirm(SONNET, 150)?;
    // Two refreshes in the same millisecond: the later refresh wins from 200 on.
    store.refresh(
        &refs,
        &[
            model(SONNET_MODEL, 4_000_000, 8_000_000),
            model(GPT_MODEL, 6, 6),
        ],
        &[],
        200,
        vec![],
    )?;
    store.refresh(
        &refs,
        &[
            model(SONNET_MODEL, 5_000_000, 9_000_000),
            model(GPT_MODEL, 1_100_000, 4_400_000),
        ],
        &[],
        200,
        vec![],
    )?;
    // The second family's boundary is one millisecond later than the first's tie.
    store.confirm(GPT, 201)?;
    let sonnet = costs::History::load(&store, SONNET)?;
    let gpt = costs::History::load(&store, GPT)?;
    let first_sonnet = snapshot_id(&store, 100, 0, "openrouter", SONNET_MODEL);
    let late_sonnet = snapshot_id(&store, 200, 1, "openrouter", SONNET_MODEL);
    let first_gpt = snapshot_id(&store, 100, 0, "openrouter", GPT_MODEL);
    let late_gpt = snapshot_id(&store, 200, 1, "openrouter", GPT_MODEL);
    let check = |history: &costs::History,
                 ts: i64,
                 status: Status,
                 snapshot: i64,
                 nano: i64|
     -> Result<()> {
        let cost = costs::classify(history, 1, ts, Some(1000), Some(2000))?;
        let provenance = cost.provenance.as_ref().unwrap();
        assert_eq!(
            (cost.status, provenance.snapshot_id, cost.nano_usd),
            (status, snapshot, Some(nano)),
            "{} at {ts}",
            history.family
        );
        let selection = selection_id(&store, &history.family);
        assert_eq!(provenance.selection_id, selection);
        // Independent oracle: pricing's own per-request cost at the event time.
        match status {
            Status::Priced => assert_eq!(store.cost(&history.family, 1000, 2000, ts)?.0, nano),
            _ => assert!(store.cost(&history.family, 1000, 2000, ts).is_err()),
        }
        Ok(())
    };
    // (1000 * input + 2000 * output + 500) / 1000 nano-USD.
    check(&sonnet, 149, Status::Estimated, first_sonnet, 16_000_000)?;
    check(&sonnet, 150, Status::Priced, first_sonnet, 16_000_000)?;
    check(&sonnet, 199, Status::Priced, first_sonnet, 16_000_000)?;
    check(&sonnet, 200, Status::Priced, late_sonnet, 23_000_000)?;
    check(&gpt, 200, Status::Estimated, first_gpt, 9_000_000)?;
    check(&gpt, 201, Status::Priced, late_gpt, 9_900_000)?;
    // Unknown tokens stay NULL/unpriced; known zero tokens are a priced zero.
    for (prompt, output) in [(None, Some(1)), (Some(1), None), (None, None)] {
        let cost = costs::classify(&sonnet, 1, 200, prompt, output)?;
        assert_eq!(
            (cost.status, cost.nano_usd, &cost.provenance),
            (Status::Unpriced, None, &None)
        );
        assert!(!cost.awaiting_price);
    }
    let zero = costs::classify(&sonnet, 1, 200, Some(0), Some(0))?;
    assert_eq!((zero.status, zero.nano_usd), (Status::Priced, Some(0)));
    Ok(())
}

#[test]
fn freeze_refuses_i64_overflow_and_stops_at_that_request() -> Result<()> {
    let mut store = pricing::Store::in_memory()?;
    refresh(&mut store, 1, (2_000_000, 0), (2_000_000, 0))?;
    store.confirm(SONNET, 2)?;
    store.confirm(GPT, 2)?;
    let histories = costs::load(&store, &costs::families()?);
    let record = |id, prompt| RequestRecord {
        id,
        ts: 3,
        endpoint: "/api/chat".into(),
        prompt_eval_count: Some(prompt),
        eval_count: Some(0),
        ..Default::default()
    };
    // i64::MAX tokens at 2 USD/Mtok exceeds i64 nano-USD; it is refused, not saturated.
    let mut records = vec![record(1, 5), record(2, i64::MAX as u64), record(3, 5)];
    let (frozen, stopped) = costs::freeze(&histories, &mut records);
    assert_eq!(records.iter().map(|r| r.id).collect::<Vec<_>>(), [1]);
    assert_eq!(frozen.len(), 2);
    assert!(
        stopped
            .unwrap()
            .to_string()
            .contains("stopped at meter id 2"),
    );
    // A pricing storage failure stops before the first inference request.
    let mut records = vec![
        RequestRecord {
            endpoint: "/api/ps".into(),
            ..record(1, 5)
        },
        record(2, 5),
    ];
    let failed = Err(anyhow::anyhow!("disk I/O error"));
    let (frozen, stopped) = costs::freeze(&failed, &mut records);
    assert!(frozen.is_empty());
    assert_eq!(records.len(), 1);
    assert!(
        stopped
            .unwrap()
            .to_string()
            .contains("pricing history unavailable")
    );
    Ok(())
}

#[test]
fn strict_types_constraints_and_only_unpriced_to_estimated() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let db = data::open(&temp.path().join("requests.db"))?;
    assert_eq!(scalar(&db, "PRAGMA user_version"), 6);
    for table in ["request_costs", "cost_backfill"] {
        let strict: i64 = db.query_row(
            "SELECT strict FROM pragma_table_list WHERE name=?1",
            [table],
            |r| r.get(0),
        )?;
        assert_eq!(strict, 1, "{table}");
    }
    db.execute_batch(
        "INSERT INTO requests(id,ts_ms,endpoint,latency_ms,status,stream,client_ip,client_hostname)
         VALUES (1,10,'/api/chat',1.0,200,0,'ip','host'),(2,10,'/api/chat',1.0,200,0,'ip','host')",
    )?;
    let columns = "request_id,family,priced_at_ms,cost_status,cost_nano_usd,selection_id,snapshot_id,reference_model_id,input_micro_usd_per_mtok,output_micro_usd_per_mtok";
    let insert = |values: &str| {
        db.execute_batch(&format!(
            "INSERT INTO request_costs({columns}) VALUES {values}"
        ))
    };
    insert("(1,'f',5,'priced',100,1,2,'m',3,4)")?;
    insert("(1,'g',5,'estimated',0,1,2,'m',0,0)")?;
    insert("(2,'f',5,'unpriced',NULL,NULL,NULL,NULL,NULL,NULL)")?;
    for invalid in [
        "(2,'g',5,'priced',1.5,1,2,'m',3,4)",
        "(2,'g',5,'priced','abc',1,2,'m',3,4)",
        "(2,'g','5ms','priced',1,1,2,'m',3,4)",
        "(2,'g',5,'priced',1,1,2,'m',2.5,4)",
        "(2,'g',5,'priced',-1,1,2,'m',3,4)",
        "(2,'g',-5,'priced',1,1,2,'m',3,4)",
        "(2,'g',5,'free',1,1,2,'m',3,4)",
        "(2,'g',5,'priced',NULL,1,2,'m',3,4)",
        "(2,'g',5,'estimated',1,1,NULL,'m',3,4)",
        "(2,'g',5,'priced',1,1,2,'m',-3,4)",
        "(2,'g',5,'unpriced',0,NULL,NULL,NULL,NULL,NULL)",
        "(2,'g',5,'unpriced',NULL,NULL,NULL,'m',NULL,NULL)",
        "(2,'',5,'unpriced',NULL,NULL,NULL,NULL,NULL,NULL)",
        "(99,'g',5,'unpriced',NULL,NULL,NULL,NULL,NULL,NULL)",
        "(1,'f',5,'unpriced',NULL,NULL,NULL,NULL,NULL,NULL)",
    ] {
        assert!(insert(invalid).is_err(), "{invalid}");
    }
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM request_costs"), 3);
    let update = |sql: &str| db.execute_batch(&format!("UPDATE request_costs SET {sql}"));
    let frozen = "SELECT group_concat(quote(cost_status)||quote(cost_nano_usd)||quote(snapshot_id),';') FROM (SELECT * FROM request_costs ORDER BY 1,2)";
    let before: String = db.query_row(frozen, [], |r| r.get(0))?;
    for rewrite in [
        "cost_nano_usd=101 WHERE request_id=1 AND family='f'",
        "priced_at_ms=6 WHERE request_id=1 AND family='f'",
        "cost_status='estimated' WHERE request_id=1 AND family='f'",
        "cost_status='priced' WHERE request_id=1 AND family='g'",
        "snapshot_id=3 WHERE request_id=1 AND family='g'",
        "cost_status='priced',cost_nano_usd=1,selection_id=1,snapshot_id=2,reference_model_id='m',input_micro_usd_per_mtok=1,output_micro_usd_per_mtok=1 WHERE request_id=2",
        "request_id=1,family='h',cost_status='estimated',cost_nano_usd=1,selection_id=1,snapshot_id=2,reference_model_id='m',input_micro_usd_per_mtok=1,output_micro_usd_per_mtok=1 WHERE request_id=2",
    ] {
        assert!(update(rewrite).is_err(), "{rewrite}");
    }
    assert_eq!(db.query_row(frozen, [], |r| r.get::<_, String>(0))?, before);
    update(
        "cost_status='estimated',cost_nano_usd=7,selection_id=1,snapshot_id=2,reference_model_id='m',input_micro_usd_per_mtok=1,output_micro_usd_per_mtok=1 WHERE request_id=2",
    )?;
    assert!(update("cost_status='unpriced',cost_nano_usd=NULL,selection_id=NULL,snapshot_id=NULL,reference_model_id=NULL,input_micro_usd_per_mtok=NULL,output_micro_usd_per_mtok=NULL WHERE request_id=2").is_err());
    // Raw request deletion (future retention) cascades to its classifications.
    db.execute("DELETE FROM requests WHERE id=1", [])?;
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM request_costs"), 1);
    Ok(())
}

type Records = Arc<RwLock<Vec<RequestRecord>>>;

async fn meter(records: Records) -> Result<(String, tokio::task::JoinHandle<()>)> {
    let app = Router::new().route(
        "/meter/requests",
        get(move |Query(q): Query<BTreeMap<String, String>>| {
            let records = records.clone();
            async move {
                let cursor: i64 = q["after_id"].parse().unwrap();
                let rows: Vec<_> = records
                    .read()
                    .unwrap()
                    .iter()
                    .filter(|r| r.id > cursor)
                    .take(500)
                    .cloned()
                    .collect();
                let next = rows.last().map_or(cursor, |r| r.id);
                ([("next_after_id", next.to_string())], Json(rows))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    Ok((
        url,
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
    ))
}

async fn state(dir: &Path, url: String) -> Result<AppState> {
    let pricing_db = dir.join("pricing.db");
    if !pricing_db.exists() {
        pricing::migrate(&pricing_db)?;
    }
    let state = AppState::new(
        url,
        dir.join("requests.db"),
        pricing_db,
        fleet::Config { nodes: vec![] },
    )
    .await?;
    state.db.clock_synchronized.store(true, Ordering::Release);
    Ok(state)
}

async fn price(state: &AppState, at: i64, sonnet: (i64, i64), confirm: bool) -> Result<()> {
    state
        .db
        .write_pricing(&Scope::default(), move |store| {
            refresh(store, at, sonnet, (2_000_000, 10_000_000))?;
            if confirm {
                store.confirm(SONNET, at)?;
                store.confirm(GPT, at)?;
            }
            Ok(())
        })
        .await
}

fn request(id: i64, ts: i64, prompt: Option<u64>, output: Option<u64>) -> RequestRecord {
    RequestRecord {
        id,
        ts,
        endpoint: "/api/chat".into(),
        model: Some("local".into()),
        prompt_eval_count: prompt,
        eval_count: output,
        status: 200,
        ..Default::default()
    }
}

/// Every stored classification column, in key order.
fn frozen_rows(path: &Path) -> Vec<String> {
    let db = Connection::open(path).unwrap();
    db.prepare("SELECT quote(request_id)||quote(family)||quote(priced_at_ms)||quote(cost_status)||quote(cost_nano_usd)||quote(selection_id)||quote(snapshot_id)||quote(reference_model_id)||quote(input_micro_usd_per_mtok)||quote(output_micro_usd_per_mtok) FROM request_costs ORDER BY request_id,family")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn spend(usage: &factory_api::types::Usage, family: &str) -> (f64, f64, usize) {
    let s = usage
        .spend_avoided
        .iter()
        .find(|s| s.family == family)
        .unwrap();
    (s.usd, s.estimated_usd, s.unpriced_requests)
}

#[tokio::test]
async fn frozen_rows_survive_later_prices_and_retried_upserts() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("requests.db");
    let at = now_ms();
    let records: Records = Arc::new(RwLock::new(vec![
        request(1, at - 1000, Some(3), Some(7)),
        request(2, at - 2000, Some(3), Some(7)),
        request(3, at - 1000, Some(3), Some(7)),
        request(4, at - 1000, Some(3), None),
        RequestRecord {
            endpoint: "/api/ps".into(),
            ..request(5, at - 1000, Some(3), Some(7))
        },
    ]));
    let (url, server) = meter(records.clone()).await?;
    let state = state(temp.path(), url).await?;
    price(&state, at - 10_000, (3_000_000, 15_000_000), true).await?;
    state.sync_meter().await?;
    let first = frozen_rows(&path);
    // Four inference requests x two families; no classification for /api/ps.
    assert_eq!(first.len(), 8);
    assert!(!first.iter().any(|r| r.starts_with("5'")));
    // A later price applies only to requests at or after its observation.
    price(&state, at - 500, (9_000_000, 45_000_000), false).await?;
    records
        .write()
        .unwrap()
        .push(request(6, at, Some(3), Some(7)));
    state.sync_meter().await?;
    let second = frozen_rows(&path);
    assert_eq!(&second[..8], &first[..]);
    let db = Connection::open(&path)?;
    let cost = |id: i64, family: &str| -> Option<i64> {
        db.query_row(
            "SELECT cost_nano_usd FROM request_costs WHERE request_id=?1 AND family=?2",
            rusqlite::params![id, family],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(
        (cost(1, SONNET), cost(6, SONNET)),
        (Some(114_000), Some(342_000))
    );
    assert_eq!((cost(1, GPT), cost(6, GPT)), (Some(76_000), Some(76_000)));
    assert_eq!(cost(4, SONNET), None);
    // Retried upserts with other values never reprice a frozen row.
    let retry = |id, status, nano| costs::Cost {
        request_id: id,
        family: SONNET.into(),
        status,
        nano_usd: nano,
        provenance: Some(costs::Provenance {
            selection_id: 1,
            snapshot_id: 1,
            model_id: "other".into(),
            input_micro_usd_per_mtok: 1,
            output_micro_usd_per_mtok: 1,
        }),
        awaiting_price: false,
    };
    state
        .db
        .write(&Scope::default(), move |db| {
            costs::store(
                db,
                &[
                    retry(1, Status::Estimated, Some(1)),
                    retry(2, Status::Priced, Some(2)),
                    retry(4, Status::Priced, Some(3)),
                ],
                now_ms(),
            )
        })
        .await?;
    assert_eq!(frozen_rows(&path), second);
    let usage = state.usage("30d".into(), 0).await?;
    assert_eq!(usage.totals.requests, 5);
    assert_eq!(
        spend(&usage, SONNET),
        ((3.0 * 114_000.0 + 342_000.0) / 1e9, 0.0, 1)
    );
    assert!(usage.warnings.is_empty(), "{:?}", usage.warnings);
    // Request 2 lies inside the window's id span but before its start time.
    let usage = state.usage("30d".into(), at - 1500).await?;
    assert_eq!(usage.totals.requests, 4);
    assert_eq!(
        spend(&usage, SONNET),
        ((2.0 * 114_000.0 + 342_000.0) / 1e9, 0.0, 1)
    );
    // With nothing to backfill, a poll reads only the state rows.
    let scope = Scope::default();
    let mut idle = state.clone();
    idle.query_scope = scope.clone();
    idle.backfill_costs().await?;
    assert_eq!(scope.counts().data, 1);
    state.db.close().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn unpriced_rows_become_estimated_only_after_a_reference_price() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("requests.db");
    let at = now_ms();
    let records: Records = Arc::new(RwLock::new(vec![
        request(1, at - 3000, Some(3), Some(7)),
        request(2, at - 3000, Some(3), Some(7)),
        request(3, at - 3000, Some(0), Some(0)),
        request(4, at - 3000, None, Some(7)),
    ]));
    let (url, server) = meter(records.clone()).await?;
    let state = state(temp.path(), url).await?;
    state.sync_meter().await?;
    let db = Connection::open(&path)?;
    let statuses = || -> Vec<(i64, String, String)> {
        db.prepare("SELECT request_id,family,cost_status FROM request_costs ORDER BY 1,2")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert!(statuses().iter().all(|(_, _, s)| s == "unpriced"));
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM cost_backfill WHERE unpriced_from_id=1"
        ),
        2
    );
    // Without any reference price, the fill-in has nothing to apply.
    state.backfill_costs().await?;
    assert!(statuses().iter().all(|(_, _, s)| s == "unpriced"));
    // Roll the unpriced rows up, so the fill-in must rewrite their spend buckets.
    let rolled = state.roll_up().await?;
    assert!(rolled.caught_up && rolled.verified, "{rolled:?}");
    assert_eq!(
        scalar(&db, "SELECT SUM(unpriced_requests) FROM spend_daily"),
        8
    );
    let before: i64 = scalar(&db, "SELECT MAX(priced_at_ms) FROM request_costs");
    price(&state, at - 1000, (3_000_000, 15_000_000), true).await?;
    // A request after confirmation is priced at ingestion.
    records
        .write()
        .unwrap()
        .push(request(5, at, Some(3), Some(7)));
    state.sync_meter().await?;
    state.backfill_costs().await?;
    let expected: Vec<_> = [
        (1, "estimated"),
        (2, "estimated"),
        (3, "estimated"),
        (4, "unpriced"),
        (5, "priced"),
    ]
    .into_iter()
    .flat_map(|(id, status)| [GPT, SONNET].map(|family| (id, family.to_owned(), status.to_owned())))
    .collect();
    assert_eq!(statuses(), expected);
    // The fill-in records when the estimate was frozen.
    assert_eq!(
        scalar(
            &db,
            &format!(
                "SELECT COUNT(*) FROM request_costs WHERE cost_status='estimated' AND priced_at_ms<{before}"
            )
        ),
        0
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM cost_backfill WHERE unpriced_from_id IS NULL AND after_id>=target_id AND completed_at_ms IS NOT NULL"
        ),
        2
    );
    let usage = state.usage("30d".into(), 0).await?;
    assert_eq!(spend(&usage, SONNET), (114_000.0 / 1e9, 228_000.0 / 1e9, 1));
    assert!(usage.warnings.is_empty(), "{:?}", usage.warnings);
    // Rolled buckets were rewritten in the fill-in transactions: hourly and
    // daily spend match the frozen rows exactly, and usage is unchanged once
    // request 5 is rolled up too.
    assert_eq!(
        scalar(
            &db,
            "SELECT SUM(estimated_requests)*1000+SUM(unpriced_requests) FROM spend_daily WHERE family='Claude Sonnet'"
        ),
        3001
    );
    let rolled = state.roll_up().await?;
    assert!(
        rolled.caught_up && rolled.verified && rolled.rows == 1,
        "{rolled:?}"
    );
    let verified = factory_api::rollups::verify(&db, 5)?;
    assert_eq!(verified.families[SONNET].estimated_requests, 3);
    assert_eq!(verified.families[SONNET].priced_requests, 1);
    let after = state.usage("30d".into(), 0).await?;
    assert_eq!(spend(&after, SONNET), spend(&usage, SONNET));
    assert_eq!(spend(&after, GPT), spend(&usage, GPT));
    state.db.close().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn overflow_and_pricing_failures_stop_ingestion_at_the_request() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("requests.db");
    let at = now_ms();
    let records: Records = Arc::new(RwLock::new(vec![
        request(1, at, Some(3), Some(7)),
        request(2, at, Some(3), Some(7)),
        request(3, at, Some(i64::MAX as u64), Some(7)),
        request(4, at, Some(3), Some(7)),
    ]));
    let (url, server) = meter(records.clone()).await?;
    let state = state(temp.path(), url).await?;
    price(&state, at - 1000, (3_000_000, 15_000_000), true).await?;
    for attempt in 0..2 {
        let error = state.sync_meter().await.unwrap_err().to_string();
        assert!(error.contains("stopped at meter id 3"), "{error}");
        let db = Connection::open(&path)?;
        assert_eq!(scalar(&db, "SELECT COUNT(*) FROM requests"), 2);
        assert_eq!(scalar(&db, "SELECT last_after_id FROM sync_state"), 2);
        assert_eq!(scalar(&db, "SELECT COUNT(*) FROM request_costs"), 4);
        // The retry stops at its first record; that is not a caught-up empty page.
        if attempt == 0 {
            db.execute_batch("UPDATE sync_state SET rebuilding=1,synced_at_ms=7")?;
        } else {
            assert_eq!(
                scalar(&db, "SELECT rebuilding*10+synced_at_ms FROM sync_state"),
                17
            );
            db.execute_batch("UPDATE sync_state SET rebuilding=0")?;
        }
    }
    let usage = state.usage("30d".into(), 0).await?;
    assert!(
        usage
            .warnings
            .iter()
            .any(|w| w.starts_with("meter: cost freeze stopped at meter id 3")),
        "{:?}",
        usage.warnings
    );
    records.write().unwrap()[2].prompt_eval_count = Some(3);
    state.sync_meter().await?;
    // Pricing storage failure: nothing at or after the first inference request commits.
    let pricing_db = Connection::open(temp.path().join("pricing.db"))?;
    pricing_db.execute_batch("ALTER TABLE price_snapshots RENAME TO price_snapshots_moved")?;
    records.write().unwrap().extend([
        RequestRecord {
            endpoint: "/api/tags".into(),
            ..request(5, at, None, None)
        },
        request(6, at, Some(3), Some(7)),
    ]);
    let error = state.sync_meter().await.unwrap_err().to_string();
    assert!(error.contains("stopped at meter id 6"), "{error}");
    assert!(error.contains("pricing history unavailable"), "{error}");
    let db = Connection::open(&path)?;
    assert_eq!(scalar(&db, "SELECT last_after_id FROM sync_state"), 5);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM request_costs"), 8);
    // Backfill also pauses visibly rather than classifying without history.
    db.execute_batch("UPDATE cost_backfill SET completed_at_ms=NULL")?;
    let error = format!("{:#}", state.backfill_costs().await.unwrap_err());
    assert!(error.contains("cost backfill paused"), "{error}");
    pricing_db.execute_batch("ALTER TABLE price_snapshots_moved RENAME TO price_snapshots")?;
    state.sync_meter().await?;
    state.backfill_costs().await?;
    assert_eq!(scalar(&db, "SELECT last_after_id FROM sync_state"), 6);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM request_costs"), 10);
    assert!(state.usage("30d".into(), 0).await?.warnings.is_empty());
    state.db.close().await?;
    server.abort();
    Ok(())
}

/// A v4 database exactly as MET-203 leaves it: deployed SQL, typed replica,
/// cursor, resolved/unresolved warnings, archived legacy rows and telemetry.
fn v4_fixture(path: &Path, base: i64) -> Result<()> {
    use factory_db::migrations::{Migration, checksum, run};
    let mut db = Connection::open(path)?;
    db.execute_batch(concat!(
        include_str!("../src/ups_schema.sql"),
        include_str!("../src/devices_schema.sql"),
        include_str!("../src/network_schema.sql")
    ))?;
    db.execute_batch(
        "PRAGMA user_version=3;
         INSERT INTO requests VALUES(1,1,'legacy fixture');
         INSERT INTO warnings VALUES('legacy warning');
         INSERT INTO ups_samples(ts_ms,energy_mwh,coverage_ms) VALUES(11,13,17);
         INSERT INTO device_samples(device_id,ts_ms,cpu_percent) VALUES('factory-gpu',19,23);
         INSERT INTO net_speed_tests(device_id,started_ms,ended_ms,outcome,error,download_bytes,upload_bytes)
             VALUES('factory-gpu',29,31,'failed','fixture failure',37,41);",
    )?;
    let sql = [
        include_str!("../src/ups_schema.sql"),
        include_str!("../src/devices_schema.sql"),
        include_str!("../src/network_schema.sql"),
        include_str!("../src/requests_v4.sql"),
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
    db.execute(
        "WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<1207)
         INSERT INTO requests(id,ts_ms,endpoint,model,prompt_eval_count,eval_count,latency_ms,status,stream,client_ip,client_hostname)
         SELECT id,?1+id*1000,CASE WHEN id%10=0 THEN '/api/ps' ELSE '/api/chat' END,'local',
                CASE WHEN id%13=0 THEN 0 ELSE 3 END,
                CASE WHEN id%17=0 THEN NULL WHEN id%13=0 THEN 0 ELSE 7 END,
                1.5,200,0,'100.64.0.1','host'
         FROM n WHERE id NOT BETWEEN 340 AND 421",
        [base],
    )?;
    db.execute_batch(
        "UPDATE sync_state SET last_after_id=1207,synced_at_ms=5,rebuilding=0;
         INSERT INTO warnings(message,first_seen_ms,last_seen_ms,first_id,last_id)
             VALUES('gap: meter ids 340..421 are absent from cursor history',1,1,340,421);
         INSERT INTO warnings(message,first_seen_ms,last_seen_ms,resolved_at_ms) VALUES('legacy warning',1,1,2);",
    )?;
    Ok(())
}

fn table_counts(path: &Path) -> Result<BTreeMap<String, i64>> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let tables: Vec<String> = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    tables
        .into_iter()
        .map(|t| {
            let n = db.query_row(&format!("SELECT COUNT(*) FROM \"{t}\""), [], |r| r.get(0))?;
            Ok((t, n))
        })
        .collect()
}

/// Expected classification for a fixture request, computed without the
/// production classifier: (status, nano-USD) per family.
fn expected(id: i64, family: &str) -> Option<(&'static str, Option<i64>)> {
    if id % 10 == 0 || (340..=421).contains(&id) {
        return None;
    }
    if id % 17 == 0 {
        return Some(("unpriced", None));
    }
    let (prompt, output) = if id % 13 == 0 { (0, 0) } else { (3, 7) };
    let (first, later) = if family == SONNET {
        ((3_000_000, 15_000_000), (6_000_000, 30_000_000))
    } else {
        ((2_000_000, 10_000_000), (4_000_000, 20_000_000))
    };
    // Confirmed exactly at request 301's time; second rates observed at 801's.
    let (status, (input, out)) = match id {
        ..301 => ("estimated", first),
        301..801 => ("priced", first),
        _ => ("priced", later),
    };
    Some((status, Some((prompt * input + output * out + 500) / 1000)))
}

#[tokio::test]
async fn v4_fixture_migrates_resumes_backfill_and_rolls_back_from_backup() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("requests.db");
    let base = now_ms() - 2 * 86_400_000;
    v4_fixture(&path, base)?;
    let before = table_counts(&path)?;
    assert_eq!(before["requests"], 1125);
    pricing::migrate(temp.path().join("pricing.db"))?;
    {
        let mut store = pricing::Store::open(temp.path().join("pricing.db"))?;
        refresh(
            &mut store,
            base,
            (3_000_000, 15_000_000),
            (2_000_000, 10_000_000),
        )?;
        store.confirm(SONNET, base + 301_000)?;
        store.confirm(GPT, base + 301_000)?;
        refresh(
            &mut store,
            base + 801_000,
            (6_000_000, 30_000_000),
            (4_000_000, 20_000_000),
        )?;
    }
    // Runtime refuses v4; only the offline command migrates, after a backup.
    let error = data::open(&path).unwrap_err().to_string();
    assert!(error.contains("user_version=6, found 4"), "{error}");
    let backup = temp.path().join("backup.db");
    Connection::open(&path)?.execute_batch(&format!("VACUUM INTO '{}'", backup.display()))?;
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
        assert!(String::from_utf8(output.stdout)?.starts_with("requests user_version=6;"));
    }
    let after = table_counts(&path)?;
    for (table, count) in &before {
        assert_eq!(after[table], *count, "{table}");
    }
    assert_eq!((after["request_costs"], after["cost_backfill"]), (0, 2));
    let db = Connection::open(&path)?;
    assert_eq!(scalar(&db, "PRAGMA user_version"), 6);
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM cost_backfill WHERE after_id=0 AND target_id=1207 AND completed_at_ms IS NULL"
        ),
        2
    );
    let inference = scalar(
        &db,
        "SELECT COUNT(*) FROM requests WHERE endpoint='/api/chat'",
    );
    let state = state(temp.path(), "http://127.0.0.1:1".into()).await?;
    let usage = state.usage("30d".into(), 0).await?;
    assert!(
        usage
            .warnings
            .iter()
            .any(|w| w.starts_with("costs: frozen request costs are backfilling"))
    );
    assert_eq!(spend(&usage, SONNET), (0.0, 0.0, inference as usize));
    // Two committed pages, then a restart mid-backfill.
    let histories = Arc::new(
        state
            .db
            .pricing
            .read(&Scope::default(), |s| costs::load(s, &costs::families()?))
            .await?,
    );
    for _ in 0..2 {
        let histories = histories.clone();
        assert!(
            state
                .db
                .write(&Scope::default(), move |db| costs::backfill_page(
                    db,
                    &histories,
                    now_ms()
                ))
                .await?
        );
    }
    state.db.close().await?;
    drop(state);
    let cursor = scalar(&db, "SELECT MIN(after_id) FROM cost_backfill");
    assert_eq!(
        cursor,
        scalar(&db, "SELECT MAX(after_id) FROM cost_backfill")
    );
    assert_eq!(
        cursor,
        scalar(
            &db,
            "SELECT id FROM requests ORDER BY id LIMIT 1 OFFSET 999"
        )
    );
    let partial = scalar(&db, "SELECT COUNT(*) FROM request_costs");
    assert_eq!(
        partial,
        2 * scalar(
            &db,
            &format!("SELECT COUNT(*) FROM requests WHERE endpoint='/api/chat' AND id<={cursor}")
        )
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM cost_backfill WHERE completed_at_ms IS NULL"
        ),
        2
    );
    let early = frozen_rows(&path);
    let state = self::state(temp.path(), "http://127.0.0.1:1".into()).await?;
    state.backfill_costs().await?;
    let rows = frozen_rows(&path);
    assert_eq!(
        &rows[..early.len()],
        &early[..],
        "resumed backfill rewrote committed rows"
    );
    assert_eq!(rows.len() as i64, 2 * inference);
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM cost_backfill WHERE completed_at_ms IS NOT NULL AND after_id=1207"
        ),
        2
    );
    // Every classification matches the independent expectation.
    let mut totals = BTreeMap::<(&str, &str), (i64, usize)>::new();
    let mut statement = db.prepare(
        "SELECT request_id,family,cost_status,cost_nano_usd,snapshot_id FROM request_costs ORDER BY 1,2",
    )?;
    let mut stored = statement.query([])?;
    let mut seen = 0;
    while let Some(row) = stored.next()? {
        let (id, family, status, nano): (i64, String, String, Option<i64>) =
            (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?);
        let family = if family == SONNET { SONNET } else { GPT };
        let (want_status, want_nano) = expected(id, family).expect("only inference rows");
        assert_eq!(
            (status.as_str(), nano),
            (want_status, want_nano),
            "request {id} {family}"
        );
        let total = totals.entry((family, want_status)).or_default();
        total.0 += nano.unwrap_or(0);
        total.1 += 1;
        seen += 1;
    }
    assert_eq!(seen, 2 * inference);
    // Same-refresh source tie: rows after the second refresh cite its OpenRouter snapshot.
    let openrouter: i64 = Connection::open(temp.path().join("pricing.db"))?.query_row(
        "SELECT id FROM price_snapshots WHERE fetched_at_ms=?1 AND source='openrouter' AND model_id=?2",
        rusqlite::params![base + 801_000, SONNET_MODEL],
        |r| r.get(0),
    )?;
    assert_eq!(
        scalar(
            &db,
            &format!(
                "SELECT COUNT(DISTINCT snapshot_id) FROM request_costs WHERE family='{SONNET}' AND request_id>=801 AND snapshot_id IS NOT NULL"
            )
        ),
        1
    );
    assert_eq!(
        scalar(
            &db,
            &format!(
                "SELECT MIN(snapshot_id) FROM request_costs WHERE family='{SONNET}' AND request_id>=801"
            )
        ),
        openrouter
    );
    let usage = state.usage("30d".into(), 0).await?;
    assert!(
        !usage.warnings.iter().any(|w| w.starts_with("costs:")),
        "{:?}",
        usage.warnings
    );
    for family in [SONNET, GPT] {
        let (usd, estimated, unpriced) = spend(&usage, family);
        assert!((usd - totals[&(family, "priced")].0 as f64 / 1e9).abs() < 1e-12);
        assert!((estimated - totals[&(family, "estimated")].0 as f64 / 1e9).abs() < 1e-12);
        assert_eq!(unpriced, totals[&(family, "unpriced")].1);
    }
    state.db.close().await?;
    drop(state);
    drop(stored);
    drop(statement);
    drop(db);
    // Backup-gated rollback: restore the verified pre-migration snapshot.
    let saved = Connection::open(&backup)?;
    assert_eq!(
        saved.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))?,
        "ok"
    );
    drop(saved);
    for suffix in ["-wal", "-shm", ""] {
        let file = format!("{}{suffix}", path.display());
        if Path::new(&file).exists() {
            std::fs::rename(&file, format!("{file}.displaced"))?;
        }
    }
    std::fs::copy(&backup, &path)?;
    assert_eq!(table_counts(&path)?, before);
    let restored = Connection::open(&path)?;
    assert_eq!(scalar(&restored, "PRAGMA user_version"), 4);
    assert_eq!(
        scalar(
            &restored,
            "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('request_costs','cost_backfill')"
        ),
        0
    );
    drop(restored);
    assert!(data::open(&path).is_err());
    Ok(())
}

/// Backfill work per transaction is constant: state read, one page read,
/// 200-row cost batches and one cursor update per family; completion verifies
/// each family once. Hot statements use their indexes on an analyzed fixture.
#[test]
fn backfill_statement_budgets_and_query_plans() -> Result<()> {
    use factory_db::explain::{self, Exception, ExceptionKind, RequiredSearch};
    let mut store = pricing::Store::in_memory()?;
    refresh(
        &mut store,
        1,
        (3_000_000, 15_000_000),
        (2_000_000, 10_000_000),
    )?;
    store.confirm(SONNET, 2)?;
    store.confirm(GPT, 2)?;
    let families = costs::families()?;
    let f = families.len();
    let histories = costs::load(&store, &families)?;
    let mut statements = Vec::new();
    for n in [3usize, 1001, 20_000] {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("requests.db");
        let mut db = data::open(&path)?;
        let records: Vec<_> = (1..=n as i64)
            .map(|id| request(id, 3, Some(3), (id % 7 != 0).then_some(7)))
            .collect();
        data::sync(&mut db, records, &[], None)?;
        db.execute_batch(
            "UPDATE cost_backfill SET after_id=0,target_id=(SELECT MAX(id) FROM requests),completed_at_ms=NULL",
        )?;
        let mut db = Tracked::new(db, |db| db)?;
        let mut counts = Vec::new();
        loop {
            let scope = Scope::recording();
            let more = db.run(&scope, Category::Data, |db| {
                costs::backfill_page(db, &histories, 10)
            })?;
            counts.push(scope.counts().data);
            if n == 20_000 {
                statements.extend(scope.statements());
            }
            if !more {
                break;
            }
        }
        let page = |rows: usize| 2 + (f * rows).div_ceil(200) + f;
        let mut want: Vec<_> = (0..n)
            .step_by(costs::PAGE)
            .map(|o| page((n - o).min(costs::PAGE)))
            .collect();
        // The final transaction reads state and the empty range, then verifies.
        want.push(1 + 2 * f);
        if n < 20_000 {
            assert_eq!(counts, want, "n={n}");
        }
        assert!(
            counts.iter().all(|c| *c <= page(costs::PAGE)),
            "n={n} {counts:?}"
        );
        let check = Connection::open(&path)?;
        assert_eq!(
            scalar(&check, "SELECT COUNT(*) FROM request_costs"),
            (f * n) as i64
        );
        if n == 20_000 {
            // Rollups: four full batches within the ≤16 per-batch job budget,
            // then the one-time verification (a reviewed scan, not traced here).
            const ROLLUP_BATCH: usize = 16;
            for _ in 0..4 {
                let scope = Scope::recording();
                let step = db.run(&scope, Category::Data, |db| rollups::batch(db, 11))?;
                assert_eq!(step, rollups::Step::Rolled(rollup::BATCH));
                assert!(scope.counts().data <= ROLLUP_BATCH, "{:?}", scope.counts());
                statements.extend(scope.statements());
            }
            let published = db.run(&Scope::default(), Category::Setup, |db| {
                rollups::run(db, 11, 1)
            })?;
            assert!(published.caught_up && published.verified);
            // A pending fill-in adds one rewind statement per family to the next
            // page, plus one existing-status read because its rows are rolled up.
            check.execute_batch("UPDATE cost_backfill SET unpriced_from_id=19000")?;
            let scope = Scope::recording();
            db.run(&scope, Category::Data, |db| {
                costs::backfill_page(db, &histories, 11)
            })?;
            assert!(
                scope.counts().data <= page(costs::PAGE) + f + 1,
                "{:?}",
                scope.counts()
            );
            statements.extend(scope.statements());
            db.run(&Scope::default(), Category::Setup, |db| {
                db.execute_batch("ANALYZE")
            })?;
            let usage = Scope::recording();
            db.run(&usage, Category::Data, |db| {
                data::usage_records(db, 0, false, vec![])
            })?;
            statements.extend(usage.statements());
            statements.sort();
            statements.dedup();
            // State, page, cost batch, cursor, rewind and completion updates,
            // verification, rollup batches, the rolled fill-in read, and usage.
            assert!(statements.len() >= 10, "{statements:#?}");
            for sql in statements
                .iter()
                .filter(|s| !s.starts_with("BEGIN") && s.as_str() != "COMMIT")
            {
                let parameters: Vec<rusqlite::types::Value> = {
                    let count = check.prepare(sql)?.parameter_count();
                    let text = sql.contains("family=?1") && !sql.contains("INSERT");
                    (0..count)
                        .map(|i| {
                            if i == 0 && text {
                                SONNET.to_owned().into()
                            } else {
                                rusqlite::types::Value::Integer(i as i64 * 1000)
                            }
                        })
                        .collect()
                };
                let plan =
                    explain::query_plan(&check, sql, rusqlite::params_from_iter(parameters))?;
                let small = Exception {
                    kind: ExceptionKind::SmallWholeSetRead,
                    table: "cost_backfill",
                    reason: "one state row per configured reference family",
                };
                let warnings = Exception {
                    kind: ExceptionKind::SmallWholeSetRead,
                    table: "warnings",
                    reason: "complete warning set is part of the API response",
                };
                let (required, exceptions) = if sql
                    .starts_with("SELECT COUNT(*) FROM requests r LEFT JOIN")
                {
                    // Reviewed one-time completion check: walks requests once, probing
                    // each classification by primary key; never on a request path.
                    assert!(plan.iter().any(|p| p.starts_with("SCAN r")), "{plan:?}");
                    (
                        vec![RequiredSearch {
                            table: "c",
                            index: None,
                        }],
                        vec![Exception {
                            kind: ExceptionKind::BoundedRowidWalk,
                            table: "r",
                            reason: "one-time backfill completion verification",
                        }],
                    )
                } else if sql.contains("WHERE id>?1 AND id<=?2") {
                    (
                        vec![RequiredSearch {
                            table: "requests",
                            index: None,
                        }],
                        vec![],
                    )
                } else if sql.starts_with("UPDATE cost_backfill") {
                    (
                        vec![RequiredSearch {
                            table: "cost_backfill",
                            index: Some("sqlite_autoindex_cost_backfill_1"),
                        }],
                        vec![],
                    )
                } else if sql.contains("FROM warnings") {
                    (vec![], vec![warnings, small])
                } else if sql.contains("FROM cost_backfill") {
                    (vec![], vec![small])
                } else if sql.starts_with("INSERT INTO request_costs") {
                    // Direct VALUES write; the conflict target is the primary key.
                    assert!(
                        plan.iter().all(|p| p.ends_with("-ROW VALUES CLAUSE")),
                        "{plan:?}"
                    );
                    continue;
                } else if sql.starts_with("WITH d(day) AS (VALUES") {
                    // Recompute each affected day from its hours.
                    (
                        vec![RequiredSearch {
                            table: "h",
                            index: None,
                        }],
                        vec![
                            Exception {
                                kind: ExceptionKind::SmallWholeSetRead,
                                table: "d",
                                reason: "affected days of one bounded batch",
                            },
                            Exception {
                                kind: ExceptionKind::SmallWholeSetRead,
                                table: "CONSTANT",
                                reason: "affected days of one bounded batch",
                            },
                            Exception {
                                kind: ExceptionKind::BoundedBatchSort,
                                table: "",
                                reason: "groups the hours of the affected days",
                            },
                        ],
                    )
                } else if sql.starts_with("INSERT INTO request_hourly")
                    || sql.starts_with("INSERT INTO request_latency_hourly")
                {
                    // Batch aggregates as bound VALUES rows; upserts probe the key.
                    let values = [
                        Exception {
                            kind: ExceptionKind::SmallWholeSetRead,
                            table: "CONSTANT",
                            reason: "pre-aggregated rows of one ≤5,000-row batch",
                        },
                        Exception {
                            kind: ExceptionKind::SmallWholeSetRead,
                            table: "(subquery-1)",
                            reason: "pre-aggregated rows of one ≤5,000-row batch",
                        },
                    ];
                    (vec![], values.into())
                } else if sql.starts_with("INSERT INTO spend_hourly") {
                    // One batch's id range, grouped per bucket/family/dimension.
                    (
                        vec![
                            RequiredSearch {
                                table: "c",
                                index: None,
                            },
                            RequiredSearch {
                                table: "r",
                                index: None,
                            },
                        ],
                        vec![Exception {
                            kind: ExceptionKind::BoundedBatchSort,
                            table: "",
                            reason: "groups one ≤5,000-row batch",
                        }],
                    )
                } else if sql.starts_with("INSERT INTO rollup_state") {
                    assert!(plan.is_empty(), "{plan:?}");
                    continue;
                } else if sql.contains("FROM rollup_state WHERE job=?1") {
                    (
                        vec![RequiredSearch {
                            table: "rollup_state",
                            index: None,
                        }],
                        vec![],
                    )
                } else if sql.contains("FROM request_hourly") {
                    // Usage rollups: hourly remainder and daily interior.
                    (
                        ["request_hourly", "request_daily", "rollup_state"]
                            .map(|table| RequiredSearch { table, index: None })
                            .into(),
                        vec![],
                    )
                } else if sql.contains("FROM spend_hourly") {
                    (
                        ["spend_hourly", "spend_daily", "rollup_state"]
                            .map(|table| RequiredSearch { table, index: None })
                            .into(),
                        vec![],
                    )
                } else if sql.contains("INDEXED BY requests_ts_latency") {
                    // Exact percentiles: covering index range, no table lookups.
                    (
                        vec![RequiredSearch {
                            table: "requests",
                            index: Some("requests_ts_latency"),
                        }],
                        vec![],
                    )
                } else if sql.contains("FROM requests r LEFT JOIN request_costs c") {
                    // Raw edge: the partial first hour by time, unrolled ids by key.
                    (
                        vec![
                            RequiredSearch {
                                table: "r",
                                index: Some("requests_ts"),
                            },
                            RequiredSearch {
                                table: "c",
                                index: None,
                            },
                        ],
                        vec![],
                    )
                } else if sql.contains("FROM request_costs WHERE request_id>?1 AND request_id<=?2")
                {
                    (
                        vec![RequiredSearch {
                            table: "request_costs",
                            index: None,
                        }],
                        vec![],
                    )
                } else {
                    panic!("unreviewed statement: {sql}");
                };
                explain::validate(&plan, &required, &exceptions)
                    .map_err(|e| e.context(format!("{sql}\n{plan:?}")))?;
            }
        }
    }
    Ok(())
}
