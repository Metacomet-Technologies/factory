use crate::{AppState, now_ms};
use axum::{
    Json, Router,
    body::Body,
    extract::{FromRequestParts, Path, Query, State},
    http::{Method, Request, StatusCode},
    response::{IntoResponse, Response, Sse, sse::Event},
};
use shared::factory_api::*;
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
async fn dispatch(State(state): State<AppState>, request: Request<Body>) -> Response {
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
    let post = path == "/v1/pricing/refresh" || confirm.is_some();
    if !matches!(
        path,
        "/v1/health"
            | "/v1/fleet"
            | "/v1/llm/usage"
            | "/v1/gpu"
            | "/v1/pricing"
            | "/v1/pricing/refresh"
            | "/v1/agents"
            | "/v1/stream"
            | "/openapi.json"
    ) && confirm.is_none()
    {
        if !crate::kiosk::reserved(path) {
            return crate::kiosk::serve(&state.static_dir, request).await;
        }
        return error(StatusCode::NOT_FOUND, "not_found", "unknown endpoint");
    }
    if request.method() != if post { Method::POST } else { Method::GET } {
        let mut response = error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            if post {
                "endpoint requires POST"
            } else {
                "endpoint requires GET"
            },
        );
        response
            .headers_mut()
            .insert("allow", if post { "POST" } else { "GET" }.parse().unwrap());
        return response;
    }
    match path {
        "/v1/health" => health(&state).into_response(),
        "/v1/fleet" => fleet(&state).await.into_response(),
        "/v1/agents" => agents().into_response(),
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
    let build = shared::build_info();
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
#[utoipa::path(get, path="/v1/agents", responses((status=200, body=Agents)))]
fn agents() -> Json<Agents> {
    Json(Agents {
        tools: ["amp", "cursor", "claude-code", "codex", "kimi"]
            .into_iter()
            .map(|tool| AgentTool {
                tool: tool.into(),
                status: "not_tracked".into(),
                note: None,
            })
            .collect(),
    })
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
        stream,
        usage,
        gpu,
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
        Pricing,
        Agents,
        StreamEvent,
        LlmRequest,
        FleetChange,
        PricingChanged
    ))
)]
struct ApiDoc;
