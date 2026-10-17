//! Throughput tests against Cloudflare-compatible speed endpoints:
//! `GET {base}/__down?bytes=N` and `POST {base}/__up`. Storage lives in network_history.
use crate::network::{self, Burst};
use anyhow::{Context, Result, ensure};
use reqwest::header::HeaderMap;
use std::{
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_URL: &str = "https://speed.cloudflare.com";
pub const DEFAULT_INTERVAL_S: u64 = 10_800;
/// Twice the hard cap, so the link idles at least half the time even when every test times out.
pub const MIN_INTERVAL_S: u64 = 120;
pub const STARTUP_DELAY: Duration = Duration::from_secs(120);
/// Decimal megabytes, as in the spec's sequence table.
pub const MB: u64 = 1_000_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A real burst takes about 1.8 s, so loaded bursts run back to back.
const LOADED_SPACING: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Download,
    Upload,
}
impl Direction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Download => "download",
            Self::Upload => "upload",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub direction: Direction,
    pub bytes: u64,
    pub count: u32,
}
const fn step(direction: Direction, megabytes: u64, count: u32) -> Step {
    Step {
        direction,
        bytes: megabytes * MB,
        count,
    }
}
/// Sizes ascend within each direction; directions run in table order.
pub const SEQUENCE: [Step; 6] = [
    step(Direction::Download, 10, 4),
    step(Direction::Download, 25, 4),
    step(Direction::Download, 100, 3),
    step(Direction::Upload, 10, 4),
    step(Direction::Upload, 25, 4),
    step(Direction::Upload, 50, 3),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub steps: &'static [Step],
    /// A finished step with any request slower than this ends its direction.
    pub slow_request: Duration,
    /// Hard cap over the whole test, latency bursts included.
    pub cap: Duration,
}
pub const PLAN: Plan = Plan {
    steps: &SEQUENCE,
    slow_request: Duration::from_secs(1),
    cap: Duration::from_secs(60),
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeedConfig {
    /// From `base_url`: http(s), a host, and no credentials, query, fragment or trailing slash.
    pub base: String,
    /// The first wan target. Idle and loaded latency bursts go here.
    pub latency_target: IpAddr,
    pub interval: Duration,
    pub plan: Plan,
}
/// Validate `--network-speed-url` at parse time.
pub fn base_url(text: &str) -> Result<String> {
    let url = reqwest::Url::parse(text).context("speed URL must be an absolute http(s) URL")?;
    ensure!(
        matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(|h| !h.is_empty()),
        "speed URL must be http(s) with a host"
    );
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "speed URL must not carry credentials, a query or a fragment"
    );
    Ok(url.as_str().trim_end_matches('/').into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Ok { download_bps: i64, upload_bps: i64 },
    Failed(String),
    Timeout,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeedTest {
    pub started_ms: i64,
    pub ended_ms: i64,
    pub verdict: Verdict,
    /// Received download bytes, and upload bodies the server answered, for every verdict.
    pub download_bytes: i64,
    pub upload_bytes: i64,
    pub idle_latency_us: Option<i64>,
    pub download_loaded_latency_us: Option<i64>,
    pub upload_loaded_latency_us: Option<i64>,
    /// `cf-meta-colo`. The public IP headers are never read.
    pub colo: Option<String>,
}

pub fn rate_bps(bytes: u64, elapsed: Duration) -> i64 {
    (u128::from(bytes) * 8 * 1_000_000 / elapsed.as_micros().max(1)) as i64
}
/// Nearest-rank 90th percentile.
pub fn p90(rates: &[i64]) -> Option<i64> {
    let mut sorted = rates.to_vec();
    sorted.sort_unstable();
    (!sorted.is_empty()).then(|| sorted[(sorted.len() * 9).div_ceil(10) - 1])
}
/// Received-weighted mean of the bursts' average RTT; None when nothing replied.
pub fn mean_rtt_us(bursts: &[Burst]) -> Option<i64> {
    let received: i64 = bursts.iter().map(|b| i64::from(b.received)).sum();
    let weighted: i64 = bursts
        .iter()
        .filter_map(|b| b.rtt.map(|rtt| i64::from(b.received) * rtt.avg_us))
        .sum();
    (received > 0).then(|| (weighted + received / 2) / received)
}
fn colo(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("cf-meta-colo")?.to_str().ok()?;
    ((1..=8).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric()))
        .then(|| value.into())
}

/// What a test has measured so far; it survives the cap cancelling the test.
#[derive(Default)]
struct Partial {
    bytes: [u64; 2],
    idle: Vec<Burst>,
    loaded: [Vec<Burst>; 2],
    colo: Option<String>,
}
fn update(partial: &Mutex<Partial>, change: impl FnOnce(&mut Partial)) {
    change(&mut partial.lock().expect("speed test progress lock"));
}

/// One test, never retried. Errors become a failed verdict, and the cap a timeout.
pub async fn run(config: &SpeedConfig) -> SpeedTest {
    let started_ms = crate::now_ms();
    let started = Instant::now();
    let partial = Mutex::new(Partial::default());
    let verdict = match tokio::time::timeout(config.plan.cap, measure(config, &partial)).await {
        Ok(Ok([download_bps, upload_bps])) => Verdict::Ok {
            download_bps,
            upload_bps,
        },
        Ok(Err(error)) => Verdict::Failed(format!("{error:#}")),
        Err(_) => Verdict::Timeout,
    };
    let partial = partial.into_inner().expect("speed test progress lock");
    let [download_loaded, upload_loaded] = &partial.loaded;
    SpeedTest {
        started_ms,
        ended_ms: started_ms + started.elapsed().as_millis() as i64,
        verdict,
        download_bytes: partial.bytes[0] as i64,
        upload_bytes: partial.bytes[1] as i64,
        idle_latency_us: mean_rtt_us(&partial.idle),
        download_loaded_latency_us: mean_rtt_us(download_loaded),
        upload_loaded_latency_us: mean_rtt_us(upload_loaded),
        colo: partial.colo,
    }
}
async fn measure(config: &SpeedConfig, partial: &Mutex<Partial>) -> Result<[i64; 2]> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("factory-speedtest/0.1")
        .build()?;
    // A failed latency burst leaves its latency null; it never fails the throughput test.
    if let Ok(burst) = network::ping(config.latency_target).await {
        update(partial, |p| p.idle.push(burst));
    }
    let mut rates = [0; 2];
    for direction in [Direction::Download, Direction::Upload] {
        let done = CancellationToken::new();
        let transfer = async {
            let rate = transfer(&client, config, direction, partial).await;
            done.cancel();
            rate
        };
        let (rate, ()) = tokio::join!(
            transfer,
            loaded_latency(config.latency_target, &done, direction, partial)
        );
        rates[direction as usize] = rate?;
    }
    Ok(rates)
}
/// Bursts run while the direction transfers. The first starts at once and the
/// one in flight when it ends is kept, so even a direction that fails at once
/// gets one loaded sample.
async fn loaded_latency(
    target: IpAddr,
    done: &CancellationToken,
    direction: Direction,
    partial: &Mutex<Partial>,
) {
    let mut timer =
        tokio::time::interval_at(tokio::time::Instant::now() + LOADED_SPACING, LOADED_SPACING);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        if let Ok(burst) = network::ping(target).await {
            update(partial, |p| p.loaded[direction as usize].push(burst));
        }
        tokio::select! { biased;
            _ = done.cancelled() => return,
            _ = timer.tick() => (),
        }
    }
}
async fn transfer(
    client: &reqwest::Client,
    config: &SpeedConfig,
    direction: Direction,
    partial: &Mutex<Partial>,
) -> Result<i64> {
    let mut rates = Vec::new();
    for step in config
        .plan
        .steps
        .iter()
        .filter(|s| s.direction == direction)
    {
        let mut slowest = Duration::ZERO;
        for _ in 0..step.count {
            let elapsed = request(client, &config.base, step, partial)
                .await
                .with_context(|| format!("{} of {} bytes", direction.as_str(), step.bytes))?;
            rates.push(rate_bps(step.bytes, elapsed));
            slowest = slowest.max(elapsed);
        }
        if slowest > config.plan.slow_request {
            break;
        }
    }
    p90(&rates).with_context(|| format!("no {} steps in the plan", direction.as_str()))
}
/// Download times response headers to last body byte, so connection setup and
/// server think time do not count against the link. Upload times request start
/// to response, because the response is the only sign the last byte arrived.
/// speed.cloudflare.com refuses `__down` of 100 MB or more without the Referer
/// its own browser test sends, so both requests send it.
async fn request(
    client: &reqwest::Client,
    base: &str,
    step: &Step,
    partial: &Mutex<Partial>,
) -> Result<Duration> {
    let bytes = step.bytes;
    match step.direction {
        Direction::Download => {
            let mut response = client
                .get(format!("{base}/__down?bytes={bytes}"))
                .header(reqwest::header::REFERER, format!("{base}/"))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(reqwest::Error::without_url)?;
            let headers_at = Instant::now();
            update(partial, |p| {
                p.colo = p.colo.take().or(colo(response.headers()))
            });
            let mut received = 0u64;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(reqwest::Error::without_url)?
            {
                received += chunk.len() as u64;
                update(partial, |p| p.bytes[0] += chunk.len() as u64);
            }
            ensure!(received == bytes, "received {received} bytes");
            Ok(headers_at.elapsed())
        }
        Direction::Upload => {
            let started = Instant::now();
            let response = client
                .post(format!("{base}/__up"))
                .header(reqwest::header::REFERER, format!("{base}/"))
                .body(vec![0u8; bytes as usize])
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(reqwest::Error::without_url)?;
            let elapsed = started.elapsed();
            update(partial, |p| {
                p.colo = p.colo.take().or(colo(response.headers()));
                p.bytes[1] += bytes;
            });
            Ok(elapsed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::Rtt;
    use axum::{
        Router,
        body::{Body, Bytes},
        extract::{Path, Query},
        http::StatusCode,
        response::{IntoResponse, Response},
        routing::{get, post},
    };

    #[test]
    fn sequence_matches_the_spec_table() {
        let total = |direction| -> u64 {
            SEQUENCE
                .iter()
                .filter(|s| s.direction == direction)
                .map(|s| s.bytes * u64::from(s.count))
                .sum()
        };
        assert_eq!(total(Direction::Download), 440 * MB);
        assert_eq!(total(Direction::Upload), 290 * MB);
        assert_eq!(MB, 1_000_000);
        for direction in [Direction::Download, Direction::Upload] {
            let sizes: Vec<_> = SEQUENCE
                .iter()
                .filter(|s| s.direction == direction)
                .map(|s| s.bytes)
                .collect();
            assert!(sizes.windows(2).all(|pair| pair[0] < pair[1]));
        }
    }

    #[test]
    fn rates_percentiles_and_latency_are_exact() {
        assert_eq!(rate_bps(125_000_000, Duration::from_secs(1)), 1_000_000_000);
        assert_eq!(rate_bps(10 * MB, Duration::from_millis(1600)), 50_000_000);
        assert_eq!(rate_bps(1, Duration::ZERO), 8_000_000);
        assert_eq!(p90(&[]), None);
        assert_eq!(p90(&[7]), Some(7));
        // ceil(0.9 * 11) = 10th of 11; ceil(0.9 * 10) = 9th of 10.
        let eleven: Vec<i64> = (1..=11).rev().collect();
        assert_eq!(p90(&eleven), Some(10));
        assert_eq!(p90(&(1..=10).collect::<Vec<_>>()), Some(9));
        let burst = |received, avg_us| Burst {
            sent: 10,
            received,
            rtt: (received > 0).then_some(Rtt {
                min_us: avg_us,
                avg_us,
                max_us: avg_us,
                mdev_us: 0,
            }),
        };
        assert_eq!(mean_rtt_us(&[]), None);
        assert_eq!(mean_rtt_us(&[burst(0, 0)]), None);
        // (10 x 1000 + 5 x 4000) / 15 = 2000.
        assert_eq!(
            mean_rtt_us(&[burst(10, 1000), burst(5, 4000), burst(0, 0)]),
            Some(2000)
        );
    }

    #[test]
    fn speed_url_is_validated() {
        assert_eq!(base_url(DEFAULT_URL).unwrap(), DEFAULT_URL);
        assert_eq!(
            base_url("http://127.0.0.1:8099/").unwrap(),
            "http://127.0.0.1:8099"
        );
        assert_eq!(
            base_url("https://speed.example/prefix/").unwrap(),
            "https://speed.example/prefix"
        );
        for invalid in [
            "",
            "speed.cloudflare.com",
            "ftp://speed.cloudflare.com",
            "file:///tmp/x",
            "https://user:pass@speed.cloudflare.com",
            "https://speed.cloudflare.com/?bytes=1",
            "https://speed.cloudflare.com/#x",
        ] {
            assert!(base_url(invalid).is_err(), "{invalid}");
        }
    }

    #[derive(serde::Deserialize)]
    struct Down {
        bytes: usize,
    }
    /// Modes by path prefix: ok, slow (each body or response waits 600 ms),
    /// fail (HTTP 500), hang (never answers) and short (truncated body).
    async fn server() -> String {
        async fn down(
            Path(mode): Path<String>,
            Query(q): Query<Down>,
            request: axum::http::HeaderMap,
        ) -> Response {
            let referer = request.get("referer").and_then(|v| v.to_str().ok());
            if !referer
                .is_some_and(|r| r.starts_with("http://") && r.ends_with(&format!("/{mode}/")))
            {
                return StatusCode::FORBIDDEN.into_response();
            }
            let headers = [("cf-meta-colo", "SBX"), ("cf-meta-ip", "203.0.113.9")];
            match mode.as_str() {
                "fail" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                "hang" => std::future::pending().await,
                "short" => (headers, vec![0u8; q.bytes / 2]).into_response(),
                "badcolo" => ([("cf-meta-colo", "not a colo")], vec![0u8; q.bytes]).into_response(),
                "slow" => {
                    let body = futures_util::stream::once(async move {
                        tokio::time::sleep(Duration::from_millis(600)).await;
                        Ok::<_, std::convert::Infallible>(Bytes::from(vec![0u8; q.bytes]))
                    });
                    (headers, Body::from_stream(body)).into_response()
                }
                _ => (headers, vec![0u8; q.bytes]).into_response(),
            }
        }
        async fn up(Path(mode): Path<String>, body: Bytes) -> Response {
            assert!(!body.is_empty());
            if mode == "slow" {
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
            let colo = if mode == "badcolo" {
                "not a colo"
            } else {
                "SBX"
            };
            ([("cf-meta-colo", colo)], "ok").into_response()
        }
        let app = Router::new()
            .route("/{mode}/__down", get(down))
            .route("/{mode}/__up", post(up))
            .layer(axum::extract::DefaultBodyLimit::disable());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }
    static STEPS: [Step; 6] = [
        Step {
            direction: Direction::Download,
            bytes: 1000,
            count: 2,
        },
        Step {
            direction: Direction::Download,
            bytes: 2000,
            count: 1,
        },
        Step {
            direction: Direction::Download,
            bytes: 4000,
            count: 1,
        },
        Step {
            direction: Direction::Upload,
            bytes: 1000,
            count: 2,
        },
        Step {
            direction: Direction::Upload,
            bytes: 3000,
            count: 1,
        },
        Step {
            direction: Direction::Upload,
            bytes: 5000,
            count: 1,
        },
    ];
    async fn test(mode: &str, cap: Duration) -> SpeedTest {
        let config = SpeedConfig {
            base: base_url(&format!("{}/{mode}", server().await)).unwrap(),
            latency_target: "127.0.0.1".parse().unwrap(),
            interval: Duration::from_secs(MIN_INTERVAL_S),
            plan: Plan {
                steps: &STEPS,
                slow_request: Duration::from_millis(500),
                cap,
            },
        };
        run(&config).await
    }

    #[tokio::test]
    async fn runner_measures_every_outcome_against_a_loopback_server() {
        let cap = Duration::from_secs(20);
        let [ok, slow, fail, short, badcolo, hang] = futures_util::future::join_all([
            test("ok", cap),
            test("slow", cap),
            test("fail", cap),
            test("short", cap),
            test("badcolo", cap),
            test("hang", Duration::from_secs(3)),
        ])
        .await
        .try_into()
        .unwrap();

        let Verdict::Ok {
            download_bps,
            upload_bps,
        } = ok.verdict
        else {
            panic!("{ok:?}")
        };
        assert!(download_bps > 0 && upload_bps > 0, "{ok:?}");
        assert_eq!((ok.download_bytes, ok.upload_bytes), (8000, 10_000));
        assert_eq!(ok.colo.as_deref(), Some("SBX"));
        // Real ping to loopback: one idle burst, and at least one burst per direction.
        for latency in [
            ok.idle_latency_us,
            ok.download_loaded_latency_us,
            ok.upload_loaded_latency_us,
        ] {
            assert!(latency.is_some_and(|us| us < 1_000_000), "{ok:?}");
        }
        assert!(ok.ended_ms >= ok.started_ms);

        // Each slow first step ends its direction: no 2000/4000 or 3000/5000 byte requests.
        assert!(matches!(slow.verdict, Verdict::Ok { .. }), "{slow:?}");
        assert_eq!((slow.download_bytes, slow.upload_bytes), (2000, 2000));
        let Verdict::Ok {
            download_bps,
            upload_bps,
        } = slow.verdict
        else {
            unreachable!()
        };
        // 1000 bytes over at least 600 ms is at most 13.3 kb/s.
        assert!(download_bps <= 13_334 && upload_bps <= 13_334, "{slow:?}");

        let Verdict::Failed(error) = &fail.verdict else {
            panic!("{fail:?}")
        };
        assert!(error.starts_with("download of 1000 bytes: "), "{error}");
        assert!(error.contains("500"), "{error}");
        assert!(
            !error.contains("127.0.0.1") && !error.contains("bytes="),
            "{error}"
        );
        assert_eq!((fail.download_bytes, fail.upload_bytes), (0, 0));
        assert!(fail.download_loaded_latency_us.is_some(), "{fail:?}");
        assert_eq!(fail.upload_loaded_latency_us, None);

        let Verdict::Failed(error) = &short.verdict else {
            panic!("{short:?}")
        };
        assert_eq!(error, "download of 1000 bytes: received 500 bytes");
        assert_eq!(short.download_bytes, 500);

        assert!(matches!(badcolo.verdict, Verdict::Ok { .. }), "{badcolo:?}");
        assert_eq!(badcolo.colo, None);

        assert_eq!(hang.verdict, Verdict::Timeout);
        let elapsed = hang.ended_ms - hang.started_ms;
        assert!((3000..4500).contains(&elapsed), "{hang:?}");
        assert_eq!((hang.download_bytes, hang.upload_bytes), (0, 0));
        assert!(hang.idle_latency_us.is_some());
    }

    #[test]
    fn plan_and_headers_never_carry_addresses() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-meta-ip", "203.0.113.9".parse().unwrap());
        assert_eq!(colo(&headers), None);
        headers.insert("cf-meta-colo", "EWR".parse().unwrap());
        assert_eq!(colo(&headers).as_deref(), Some("EWR"));
        headers.insert("cf-meta-colo", "".parse().unwrap());
        assert_eq!(colo(&headers), None);
    }
}
