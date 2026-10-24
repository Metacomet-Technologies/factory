use crate::devices::{self, DeviceList, DeviceView};
use crate::devices_history::{self, DeviceHistory};
use crate::devices_ingest::{self, IngestResult};
use crate::network::{NetworkStatus, Sample};
use crate::network_history::{self, NetworkEvents, NetworkSeries, NetworkSpeedTest};
use crate::types::*;
use crate::ups::{Ups, UpsCurrent};
use crate::ups_history::{self, UpsEnergy, UpsEvents, UpsPoint, UpsSettings};
use crate::{AppState, now_ms};
use axum::{
    Json, Router,
    body::Body,
    extract::{FromRequestParts, Path, Query, State},
    http::{Method, Request, StatusCode},
    response::{IntoResponse, Response, Sse, sse::Event},
};
use sha2::Digest;
use std::{convert::Infallible, time::Duration};
use utoipa::OpenApi;

pub(crate) fn error(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (
        status,
        Json(ApiError {
            error: ErrorDetail {
                code: code.into(),
                message: message.into(),
            },
        }),
    )
        .into_response()
}
pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/v1/pricing/confirm/{family}", axum::routing::any(dispatch))
        .route("/v1", axum::routing::any(dispatch))
        .route("/v1/{*path}", axum::routing::any(dispatch))
        .layer(
            tower::ServiceBuilder::new()
                .layer(axum::error_handling::HandleErrorLayer::new(layer_error))
                .timeout(Duration::from_secs(4)),
        )
        // SSE has no request timeout. Its body observes the shutdown token.
        .route("/v1/stream", axum::routing::any(dispatch))
        .layer(
            tower::ServiceBuilder::new()
                .layer(axum::error_handling::HandleErrorLayer::new(layer_error))
                .load_shed()
                .layer(tower::limit::GlobalConcurrencyLimitLayer::new(16)),
        );
    Router::new()
        .merge(api)
        .route("/{*path}", axum::routing::any(dispatch))
        .fallback(dispatch)
        .with_state(state)
        .layer(axum::middleware::map_response(
            |mut response: Response| async move {
                response.headers_mut().insert(
                    "x-content-type-options",
                    axum::http::HeaderValue::from_static("nosniff"),
                );
                response
            },
        ))
}
async fn layer_error(error_value: tower::BoxError) -> Response {
    if error_value.is::<tower::timeout::error::Elapsed>() {
        error(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "request exceeded four seconds",
        )
    } else {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "overloaded",
            "too many in-flight requests",
        )
    }
}

#[derive(Default, serde::Deserialize)]
struct RangeQuery {
    range: Option<String>,
}
fn range(request: &Request<Body>, gpu: bool) -> Result<(String, i64), String> {
    let Query(query) =
        Query::<RangeQuery>::try_from_uri(request.uri()).map_err(|e| e.to_string())?;
    let range = query.range.unwrap_or(if gpu { "1h" } else { "24h" }.into());
    let hours = match (gpu, range.as_str()) {
        (true, "1h") => 1,
        (_, "24h") => 24,
        (_, "7d") => 168,
        (false, "30d") => 720,
        (false, "365d") => 8760,
        _ => {
            return Err(if gpu {
                "range must be 1h, 24h, or 7d"
            } else {
                "range must be 24h, 7d, 30d, or 365d"
            }
            .into());
        }
    };
    Ok((range, now_ms() - hours * 3_600_000))
}
async fn dispatch(State(mut state): State<AppState>, request: Request<Body>) -> Response {
    state.query_scope = request
        .extensions()
        .get::<factory_db::Scope>()
        .cloned()
        .unwrap_or_default();
    if state.shutdown.is_cancelled() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "shutting_down",
            "server shutting down",
        );
    }
    let path = request.uri().path();
    if let Some(route) = device_route(path) {
        let allowed = if matches!(route, DeviceRoute::Samples(_)) {
            Method::POST
        } else {
            Method::GET
        };
        if request.method() != allowed {
            let mut response = error(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                format!("endpoint requires {allowed}"),
            );
            response
                .headers_mut()
                .insert("allow", allowed.as_str().parse().unwrap());
            return response;
        }
        return match route {
            DeviceRoute::Samples(id) => ingest_sample(&state, &id, request).await,
            DeviceRoute::List => devices_list(&state).await.into_response(),
            DeviceRoute::Current(id) if id == devices::DEVICE_ID => {
                device_current(&state).await.into_response()
            }
            DeviceRoute::History(id) if id == devices::DEVICE_ID => {
                device_history(&state, request).await
            }
            DeviceRoute::Current(id) if state.known_device(&id) => {
                remote_device_current(&state, &id).await.into_response()
            }
            DeviceRoute::History(id) if state.known_device(&id) => {
                remote_device_history(&state, &id, request).await
            }
            _ => error(StatusCode::NOT_FOUND, "unknown_device", "unknown device"),
        };
    }
    let confirm = path
        .strip_prefix("/v1/pricing/confirm/")
        .filter(|family| !family.is_empty() && !family.contains('/'));
    let post = matches!(path, "/v1/pricing/refresh" | "/v1/agents/refresh") || confirm.is_some();
    if !matches!(
        path,
        "/v1/health"
            | "/v1/fleet"
            | "/v1/llm/usage"
            | "/v1/gpu"
            | "/v1/ups"
            | "/v1/ups/history"
            | "/v1/ups/events"
            | "/v1/ups/energy"
            | "/v1/settings/ups"
            | "/v1/network"
            | "/v1/network/history"
            | "/v1/network/speed-tests"
            | "/v1/network/events"
            | "/v1/pricing"
            | "/v1/pricing/refresh"
            | "/v1/agents"
            | "/v1/agents/refresh"
            | "/v1/alerts"
            | "/v1/stream"
            | "/openapi.json"
    ) && confirm.is_none()
    {
        if !crate::kiosk::reserved(path) {
            return crate::kiosk::serve(&state.static_dir, request).await;
        }
        return error(StatusCode::NOT_FOUND, "not_found", "unknown endpoint");
    }
    let settings_put = path == "/v1/settings/ups" && request.method() == Method::PUT;
    if !settings_put && request.method() != if post { Method::POST } else { Method::GET } {
        let mut response = error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            if post {
                "endpoint requires POST"
            } else {
                "endpoint requires GET"
            },
        );
        response.headers_mut().insert(
            "allow",
            if path == "/v1/settings/ups" {
                "GET, PUT"
            } else if post {
                "POST"
            } else {
                "GET"
            }
            .parse()
            .unwrap(),
        );
        return response;
    }
    match path {
        "/v1/health" => health(&state).await.into_response(),
        "/v1/fleet" => fleet(&state).await.into_response(),
        "/v1/agents" => agents(&state).await.into_response(),
        "/v1/agents/refresh" => refresh_agents(&state, request).await,
        "/v1/alerts" => alerts(&state).await.into_response(),
        "/v1/ups" => ups(&state).await.into_response(),
        "/v1/ups/history" => ups_history(&state, request).await,
        "/v1/ups/events" => ups_events(&state, request).await,
        "/v1/ups/energy" => ups_energy(&state, request).await,
        "/v1/settings/ups" if settings_put => put_ups_settings(&state, request).await,
        "/v1/settings/ups" => get_ups_settings(&state).await,
        "/v1/network" => network(&state).await,
        "/v1/network/history" => network_history(&state, request).await,
        "/v1/network/speed-tests" => network_speed_tests(&state, request).await,
        "/v1/network/events" => network_events(&state, request).await,
        "/openapi.json" => Json(ApiDoc::openapi()).into_response(),
        "/v1/stream" => stream(&state).into_response(),
        "/v1/gpu" => match range(&request, true) {
            Ok((range, since)) => gpu(&state, &range, since).await,
            Err(e) => error(StatusCode::BAD_REQUEST, "invalid_range", e),
        },
        "/v1/llm/usage" => match range(&request, false) {
            Ok((range, since)) => usage(&state, range, since).await,
            Err(e) => error(StatusCode::BAD_REQUEST, "invalid_range", e),
        },
        "/v1/pricing" => pricing(&state).await,
        "/v1/pricing/refresh" => refresh(&state).await,
        _ => {
            let (mut parts, _) = request.into_parts();
            let family = match Path::<String>::from_request_parts(&mut parts, &state).await {
                Ok(Path(family)) => family,
                Err(e) => {
                    return error(StatusCode::BAD_REQUEST, "invalid_family", e.to_string());
                }
            };
            match state.pricing().await {
                Ok(prices) if !prices.families.iter().any(|f| f.family == family) => {
                    return error(
                        StatusCode::NOT_FOUND,
                        "unknown_family",
                        "unknown pricing family",
                    );
                }
                Ok(prices)
                    if prices
                        .families
                        .iter()
                        .find(|f| f.family == family)
                        .unwrap()
                        .pending
                        .is_none() =>
                {
                    return error(
                        StatusCode::CONFLICT,
                        "no_pending_selection",
                        "no pending change for this family",
                    );
                }
                Err(e) => {
                    return error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "storage_error",
                        e.to_string(),
                    );
                }
                _ => (),
            }
            confirm_selection(&state, family).await
        }
    }
}
fn response<T: serde::Serialize>(result: anyhow::Result<T>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            e.to_string(),
        ),
    }
}
/// Hash the bytes the snapshot test commits, so the kiosk can compare against
/// the `openapi.json` it was built from.
fn openapi_sha256() -> &'static str {
    static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HASH.get_or_init(|| {
        let spec = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI serializes");
        let snapshot = format!("{}\n", serde_json::to_string_pretty(&spec).unwrap());
        let digest = sha2::Sha256::digest(snapshot);
        digest[..6].iter().map(|b| format!("{b:02x}")).collect()
    })
}
#[utoipa::path(get, path="/v1/health", responses((status=200, body=Health)))]
async fn health(state: &AppState) -> Json<Health> {
    #[derive(serde::Deserialize)]
    struct MeterHealth {
        openapi_sha256: Option<String>,
    }
    // Stay inside the four-second route deadline, including a stalled response body.
    let meter = tokio::time::timeout(
        Duration::from_secs(1),
        state.get::<MeterHealth>("/meter/health"),
    )
    .await;
    let build = shared::build_info(env!("FACTORY_INPUTS_FINGERPRINT"));
    Json(Health {
        status: if state.require_clock().is_ok() {
            "ok"
        } else {
            "clock_unsynchronized"
        }
        .into(),
        version: build.version,
        git_sha: build.git_sha,
        git_dirty: build.git_dirty,
        built_at_ms: build.built_at_ms,
        inputs_fingerprint: build.inputs_fingerprint,
        openapi_sha256: openapi_sha256().into(),
        meter_openapi_expected: env!("FACTORY_METER_OPENAPI_SHA256").into(),
        meter_openapi_sha256: meter
            .ok()
            .and_then(Result::ok)
            .and_then(|m| m.openapi_sha256),
        uptime_ms: state.started.elapsed().as_millis() as u64,
        retention: state.retention(),
    })
}
#[utoipa::path(get, path="/v1/fleet", responses((status=200, body=Fleet)))]
async fn fleet(state: &AppState) -> Json<Fleet> {
    if state.fleet.read().await.generated_at_ms == 0 {
        state.collect_fleet().await;
    }
    Json(state.fleet.read().await.clone())
}
enum DeviceRoute {
    List,
    Current(String),
    History(String),
    Samples(String),
    Unknown,
}

fn device_route(path: &str) -> Option<DeviceRoute> {
    let rest = path.strip_prefix("/v1/devices")?;
    if rest.is_empty() {
        return Some(DeviceRoute::List);
    }
    let rest = rest.strip_prefix('/')?;
    let (id, kind): (&str, fn(String) -> DeviceRoute) =
        if let Some(id) = rest.strip_suffix("/samples") {
            (id, DeviceRoute::Samples)
        } else if let Some(id) = rest.strip_suffix("/history") {
            (id.strip_suffix('/').unwrap_or(id), DeviceRoute::History)
        } else {
            (rest, DeviceRoute::Current)
        };
    if id.is_empty() || id.contains('/') {
        return Some(DeviceRoute::Unknown);
    }
    Some(kind(id.into()))
}

#[utoipa::path(get, path="/v1/devices", responses((status=200, body=DeviceList)))]
async fn devices_list(state: &AppState) -> Json<DeviceList> {
    let view = state.devices_view().await;
    let mut devices = vec![view.summary()];
    for remote in state.remote_views(view.generated_at_ms).await {
        devices.push(remote.summary());
    }
    Json(crate::devices::DeviceList {
        generated_at_ms: view.generated_at_ms,
        devices,
    })
}

#[utoipa::path(get, path="/v1/devices/factory-gpu", responses((status=200, body=DeviceView),(status=404, body=ApiError)))]
async fn device_current(state: &AppState) -> Json<DeviceView> {
    Json(state.devices_view().await)
}

/// An enrolled remote device: stale after 45 s of transport or collection age, and
/// `unknown` until its first fresh sample since factory-api started. `factory-gpu`
/// is served the same way at its literal path.
#[utoipa::path(get, path="/v1/devices/{device_id}", params(("device_id"=String, Path)), responses((status=200, body=DeviceView),(status=404, body=ApiError)))]
async fn remote_device_current(state: &AppState, device_id: &str) -> Json<DeviceView> {
    Json(state.remote.view(device_id, now_ms()).await)
}

fn device_range(request: &Request<Body>) -> Result<(String, i64, i64, bool), String> {
    let Query(query) =
        Query::<RangeQuery>::try_from_uri(request.uri()).map_err(|e| e.to_string())?;
    let range = query.range.unwrap_or_else(|| "1h".into());
    let (hours, raw) = match range.as_str() {
        "1h" => (1, true),
        "24h" => (24, false),
        "7d" => (168, false),
        _ => return Err("range must be 1h, 24h, or 7d".into()),
    };
    let now = now_ms();
    Ok((range, now - hours * devices_history::HOUR_MS, now, raw))
}

#[utoipa::path(get, path="/v1/devices/factory-gpu/history", params(("range"=Option<String>, Query, description="1h (default), 24h, or 7d")), responses((status=200, body=DeviceHistory),(status=400, body=ApiError),(status=404, body=ApiError)))]
async fn device_history(state: &AppState, request: Request<Body>) -> Response {
    history_for(state, devices::DEVICE_ID, request).await
}

#[utoipa::path(get, path="/v1/devices/{device_id}/history", params(("device_id"=String, Path), ("range"=Option<String>, Query, description="1h (default), 24h, or 7d")), responses((status=200, body=DeviceHistory),(status=400, body=ApiError),(status=404, body=ApiError)))]
async fn remote_device_history(
    state: &AppState,
    device_id: &str,
    request: Request<Body>,
) -> Response {
    history_for(state, device_id, request).await
}

async fn history_for(state: &AppState, device_id: &str, request: Request<Body>) -> Response {
    let (range, since, now, raw) = match device_range(&request) {
        Ok(value) => value,
        Err(message) => return error(StatusCode::BAD_REQUEST, "invalid_range", message),
    };
    let id = device_id.to_string();
    let points = state
        .db
        .requests
        .read(&state.query_scope, move |db| {
            devices_history::history(db, &id, since, now, raw)
        })
        .await;
    match points {
        Ok(points) => Json(DeviceHistory {
            device_id: device_id.into(),
            range,
            generated_at_ms: now,
            points,
        })
        .into_response(),
        Err(failure) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            failure.to_string(),
        ),
    }
}

fn ingest_error(rejection: devices_ingest::Rejection) -> Response {
    let mut detail = serde_json::json!({
        "code": rejection.code,
        "message": rejection.message,
    });
    if let Some(field) = rejection.field {
        detail["field"] = field.into();
    }
    let mut body = serde_json::json!({ "error": detail });
    if rejection.code == "unsupported_schema_version" {
        body["accepted_schema_versions"] = devices_ingest::SCHEMA_VERSIONS.to_vec().into();
    }
    (rejection.status, Json(body)).into_response()
}

/// Claimed device and caller for failed-credential logs. Never the token.
fn caller(request: &Request<Body>) -> (String, String) {
    let peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.to_string())
        .unwrap_or_else(|| "unknown".into());
    let forwarded = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .chars()
                .filter(|c| c.is_ascii_graphic() || *c == ' ')
                .take(100)
                .collect()
        })
        .unwrap_or_else(|| "-".into());
    (peer, forwarded)
}

/// One remote sample (docs/devices-ingest.md). Checks run in the contract's order:
/// method, Sec-Fetch-Site, credential, device binding, content type, body size,
/// JSON and schema, then rate. Errors use ApiError, adding `error.field` and, for
/// `unsupported_schema_version`, `accepted_schema_versions`.
#[utoipa::path(post, path="/v1/devices/{device_id}/samples", params(("device_id"=String, Path)),
    request_body(content=crate::devices_ingest::DeviceSampleV1, description="Schema version 1 sample; see docs/devices-ingest.md", content_type="application/json"),
    security(("device_bearer"=[])),
    responses(
        (status=200, body=IngestResult),
        (status=400, body=ApiError), (status=401, body=ApiError), (status=403, body=ApiError),
        (status=405, body=ApiError), (status=413, body=ApiError), (status=415, body=ApiError),
        (status=429, body=ApiError, headers(("Retry-After"=u64, description="Seconds before retrying"))),
        (status=500, body=ApiError)
    ))]
async fn ingest_sample(state: &AppState, device_id: &str, request: Request<Body>) -> Response {
    let claimed = if crate::device_auth::valid_device_id(device_id) {
        device_id.to_string()
    } else {
        "<invalid>".into()
    };
    if request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return error(
            StatusCode::FORBIDDEN,
            "cross_site",
            "cross-site sample refused",
        );
    }
    let Some(credential) = state
        .remote
        .tokens
        .verify(request.headers().get(axum::http::header::AUTHORIZATION))
    else {
        let (peer, forwarded) = caller(&request);
        tracing::warn!(device = %claimed, %peer, %forwarded, "device ingest refused: missing or unknown credential");
        let mut response = error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing, malformed, unknown or revoked device credential",
        );
        response
            .headers_mut()
            .insert("www-authenticate", "Bearer".parse().unwrap());
        return response;
    };
    if device_id == devices::DEVICE_ID || credential != device_id {
        let (peer, forwarded) = caller(&request);
        tracing::warn!(device = %claimed, credential = %credential, %peer, %forwarded, "device ingest refused: credential is for another device");
        return error(
            StatusCode::FORBIDDEN,
            "forbidden_device",
            "credential may not write this device",
        );
    }
    let json = request
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"));
    if !json {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Content-Type must be application/json",
        );
    }
    let body = match axum::body::to_bytes(request.into_body(), devices_ingest::MAX_BODY).await {
        Ok(body) => body,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "body exceeds 64 KiB",
            );
        }
    };
    let received_at_ms = now_ms();
    let sample = match devices_ingest::parse(&body, device_id, received_at_ms) {
        Ok(sample) => sample,
        Err(rejection) => return ingest_error(rejection),
    };
    if let Err(seconds) = state.remote.admit(device_id, received_at_ms) {
        let mut response = error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "more than 4 samples per second for this device",
        );
        response
            .headers_mut()
            .insert("retry-after", seconds.to_string().parse().unwrap());
        return response;
    }
    match state.ingest_sample(sample, received_at_ms).await {
        Ok(result) => Json(result).into_response(),
        Err(failure) => {
            tracing::error!(device = %claimed, error = %failure, "device ingest storage failed");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "storage failed; nothing was written",
            )
        }
    }
}

#[utoipa::path(get, path="/v1/ups", responses((status=200, body=Ups)))]
async fn ups(state: &AppState) -> Json<Ups> {
    Json(state.ups().await)
}

fn ups_range(request: &Request<Body>) -> Result<(String, i64, i64), String> {
    let Query(query) =
        Query::<RangeQuery>::try_from_uri(request.uri()).map_err(|e| e.to_string())?;
    let range = query.range.unwrap_or_else(|| "24h".into());
    let hours = match range.as_str() {
        "1h" => 1,
        "24h" => 24,
        "7d" => 168,
        "30d" => 720,
        "365d" => 8760,
        _ => return Err("range must be 1h, 24h, 7d, 30d, 365d".into()),
    };
    let now = now_ms();
    Ok((range, now - hours * ups_history::HOUR_MS, now))
}
/// Raw ranges use at most 720 time buckets. All metrics expose min/avg/max;
/// runtime is the minimum. Longer ranges include the overlapping hourly bucket.
#[utoipa::path(get, path="/v1/ups/history", params(("range"=Option<String>, Query, description="1h, 24h (default), 7d, 30d, 365d")), responses((status=200, body=[UpsPoint]),(status=400, body=ApiError),(status=500, body=ApiError)))]
async fn ups_history(state: &AppState, request: Request<Body>) -> Response {
    let (_, since, now) = match ups_range(&request) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_range", e),
    };
    response(
        state
            .db
            .requests
            .read(&state.query_scope, move |db| {
                ups_history::history(db, since, now, now - since <= ups_history::DAY_MS)
            })
            .await,
    )
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct UpsEventsQuery {
    limit: Option<u32>,
    before_ms: Option<i64>,
    before_id: Option<i64>,
}
#[utoipa::path(get, path="/v1/ups/events", params(("limit"=Option<u32>, Query, description="1–200; default 50"),("before_ms"=Option<i64>, Query, description="Exclusive timestamp cursor"),("before_id"=Option<i64>, Query, description="Use with next_before_ms to page simultaneous events without loss")), responses((status=200, body=UpsEvents),(status=400, body=ApiError),(status=500, body=ApiError)))]
async fn ups_events(state: &AppState, request: Request<Body>) -> Response {
    let query = match Query::<UpsEventsQuery>::try_from_uri(request.uri()) {
        Ok(Query(v)) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_query", e.to_string()),
    };
    let limit = query.limit.unwrap_or(50);
    if !(1..=200).contains(&limit)
        || query.before_ms.is_some_and(|v| v < 0)
        || query.before_id.is_some_and(|v| v < 1)
        || (query.before_id.is_some() && query.before_ms.is_none())
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "limit must be 1–200; cursor must contain a nonnegative timestamp and optional positive ID",
        );
    }
    let before_ms = query.before_ms.unwrap_or(i64::MAX);
    let before_id = query.before_id.unwrap_or(if query.before_ms.is_some() {
        0
    } else {
        i64::MAX
    });
    response(
        state
            .db
            .requests
            .read(&state.query_scope, move |db| {
                ups_history::events(db, limit, before_ms, before_id)
            })
            .await,
    )
}
/// Costs round half-up once per range. Coverage counts intervals between reads
/// no more than 30s apart. An expired leading partial hour is omitted, not estimated.
/// GPU energy uses the same covered UPS intervals and right-endpoint rounding.
/// It is null if GPU coverage is missing or its energy exceeds the UPS load.
#[utoipa::path(get, path="/v1/ups/energy", params(("range"=Option<String>, Query, description="1h, 24h (default), 7d, 30d, 365d")), responses((status=200, body=UpsEnergy),(status=400, body=ApiError),(status=500, body=ApiError)))]
async fn ups_energy(state: &AppState, request: Request<Body>) -> Response {
    let (range, since, now) = match ups_range(&request) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_range", e),
    };
    let result = async {
        let ups_history::CoveredEnergy {
            mut energy,
            intervals,
        } = state
            .db
            .requests
            .read(&state.query_scope, move |db| {
                ups_history::energy(db, since, now)
            })
            .await?;
        // Meter retains only seven days; a missing upstream must not hide UPS data.
        if matches!(range.as_str(), "1h" | "24h" | "7d")
            && let Some(intervals) = intervals
            && let Ok(Ok(samples)) = tokio::time::timeout(
                Duration::from_secs(2),
                state.get::<Vec<shared::GpuSample>>(&format!(
                    "/meter/gpu/history?range={}",
                    if range == "1h" { "24h" } else { &range }
                )),
            )
            .await
        {
            energy.gpu_energy_mwh = ups_history::gpu_energy(&samples, &intervals)?;
        }
        let exceeds = energy
            .gpu_energy_mwh
            .is_some_and(|gpu| gpu > energy.energy_mwh);
        if exceeds {
            energy.gpu_energy_mwh = None;
        }
        state
            .warning(
                "energy",
                exceeds.then(|| "GPU energy exceeds UPS energy over covered intervals".into()),
            )
            .await;
        anyhow::Ok(energy)
    }
    .await;
    response(result)
}
#[utoipa::path(get, path="/v1/settings/ups", responses((status=200, body=UpsSettings),(status=500, body=ApiError)))]
async fn get_ups_settings(state: &AppState) -> Response {
    response(
        state
            .db
            .requests
            .read(&state.query_scope, ups_history::settings)
            .await,
    )
}
#[utoipa::path(put, path="/v1/settings/ups", request_body=UpsSettings, responses((status=200, body=UpsSettings),(status=400, body=ApiError),(status=403, body=ApiError),(status=413, body=ApiError),(status=503, body=ApiError),(status=500, body=ApiError)))]
async fn put_ups_settings(state: &AppState, request: Request<Body>) -> Response {
    if request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return error(
            StatusCode::FORBIDDEN,
            "cross_site",
            "cross-site settings write refused",
        );
    }
    if let Err(e) = state.require_clock() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "clock_unsynchronized",
            e.to_string(),
        );
    }
    let body = match axum::body::to_bytes(request.into_body(), 1024).await {
        Ok(v) => v,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "body exceeds 1024 bytes",
            );
        }
    };
    let values: UpsSettings = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_settings", e.to_string()),
    };
    if let Err(e) = values.validate(now_ms()) {
        return error(StatusCode::BAD_REQUEST, "invalid_settings", e.to_string());
    }
    response(
        state
            .db
            .write(&state.query_scope, move |db| {
                ups_history::put_settings(db, values, now_ms())
            })
            .await,
    )
}
/// Every registry target in layer order with its latest stored sample (null
/// before the first tick), plus network and clock warnings.
#[utoipa::path(get, path="/v1/network", responses((status=200, body=NetworkStatus),(status=500, body=ApiError)))]
async fn network(state: &AppState) -> Response {
    response(state.network().await)
}
#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
enum Resolution {
    Raw,
    Hourly,
}
#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
struct NetworkHistory {
    range: String,
    resolution: Resolution,
    series: Vec<NetworkSeries>,
}
/// 1h and 24h read raw bursts in at most 720 buckets per target; jitter is the
/// mean of the bursts' mdev. 7d and 30d read hourly rollups; jitter is the
/// nearest-rank p95 of each hour's mdev values. Loss is lost replies over sent.
#[utoipa::path(get, path="/v1/network/history", params(("range"=Option<String>, Query, description="1h, 24h (default), 7d, 30d")), responses((status=200, body=NetworkHistory),(status=400, body=ApiError),(status=500, body=ApiError)))]
async fn network_history(state: &AppState, request: Request<Body>) -> Response {
    let Ok(Query(query)) = Query::<RangeQuery>::try_from_uri(request.uri()) else {
        return error(StatusCode::BAD_REQUEST, "invalid_range", "malformed query");
    };
    let range = query.range.unwrap_or_else(|| "24h".into());
    let (hours, resolution) = match range.as_str() {
        "1h" => (1, Resolution::Raw),
        "24h" => (24, Resolution::Raw),
        "7d" => (168, Resolution::Hourly),
        "30d" => (720, Resolution::Hourly),
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_range",
                "range must be 1h, 24h, 7d, or 30d",
            );
        }
    };
    let now = now_ms();
    let since = now - hours * ups_history::HOUR_MS;
    let raw = matches!(resolution, Resolution::Raw);
    response(
        state
            .db
            .requests
            .read(&state.query_scope, move |db| {
                network_history::history(db, crate::network::DEVICE_ID, since, now, raw)
            })
            .await
            .map(|series| NetworkHistory {
                range,
                resolution,
                series,
            }),
    )
}
#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
struct NetworkSpeedTests {
    range: String,
    /// Oldest first.
    tests: Vec<NetworkSpeedTest>,
}
/// Throughput tests that started within the range, for charts.
#[utoipa::path(get, path="/v1/network/speed-tests", params(("range"=Option<String>, Query, description="24h, 7d (default), 30d, 365d")), responses((status=200, body=NetworkSpeedTests),(status=400, body=ApiError),(status=500, body=ApiError)))]
async fn network_speed_tests(state: &AppState, request: Request<Body>) -> Response {
    let Ok(Query(query)) = Query::<RangeQuery>::try_from_uri(request.uri()) else {
        return error(StatusCode::BAD_REQUEST, "invalid_range", "malformed query");
    };
    let range = query.range.unwrap_or_else(|| "7d".into());
    let days = match range.as_str() {
        "24h" => 1,
        "7d" => 7,
        "30d" => 30,
        "365d" => 365,
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_range",
                "range must be 24h, 7d, 30d, or 365d",
            );
        }
    };
    let since = now_ms() - days * ups_history::DAY_MS;
    response(
        state
            .db
            .requests
            .read(&state.query_scope, move |db| {
                network_history::speed_tests(db, crate::network::DEVICE_ID, since)
            })
            .await
            .map(|tests| NetworkSpeedTests { range, tests }),
    )
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NetworkEventsQuery {
    limit: Option<u32>,
    before: Option<i64>,
}
/// Degraded and down episodes, newest first by started_ms then id, the open one included.
#[utoipa::path(get, path="/v1/network/events", params(("limit"=Option<u32>, Query, description="1–200; default 50"),("before"=Option<i64>, Query, description="Exclusive cursor: an event id, such as the previous page's next_before. The page continues after that event in (started_ms, id) descending order; an unknown id is a 400.")), responses((status=200, body=NetworkEvents),(status=400, body=ApiError),(status=500, body=ApiError)))]
async fn network_events(state: &AppState, request: Request<Body>) -> Response {
    let query = match Query::<NetworkEventsQuery>::try_from_uri(request.uri()) {
        Ok(Query(v)) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_query", e.to_string()),
    };
    let limit = query.limit.unwrap_or(50);
    let before = query.before;
    if !(1..=200).contains(&limit) || before.is_some_and(|id| id < 1) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "limit must be 1–200; before must be a positive event id",
        );
    }
    let page = state
        .db
        .requests
        .read(&state.query_scope, move |db| {
            network_history::events(db, crate::network::DEVICE_ID, limit, before)
        })
        .await;
    match page {
        Ok(Some(page)) => Json(page).into_response(),
        Ok(None) => error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "before is not a known event id",
        ),
        Err(e) => response::<()>(Err(e)),
    }
}
#[utoipa::path(get, path="/v1/agents", responses((status=200, body=Agents)))]
async fn agents(state: &AppState) -> Json<Agents> {
    Json(crate::usage::read(&state.usage_snapshot).await)
}
/// Active alerts and the last 20 cleared ones, as posted to Slack `#factory-alerts`.
#[utoipa::path(get, path="/v1/alerts", responses((status=200, body=Alerts)))]
async fn alerts(state: &AppState) -> Json<Alerts> {
    Json(state.alerts.view().await)
}
#[utoipa::path(post, path="/v1/agents/refresh", responses(
    (status=202, body=AgentsRefresh),
    (status=429, body=AgentsRefreshCooldown, headers(("Retry-After"=u64, description="Seconds until next refresh, rounded up"))),
    (status=400, body=ApiError), (status=403, body=ApiError),
    (status=413, body=ApiError), (status=500, body=ApiError)
))]
async fn refresh_agents(state: &AppState, request: Request<Body>) -> Response {
    // Block cross-site browser submissions without adding privileges or auth.
    if request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return error(
            StatusCode::FORBIDDEN,
            "cross_site",
            "cross-site refresh refused",
        );
    }
    match axum::body::to_bytes(request.into_body(), 1024).await {
        Ok(body) if body.is_empty() => (),
        Ok(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "unexpected_body",
                "refresh takes no body",
            );
        }
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "body exceeds 1024 bytes",
            );
        }
    }
    match state.refresh_usage().await {
        Ok((true, next_allowed_at_ms)) => (
            StatusCode::ACCEPTED,
            Json(AgentsRefresh {
                status: "accepted".into(),
                next_allowed_at_ms,
            }),
        )
            .into_response(),
        Ok((false, next_allowed_at_ms)) => {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(AgentsRefreshCooldown {
                    error: ErrorDetail {
                        code: "cooldown".into(),
                        message: "usage refresh is cooling down".into(),
                    },
                    next_allowed_at_ms,
                }),
            )
                .into_response();
            let seconds =
                (next_allowed_at_ms.saturating_sub(now_ms()).max(1) as u64).div_ceil(1000);
            response
                .headers_mut()
                .insert("retry-after", seconds.to_string().parse().unwrap());
            response
        }
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "trigger_write_failed",
            "could not request usage refresh",
        ),
    }
}
#[utoipa::path(get, path="/v1/stream", responses((status=200, content_type="text/event-stream", body=StreamEvent)))]
fn stream(
    state: &AppState,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>> + use<>> {
    let receiver = state.events.subscribe();
    let keepalive = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(15),
        Duration::from_secs(15),
    );
    let events = futures_util::stream::unfold(
        (receiver, keepalive, state.shutdown.clone()),
        |(mut receiver, mut keepalive, shutdown)| async move {
            loop {
                tokio::select! { biased;
                    _ = shutdown.cancelled() => return None,
                    _ = keepalive.tick() => return Some((Ok(Event::default().comment("keepalive")), (receiver, keepalive, shutdown))),
                    result = receiver.recv() => match result {
                    Ok(event) => {
                        return Some((
                            Ok(Event::default()
                                .event(&event.r#type)
                                .json_data(&event)
                                .expect("JSON event")),
                            (receiver, keepalive, shutdown),
                        ));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        tracing::warn!(count, "SSE client lagged; reconnect and fetch snapshots")
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                    }
                }
            }
        },
    );
    Sse::new(events)
}
#[utoipa::path(get, path="/v1/llm/usage", params(("range"=Option<String>, Query, description="24h (default), 7d, 30d, 365d. Percentiles are exact nearest-rank values through 30d; 365d percentiles come from merged latency histograms and set percentiles_approximate.")), responses((status=200, body=Usage),(status=400, body=ApiError)))]
async fn usage(state: &AppState, range: String, since: i64) -> Response {
    response(state.usage(range, since).await)
}
#[utoipa::path(get, path="/v1/gpu", params(("range"=Option<String>, Query, description="1h (default), 24h, 7d")), responses((status=200, body=Gpu),(status=400, body=ApiError)))]
async fn gpu(state: &AppState, range: &str, since: i64) -> Response {
    Json(state.gpu(range, since).await).into_response()
}
#[utoipa::path(get, path="/v1/pricing", responses((status=200, body=Pricing)))]
async fn pricing(state: &AppState) -> Response {
    response(state.pricing().await)
}
#[utoipa::path(post, path="/v1/pricing/refresh", responses((status=200, body=Pricing)))]
async fn refresh(state: &AppState) -> Response {
    response(state.refresh_pricing().await)
}
#[utoipa::path(post, path="/v1/pricing/confirm/{family}", params(("family"=String, Path)), responses((status=200, body=Pricing),(status=404, body=ApiError),(status=409, body=ApiError)))]
async fn confirm_selection(state: &AppState, family: String) -> Response {
    match state.confirm_pricing(family).await {
        Err(e) if e.to_string() == "no pending change for this family" => {
            error(StatusCode::CONFLICT, "no_pending_selection", e.to_string())
        }
        result => response(result),
    }
}
#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        fleet,
        agents,
        refresh_agents,
        alerts,
        stream,
        usage,
        gpu,
        devices_list,
        device_current,
        device_history,
        remote_device_current,
        remote_device_history,
        ingest_sample,
        ups,
        ups_history,
        ups_events,
        ups_energy,
        get_ups_settings,
        put_ups_settings,
        network,
        network_history,
        network_speed_tests,
        network_events,
        pricing,
        refresh,
        confirm_selection
    ),
    components(schemas(
        Health,
        RequestRetention,
        ApiError,
        Fleet,
        Usage,
        Gpu,
        Ups,
        UpsCurrent,
        DeviceList,
        DeviceView,
        DeviceHistory,
        IngestResult,
        crate::devices_ingest::DeviceSampleV1,
        NetworkStatus,
        NetworkSpeedTest,
        Sample,
        Pricing,
        Agents,
        Alerts,
        StreamEvent,
        LlmRequest,
        FleetChange,
        PricingChanged
    )),
    modifiers(&DeviceBearer)
)]
struct ApiDoc;

/// `device_bearer`: the per-device `fdv1_` token sent as `Authorization: Bearer`.
struct DeviceBearer;

impl utoipa::Modify for DeviceBearer {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
        openapi.components.get_or_insert_with(Default::default).add_security_scheme(
            "device_bearer",
            SecurityScheme::Http(
                HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .description(Some(
                        "Per-device token (fdv1_ plus 43 base64url characters); the server stores only its SHA-256.",
                    ))
                    .build(),
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::{self, Availability};
    use axum::http::StatusCode;

    async fn state() -> AppState {
        let directory = tempfile::tempdir().unwrap();
        pricing::migrate(directory.path().join("pricing.db")).unwrap();
        AppState::new(
            "http://127.0.0.1:1".into(),
            directory.path().join("requests.db"),
            directory.path().join("pricing.db"),
            crate::fleet::Config { nodes: vec![] },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn stale_snapshot_is_not_served_as_live() {
        let state = state().await;
        let now = now_ms();
        let old = now - 60_000;
        let mut view = devices::unavailable(old);
        view.device.observed_at_ms = old;
        view.device.collector.fast_ok = true;
        view.device.collector.last_fast_ms = Some(old);
        view.device.cpu.utilization =
            devices::metric("%", old, Availability::Available, Some(12.0), None);
        *state.devices_latest.write().await = Some(view);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server =
            tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
        let body: serde_json::Value = reqwest::get(format!("{url}/v1/devices/factory-gpu"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            body["device"]["cpu"]["utilization"]["value"],
            serde_json::Value::Null
        );
        assert_eq!(
            body["device"]["cpu"]["utilization"]["availability"],
            "stale"
        );
        assert_eq!(body["device"]["health"]["status"], "stale");
        server.abort();
    }

    #[tokio::test]
    async fn unknown_device_and_range_use_the_error_envelope() {
        let state = state().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server =
            tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
        let client = reqwest::Client::new();
        let missing = client
            .get(format!("{url}/v1/devices/other"))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let body: serde_json::Value = missing.json().await.unwrap();
        assert_eq!(body["error"]["code"], "unknown_device");
        let range = client
            .get(format!("{url}/v1/devices/factory-gpu/history?range=30d"))
            .send()
            .await
            .unwrap();
        assert_eq!(range.status(), StatusCode::BAD_REQUEST);
        let body: serde_json::Value = range.json().await.unwrap();
        assert_eq!(body["error"]["message"], "range must be 1h, 24h, or 7d");
        server.abort();
    }
}
