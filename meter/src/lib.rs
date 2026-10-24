pub mod db;
pub mod migrate;
pub mod rollup;
mod storage;
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
    sync::{Arc, Mutex, OnceLock, RwLock},
    task::{Context, Poll},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use usage::UsageParser;

fn local_hostname() -> &'static str {
    static HOSTNAME: OnceLock<String> = OnceLock::new();
    HOSTNAME.get_or_init(|| {
        unsafe extern "C" {
            fn gethostname(name: *mut std::ffi::c_char, len: usize) -> std::ffi::c_int;
        }
        // Linux hostnames are at most 64 bytes; leave room for the terminating NUL.
        let mut buffer = [0_u8; 256];
        // SAFETY: gethostname writes at most buffer.len() bytes to this valid buffer.
        let result = unsafe { gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        assert_eq!(
            result,
            0,
            "gethostname: {}",
            std::io::Error::last_os_error()
        );
        let end = buffer.iter().position(|&byte| byte == 0).unwrap();
        String::from_utf8_lossy(&buffer[..end]).into_owned()
    })
}

#[derive(Clone)]
pub struct AppState {
    pub db: db::Db,
    pub upstream: String,
    client: Client<HttpConnector, Body>,
    hosts: Arc<RwLock<HashMap<String, String>>>,
}

impl AppState {
    pub fn new(upstream: String, db: db::Db) -> Self {
        local_hostname();
        Self {
            db,
            upstream: upstream.trim_end_matches('/').into(),
            client: Client::builder(TokioExecutor::new()).build_http(),
            hosts: Default::default(),
        }
    }

    pub fn start_telemetry(&self, seconds: u64) -> tokio::task::JoinHandle<()> {
        telemetry::start(self.clone(), seconds)
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
    let hostname = if peer.ip().is_loopback() {
        local_hostname().to_owned()
    } else {
        state
            .hosts
            .read()
            .unwrap()
            .get(&ip)
            .cloned()
            .unwrap_or_else(|| ip.clone())
    };
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
    use shared::{GpuResponse, Health, MeterQuery, MeterRequestsQuery, ModelStats};
    use utoipa::OpenApi;

    #[derive(serde::Serialize, utoipa::ToSchema)]
    struct MeterHealth {
        #[serde(flatten)]
        build: Health,
        /// SHA-256 (first 12 hex) of the whole served `/meter/openapi.json` snapshot.
        openapi_sha256: String,
        #[serde(flatten)]
        queue: db::QueueStatus,
        /// Rollup job health; status stays "ok" so inference health is unchanged.
        maintenance: db::Maintenance,
    }

    /// Range start relative to the request time `now`, which later reads reuse.
    fn since(range: Option<&str>, now: i64) -> Result<i64, String> {
        let days = match range.unwrap_or("24h") {
            "24h" => 1,
            "7d" => 7,
            "30d" => 30,
            "365d" => 365,
            _ => return Err("range must be 24h, 7d, 30d, or 365d".into()),
        };
        Ok(now - days * 86_400_000)
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
                let parameters = match Query::<MeterRequestsQuery>::try_from_uri(request.uri()) {
                    Ok(parameters) => parameters.0,
                    Err(message) => return error(StatusCode::BAD_REQUEST, message.to_string()),
                };
                let (default, max) = if parameters.after_id.is_some() {
                    (500, 5000)
                } else {
                    (100, 10_000)
                };
                let limit = parameters.limit.unwrap_or(default);
                if !(1..=max).contains(&limit) {
                    return error(StatusCode::BAD_REQUEST, format!("limit must be 1..={max}"));
                }
                if parameters.after_id.is_some_and(|id| id < 0) {
                    return error(
                        StatusCode::BAD_REQUEST,
                        "after_id must be nonnegative".into(),
                    );
                }
                return match requests_doc(state, limit, parameters.after_id).await {
                    Ok(response) => response,
                    Err(message) => error(StatusCode::SERVICE_UNAVAILABLE, message),
                };
            }
            "/meter/stats" | "/meter/gpu/history" => {
                // One request time: a 7d range stays raw however long the read waits.
                let now = now_ms();
                let since = match since(parameters.range.as_deref(), now) {
                    Ok(since) => since,
                    Err(message) => return error(StatusCode::BAD_REQUEST, message),
                };
                if path == "/meter/gpu/history" {
                    history_doc(state, since, now).await
                } else {
                    // Exact raw percentiles through 30 days; longer ranges are flagged.
                    let exact = parameters.range.as_deref() != Some("365d");
                    stats_doc(state, since, parameters.model, exact).await
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

    #[utoipa::path(get, path = "/meter/health", responses((status = 200, body = MeterHealth), (status = 503, body = ApiError)))]
    async fn health(state: &AppState) -> Result<serde_json::Value, String> {
        state.db.health().await.map_err(|e| e.to_string())?;
        serde_json::to_value(MeterHealth {
            build: shared::build_info(env!("FACTORY_INPUTS_FINGERPRINT")),
            openapi_sha256: openapi_sha256().into(),
            queue: state.db.queue_status(),
            maintenance: state.db.maintenance(),
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

    #[utoipa::path(get, path = "/meter/stats", params(("range" = Option<String>, Query, description = "24h (default), 7d, 30d, 365d. Percentiles are exact through 30d and approximate (flagged) beyond."), ("model" = Option<String>, Query)), responses((status = 200, body = [ModelStats]), (status = 400, body = ApiError), (status = 503, body = ApiError)))]
    async fn stats_doc(
        state: &AppState,
        since: i64,
        model: Option<String>,
        exact: bool,
    ) -> Result<serde_json::Value, String> {
        let stats = state
            .db
            .stats(since, model, exact)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(stats).map_err(|e| e.to_string())
    }
    #[utoipa::path(get, path = "/meter/requests", params(
        ("limit" = Option<usize>, Query, description = "Without after_id: 1..10000, default 100. With after_id: 1..5000, default 500."),
        ("after_id" = Option<i64>, Query, description = "Nonnegative cursor: return id > after_id in ascending order. Omit for legacy newest-first behavior.")
    ), responses((status = 200, body = [RequestRecord], headers(
        ("next_after_id" = i64, description = "Present only with after_id: last returned ID, or the supplied cursor for an empty page."),
        ("oldest_retained_id" = i64, description = "Present only with after_id on a nonempty page: the lowest request ID meter still stores, read in the same snapshot. Lower IDs were removed by 365-day retention, which never removes a higher ID.")
    )), (status = 400, body = ApiError), (status = 503, body = ApiError)))]
    async fn requests_doc(
        state: &AppState,
        limit: usize,
        after_id: Option<i64>,
    ) -> Result<Response<Body>, String> {
        let (rows, oldest) = state
            .db
            .requests_page(limit, after_id)
            .await
            .map_err(|e| e.to_string())?;
        let next = after_id.map(|cursor| rows.last().map_or(cursor, |row| row.id));
        let mut response = Json(rows).into_response();
        for (name, value) in [("next_after_id", next), ("oldest_retained_id", oldest)] {
            if let Some(value) = value {
                response
                    .headers_mut()
                    .insert(name, value.to_string().parse().unwrap());
            }
        }
        Ok(response)
    }
    #[utoipa::path(get, path = "/meter/gpu/history", params(("range" = Option<String>, Query, description = "24h (default), 7d, 30d, 365d. Raw samples are retained 7 days; longer ranges return hourly means (with samples) before that.")), responses((status = 200, body = [rollup::GpuPoint]), (status = 400, body = ApiError), (status = 503, body = ApiError)))]
    async fn history_doc(
        state: &AppState,
        since: i64,
        now: i64,
    ) -> Result<serde_json::Value, String> {
        let samples = state
            .db
            .history_at(since, now)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(samples).map_err(|e| e.to_string())
    }
    #[utoipa::path(get, path = "/meter/openapi.json", responses((status = 200, description = "OpenAPI 3.1 document")))]
    fn openapi_doc() -> Response<Body> {
        Json(ApiDoc::openapi()).into_response()
    }

    fn openapi_sha256() -> &'static str {
        use sha2::Digest;
        static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        HASH.get_or_init(|| {
            let spec = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI serializes");
            let snapshot = format!("{}\n", serde_json::to_string_pretty(&spec).unwrap());
            let digest = sha2::Sha256::digest(snapshot);
            digest[..6].iter().map(|b| format!("{b:02x}")).collect()
        })
    }

    #[derive(OpenApi)]
    #[openapi(
        paths(health, gpu, stats_doc, requests_doc, history_doc, openapi_doc),
        components(schemas(
            RequestRecord,
            shared::GpuSample,
            GpuResponse,
            Health,
            MeterHealth,
            db::QueueStatus,
            db::Maintenance,
            db::Retention,
            rollup::GpuPoint,
            ModelStats,
            ApiError,
            MeterQuery,
            MeterRequestsQuery
        ))
    )]
    struct ApiDoc;
}
