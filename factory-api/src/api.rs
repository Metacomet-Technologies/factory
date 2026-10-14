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
        _ => {
            return Err(if gpu {
                "range must be 1h, 24h, or 7d"
            } else {
                "range must be 24h, 7d, or 30d"
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
        "/v1/health" => health(&state).into_response(),
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
#[utoipa::path(get, path="/v1/health", responses((status=200, body=Health)))]
fn health(state: &AppState) -> Json<Health> {
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
        uptime_ms: state.started.elapsed().as_millis() as u64,
    })
}
#[utoipa::path(get, path="/v1/fleet", responses((status=200, body=Fleet)))]
async fn fleet(state: &AppState) -> Json<Fleet> {
    if state.fleet.read().await.generated_at_ms == 0 {
        state.collect_fleet().await;
    }
    Json(state.fleet.read().await.clone())
}
#[utoipa::path(get, path="/v1/ups", responses((status=200, body=Ups)))]
async fn ups(state: &AppState) -> Json<Ups> {
    Json(state.ups().await)
}

fn ups_range(request: &Request<Body>, energy: bool) -> Result<(String, i64, i64), String> {
    let Query(query) =
        Query::<RangeQuery>::try_from_uri(request.uri()).map_err(|e| e.to_string())?;
    let range = query.range.unwrap_or_else(|| "24h".into());
    let hours = match range.as_str() {
        "1h" if !energy => 1,
        "24h" => 24,
        "7d" => 168,
        "30d" => 720,
        "365d" => 8760,
        _ => return Err("range must be 24h, 7d, 30d, 365d (history also accepts 1h)".into()),
    };
    let now = now_ms();
    Ok((range, now - hours * ups_history::HOUR_MS, now))
}
/// Raw ranges use at most 720 time buckets. All metrics expose min/avg/max;
/// runtime is the minimum. Longer ranges include the overlapping hourly bucket.
#[utoipa::path(get, path="/v1/ups/history", params(("range"=Option<String>, Query, description="1h, 24h (default), 7d, 30d, 365d")), responses((status=200, body=[UpsPoint]),(status=400, body=ApiError),(status=500, body=ApiError)))]
async fn ups_history(state: &AppState, request: Request<Body>) -> Response {
    let (_, since, now) = match ups_range(&request, false) {
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
/// GPU energy is null unless GPU 0 history covers the range with gaps <=30s.
#[utoipa::path(get, path="/v1/ups/energy", params(("range"=Option<String>, Query, description="24h (default), 7d, 30d, 365d")), responses((status=200, body=UpsEnergy),(status=400, body=ApiError),(status=500, body=ApiError)))]
async fn ups_energy(state: &AppState, request: Request<Body>) -> Response {
    let (range, since, now) = match ups_range(&request, true) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_range", e),
    };
    let result = async {
        let mut energy = state
            .db
            .requests
            .read(&state.query_scope, move |db| {
                ups_history::energy(db, since, now)
            })
            .await?;
        // Meter retains only seven days; a missing upstream must not hide UPS data.
        if matches!(range.as_str(), "24h" | "7d")
            && let Ok(Ok(samples)) = tokio::time::timeout(
                Duration::from_secs(2),
                state.get::<Vec<shared::GpuSample>>(&format!("/meter/gpu/history?range={range}")),
            )
            .await
        {
            energy.gpu_energy_mwh = ups_history::gpu_energy(&samples, since, now)?;
        }
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
#[utoipa::path(get, path="/v1/llm/usage", params(("range"=Option<String>, Query, description="24h (default), 7d, 30d")), responses((status=200, body=Usage),(status=400, body=ApiError)))]
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
        ups,
        ups_history,
        ups_events,
        ups_energy,
        get_ups_settings,
        put_ups_settings,
        pricing,
        refresh,
        confirm_selection
    ),
    components(schemas(
        Health,
        ApiError,
        Fleet,
        Usage,
        Gpu,
        Ups,
        UpsCurrent,
        Pricing,
        Agents,
        Alerts,
        StreamEvent,
        LlmRequest,
        FleetChange,
        PricingChanged
    ))
)]
struct ApiDoc;
