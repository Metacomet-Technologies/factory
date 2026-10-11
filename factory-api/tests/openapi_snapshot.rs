use anyhow::Result;
use factory_api::{AppState, fleet, router};

#[tokio::test]
async fn openapi_snapshot() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let state = AppState::new(
        "http://127.0.0.1:1".into(),
        directory.path().join("requests.db"),
        directory.path().join("pricing.db"),
        fleet::Config { nodes: vec![] },
    )
    .await?;
    // Do not start collectors: this test only exercises the public schema endpoint.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await });
    let response = reqwest::get(format!("http://{address}/openapi.json"))
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await;
    server.abort();
    let spec = response?;
    let snapshot = format!("{}\n", serde_json::to_string_pretty(&spec)?);
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("openapi.json");
    if std::env::var("UPDATE_OPENAPI").as_deref() == Ok("1") {
        std::fs::write(&path, &snapshot)?;
    }
    assert_eq!(
        std::fs::read_to_string(path).unwrap_or_default(),
        snapshot,
        "OpenAPI snapshot drift. Regenerate with: UPDATE_OPENAPI=1 cargo test -p factory-api --test openapi_snapshot"
    );
    Ok(())
}
