//! RDP X.224 negotiation canary and per-service check cache (MET-260).
use anyhow::Result;
use factory_api::{AppState, fleet};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// Independent expectation: the exact request sent by the MET-260 hand test
/// against factory-console on 2026-10-18 (TPKT + X.224 CR + RDP_NEG_REQ for
/// TLS|CredSSP).
const REQUEST_HEX: &str = "030000130ee000000000000100080003000000";
/// The exact Connection Confirm gnome-remote-desktop returned to that request.
const GRD_CONFIRM_HEX: &str = "030000130ed00000000000020b080002000000";

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
        .collect()
}

/// An X.224 Connection Confirm: `negotiation` is the optional 8-byte RDP_NEG_*
/// block written as type, flags, length (2 LE) and value (4 LE).
fn confirm(negotiation: Option<(u8, u8, u32)>) -> Vec<u8> {
    match negotiation {
        None => vec![
            0x03, 0x00, 0x00, 0x0b, 0x0b, 0xd0, 0x00, 0x00, 0x00, 0x00, 0x00,
        ],
        Some((kind, flags, value)) => {
            let mut packet = vec![
                0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x00, 0x00, 0x00,
            ];
            packet.extend_from_slice(&[kind, flags]);
            packet.extend_from_slice(&8u16.to_le_bytes());
            packet.extend_from_slice(&value.to_le_bytes());
            packet
        }
    }
}

#[derive(Default)]
struct FakeStats {
    connections: AtomicUsize,
    clean_closes: AtomicUsize,
    request: Mutex<Vec<u8>>,
}

#[derive(Clone)]
enum Script {
    /// Read the request, optionally wait, reply, then wait for a clean close.
    Reply(Vec<u8>, u64),
    /// Read the request, reply partially, then close without waiting.
    PartialReply(Vec<u8>),
    /// Close the write half immediately: the client sees EOF before any response.
    ImmediateEof,
    /// Read the request and then stay silent until the client gives up.
    Silent,
}

async fn play(mut socket: TcpStream, script: Script, stats: &FakeStats) {
    stats.connections.fetch_add(1, Ordering::Relaxed);
    let mut request = [0u8; 19];
    let read = socket.read_exact(&mut request).await;
    if read.is_ok() {
        *stats.request.lock().unwrap() = request.to_vec();
    }
    match script {
        Script::Reply(bytes, delay_ms) => {
            if read.is_err() {
                return;
            }
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            if socket.write_all(&bytes).await.is_err() {
                return;
            }
        }
        Script::PartialReply(bytes) => {
            if read.is_err() {
                return;
            }
            let _ = socket.write_all(&bytes).await;
            // Half-close the write side so the client sees EOF on its next
            // read; the read half stays open to observe the hangup.
            let _ = socket.shutdown().await;
        }
        Script::ImmediateEof => {
            if read.is_ok() {
                // Half-close the write side only: the client reads EOF while
                // the fake keeps its read half open to observe the hangup.
                let _ = socket.shutdown().await;
            }
        }
        Script::Silent => {}
    }
    // Every connection ends the same way: wait for the client to hang up and
    // count it as clean only when the first read is EOF with no extra bytes.
    let clean = matches!(socket.read(&mut [0u8; 1]).await, Ok(0));
    stats
        .clean_closes
        .fetch_add(usize::from(clean), Ordering::Relaxed);
}

async fn serve(listener: TcpListener, script: Script, stats: Arc<FakeStats>) {
    while let Ok((socket, _)) = listener.accept().await {
        play(socket, script.clone(), &stats).await;
    }
}

async fn spawn_fake(script: Script) -> (String, Arc<FakeStats>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = listener.local_addr().unwrap().to_string();
    let stats = Arc::new(FakeStats::default());
    let handle = tokio::spawn(serve(listener, script, stats.clone()));
    (target, stats, handle)
}

/// The fake task observes the client's close on its own schedule; wait for it.
async fn clean_closes(stats: &FakeStats, count: usize) {
    for _ in 0..200 {
        if stats.clean_closes.load(Ordering::Relaxed) >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the fake never observed {count} clean client closes");
}

async fn state_for(target: &str, interval_s: u64) -> Result<(AppState, tempfile::TempDir)> {
    let config = fleet::Config::parse(&format!(
        "[[nodes]]\nname='test'\nservices=[{{name='rdp',kind='rdp',target='{target}',interval_s={interval_s}}}]"
    ))?;
    let temp = tempfile::tempdir()?;
    pricing::migrate(temp.path().join("pricing.db"))?;
    let state = AppState::new(
        "http://127.0.0.1:1".into(),
        temp.path().join("requests.db"),
        temp.path().join("pricing.db"),
        config,
    )
    .await?;
    Ok((state, temp))
}

/// An injected clock so cache tests can travel without waiting.
fn with_fake_clock(state: &AppState) -> Arc<AtomicI64> {
    let clock = Arc::new(AtomicI64::new(1_000_000));
    state.config.nodes[0].cache.set_now({
        let clock = clock.clone();
        move || clock.load(Ordering::Relaxed)
    });
    clock
}

fn service_of(collected: &factory_api::types::Fleet) -> factory_api::types::Service {
    collected.nodes[0].services[0].clone()
}

#[tokio::test]
async fn confirm_with_response_negotiates_for_each_protocol() -> Result<()> {
    for (protocol, expected) in [
        (0, "standard RDP security"),
        (1, "TLS"),
        (2, "CredSSP (hybrid)"),
        (4, "RDSTLS"),
        (8, "CredSSP (hybrid ex)"),
        (0x10, "protocol 0x00000010"),
    ] {
        let (target, stats, server) =
            spawn_fake(Script::Reply(confirm(Some((0x02, 0x00, protocol))), 0)).await;
        let detail = fleet::probe_rdp(&target).await?;
        assert_eq!(detail, format!("RDP_NEG_RSP: {expected}"));
        assert_eq!(stats.connections.load(Ordering::Relaxed), 1);
        clean_closes(&stats, 1).await;
        assert_eq!(stats.clean_closes.load(Ordering::Relaxed), 1);
        assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
        server.abort();
    }
    Ok(())
}

/// The bytes observed in the hand test must parse as RSP with CredSSP selected.
#[tokio::test]
async fn gnome_remote_desktop_confirm_parses_as_credssp() -> Result<()> {
    let (target, stats, server) = spawn_fake(Script::Reply(hex(GRD_CONFIRM_HEX), 0)).await;
    assert_eq!(
        fleet::probe_rdp(&target).await?,
        "RDP_NEG_RSP: CredSSP (hybrid)"
    );
    assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
    clean_closes(&stats, 1).await;
    assert_eq!(stats.clean_closes.load(Ordering::Relaxed), 1);
    server.abort();
    Ok(())
}

#[tokio::test]
async fn negotiation_failure_is_not_ok_and_names_the_code() -> Result<()> {
    for (code, expected) in [
        (5, "HYBRID_REQUIRED_BY_SERVER"),
        (1, "SSL_REQUIRED_BY_SERVER"),
        (9, "failure code 0x00000009"),
    ] {
        let (target, stats, server) =
            spawn_fake(Script::Reply(confirm(Some((0x03, 0x00, code))), 0)).await;
        let error = fleet::probe_rdp(&target).await.unwrap_err();
        assert_eq!(error.to_string(), format!("RDP_NEG_FAILURE: {expected}"));
        assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
        clean_closes(&stats, 1).await;
        server.abort();
    }
    Ok(())
}

#[tokio::test]
async fn confirm_without_negotiation_block_is_legacy() -> Result<()> {
    let (target, stats, server) = spawn_fake(Script::Reply(confirm(None), 0)).await;
    assert_eq!(fleet::probe_rdp(&target).await?, "legacy negotiation");
    assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
    clean_closes(&stats, 1).await;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn wrong_tpkt_version_and_length_bounds_are_refused() -> Result<()> {
    // TPKT version 4, otherwise a valid-looking CC.
    let mut wrong_version = hex("040000130ed000000000000000000000000000");
    let (target, stats, server) = spawn_fake(Script::Reply(wrong_version.clone(), 0)).await;
    let error = fleet::probe_rdp(&target).await.unwrap_err();
    assert_eq!(error.to_string(), "TPKT version 0x04 instead of 3");
    assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
    clean_closes(&stats, 1).await;
    server.abort();

    // TPKT total length 10 is below the 11-byte minimum, 65 above the cap.
    for length in [10u16, 65] {
        wrong_version[0] = 3;
        wrong_version[2..4].copy_from_slice(&length.to_be_bytes());
        let (target, stats, server) =
            spawn_fake(Script::PartialReply(wrong_version[..4].into())).await;
        let error = fleet::probe_rdp(&target).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("TPKT length {length} outside 11-64")
        );
        assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
        clean_closes(&stats, 1).await;
        server.abort();
    }
    Ok(())
}

#[tokio::test]
async fn truncated_body_reports_how_far_the_connection_got() -> Result<()> {
    // TPKT header promises 19 bytes; the server sends 14 and closes.
    let mut partial = hex(GRD_CONFIRM_HEX);
    partial.truncate(14);
    let (target, stats, server) = spawn_fake(Script::PartialReply(partial)).await;
    let error = fleet::probe_rdp(&target).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "connection closed after 10 of 15 bytes of the X.224 body"
    );
    assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
    clean_closes(&stats, 1).await;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn immediate_eof_is_not_ok() -> Result<()> {
    let (target, stats, server) = spawn_fake(Script::ImmediateEof).await;
    let error = fleet::probe_rdp(&target).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "connection closed after 0 of 4 bytes of the TPKT header"
    );
    assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
    clean_closes(&stats, 1).await;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn silent_server_times_out_with_a_specific_detail() -> Result<()> {
    let (target, stats, server) = spawn_fake(Script::Silent).await;
    let error = fleet::probe_rdp_within(&target, Duration::from_millis(300))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "no response within 0.3 s");
    assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
    clean_closes(&stats, 1).await;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cached_ok_result_is_reused_until_interval_expires() -> Result<()> {
    let (target, stats, server) = spawn_fake(Script::Reply(hex(GRD_CONFIRM_HEX), 0)).await;
    let (state, _temp) = state_for(&target, 300).await?;
    let clock = with_fake_clock(&state);

    let first = service_of(&fleet::collect(&state).await);
    assert_eq!(stats.connections.load(Ordering::Relaxed), 1);
    assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
    clean_closes(&stats, 1).await;
    assert_eq!(stats.clean_closes.load(Ordering::Relaxed), 1);
    assert!(first.ok);
    assert_eq!(
        first.detail.as_deref(),
        Some("RDP_NEG_RSP: CredSSP (hybrid)")
    );
    assert_eq!(first.kind, factory_api::types::ServiceKind::Rdp);
    assert_eq!(first.checked_at_ms, 1_000_000);

    // One second before the interval ends the stored result is still returned,
    // with its original checked_at_ms.
    clock.store(1_000_000 + 299_000, Ordering::Relaxed);
    let cached = service_of(&fleet::collect(&state).await);
    assert_eq!(stats.connections.load(Ordering::Relaxed), 1);
    assert_eq!(cached.checked_at_ms, first.checked_at_ms);
    assert_eq!(cached.latency_ms, first.latency_ms);

    // After the interval the service is probed again.
    clock.store(1_000_000 + 300_500, Ordering::Relaxed);
    let fresh = service_of(&fleet::collect(&state).await);
    assert_eq!(stats.connections.load(Ordering::Relaxed), 2);
    assert_eq!(fresh.checked_at_ms, 1_000_000 + 300_500);
    clean_closes(&stats, 2).await;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn failed_check_is_retested_after_30_s() -> Result<()> {
    let (target, stats, server) = spawn_fake(Script::ImmediateEof).await;
    let (state, _temp) = state_for(&target, 300).await?;
    let clock = with_fake_clock(&state);

    let first = service_of(&fleet::collect(&state).await);
    assert!(!first.ok);
    assert_eq!(
        first.detail.as_deref(),
        Some("connection closed after 0 of 4 bytes of the TPKT header")
    );
    assert_eq!(first.checked_at_ms, 1_000_000);
    assert_eq!(stats.connections.load(Ordering::Relaxed), 1);
    assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
    clean_closes(&stats, 1).await;

    // 29 s later the failed result is still cached.
    clock.store(1_000_000 + 29_000, Ordering::Relaxed);
    let cached = service_of(&fleet::collect(&state).await);
    assert_eq!(stats.connections.load(Ordering::Relaxed), 1);
    assert_eq!(cached.checked_at_ms, first.checked_at_ms);

    // After the 30 s failure retest the probe runs again.
    clock.store(1_000_000 + 30_500, Ordering::Relaxed);
    let retested = service_of(&fleet::collect(&state).await);
    assert_eq!(stats.connections.load(Ordering::Relaxed), 2);
    assert_eq!(retested.checked_at_ms, 1_000_000 + 30_500);
    assert!(!retested.ok);
    clean_closes(&stats, 2).await;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn concurrent_collects_share_one_in_flight_probe() -> Result<()> {
    // The fake answers slowly so both collects overlap inside the probe.
    let (target, stats, server) = spawn_fake(Script::Reply(hex(GRD_CONFIRM_HEX), 200)).await;
    let (state, _temp) = state_for(&target, 300).await?;
    let _clock = with_fake_clock(&state);

    let (first, second) = tokio::join!(fleet::collect(&state), fleet::collect(&state));
    assert_eq!(stats.connections.load(Ordering::Relaxed), 1);
    assert_eq!(*stats.request.lock().unwrap(), hex(REQUEST_HEX));
    clean_closes(&stats, 1).await;
    let (a, b) = (service_of(&first), service_of(&second));
    assert!(a.ok && b.ok);
    assert_eq!(a.checked_at_ms, b.checked_at_ms);
    server.abort();
    Ok(())
}

#[test]
fn interval_s_is_range_validated_on_every_kind() -> Result<()> {
    let config = |interval: &str| {
        fleet::Config::parse(&format!(
            "[[nodes]]\nname='test'\nservices=[{{name='x',kind='http',target='http://127.0.0.1:1/h',interval_s={interval}}}]"
        ))
    };
    assert!(config("10").is_ok());
    assert!(config("3600").is_ok());
    assert!(config("9").is_err());
    assert!(config("3601").is_err());
    // A missing interval_s stays valid: the service probes every collect.
    assert!(
        fleet::Config::parse(
            "[[nodes]]\nname='test'\nservices=[{name='x',kind='tcp',target='127.0.0.1:22'}]"
        )
        .is_ok()
    );
    Ok(())
}

#[test]
fn rdp_target_is_validated_like_tcp() -> Result<()> {
    let config = |target: &str| {
        fleet::Config::parse(&format!(
            "[[nodes]]\nname='test'\nservices=[{{name='x',kind='rdp',target='{target}'}}]"
        ))
    };
    assert!(config("factory-gpu:3389").is_ok());
    assert!(config("factory-gpu").is_err());
    assert!(config(":3389").is_err());
    assert!(config("factory-gpu:0").is_err());
    assert!(config("factory-gpu:99999").is_err());
    assert!(fleet::Config::parse(fleet::DEFAULT_CONFIG).is_ok());
    Ok(())
}
