pub mod db;
mod telemetry;
mod usage;

use axum::{
    Router,
    body::{Body, Bytes, HttpBody},
    extract::{ConnectInfo, State},
    http::{Request, Response, StatusCode},
    response::IntoResponse,
};
use http_body_util::BodyExt;
use hyper::body::{Frame, SizeHint};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use shared::{ApiError, RequestRecord};
use std::{
    collections::HashMap,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex, RwLock},
    task::{Context, Poll},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use usage::UsageParser;

#[derive(Clone)]
pub struct AppState {
    pub db: db::Db,
    pub upstream: String,
    client: Client<HttpConnector, Body>,
    hosts: Arc<RwLock<HashMap<String, String>>>,
}

impl AppState {
    pub fn new(upstream: String, db: db::Db) -> Self {
        Self {
            db,
            upstream: upstream.trim_end_matches('/').into(),
            client: Client::builder(TokioExecutor::new()).build_http(),
            hosts: Default::default(),
        }
    }

    pub fn start_telemetry(&self, seconds: u64) {
        telemetry::start(self.clone(), seconds);
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub fn router(state: AppState) -> Router {
    Router::new().fallback(dispatch).with_state(state)
}

async fn dispatch(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut request: Request<Body>,
) -> Response<Body> {
    let endpoint = request.uri().path().to_owned();
    if endpoint == "/meter" || endpoint.starts_with("/meter/") {
        return api::handle(&state, request).await;
    }
    let started = Instant::now();
    let ip = peer.ip().to_string();
    let hostname = state
        .hosts
        .read()
        .unwrap()
        .get(&ip)
        .cloned()
        .unwrap_or_else(|| ip.clone());
    let record = Arc::new(Mutex::new(RequestRecord {
        ts: now_ms(),
        endpoint: endpoint.clone(),
        stream: matches!(endpoint.as_str(), "/api/generate" | "/api/chat"),
        client_ip: ip,
        client_hostname: hostname,
        ..Default::default()
    }));
    let uri = format!(
        "{}{}",
        state.upstream,
        request
            .uri()
            .path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/")
    );
    *request.uri_mut() = match uri.parse() {
        Ok(uri) => uri,
        Err(error) => {
            return api::error(
                StatusCode::BAD_GATEWAY,
                format!("invalid upstream URI: {error}"),
            );
        }
    };
    let (parts, body) = request.into_parts();
    let request_body = Body::new(Tap {
        inner: body,
        record: record.clone(),
        parser: UsageParser::default(),
        request_bytes: Vec::new(),
        request: true,
        inspect: true,
        db: None,
        started,
        finished: false,
    });
    match state
        .client
        .request(Request::from_parts(parts, request_body))
        .await
    {
        Ok(response) => {
            record.lock().unwrap().status = response.status().as_u16();
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("");
            let lines = content_type.contains("ndjson") || content_type.contains("event-stream");
            let inspect = matches!(
                endpoint.as_str(),
                "/api/generate" | "/api/chat" | "/v1/chat/completions" | "/v1/completions"
            ) || !response.status().is_success();
            let (parts, body) = response.into_parts();
            let mut parser = UsageParser::default();
            parser.lines = lines;
            Response::from_parts(
                parts,
                Body::new(Tap {
                    inner: Body::new(body),
                    record,
                    parser,
                    request_bytes: Vec::new(),
                    request: false,
                    inspect,
                    db: Some(state.db),
                    started,
                    finished: false,
                }),
            )
        }
        Err(error) => {
            let mut record = record.lock().unwrap();
            record.status = 502;
            record.error = Some(error.to_string());
            record.latency_ms = started.elapsed().as_secs_f64() * 1000.0;
            state.db.send(db::Event::Request(Box::new(record.clone())));
            api::error(StatusCode::BAD_GATEWAY, error.to_string())
        }
    }
}

struct Tap {
    inner: Body,
    record: Arc<Mutex<RequestRecord>>,
    parser: UsageParser,
    request_bytes: Vec<u8>,
    request: bool,
    inspect: bool,
    db: Option<db::Db>,
    started: Instant,
    finished: bool,
}

impl Tap {
    fn finish(&mut self, interrupted: bool) {
        if self.finished {
            return;
        }
        self.finished = true;
        let mut record = self.record.lock().unwrap();
        if self.request {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&self.request_bytes) {
                if let Some(model) = value["model"].as_str() {
                    record.model = Some(model.into());
                }
                if let Some(stream) = value["stream"].as_bool() {
                    record.stream = stream;
                }
            }
        } else {
            self.parser.finish(&mut record);
            if interrupted && record.error.is_none() {
                record.error = Some("response stream interrupted".into());
            }
            record.latency_ms = self.started.elapsed().as_secs_f64() * 1000.0;
            tracing::info!(endpoint = %record.endpoint, status = record.status, latency_ms = record.latency_ms, "request completed");
            if let Some(db) = &self.db {
                db.send(db::Event::Request(Box::new(record.clone())));
            }
        }
    }
}

impl hyper::body::Body for Tap {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let frame = Pin::new(&mut self.inner).poll_frame(cx);
        match &frame {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(bytes) = frame.data_ref() {
                    if self.request {
                        self.request_bytes.extend_from_slice(bytes);
                    } else if self.inspect {
                        let record = self.record.clone();
                        self.parser.feed(bytes, &mut record.lock().unwrap());
                    }
                }
                if self.inner.is_end_stream() {
                    self.finish(false);
                }
            }
            Poll::Ready(None) => self.finish(false),
            Poll::Ready(Some(Err(error))) => {
                self.record.lock().unwrap().error = Some(error.to_string());
                self.finish(true);
            }
            Poll::Pending => {}
        }
        frame
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.finish(!self.inner.is_end_stream());
    }
}

mod api {
    use super::*;
    use axum::{Json, extract::Query, http::Method};
    use shared::{GpuResponse, Health, MeterQuery, ModelStats};
    use utoipa::OpenApi;

    fn since(range: Option<&str>) -> Result<i64, String> {
        let days = match range.unwrap_or("24h") {
            "24h" => 1,
            "7d" => 7,
            "30d" => 30,
            _ => return Err("range must be 24h, 7d, or 30d".into()),
        };
        Ok(now_ms() - days * 86_400_000)
    }

    pub fn error(status: StatusCode, message: String) -> Response<Body> {
        (status, Json(ApiError { error: message })).into_response()
    }

    pub async fn handle(state: &AppState, request: Request<Body>) -> Response<Body> {
        if request.method() != Method::GET {
            return error(
                StatusCode::METHOD_NOT_ALLOWED,
                "meter endpoints require GET".into(),
            );
        }
        let path = request.uri().path().to_owned();
        let parameters = match Query::<MeterQuery>::try_from_uri(request.uri()) {
            Ok(parameters) => parameters.0,
            Err(error_message) => return error(StatusCode::BAD_REQUEST, error_message.to_string()),
        };
        let result = match path.as_str() {
            "/meter/health" => health(state).await,
            "/meter/openapi.json" => return openapi_doc(),
            "/meter/requests" => {
                let limit = parameters.limit.unwrap_or(100);
                if !(1..=10_000).contains(&limit) {
                    return error(StatusCode::BAD_REQUEST, "limit must be 1..=10000".into());
                }
                requests_doc(state, limit).await
            }
            "/meter/stats" | "/meter/gpu/history" => {
                let since = match since(parameters.range.as_deref()) {
                    Ok(since) => since,
                    Err(message) => return error(StatusCode::BAD_REQUEST, message),
                };
                if path == "/meter/gpu/history" {
                    history_doc(state, since).await
                } else {
                    stats_doc(state, since, parameters.model).await
                }
            }
            "/meter/gpu" => gpu(state).await,
            _ => return error(StatusCode::NOT_FOUND, "unknown meter endpoint".into()),
        };
        match result {
            Ok(value) => Json(value).into_response(),
            Err(message) => error(StatusCode::SERVICE_UNAVAILABLE, message),
        }
    }

    #[utoipa::path(get, path = "/meter/health", responses((status = 200, body = Health), (status = 503, body = ApiError)))]
    async fn health(state: &AppState) -> Result<serde_json::Value, String> {
        state
            .db
            .query("SELECT id,record FROM requests LIMIT 0".into())
            .await?;
        serde_json::to_value(Health {
            status: "ok".into(),
        })
        .map_err(|e| e.to_string())
    }

    #[utoipa::path(get, path = "/meter/gpu", responses((status = 200, body = GpuResponse), (status = 503, body = ApiError)))]
    async fn gpu(state: &AppState) -> Result<serde_json::Value, String> {
        let gpus = telemetry::gpu().await?;
        let request = Request::builder()
            .uri(format!("{}/api/ps", state.upstream))
            .body(Body::empty())
            .map_err(|e| e.to_string())?;
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            state.client.request(request),
        )
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Ollama /api/ps returned {}", response.status()));
        }
        let bytes = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            response.into_body().collect(),
        )
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
        .to_bytes();
        let ollama_ps = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        serde_json::to_value(GpuResponse { gpus, ollama_ps }).map_err(|e| e.to_string())
    }

    #[utoipa::path(get, path = "/meter/stats", params(("range" = Option<String>, Query, description = "24h (default), 7d, 30d"), ("model" = Option<String>, Query)), responses((status = 200, body = [ModelStats]), (status = 400, body = ApiError), (status = 503, body = ApiError)))]
    async fn stats_doc(
        state: &AppState,
        since: i64,
        model: Option<String>,
    ) -> Result<serde_json::Value, String> {
        let filter = model
            .map(|m| format!(" AND model = '{}'", m.replace('\'', "''")))
            .unwrap_or_default();
        let value = state
            .db
            .query(format!(
                "SELECT id,record FROM requests WHERE ts >= {since}{filter}"
            ))
            .await?;
        serde_json::from_value(value)
            .map(db::stats)
            .and_then(serde_json::to_value)
            .map_err(|e| e.to_string())
    }
    #[utoipa::path(get, path = "/meter/requests", params(("limit" = Option<usize>, Query, description = "1..10000; default 100")), responses((status = 200, body = [RequestRecord]), (status = 400, body = ApiError), (status = 503, body = ApiError)))]
    async fn requests_doc(state: &AppState, limit: usize) -> Result<serde_json::Value, String> {
        state
            .db
            .query(format!(
                "SELECT id,record FROM requests ORDER BY id DESC LIMIT {limit}"
            ))
            .await
    }
    #[utoipa::path(get, path = "/meter/gpu/history", params(("range" = Option<String>, Query, description = "24h (default), 7d, 30d; retained for 7 days")), responses((status = 200, body = [shared::GpuSample]), (status = 400, body = ApiError), (status = 503, body = ApiError)))]
    async fn history_doc(state: &AppState, since: i64) -> Result<serde_json::Value, String> {
        state
            .db
            .query(format!(
                "SELECT id,sample FROM gpu_samples WHERE ts >= {since} ORDER BY ts,id"
            ))
            .await
    }
    #[utoipa::path(get, path = "/meter/openapi.json", responses((status = 200, description = "OpenAPI 3.1 document")))]
    fn openapi_doc() -> Response<Body> {
        Json(ApiDoc::openapi()).into_response()
    }

    #[derive(OpenApi)]
    #[openapi(
        paths(health, gpu, stats_doc, requests_doc, history_doc, openapi_doc),
        components(schemas(
            RequestRecord,
            shared::GpuSample,
            GpuResponse,
            Health,
            ModelStats,
            ApiError,
            MeterQuery
        ))
    )]
    struct ApiDoc;
}
