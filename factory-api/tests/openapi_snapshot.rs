use anyhow::Result;
use factory_api::{AppState, fleet, router};

#[tokio::test]
async fn openapi_snapshot() -> Result<()> {
    let directory = tempfile::tempdir()?;
    pricing::migrate(directory.path().join("pricing.db"))?;
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
    let health = reqwest::get(format!("http://{address}/v1/health"))
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await;
    server.abort();
    let spec = response?;
    // Every security requirement names a defined scheme; the device ingest one is bearer.
    let schemes = &spec["components"]["securitySchemes"];
    let mut required = 0;
    for operations in spec["paths"].as_object().unwrap().values() {
        for operation in operations.as_object().unwrap().values() {
            for requirement in operation["security"].as_array().into_iter().flatten() {
                for name in requirement.as_object().unwrap().keys() {
                    assert!(
                        schemes[name].is_object(),
                        "undefined security scheme {name}"
                    );
                    required += 1;
                }
            }
        }
    }
    assert!(required >= 1);
    assert_eq!(schemes["device_bearer"]["type"], "http");
    assert_eq!(schemes["device_bearer"]["scheme"], "bearer");
    let samples = &spec["paths"]["/v1/devices/{device_id}/samples"]["post"];
    assert_eq!(
        samples["requestBody"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/DeviceSampleV1"
    );
    let snapshot = format!("{}\n", serde_json::to_string_pretty(&spec)?);
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("openapi.json");
    if std::env::var("UPDATE_OPENAPI").as_deref() == Ok("1") {
        std::fs::write(&path, &snapshot)?;
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap_or_default(),
        snapshot,
        "OpenAPI snapshot drift. Regenerate with: UPDATE_OPENAPI=1 cargo test -p factory-api --test openapi_snapshot"
    );
    // The kiosk embeds this hash of the committed file; health must report the same.
    use sha2::Digest;
    let committed = sha2::Sha256::digest(std::fs::read(&path)?);
    let committed: String = committed[..6].iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(health?["openapi_sha256"], committed.as_str());
    Ok(())
}
