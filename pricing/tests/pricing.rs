use pricing::{
    DEFAULT_CONFIG, Model, Reference, Store, parse_litellm, parse_openrouter, parse_references,
    resolve,
};

#[test]
fn feed_urls_validate_loopback_and_redact_startup_logs() {
    for url in [
        "https://public.example/feed",
        "http://127.0.0.1/feed",
        "http://127.255.255.254:123/feed",
        "http://[::1]/feed",
        "http://localhost/feed",
    ] {
        assert!(pricing::feed_url(url).is_ok(), "{url}");
    }
    for url in [
        "http://public.example/feed",
        "http://128.0.0.1/feed",
        "http://126.255.255.255/feed",
        "http://[::2]/feed",
        "http://localhost.example/feed",
        "/relative",
        "garbage",
        "ftp://localhost/feed",
        "https:///",
        "https://",
    ] {
        assert!(pricing::feed_url(url).is_err(), "{url}");
    }
    assert_eq!(
        pricing::feed_url_for_log("https://user:secret@example.com/feed?private=1#fragment"),
        "https://example.com/feed"
    );
}

#[test]
fn cli_feed_precedence_defaults_and_startup_validation() {
    let temp = tempfile::tempdir().unwrap();
    pricing::migrate(temp.path().join("pricing.db")).unwrap();
    for (environment, flags, expected) in [
        (
            false,
            false,
            [
                "https://openrouter.ai/api/v1/models",
                "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
            ],
        ),
        (
            true,
            false,
            [
                "https://env.example/primary",
                "https://env.example/secondary",
            ],
        ),
        (
            true,
            true,
            ["http://localhost/primary", "http://127.1.2.3/secondary"],
        ),
    ] {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_pricing"));
        command
            .env_clear()
            .arg("--db")
            .arg(temp.path().join("pricing.db"));
        if environment {
            command
                .env("PRICING_OPENROUTER_FEED_URL", "https://env.example/primary")
                .env("PRICING_LITELLM_FEED_URL", "https://env.example/secondary");
        }
        if flags {
            command.args(["--openrouter-feed-url", "http://localhost/primary?hidden=1"]);
        }
        command.arg("show");
        // Global feed flags work on both sides of the subcommand.
        if flags {
            command.args(["--litellm-feed-url", "http://127.1.2.3/secondary?hidden=2"]);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let log = String::from_utf8(output.stderr).unwrap();
        for url in expected {
            assert!(log.contains(url), "{log}");
        }
        assert!(!log.contains("hidden"));
    }
    for flag in ["--openrouter-feed-url", "--litellm-feed-url"] {
        for value in [
            "http://public.example/feed",
            "/relative",
            "garbage",
            "ftp://localhost/feed",
        ] {
            let output = std::process::Command::new(env!("CARGO_BIN_EXE_pricing"))
                .env_clear()
                .args(["show", flag, value])
                .output()
                .unwrap();
            assert!(!output.status.success());
            let error = String::from_utf8(output.stderr).unwrap();
            assert!(
                error.contains(flag) && error.contains("feed URL"),
                "{error}"
            );
        }
    }
}

fn references() -> Vec<Reference> {
    vec![Reference {
        name: "Claude Sonnet".into(),
        pattern: "^anthropic/claude-sonnet".into(),
    }]
}

fn model(id: &str, released: i64, input: f64, output: f64) -> Model {
    Model {
        model_id: id.into(),
        released_at_ms: Some(released),
        input_micro_usd_per_mtok: (input * 1_000_000.0).round() as i64,
        output_micro_usd_per_mtok: (output * 1_000_000.0).round() as i64,
    }
}

fn close(actual: factory_db::money::NanoUsd, expected: f64) {
    let actual = actual.display_usd();
    assert!((actual - expected).abs() < 1e-10, "{actual} != {expected}");
}

#[test]
fn live_fixtures_parse_offline_and_resolve_newest_not_highest_price() {
    let primary = parse_openrouter(include_str!("fixtures/openrouter.json")).unwrap();
    let secondary = parse_litellm(include_str!("fixtures/litellm.json")).unwrap();
    assert_eq!(primary.len(), 11);
    assert_eq!(secondary.len(), 5); // Ignore sample_spec, reseller rates and missing rates.
    let sonnet = secondary
        .iter()
        .find(|m| m.model_id == "anthropic/claude-sonnet-5.5")
        .unwrap();
    assert_eq!(sonnet.input_micro_usd_per_mtok, 2_000_000);
    assert_eq!(sonnet.output_micro_usd_per_mtok, 10_000_000);
    assert_eq!(sonnet.released_at_ms, None);
    let references = parse_references(DEFAULT_CONFIG).unwrap();
    assert_eq!(
        resolve(&references[0], &primary).unwrap().unwrap().model_id,
        "anthropic/claude-sonnet-5.5"
    ); // Same-date :batch must not win.
    assert_eq!(
        resolve(&references[1], &primary).unwrap().unwrap().model_id,
        "openai/gpt-6.1-sol"
    );
    let older = primary
        .iter()
        .find(|m| m.model_id == "anthropic/claude-sonnet-4.6")
        .unwrap();
    assert_eq!(older.input_micro_usd_per_mtok, 3_000_000);
    assert_eq!(older.output_micro_usd_per_mtok, 15_000_000);
    assert_eq!(older.released_at_ms, Some(1_771_342_990_000));
}

#[test]
fn chatgpt_mid_tier_selects_sol_and_excludes_other_tiers_and_batch() {
    let models = parse_openrouter(include_str!("fixtures/openrouter.json")).unwrap();
    let references = parse_references(DEFAULT_CONFIG).unwrap();
    let reference = references
        .iter()
        .find(|r| r.name == "ChatGPT mid-tier")
        .unwrap();
    assert_eq!(
        resolve(reference, &models).unwrap().unwrap().model_id,
        "openai/gpt-6.1-sol"
    );
    for id in [
        "openai/gpt-6.1-sol-pro",
        "openai/gpt-6-luna",
        "openai/gpt-6-astra",
        "openai/gpt-6.1-sol:batch",
        "openai/gpt-6.1-sol-pro:batch",
    ] {
        let excluded = models.iter().find(|m| m.model_id == id).unwrap();
        // Testing each candidate alone proves exclusion, not merely an older release.
        assert!(
            resolve(reference, std::slice::from_ref(excluded))
                .unwrap()
                .is_none(),
            "{id}"
        );
    }
}

#[test]
fn pending_changes_require_confirmation_and_preserve_historical_cost() {
    let refs = references();
    let mut store = Store::in_memory().unwrap();
    let old = model("anthropic/claude-sonnet-4.6", 10, 2.0, 10.0);
    let items = store
        .refresh(
            &refs,
            std::slice::from_ref(&old),
            std::slice::from_ref(&old),
            100,
            vec![],
        )
        .unwrap();
    assert_eq!(
        items.iter().filter(|i| i.kind == "pricing.changed").count(),
        1
    );
    assert!(store.cost(&refs[0].name, 250_000, 40_000, 100).is_err());
    let status = store.show(&refs, 100).unwrap().remove(0);
    assert!(status.selected.is_none());
    assert_eq!(status.pending.unwrap().model_id, old.model_id);
    assert_eq!(
        status.pending_rates.unwrap().model.input_micro_usd_per_mtok,
        2_000_000
    );
    assert!(store.confirm(&refs[0].name, 99).is_err());
    store.confirm(&refs[0].name, 110).unwrap();
    assert!(store.confirm(&refs[0].name, 111).is_err());
    assert!(store.cost(&refs[0].name, 1, 1, 109).is_err());
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 110).unwrap(),
        0.9,
    );

    let changed = model(&old.model_id, 10, 4.0, 12.0);
    let items = store
        .refresh(
            &refs,
            std::slice::from_ref(&changed),
            std::slice::from_ref(&changed),
            200,
            vec![],
        )
        .unwrap();
    assert!(items.is_empty());
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 199).unwrap(),
        0.9,
    );
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 200).unwrap(),
        1.48,
    );

    let newer = model("anthropic/claude-sonnet-5.5", 20, 7.0, 30.0);
    store
        .refresh(
            &refs,
            &[changed.clone(), newer.clone()],
            &[changed.clone(), newer.clone()],
            300,
            vec![],
        )
        .unwrap();
    let status = store.show(&refs, 300).unwrap().remove(0);
    assert_eq!(status.selected.unwrap().model_id, old.model_id);
    assert_eq!(status.pending.unwrap().model_id, newer.model_id);
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 319).unwrap(),
        1.48,
    );
    store.confirm(&refs[0].name, 320).unwrap();
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 320).unwrap(),
        2.95,
    );
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 110).unwrap(),
        0.9,
    );
    assert!(store.show(&refs, 320).unwrap()[0].pending.is_none());
    assert!(store.cost("unknown", 1, 1, 320).is_err());
}

#[test]
fn cross_check_warns_only_above_five_percent_on_either_rate() {
    let refs = references();
    let primary = model("anthropic/claude-sonnet-5.5", 10, 2.0, 10.0);
    let mut store = Store::in_memory().unwrap();
    for (at, input, output, warning) in [
        (100, 2.1, 9.5, false),
        (200, 2.1001, 10.0, true),
        (300, 2.0, 9.499, true),
        (400, 2.0, 10.0, false),
    ] {
        let secondary = model(&primary.model_id, 10, input, output);
        store
            .refresh(
                &refs,
                std::slice::from_ref(&primary),
                &[secondary],
                at,
                vec![],
            )
            .unwrap();
        assert_eq!(
            store
                .items()
                .unwrap()
                .iter()
                .any(|i| i.message.contains("disagree >5%")),
            warning
        );
        if at == 100 {
            store.confirm(&refs[0].name, 100).unwrap();
        }
        close(store.cost(&refs[0].name, 500_000, 20_000, at).unwrap(), 1.2);
    }
    let free = model(&primary.model_id, 10, 0.0, 0.0);
    let paid = model(&primary.model_id, 10, 0.000001, 0.0);
    store.refresh(&refs, &[free], &[paid], 500, vec![]).unwrap();
    assert!(
        store
            .items()
            .unwrap()
            .iter()
            .any(|i| i.message.contains("disagree >5%"))
    );
}

#[test]
fn fallback_uses_known_dates_and_never_invents_a_new_release_date() {
    let refs = references();
    let primary = model("anthropic/claude-sonnet-5.5", 10, 2.0, 10.0);
    let mut fallback = model(&primary.model_id, 10, 3.0, 20.0);
    fallback.released_at_ms = None;
    let mut store = Store::in_memory().unwrap();
    let items = store
        .refresh(&refs, &[], &[fallback.clone()], 100, vec![])
        .unwrap();
    assert!(
        items
            .iter()
            .any(|i| i.message.contains("known release date"))
    );
    assert!(store.confirm(&refs[0].name, 100).is_err());
    store
        .refresh(
            &refs,
            std::slice::from_ref(&primary),
            &[fallback.clone()],
            200,
            vec![],
        )
        .unwrap();
    store.confirm(&refs[0].name, 200).unwrap();
    store.refresh(&refs, &[], &[fallback], 300, vec![]).unwrap();
    let rates = store.show(&refs, 300).unwrap().remove(0).rates.unwrap();
    assert_eq!(rates.source, "litellm");
    assert_eq!(rates.model.released_at_ms, Some(10));
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 299).unwrap(),
        0.9,
    );
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 300).unwrap(),
        1.55,
    );
}

#[test]
fn latest_refresh_retracts_stale_pending_even_within_the_same_second() {
    let refs = references();
    let old = model("anthropic/claude-sonnet-4.6", 10, 2.0, 10.0);
    let new = model("anthropic/claude-sonnet-5.5", 20, 3.0, 15.0);
    let mut store = Store::in_memory().unwrap();
    store
        .refresh(
            &refs,
            std::slice::from_ref(&old),
            std::slice::from_ref(&old),
            100,
            vec![],
        )
        .unwrap();
    store.confirm(&refs[0].name, 100).unwrap();
    store
        .refresh(
            &refs,
            std::slice::from_ref(&new),
            std::slice::from_ref(&new),
            200,
            vec![],
        )
        .unwrap();
    assert!(store.show(&refs, 200).unwrap()[0].pending.is_some());
    store
        .refresh(
            &refs,
            std::slice::from_ref(&old),
            std::slice::from_ref(&old),
            200,
            vec![],
        )
        .unwrap();
    assert!(store.show(&refs, 200).unwrap()[0].pending.is_none());
    assert!(store.items().unwrap().is_empty());
    assert!(store.confirm(&refs[0].name, 200).is_err());
    let fallback = model(&old.model_id, 10, 4.0, 20.0);
    store.refresh(&refs, &[], &[fallback], 200, vec![]).unwrap();
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 200).unwrap(),
        1.8,
    );
}

#[test]
fn invalid_refresh_rolls_back_and_cannot_rewrite_history() {
    let refs = references();
    let old = model("anthropic/claude-sonnet-4.6", 10, 2.0, 10.0);
    let mut store = Store::in_memory().unwrap();
    store
        .refresh(
            &refs,
            std::slice::from_ref(&old),
            std::slice::from_ref(&old),
            100,
            vec![],
        )
        .unwrap();
    store.confirm(&refs[0].name, 110).unwrap();
    let invalid = model("anthropic/claude-sonnet-5.5", 20, -1.0, 20.0);
    assert!(
        store
            .refresh(&refs, &[old.clone(), invalid], &[], 200, vec![])
            .is_err()
    );
    assert!(store.show(&refs, 200).unwrap()[0].pending.is_none());
    close(
        store.cost(&refs[0].name, 250_000, 40_000, 200).unwrap(),
        0.9,
    );
    assert!(store.refresh(&refs, &[old], &[], 109, vec![]).is_err());
    assert!(store.refresh(&refs, &[], &[], 300, vec![]).is_err());
}

#[test]
fn parser_rejects_invalid_rates_and_config() {
    assert!(
        parse_openrouter(
            r#"{"data":[{"id":"bad","created":1,"pricing":{"prompt":"NaN","completion":"0"}}]}"#
        )
        .is_err()
    );
    assert!(
        parse_openrouter(
            r#"{"data":[{"id":"bad","created":1,"pricing":{"prompt":"-0.1","completion":"0"}}]}"#
        )
        .is_err()
    );
    assert!(parse_references("[[reference]]\nname='x'\nmatch='['").is_err());
    assert!(parse_references("reference=[]").is_err());
    let dated = parse_litellm(r#"{"claude-sonnet-4-20250514":{"litellm_provider":"anthropic","input_cost_per_token":0.000003,"output_cost_per_token":0.000015}}"#).unwrap();
    assert_eq!(dated[0].model_id, "anthropic/claude-sonnet-4-20250514");
}

#[test]
fn standalone_store_waits_for_a_write_lock() {
    use std::{
        sync::mpsc,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    let path = std::env::temp_dir().join(format!(
        "pricing-contention-{}-{}.db",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    pricing::migrate(&path).unwrap();
    let mut store = Store::open(&path).unwrap();
    for connection in [store.connection(), Store::in_memory().unwrap().connection()] {
        assert_eq!(
            connection
                .pragma_query_value(None, "busy_timeout", |row| row.get::<_, i64>(0))
                .unwrap(),
            5000
        );
    }
    let mut blocker = rusqlite::Connection::open(&path).unwrap();
    let lock = blocker
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let (started, ready) = mpsc::channel();
    let (finished, result) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        started.send(()).unwrap();
        let models = [model("anthropic/claude-sonnet-5.5", 10, 2.0, 10.0)];
        let outcome = store.refresh(&references(), &models, &[], 100, vec![]);
        finished.send(outcome).unwrap();
        store
    });
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let early = result.recv_timeout(Duration::from_millis(200));
    let waited = matches!(early, Err(mpsc::RecvTimeoutError::Timeout));
    lock.commit().unwrap();
    let outcome = match early {
        Err(mpsc::RecvTimeoutError::Timeout) => result.recv_timeout(Duration::from_secs(5)),
        _ => early,
    };
    let store = writer.join().unwrap();
    let status = store.show(&references(), 100).unwrap();
    drop(store);
    drop(blocker);
    std::fs::remove_file(path).unwrap();
    assert!(waited, "write completed before the lock was released");
    outcome.unwrap().unwrap();
    assert_eq!(
        status[0].pending.as_ref().unwrap().model_id,
        "anthropic/claude-sonnet-5.5"
    );
}

#[test]
fn cli_confirms_shows_and_prices_with_db_env_and_historical_timestamp() {
    use std::{
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };
    let path = std::env::temp_dir().join(format!(
        "pricing-{}-{}.db",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let refs = references();
    let models = [model("anthropic/claude-sonnet-5.5", 10, 2.0, 10.0)];
    pricing::migrate(&path).unwrap();
    {
        let mut store = Store::open(&path).unwrap();
        store.refresh(&refs, &models, &models, 100, vec![]).unwrap();
    }
    let binary = env!("CARGO_BIN_EXE_pricing");
    let confirm = Command::new(binary)
        .env("PRICING_DB", &path)
        .args(["confirm", "Claude Sonnet"])
        .output()
        .unwrap();
    assert!(
        confirm.status.success(),
        "{}",
        String::from_utf8_lossy(&confirm.stderr)
    );
    let selection: serde_json::Value = serde_json::from_slice(&confirm.stdout).unwrap();
    let at = selection["effective_from_ms"].as_i64().unwrap();
    let show = Command::new(binary)
        .env("PRICING_DB", "missing-directory/unused.db")
        .arg("show")
        .arg("--db")
        .arg(&path)
        .output()
        .unwrap();
    assert!(show.status.success());
    let status: serde_json::Value = serde_json::from_slice(&show.stdout).unwrap();
    assert_eq!(
        status["families"][0]["selected"]["model_id"],
        "anthropic/claude-sonnet-5.5"
    );
    assert!(status["families"][0]["pending"].is_null());
    let date = chrono::DateTime::from_timestamp_millis(at)
        .unwrap()
        .to_rfc3339();
    let cost = Command::new(binary)
        .env("PRICING_DB", &path)
        .args(["cost", "Claude Sonnet", "250000", "40000", "--at", &date])
        .output()
        .unwrap();
    assert!(cost.status.success());
    assert_eq!(String::from_utf8(cost.stdout).unwrap(), "0.900000000 USD\n");
    let early = Command::new(binary)
        .env("PRICING_DB", &path)
        .args(["cost", "Claude Sonnet", "250000", "40000", "--at", "100"])
        .output()
        .unwrap();
    assert!(!early.status.success());
    assert!(String::from_utf8_lossy(&early.stderr).contains("no confirmed selection"));
    for (flag, value) in [
        ("--at-ms", at.to_string()),
        ("--at", (at / 1000 + 1).to_string()),
    ] {
        let cost = Command::new(binary)
            .env("PRICING_DB", &path)
            .args(["cost", "Claude Sonnet", "250000", "40000", flag, &value])
            .output()
            .unwrap();
        assert!(
            cost.status.success(),
            "{}",
            String::from_utf8_lossy(&cost.stderr)
        );
        assert_eq!(cost.stdout, b"0.900000000 USD\n");
    }
    for (flag, value) in [
        ("--at-ms", "100"),
        ("--at", "9223372036854775807"),
        ("--at", "2026-10-11T01:10:40"),
    ] {
        let result = Command::new(binary)
            .env("PRICING_DB", &path)
            .args(["cost", "Claude Sonnet", "1", "0", flag, value])
            .output()
            .unwrap();
        assert!(!result.status.success());
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn exact_decimal_rates_from_strings_and_numeric_lexemes() -> anyhow::Result<()> {
    for (text, expected) in [
        ("0", 0),
        ("0.000002", 2_000_000),
        ("8e-6", 8_000_000),
        ("0.000000000001", 1),
        ("0.0000001234560000000000", 123_456),
        ("1.23456789012e-1", 123_456_789_012),
        ("1E+2", 100_000_000_000_000),
        ("9223372.036854775807", i64::MAX),
    ] {
        assert_eq!(pricing::parse_rate(text)?, expected, "{text}");
        let primary = parse_openrouter(&format!(
            r#"{{"data":[{{"id":"openai/gpt-6-sol","created":17,"pricing":{{"prompt":"{text}","completion":"0"}}}}]}}"#
        ))?;
        let secondary = parse_litellm(&format!(
            r#"{{"gpt-6-sol":{{"litellm_provider":"openai","input_cost_per_token":{text},"output_cost_per_token":0}}}}"#
        ))?;
        assert_eq!(primary[0].input_micro_usd_per_mtok, expected);
        assert_eq!(secondary[0].input_micro_usd_per_mtok, expected);
        assert_eq!(primary[0].released_at_ms, Some(17_000));
    }
    for text in [
        "-1",
        "-0",
        "NaN",
        "Inf",
        "Infinity",
        "1e999",
        "9223372.036854775808",
        "0.0000000000001",
        "0.0000010000001",
        "",
        "+1",
        " 1",
        "1 ",
        "01",
        "1.",
    ] {
        assert!(pricing::parse_rate(text).is_err(), "accepted {text:?}");
    }
    assert!(parse_openrouter(r#"{"data":[{"id":"x","created":9223372036854775807,"pricing":{"prompt":"0","completion":"0"}}]}"#).is_err());
    Ok(())
}

#[test]
fn migration_and_runtime_version_contract() -> anyhow::Result<()> {
    use rusqlite::Connection;
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("pricing.db");
    let cli = || {
        std::process::Command::new(env!("CARGO_BIN_EXE_pricing"))
            .arg("--db")
            .arg(&path)
            .arg("show")
            .output()
            .unwrap()
    };
    assert!(Store::open(&path).is_err());
    assert!(!cli().status.success());
    assert!(!path.exists());
    let db = Connection::open(&path)?;
    db.execute_batch(include_str!("fixtures/v0.sql"))?;
    db.execute("INSERT INTO refreshes VALUES(100)", [])?;
    drop(db);
    let before = std::fs::read(&path)?;
    assert_eq!(
        pricing::migrate(&path).unwrap_err().to_string(),
        "legacy pricing DB found; move it aside first (the installer does this)"
    );
    assert!(Store::open(&path).is_err());
    assert!(!cli().status.success());
    assert_eq!(std::fs::read(&path)?, before);
    std::fs::rename(&path, temp.path().join("pricing.v0.db"))?;
    assert_eq!(pricing::migrate(&path)?.applied, [1]);
    let before = std::fs::read(&path)?;
    assert!(pricing::migrate(&path)?.applied.is_empty());
    assert_eq!(std::fs::read(&path)?, before);
    let db = Connection::open(&path)?;
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM pragma_table_list WHERE schema='main' AND strict=1",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        4
    );
    for table in [
        "refreshes",
        "price_snapshots",
        "reference_selection",
        "pricing_items",
    ] {
        assert_eq!(
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))?,
            0
        );
        assert_eq!(
            db.query_row(
                &format!(
                    "SELECT pk FROM pragma_table_info('{table}') WHERE name='id' AND type='INTEGER'"
                ),
                [],
                |r| r.get::<_, i64>(0)
            )?,
            1
        );
    }
    assert!(cli().status.success());
    db.pragma_update(None, "foreign_keys", true)?;
    for sql in [
        "INSERT INTO refreshes(fetched_at_ms) VALUES(-1)",
        "INSERT INTO price_snapshots(refresh_id,fetched_at_ms,source,model_id,input_micro_usd_per_mtok,output_micro_usd_per_mtok) VALUES(999,0,'openrouter','x',1,2)",
        "INSERT INTO refreshes(fetched_at_ms) VALUES(0.5)",
    ] {
        assert!(db.execute(sql, []).is_err(), "{sql}");
    }
    db.execute("INSERT INTO refreshes(fetched_at_ms) VALUES(0)", [])?;
    for (source, input) in [
        ("other", "1"),
        ("openrouter", "-1"),
        ("openrouter", "1.5"),
        ("openrouter", "9223372036854775808"),
    ] {
        assert!(db.execute(&format!("INSERT INTO price_snapshots(refresh_id,fetched_at_ms,source,model_id,input_micro_usd_per_mtok,output_micro_usd_per_mtok) VALUES(1,0,'{source}','x',{input},2)"), []).is_err());
    }
    db.pragma_update(None, "user_version", 2)?;
    drop(db);
    let before = std::fs::read(&path)?;
    assert!(pricing::migrate(&path).is_err());
    assert!(!cli().status.success());
    assert!(Store::open(&path).is_err());
    assert_eq!(std::fs::read(&path)?, before);
    Ok(())
}

#[test]
fn refresh_batches_release_history_and_indexed_hot_reads() -> anyhow::Result<()> {
    use factory_db::{
        Category, Scope, Tracked,
        explain::{self, Exception, ExceptionKind, RequiredSearch},
    };
    let refs = parse_references(DEFAULT_CONFIG)?;
    for n in [3usize, 1001] {
        let store = Store::in_memory()?;
        let mut tracked = Tracked::new(store, Store::connection)?;
        let mut primary = (0..n)
            .map(|i| model(&format!("noise-{i}"), i as i64, 2.0, 8.0))
            .collect::<Vec<_>>();
        primary[0] = model("anthropic/claude-sonnet-5.5", 11, 2.0, 8.0);
        primary[1] = model("openai/gpt-6-sol", 7, 3.0, 9.0);
        // Asymmetric history: the first family appears on every refresh, the second only once.
        tracked.run(
            &Scope::default(),
            Category::Setup,
            |store| -> anyhow::Result<()> {
                store.refresh(&refs, &primary, &[], 100, vec![])?;
                for at in 101..if n == 3 { 105 } else { 132 } {
                    store.refresh(&refs, &primary[..1], &[], at, vec![])?;
                }
                store.connection().execute_batch("ANALYZE")?;
                Ok(())
            },
        )?;
        let secondary = primary
            .iter()
            .cloned()
            .map(|mut m| {
                m.released_at_ms = None;
                m
            })
            .collect::<Vec<_>>();
        let scope = Scope::recording();
        let items = tracked.run(&scope, Category::Data, |store| {
            let warnings = (0..n + 3)
                .map(|i| pricing::Item {
                    fetched_at_ms: 200,
                    kind: "warning".into(),
                    family: "*".into(),
                    message: format!("fixture {i}"),
                })
                .collect();
            store.refresh(&refs, &[], &secondary, 200, warnings)
        })?;
        assert_eq!(items.len(), n + 7);
        let expected = 6 + n.div_ceil(100) + 1 + items.len().div_ceil(100);
        assert_eq!(scope.counts().data, expected);
        assert_eq!(scope.counts().transaction, 2);
        assert_eq!(scope.counts().setup, 0);
        eprintln!(
            "refresh n={n}: data={expected}, transaction=2, items={}",
            items.len()
        );
        let view = Scope::recording();
        tracked.run(&view, Category::Data, |store| -> anyhow::Result<()> {
            let status = store.show(&refs, 200)?;
            assert_eq!(
                status[0].pending.as_ref().unwrap().model_id,
                primary[0].model_id
            );
            assert_eq!(
                status[1].pending.as_ref().unwrap().model_id,
                primary[1].model_id
            );
            assert_eq!(
                status[0]
                    .pending_rates
                    .as_ref()
                    .unwrap()
                    .model
                    .released_at_ms,
                Some(11)
            );
            assert_eq!(
                status[1]
                    .pending_rates
                    .as_ref()
                    .unwrap()
                    .model
                    .released_at_ms,
                Some(7)
            );
            assert_eq!(store.items()?.len(), n + 7);
            Ok(())
        })?;
        assert_eq!(view.counts().data, 7);
        let confirm = Scope::recording();
        tracked.run(&confirm, Category::Data, |store| {
            store.confirm(&refs[0].name, 201)
        })?;
        assert_eq!(confirm.counts().data, 3);
        assert_eq!(confirm.counts().transaction, 2);
        tracked.run(
            &Scope::default(),
            Category::Data,
            |store| -> anyhow::Result<()> {
                assert_eq!(store.cost(&refs[0].name, 3, 7, 201)?.0, 62_000);
                for sql in scope
                    .statements()
                    .into_iter()
                    .chain(view.statements())
                    .chain(confirm.statements())
                    .filter(|s| s.starts_with("SELECT"))
                {
                    let count = store.connection().prepare(&sql)?.parameter_count();
                    let mut values = Vec::<rusqlite::types::Value>::new();
                    if count > 0 {
                        values.push(if sql.contains("json_each") {
                            serde_json::to_string(
                                &secondary.iter().map(|m| &m.model_id).collect::<Vec<_>>(),
                            )?
                            .into()
                        } else if sql.contains("WHERE model_id=?1") {
                            primary[0].model_id.clone().into()
                        } else {
                            refs[0].name.clone().into()
                        });
                    }
                    if count > 1 {
                        values.push(200.into());
                    }
                    let plan = explain::query_plan(
                        store.connection(),
                        &sql,
                        rusqlite::params_from_iter(values),
                    )?;
                    let (table, index) = if sql.contains("json_each") {
                        ("price_snapshots", "snapshot_release")
                    } else if sql.contains("FROM price_snapshots") {
                        ("price_snapshots", "snapshot_lookup")
                    } else if sql.contains("FROM pricing_items") {
                        ("pricing_items", "items_refresh")
                    } else if sql.contains("MAX(effective_from_ms)") {
                        ("reference_selection", "selection_time")
                    } else if sql.contains("MAX(fetched_at_ms)") {
                        ("refreshes", "refreshes_time")
                    } else if sql.contains("confirmed=0") {
                        ("reference_selection", "selection_pending")
                    } else {
                        ("reference_selection", "selection_lookup")
                    };
                    explain::validate(
                        &plan,
                        &[RequiredSearch {
                            table,
                            index: Some(index),
                        }],
                        &[Exception {
                            kind: ExceptionKind::SmallWholeSetRead,
                            table: "json_each",
                            reason: "bounded incoming model IDs, never a persisted history scan",
                        }],
                    )
                    .map_err(|e| anyhow::anyhow!("{sql}\n{e:#}"))?;
                }
                Ok(())
            },
        )?;
    }
    Ok(())
}
