//! Network quality probes. A fixed target registry, ordered by layer, is probed
//! in short bursts; storage lives in network_history.
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    process::Stdio,
    time::{Duration, Instant},
};
use utoipa::ToSchema;

/// v1 probes run on factory-gpu only; rows carry the id so other hosts can follow.
pub const DEVICE_ID: &str = "factory-gpu";
pub const PROBES: u32 = 10;
const SPACING: Duration = Duration::from_millis(200);
const TIMEOUT: Duration = Duration::from_secs(1);
const PING_DEADLINE: Duration = Duration::from_secs(5);
pub const DEFAULT_WAN_TARGETS: &str = "1.1.1.1,8.8.8.8";
pub const DEFAULT_DNS_NAME: &str = "cloudflare.com";
pub const DEFAULT_TAILNET_TARGET: &str = "factory-console:22";
pub const DEFAULT_ROUTE_TABLE: &str = "/proc/net/route";

/// Declaration order is registry order; diagnosis blames the first failing layer.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ToSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Lan,
    Wan,
    Dns,
    Tailnet,
}
impl Layer {
    /// Registry order. `layer as usize` indexes per-layer arrays.
    pub const ALL: [Self; 4] = [Self::Lan, Self::Wan, Self::Dns, Self::Tailnet];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Lan => "lan",
            Self::Wan => "wan",
            Self::Dns => "dns",
            Self::Tailnet => "tailnet",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|layer| layer.as_str() == text)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// ICMP to the default gateway, rediscovered from this route table every tick.
    /// `ip route` needs AF_NETLINK, which the service unit forbids.
    Gateway(PathBuf),
    Icmp(IpAddr),
    /// getaddrinfo through the system resolver.
    Resolve(String),
    /// TCP handshake to `host:port`; the host is resolved once per burst.
    Connect(String),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProbeKind {
    Icmp,
    Resolve,
    TcpConnect,
}
impl Probe {
    pub fn kind(&self) -> ProbeKind {
        match self {
            Self::Gateway(_) | Self::Icmp(_) => ProbeKind::Icmp,
            Self::Resolve(_) => ProbeKind::Resolve,
            Self::Connect(_) => ProbeKind::TcpConnect,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub layer: Layer,
    /// Stable storage key, unique within the registry.
    pub key: String,
    pub probe: Probe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkConfig {
    pub route_table: PathBuf,
    pub wan: Vec<IpAddr>,
    pub dns_name: String,
    pub tailnet: String,
}
impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            route_table: DEFAULT_ROUTE_TABLE.into(),
            wan: DEFAULT_WAN_TARGETS
                .split(',')
                .map(|a| a.parse().expect("default WAN target"))
                .collect(),
            dns_name: DEFAULT_DNS_NAME.into(),
            tailnet: DEFAULT_TAILNET_TARGET.into(),
        }
    }
}
fn hostname(text: &str) -> bool {
    text.len() <= 253
        && text.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}
impl NetworkConfig {
    pub fn new(
        route_table: PathBuf,
        wan: Vec<IpAddr>,
        dns_name: String,
        tailnet: String,
    ) -> Result<Self> {
        ensure!(
            (1..=8).contains(&wan.len()),
            "--network-wan-targets needs 1 to 8 addresses"
        );
        for (i, address) in wan.iter().enumerate() {
            ensure!(
                !address.is_unspecified() && !address.is_multicast(),
                "--network-wan-targets: {address} is not a unicast address"
            );
            ensure!(
                !wan[..i].contains(address),
                "--network-wan-targets: {address} is listed twice"
            );
        }
        // Resolving a literal address would not exercise the resolver.
        ensure!(
            hostname(&dns_name) && dns_name.parse::<IpAddr>().is_err(),
            "--network-dns-name must be a hostname"
        );
        let (host, port) = tailnet
            .rsplit_once(':')
            .context("--network-tailnet-target must be host:port")?;
        ensure!(
            port.parse::<u16>().is_ok_and(|p| p > 0),
            "--network-tailnet-target port must be 1 to 65535"
        );
        let bracketed = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .is_some_and(|h| h.parse::<std::net::Ipv6Addr>().is_ok());
        ensure!(
            bracketed || hostname(host),
            "--network-tailnet-target host must be a hostname, IPv4 address or [IPv6] address"
        );
        Ok(Self {
            route_table,
            wan,
            dns_name,
            tailnet,
        })
    }
    pub fn targets(&self) -> Vec<Target> {
        let mut targets = vec![Target {
            layer: Layer::Lan,
            key: "gateway".into(),
            probe: Probe::Gateway(self.route_table.clone()),
        }];
        targets.extend(self.wan.iter().map(|address| Target {
            layer: Layer::Wan,
            key: address.to_string(),
            probe: Probe::Icmp(*address),
        }));
        targets.push(Target {
            layer: Layer::Dns,
            key: "dns".into(),
            probe: Probe::Resolve(self.dns_name.clone()),
        });
        targets.push(Target {
            layer: Layer::Tailnet,
            key: "tailnet".into(),
            probe: Probe::Connect(self.tailnet.clone()),
        });
        targets
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Rtt {
    pub min_us: i64,
    pub avg_us: i64,
    pub max_us: i64,
    /// Jitter, as iputils computes it: the population standard deviation.
    pub mdev_us: i64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Burst {
    pub sent: u32,
    pub received: u32,
    /// Null exactly when nothing was received.
    pub rtt: Option<Rtt>,
}
impl Burst {
    pub const fn lost(sent: u32) -> Self {
        Self {
            sent,
            received: 0,
            rtt: None,
        }
    }
    pub fn from_replies(sent: u32, replies_us: &[i64]) -> Self {
        let n = replies_us.len() as f64;
        let rtt = (!replies_us.is_empty()).then(|| {
            let mean = replies_us.iter().sum::<i64>() as f64 / n;
            let square = replies_us.iter().map(|&x| (x as f64).powi(2)).sum::<f64>() / n;
            Rtt {
                min_us: *replies_us.iter().min().unwrap(),
                avg_us: mean.round() as i64,
                max_us: *replies_us.iter().max().unwrap(),
                mdev_us: (square - mean * mean).max(0.0).sqrt().round() as i64,
            }
        });
        Self {
            sent,
            received: replies_us.len() as u32,
            rtt,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Sample {
    /// Start of the tick; every target in one tick shares it.
    pub ts_ms: i64,
    pub layer: Layer,
    pub target: String,
    /// What was probed: the gateway or WAN IP, the resolved name, or the
    /// resolved tailnet socket address. Null when it could not be found.
    pub address: Option<String>,
    #[serde(flatten)]
    pub burst: Burst,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NetworkTarget {
    pub layer: Layer,
    pub target: String,
    pub probe: ProbeKind,
    pub latest: Option<Sample>,
}
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NetworkStatus {
    pub generated_at_ms: i64,
    pub device_id: String,
    /// The stored open event's state; healthy when none is open.
    pub state: crate::network_diagnosis::LinkState,
    /// The open degraded or down episode; null when healthy.
    pub open_event: Option<crate::network_history::NetworkEvent>,
    /// Registry order: lan, wan, dns, tailnet.
    pub targets: Vec<NetworkTarget>,
    /// Null before the first stored test.
    pub latest_speed_test: Option<crate::network_history::NetworkSpeedTest>,
    pub warnings: Vec<String>,
}

fn milliseconds_to_us(text: &str) -> Result<i64> {
    let ms: f64 = text.parse().with_context(|| format!("bad RTT {text:?}"))?;
    ensure!(ms.is_finite() && ms >= 0.0, "bad RTT {text:?}");
    Ok((ms * 1000.0).round() as i64)
}
/// Parse the iputils `-q` summary. None means ping printed no summary at all.
pub fn parse_ping(stdout: &str) -> Result<Option<Burst>> {
    let Some(counts) = stdout
        .lines()
        .find(|line| line.contains(" packets transmitted, "))
    else {
        return Ok(None);
    };
    // "10 packets transmitted, 7 received, +3 errors, 30% packet loss, time 1810ms"
    let mut fields = counts.split(", ");
    let count = |field: Option<&str>, suffix: &str| -> Result<u32> {
        field
            .and_then(|f| f.trim().strip_suffix(suffix))
            .and_then(|n| n.parse().ok())
            .with_context(|| format!("malformed ping summary {counts:?}"))
    };
    let sent = count(fields.next(), " packets transmitted")?;
    let received = count(fields.next(), " received")?;
    ensure!(
        (1..=100).contains(&sent) && received <= sent,
        "implausible ping summary {counts:?}"
    );
    let rtt = stdout
        .lines()
        .find_map(|line| line.strip_prefix("rtt min/avg/max/mdev = "))
        .map(|values| -> Result<Rtt> {
            let values = values
                .split_once(" ms")
                .with_context(|| format!("malformed ping RTT {values:?}"))?
                .0;
            let parts = values
                .split('/')
                .map(milliseconds_to_us)
                .collect::<Result<Vec<_>>>()?;
            let [min_us, avg_us, max_us, mdev_us] = parts[..] else {
                bail!("malformed ping RTT {values:?}");
            };
            ensure!(
                min_us <= avg_us && avg_us <= max_us,
                "implausible ping RTT {values:?}"
            );
            Ok(Rtt {
                min_us,
                avg_us,
                max_us,
                mdev_us,
            })
        })
        .transpose()?;
    ensure!(
        rtt.is_some() == (received > 0),
        "ping summary and RTT line disagree: {counts:?}"
    );
    Ok(Some(Burst {
        sent,
        received,
        rtt,
    }))
}
/// Interpret a finished ping. ping exits 1 when nothing came back; that is a
/// valid total-loss sample. Without a summary, only a routing failure counts
/// as loss. Anything else (e.g. no ICMP socket permission) is a monitoring
/// error, so a broken probe never reports a fake outage.
pub fn ping_outcome(success: bool, stdout: &str, stderr: &str) -> Result<Burst> {
    if let Some(burst) = parse_ping(stdout)? {
        return Ok(burst);
    }
    let unreachable = ["unreachable", "no route to host"]
        .iter()
        .any(|text| stderr.to_ascii_lowercase().contains(text));
    if !success && unreachable {
        return Ok(Burst::lost(PROBES));
    }
    let detail = stderr.lines().next().unwrap_or("").trim();
    bail!("ping printed no summary ({detail:?})")
}

/// Lowest-metric default route with RTF_UP|RTF_GATEWAY from /proc/net/route.
pub fn default_gateway(route_table: &str) -> Result<Option<Ipv4Addr>> {
    let mut best = None::<(u32, Ipv4Addr)>;
    for line in route_table.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.is_empty() {
            continue;
        }
        ensure!(fields.len() >= 8, "malformed route table line {line:?}");
        let hex = |i: usize| {
            u32::from_str_radix(fields[i], 16)
                .with_context(|| format!("malformed route table line {line:?}"))
        };
        let (destination, gateway, flags, mask) = (hex(1)?, hex(2)?, hex(3)?, hex(7)?);
        let metric: u32 = fields[6]
            .parse()
            .with_context(|| format!("malformed route table line {line:?}"))?;
        if destination == 0 && mask == 0 && flags & 0x3 == 0x3 {
            // The kernel prints addresses in host (little-endian) byte order.
            let address = Ipv4Addr::from(gateway.to_le_bytes());
            if best.is_none_or(|(m, _)| metric < m) {
                best = Some((metric, address));
            }
        }
    }
    Ok(best.map(|(_, address)| address))
}

/// PROBES attempts started SPACING apart; any reply after TIMEOUT is lost.
async fn burst<F, Fut, T>(attempt: F) -> Burst
where
    F: Fn() -> Fut,
    Fut: Future<Output = std::io::Result<T>>,
{
    let attempts = (0..PROBES).map(|i| {
        let reply = attempt();
        async move {
            tokio::time::sleep(SPACING * i).await;
            let started = Instant::now();
            matches!(tokio::time::timeout(TIMEOUT, reply).await, Ok(Ok(_)))
                .then(|| started.elapsed().as_micros() as i64)
        }
    });
    let replies: Vec<i64> = futures_util::future::join_all(attempts)
        .await
        .into_iter()
        .flatten()
        .collect();
    Burst::from_replies(PROBES, &replies)
}
pub async fn ping(address: IpAddr) -> Result<Burst> {
    let child = tokio::process::Command::new("ping")
        .args(["-n", "-q", "-c", "10", "-i", "0.2", "-W", "1"])
        .arg(address.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("ping could not start")?;
    let output = tokio::time::timeout(PING_DEADLINE, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("ping did not finish within 5 s"))??;
    ping_outcome(
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}
pub async fn probe(target: &Target, ts_ms: i64) -> Result<Sample> {
    let (address, burst) = match &target.probe {
        Probe::Gateway(path) => {
            let table = tokio::fs::read_to_string(path)
                .await
                .with_context(|| format!("cannot read route table {}", path.display()))?;
            match default_gateway(&table)? {
                Some(gateway) => (Some(gateway.to_string()), ping(gateway.into()).await?),
                None => (None, Burst::lost(PROBES)),
            }
        }
        Probe::Icmp(address) => (Some(address.to_string()), ping(*address).await?),
        Probe::Resolve(name) => (
            Some(name.clone()),
            burst(|| tokio::net::lookup_host((name.as_str(), 0))).await,
        ),
        Probe::Connect(host_port) => {
            let resolved = tokio::time::timeout(TIMEOUT, tokio::net::lookup_host(host_port))
                .await
                .ok()
                .and_then(Result::ok)
                .and_then(|mut addresses| addresses.next());
            match resolved {
                Some(address) => (
                    Some(address.to_string()),
                    burst(|| tokio::net::TcpStream::connect(address)).await,
                ),
                None => (None, Burst::lost(PROBES)),
            }
        }
    };
    Ok(Sample {
        ts_ms,
        layer: target.layer,
        target: target.key.clone(),
        address,
        burst,
    })
}
/// Probe every target concurrently, so one tick takes about three seconds.
pub async fn probe_all(targets: &[Target], ts_ms: i64) -> Vec<Result<Sample>> {
    futures_util::future::join_all(targets.iter().map(|target| async move {
        probe(target, ts_ms)
            .await
            .with_context(|| format!("{} probe failed", target.key))
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEALTHY: &str = "PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.

--- 1.1.1.1 ping statistics ---
10 packets transmitted, 10 received, 0% packet loss, time 1807ms
rtt min/avg/max/mdev = 8.113/8.691/9.050/0.272 ms
";
    const PARTIAL: &str = "PING 192.168.4.1 (192.168.4.1) 56(84) bytes of data.

--- 192.168.4.1 ping statistics ---
10 packets transmitted, 7 received, +2 duplicates, 30% packet loss, time 1810ms
rtt min/avg/max/mdev = 0.315/0.402/0.988/0.201 ms, pipe 2
";
    const TOTAL: &str = "PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.

--- 192.0.2.1 ping statistics ---
10 packets transmitted, 0 received, +10 errors, 100% packet loss, time 1834ms

";

    fn rtt(min_us: i64, avg_us: i64, max_us: i64, mdev_us: i64) -> Option<Rtt> {
        Some(Rtt {
            min_us,
            avg_us,
            max_us,
            mdev_us,
        })
    }

    #[test]
    fn iputils_summaries_become_bursts() {
        assert_eq!(
            ping_outcome(true, HEALTHY, "").unwrap(),
            Burst {
                sent: 10,
                received: 10,
                rtt: rtt(8113, 8691, 9050, 272)
            }
        );
        assert_eq!(
            ping_outcome(true, PARTIAL, "").unwrap(),
            Burst {
                sent: 10,
                received: 7,
                rtt: rtt(315, 402, 988, 201)
            }
        );
        // ping exits 1 when nothing is received; that is data, not an error.
        assert_eq!(ping_outcome(false, TOTAL, "").unwrap(), Burst::lost(10));
        assert_eq!(
            ping_outcome(false, "", "ping: connect: Network is unreachable\n").unwrap(),
            Burst::lost(10)
        );
        assert_eq!(
            ping_outcome(false, "", "ping: connect: No route to host\n").unwrap(),
            Burst::lost(10)
        );
        for (success, stdout, stderr) in [
            (
                false,
                "",
                "ping: socktype: SOCK_RAW\nping: socket: Operation not permitted\n",
            ),
            (true, "PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.\n", ""),
            (
                false,
                "",
                "ping: 1.1.1.1x: Temporary failure in name resolution\n",
            ),
            (
                true,
                "10 packets transmitted, 11 received, 0% packet loss\n",
                "",
            ),
            (true, "0 packets transmitted, 0 received\n", ""),
            (true, "10 packets transmitted, 10 received\n", ""),
            (
                true,
                "10 packets transmitted, 0 received\nrtt min/avg/max/mdev = 1/1/1/0 ms\n",
                "",
            ),
            (
                true,
                "10 packets transmitted, 1 received\nrtt min/avg/max/mdev = 3/2/1/0 ms\n",
                "",
            ),
            (
                true,
                "10 packets transmitted, 1 received\nrtt min/avg/max/mdev = 1/x/1/0 ms\n",
                "",
            ),
            (
                true,
                "10 packets transmitted, 1 received\nrtt min/avg/max/mdev = 1/1/1 ms\n",
                "",
            ),
        ] {
            assert!(
                ping_outcome(success, stdout, stderr).is_err(),
                "{stdout:?} {stderr:?}"
            );
        }
    }

    #[test]
    fn reply_times_use_iputils_statistics() {
        assert_eq!(Burst::from_replies(10, &[]), Burst::lost(10));
        // mean 2500, mean of squares 7500000, mdev sqrt(1250000) = 1118.03.
        assert_eq!(
            Burst::from_replies(10, &[1000, 2000, 3000, 4000]),
            Burst {
                sent: 10,
                received: 4,
                rtt: rtt(1000, 2500, 4000, 1118)
            }
        );
        assert_eq!(
            Burst::from_replies(10, &[700; 10]).rtt,
            rtt(700, 700, 700, 0)
        );
    }

    #[test]
    fn default_route_is_read_from_the_kernel_table() {
        let header =
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n";
        let table = format!(
            "{header}enp42s0\t00000000\t0104A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n\
             wlan0\t00000000\t0101A8C0\t0003\t0\t0\t50\t00000000\t0\t0\t0\n\
             enp42s0\t0004A8C0\t00000000\t0001\t0\t0\t100\t00FCFFFF\t0\t0\t0\n"
        );
        assert_eq!(
            default_gateway(&table).unwrap(),
            Some(Ipv4Addr::new(192, 168, 1, 1))
        );
        let down =
            format!("{header}enp42s0\t00000000\t0104A8C0\t0002\t0\t0\t100\t00000000\t0\t0\t0\n");
        let direct =
            format!("{header}enp42s0\t00000000\t00000000\t0001\t0\t0\t100\t00000000\t0\t0\t0\n");
        for table in [header.to_string(), down, direct] {
            assert_eq!(default_gateway(&table).unwrap(), None);
        }
        assert!(default_gateway(&format!("{header}enp42s0\tzz\n")).is_err());
        assert!(
            default_gateway(&format!(
                "{header}enp42s0\t00000000\tXYZ\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"
            ))
            .is_err()
        );
    }

    #[test]
    fn registry_is_layer_ordered_and_config_is_validated() {
        let config = NetworkConfig::new(
            DEFAULT_ROUTE_TABLE.into(),
            vec!["1.1.1.1".parse().unwrap(), "8.8.8.8".parse().unwrap()],
            DEFAULT_DNS_NAME.into(),
            DEFAULT_TAILNET_TARGET.into(),
        )
        .unwrap();
        assert_eq!(config, NetworkConfig::default());
        let targets = config.targets();
        assert_eq!(
            targets
                .iter()
                .map(|t| (t.layer, t.key.as_str(), t.probe.kind()))
                .collect::<Vec<_>>(),
            [
                (Layer::Lan, "gateway", ProbeKind::Icmp),
                (Layer::Wan, "1.1.1.1", ProbeKind::Icmp),
                (Layer::Wan, "8.8.8.8", ProbeKind::Icmp),
                (Layer::Dns, "dns", ProbeKind::Resolve),
                (Layer::Tailnet, "tailnet", ProbeKind::TcpConnect),
            ]
        );
        assert!(
            targets
                .windows(2)
                .all(|pair| pair[0].layer <= pair[1].layer)
        );
        assert_eq!(Layer::parse("tailnet"), Some(Layer::Tailnet));
        assert_eq!(Layer::parse("wifi"), None);
        let one = |s: &str| -> Vec<IpAddr> { vec![s.parse().unwrap()] };
        for (wan, dns, tailnet) in [
            (vec![], "cloudflare.com", "factory-console:22"),
            (
                vec!["1.1.1.1".parse().unwrap(), "1.1.1.1".parse().unwrap()],
                "cloudflare.com",
                "factory-console:22",
            ),
            (one("0.0.0.0"), "cloudflare.com", "factory-console:22"),
            (one("224.0.0.1"), "cloudflare.com", "factory-console:22"),
            (one("1.1.1.1"), "1.1.1.1", "factory-console:22"),
            (one("1.1.1.1"), "", "factory-console:22"),
            (one("1.1.1.1"), "bad_name.com", "factory-console:22"),
            (one("1.1.1.1"), "-bad.com", "factory-console:22"),
            (one("1.1.1.1"), "cloudflare.com", "factory-console"),
            (one("1.1.1.1"), "cloudflare.com", "factory-console:0"),
            (one("1.1.1.1"), "cloudflare.com", "factory-console:70000"),
            (one("1.1.1.1"), "cloudflare.com", ":22"),
            (one("1.1.1.1"), "cloudflare.com", "::1:22"),
            (one("1.1.1.1"), "cloudflare.com", "a b:22"),
        ] {
            assert!(
                NetworkConfig::new("/r".into(), wan.clone(), dns.into(), tailnet.into()).is_err(),
                "{wan:?} {dns} {tailnet}"
            );
        }
        for tailnet in ["127.0.0.1:2222", "[::1]:22", "factory-console.ts.net:22"] {
            NetworkConfig::new(
                "/r".into(),
                one("2606:4700::1111"),
                "probe.sandbox.test".into(),
                tailnet.into(),
            )
            .unwrap();
        }
    }

    #[tokio::test]
    async fn resolve_and_connect_probes_measure_each_attempt() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let open = listener.local_addr().unwrap().to_string();
        let accept = tokio::spawn(async move {
            loop {
                drop(listener.accept().await.unwrap());
            }
        });
        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().to_string()
        };
        let target = |layer, probe| Target {
            layer,
            key: "k".into(),
            probe,
        };
        let started = Instant::now();
        let results = probe_all(
            &[
                target(Layer::Tailnet, Probe::Connect(open.clone())),
                target(Layer::Tailnet, Probe::Connect(closed)),
                target(Layer::Dns, Probe::Resolve("localhost".into())),
                target(Layer::Lan, Probe::Gateway("/nonexistent/route".into())),
            ],
            42,
        )
        .await;
        // Bursts run concurrently: 9 x 200 ms spacing plus at most one timeout.
        assert!(started.elapsed() < Duration::from_millis(2900));
        let up = results[0].as_ref().unwrap();
        assert_eq!((up.ts_ms, up.burst.sent, up.burst.received), (42, 10, 10));
        assert_eq!(up.address.as_deref(), Some(open.as_str()));
        assert!(up.burst.rtt.unwrap().max_us < 1_000_000);
        let refused = results[1].as_ref().unwrap();
        assert_eq!(refused.burst, Burst::lost(10));
        let dns = results[2].as_ref().unwrap();
        assert_eq!(dns.burst.received, 10);
        assert_eq!(dns.address.as_deref(), Some("localhost"));
        // A missing route table is a monitoring error, never a fake outage.
        assert!(format!("{:#}", results[3].as_ref().unwrap_err()).contains("route table"));
        accept.abort();
    }

    #[tokio::test]
    async fn gateway_probe_runs_the_real_ping_command() {
        let directory = tempfile::tempdir().unwrap();
        let route = directory.path().join("route");
        std::fs::write(
            &route,
            "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n\
             lo\t00000000\t0100007F\t0003\t0\t0\t0\t00000000\t0\t0\t0\n",
        )
        .unwrap();
        let target = Target {
            layer: Layer::Lan,
            key: "gateway".into(),
            probe: Probe::Gateway(route.clone()),
        };
        let sample = probe(&target, 7).await.unwrap();
        assert_eq!(sample.address.as_deref(), Some("127.0.0.1"));
        assert_eq!((sample.burst.sent, sample.burst.received), (10, 10));
        std::fs::write(&route, "Iface\tDestination\tGateway\n").unwrap();
        let sample = probe(&target, 8).await.unwrap();
        assert_eq!((sample.address, sample.burst), (None, Burst::lost(10)));
    }
}
