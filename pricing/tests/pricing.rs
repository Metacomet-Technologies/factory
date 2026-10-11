use pricing::{
    DEFAULT_CONFIG, Model, Reference, Store, parse_litellm, parse_openrouter, parse_references,
    resolve,
};

fn references() -> Vec<Reference> {
    vec![Reference {
        name: "Claude Sonnet".into(),
        pattern: "^anthropic/claude-sonnet".into(),
    }]
}

fn model(id: &str, released: i64, input: f64, output: f64) -> Model {
    Model {
        model_id: id.into(),
        released_at: Some(released),
        input_per_mtok: input,
        output_per_mtok: output,
    }
}

fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-10, "{actual} != {expected}");
}

#[test]
fn live_fixtures_parse_offline_and_resolve_newest_not_highest_price() {
    let primary = parse_openrouter(include_str!("fixtures/openrouter.json")).unwrap();
    let secondary = parse_litellm(include_str!("fixtures/litellm.json")).unwrap();
    assert_eq!(primary.len(), 7);
    assert_eq!(secondary.len(), 5); // Ignore sample_spec, reseller rates and missing rates.
    let sonnet = secondary
        .iter()
        .find(|m| m.model_id == "anthropic/claude-sonnet-5.5")
        .unwrap();
    close(sonnet.input_per_mtok, 2.0);
    close(sonnet.output_per_mtok, 10.0);
    assert_eq!(sonnet.released_at, None);
    let references = parse_references(DEFAULT_CONFIG).unwrap();
    assert_eq!(
        resolve(&references[0], &primary).unwrap().unwrap().model_id,
        "anthropic/claude-sonnet-5.5"
    ); // Same-date :batch must not win.
    assert_eq!(
        resolve(&references[1], &primary).unwrap().unwrap().model_id,
        "openai/gpt-6.1-sol-pro"
    ); // The placeholder includes pro, intentionally.
    let older = primary
        .iter()
        .find(|m| m.model_id == "anthropic/claude-sonnet-4.6")
        .unwrap();
    close(older.input_per_mtok, 3.0);
    close(older.output_per_mtok, 15.0);
    assert_eq!(older.released_at, Some(1771342990));
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
    close(status.pending_rates.unwrap().model.input_per_mtok, 2.0);
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
    let paid = model(&primary.model_id, 10, 1e-13, 0.0);
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
    fallback.released_at = None;
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
    assert_eq!(rates.model.released_at, Some(10));
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
    let invalid = model("anthropic/claude-sonnet-5.5", 20, f64::NAN, 20.0);
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
    let at = selection["effective_from"].as_i64().unwrap();
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
    let date = chrono::DateTime::from_timestamp(at, 0)
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
    std::fs::remove_file(path).unwrap();
}
