//! Network diagnosis (MET-197). Each tick's samples give every layer a health;
//! a reducer over ticks names the first failing layer in registry order. Pure:
//! no IO and no clock. Storage of the resulting episodes lives in network_history.
use crate::network::{Burst, Layer, Sample};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = NetworkReason)]
pub enum Reason {
    Loss,
    Latency,
    Jitter,
}
impl Reason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Loss => "loss",
            Self::Latency => "latency",
            Self::Jitter => "jitter",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Loss, Self::Latency, Self::Jitter]
            .into_iter()
            .find(|reason| reason.as_str() == text)
    }
}

/// One layer's health in one tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerHealth {
    /// No sample this tick: a broken probe or no configured target. Missing
    /// evidence is never blame.
    Unknown,
    Ok,
    Degraded(Reason),
    /// Nothing came back from any target.
    Lost,
}
impl LayerHealth {
    /// Healthier ranks higher. Unknown has no rank because it is not evidence.
    const fn rank(self) -> Option<u8> {
        match self {
            Self::Unknown => None,
            Self::Lost => Some(0),
            Self::Degraded(Reason::Loss) => Some(1),
            Self::Degraded(Reason::Latency) => Some(2),
            Self::Degraded(Reason::Jitter) => Some(3),
            Self::Ok => Some(4),
        }
    }
}

/// A layer degrades at or above any of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub loss_percent: u32,
    /// Average RTT of the burst.
    pub rtt_ms: u32,
    /// Jitter: the burst's mdev.
    pub mdev_ms: u32,
}
const fn limits(loss_percent: u32, rtt_ms: u32, mdev_ms: u32) -> Limits {
    Limits {
        loss_percent,
        rtt_ms,
        mdev_ms,
    }
}
/// Per-layer limits in registry order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Thresholds([Limits; 4]);
/// The defaults table in docs/network.md (Diagnosis).
pub const DEFAULT_THRESHOLDS: Thresholds = Thresholds([
    limits(20, 20, 10),
    limits(20, 100, 30),
    limits(20, 250, 100),
    limits(20, 150, 50),
]);
impl Default for Thresholds {
    fn default() -> Self {
        DEFAULT_THRESHOLDS
    }
}
impl Thresholds {
    pub const fn get(&self, layer: Layer) -> Limits {
        self.0[layer as usize]
    }
    /// `--network-thresholds`: comma-separated `layer:loss/rtt/jitter` entries
    /// in integer percent and milliseconds, e.g. `wan:20/100/30,dns:30/400/150`.
    /// Listed layers replace their defaults; the rest keep them.
    pub fn parse(text: &str) -> Result<Self> {
        let mut table = DEFAULT_THRESHOLDS;
        let mut seen = Vec::new();
        for entry in text.split(',').map(str::trim) {
            let (name, values) = entry.split_once(':').with_context(|| {
                format!("--network-thresholds: {entry:?} is not layer:loss/rtt/jitter")
            })?;
            let layer = Layer::parse(name)
                .with_context(|| format!("--network-thresholds: unknown layer {name:?}"))?;
            ensure!(
                !seen.contains(&layer),
                "--network-thresholds: {name} is listed twice"
            );
            seen.push(layer);
            let values = values
                .split('/')
                .map(|v| v.parse::<u32>().ok())
                .collect::<Option<Vec<_>>>()
                .with_context(|| format!("--network-thresholds: {entry:?} needs integer values"))?;
            let [loss_percent, rtt_ms, mdev_ms] = values[..] else {
                anyhow::bail!(
                    "--network-thresholds: {entry:?} needs three values: loss/rtt/jitter"
                );
            };
            // Every probe attempt times out after 1 s, so a longer limit could never trip.
            ensure!(
                (1..=100).contains(&loss_percent)
                    && (1..=1000).contains(&rtt_ms)
                    && (1..=1000).contains(&mdev_ms),
                "--network-thresholds: {entry:?} needs loss 1-100 % and rtt and jitter 1-1000 ms"
            );
            table.0[layer as usize] = limits(loss_percent, rtt_ms, mdev_ms);
        }
        Ok(table)
    }
}

/// One target's burst against its layer's limits. Loss outranks latency, and
/// latency outranks jitter.
pub fn classify(burst: &Burst, limits: Limits) -> LayerHealth {
    // A burst carries RTTs exactly when something came back.
    let Some(rtt) = burst.rtt.filter(|_| burst.received > 0) else {
        return LayerHealth::Lost;
    };
    let lost = u64::from(burst.sent - burst.received);
    if lost * 100 >= u64::from(limits.loss_percent) * u64::from(burst.sent) {
        LayerHealth::Degraded(Reason::Loss)
    } else if rtt.avg_us >= i64::from(limits.rtt_ms) * 1000 {
        LayerHealth::Degraded(Reason::Latency)
    } else if rtt.mdev_us >= i64::from(limits.mdev_ms) * 1000 {
        LayerHealth::Degraded(Reason::Jitter)
    } else {
        LayerHealth::Ok
    }
}

/// The worst values among the targets that set a layer's health in one tick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Peak {
    pub loss_percent: f64,
    /// Average RTT; null when nothing came back.
    pub rtt_us: Option<i64>,
    pub mdev_us: Option<i64>,
}
impl Peak {
    fn of(burst: &Burst) -> Self {
        Self {
            loss_percent: 100.0 * f64::from(burst.sent - burst.received) / f64::from(burst.sent),
            rtt_us: burst.rtt.map(|r| r.avg_us),
            mdev_us: burst.rtt.map(|r| r.mdev_us),
        }
    }
    pub fn max(self, other: Self) -> Self {
        Self {
            loss_percent: self.loss_percent.max(other.loss_percent),
            rtt_us: self.rtt_us.max(other.rtt_us),
            mdev_us: self.mdev_us.max(other.mdev_us),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reading {
    pub health: LayerHealth,
    /// Null exactly when the health is unknown.
    pub peak: Option<Peak>,
}

/// One tick's readings in registry order.
///
/// A layer is as healthy as its healthiest sampled target, ranked Ok, then
/// Degraded by jitter, latency and loss, then Lost. The spec calls both anycast
/// targets down an ISP outage (`Down { wan }`), so one resolver that drops ICMP
/// must not blame the ISP. Targets without a sample are ignored; a layer with
/// none is Unknown. The peak comes from the targets that share the chosen health.
pub fn assess(samples: &[Sample], thresholds: &Thresholds) -> [Reading; 4] {
    Layer::ALL.map(|layer| {
        let classified: Vec<_> = samples
            .iter()
            .filter(|s| s.layer == layer)
            .map(|s| (classify(&s.burst, thresholds.get(layer)), &s.burst))
            .collect();
        let health = classified
            .iter()
            .map(|(health, _)| *health)
            .max_by_key(|health| health.rank())
            .unwrap_or(LayerHealth::Unknown);
        let peak = classified
            .iter()
            .filter(|(h, _)| *h == health)
            .map(|(_, burst)| Peak::of(burst))
            .reduce(Peak::max);
        Reading { health, peak }
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "state", rename_all = "lowercase")]
#[schema(as = NetworkLinkState)]
pub enum LinkState {
    #[default]
    Healthy,
    Degraded {
        layer: Layer,
        reason: Reason,
    },
    /// 100% loss for at least DOWN_TICKS consecutive ticks.
    Down {
        layer: Layer,
    },
}
impl LinkState {
    pub const fn layer(self) -> Option<Layer> {
        match self {
            Self::Healthy => None,
            Self::Degraded { layer, .. } | Self::Down { layer } => Some(layer),
        }
    }
}

pub const DOWN_TICKS: u32 = 2;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Diagnosis {
    /// Consecutive Lost ticks per layer, in registry order.
    pub streak: [u32; 4],
    pub state: LinkState,
}

/// Advance one tick. A Lost layer is down from its second consecutive Lost
/// tick and Degraded by loss before that; any other health, Unknown included,
/// resets its streak, so recovery is immediate. The first layer in registry
/// order that is down or degraded names the state, even when a later layer is
/// down: a degraded lan masks a down wan.
pub fn step(previous: &Diagnosis, health: &[LayerHealth; 4]) -> Diagnosis {
    let streak = std::array::from_fn(|i| match health[i] {
        LayerHealth::Lost => previous.streak[i].saturating_add(1),
        _ => 0,
    });
    let state = Layer::ALL
        .into_iter()
        .find_map(|layer| {
            let i = layer as usize;
            match health[i] {
                LayerHealth::Lost if streak[i] >= DOWN_TICKS => Some(LinkState::Down { layer }),
                LayerHealth::Lost => Some(LinkState::Degraded {
                    layer,
                    reason: Reason::Loss,
                }),
                LayerHealth::Degraded(reason) => Some(LinkState::Degraded { layer, reason }),
                LayerHealth::Unknown | LayerHealth::Ok => None,
            }
        })
        .unwrap_or_default();
    Diagnosis { streak, state }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::Rtt;
    use Layer::{Dns, Lan, Tailnet, Wan};
    use LayerHealth::{Lost, Unknown};
    use Reason::{Jitter, Latency, Loss};

    fn burst(sent: u32, received: u32, avg_us: i64, mdev_us: i64) -> Burst {
        Burst {
            sent,
            received,
            rtt: (received > 0).then_some(Rtt {
                min_us: avg_us,
                avg_us,
                max_us: avg_us,
                mdev_us,
            }),
        }
    }
    fn sample(layer: Layer, target: &str, burst: Burst) -> Sample {
        Sample {
            ts_ms: 0,
            layer,
            target: target.into(),
            address: None,
            burst,
        }
    }
    fn health(samples: &[Sample]) -> [LayerHealth; 4] {
        assess(samples, &DEFAULT_THRESHOLDS).map(|r| r.health)
    }
    fn run(ticks: &[[LayerHealth; 4]]) -> Vec<LinkState> {
        let mut diagnosis = Diagnosis::default();
        ticks
            .iter()
            .map(|health| {
                diagnosis = step(&diagnosis, health);
                diagnosis.state
            })
            .collect()
    }
    const OK: LayerHealth = LayerHealth::Ok;
    const fn degraded(reason: Reason) -> LayerHealth {
        LayerHealth::Degraded(reason)
    }

    /// Effective health: what a layer amounts to once streaks are applied.
    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Effective {
        Unknown,
        Ok,
        Degraded(Reason),
        Down,
    }
    const EFFECTIVE: [Effective; 6] = [
        Effective::Unknown,
        Effective::Ok,
        Effective::Degraded(Loss),
        Effective::Degraded(Latency),
        Effective::Degraded(Jitter),
        Effective::Down,
    ];
    /// Down is driven by the same Lost health on two consecutive ticks; the
    /// rest need one tick.
    fn diagnose(effective: [Effective; 4]) -> LinkState {
        let health = effective.map(|e| match e {
            Effective::Unknown => Unknown,
            Effective::Ok => OK,
            Effective::Degraded(reason) => degraded(reason),
            Effective::Down => Lost,
        });
        let ticks = if effective.contains(&Effective::Down) {
            2
        } else {
            1
        };
        *run(&vec![health; ticks]).last().unwrap()
    }

    #[test]
    fn every_layer_combination_blames_the_first_faulting_layer() {
        let combinations: Vec<[Effective; 4]> = (0..6usize.pow(4))
            .map(|n| std::array::from_fn(|i| EFFECTIVE[n / 6usize.pow(i as u32) % 6]))
            .collect();
        assert_eq!(combinations.len(), 1296);
        let faulting = |e: Effective| !matches!(e, Effective::Unknown | Effective::Ok);
        for effective in combinations {
            let state = diagnose(effective);
            let first = (0..4).find(|&i| faulting(effective[i]));
            assert_eq!(
                state == LinkState::Healthy,
                first.is_none(),
                "healthy iff every layer is unknown or ok: {effective:?} -> {state:?}"
            );
            let Some(first) = first else {
                continue;
            };
            let layer = Layer::ALL[first];
            assert_eq!(
                state.layer(),
                Some(layer),
                "first faulting layer is named: {effective:?} -> {state:?}"
            );
            let named = effective[state.layer().unwrap() as usize];
            assert_ne!(
                named,
                Effective::Unknown,
                "unknown is never named: {effective:?}"
            );
            assert_eq!(
                matches!(state, LinkState::Down { .. }),
                named == Effective::Down,
                "down iff the named layer is down: {effective:?} -> {state:?}"
            );
            match named {
                Effective::Down => assert_eq!(state, LinkState::Down { layer }),
                Effective::Degraded(reason) => {
                    assert_eq!(
                        state,
                        LinkState::Degraded { layer, reason },
                        "{effective:?}"
                    )
                }
                Effective::Unknown | Effective::Ok => unreachable!(),
            }
            for later in first + 1..4 {
                for other in EFFECTIVE {
                    let mut changed = effective;
                    changed[later] = other;
                    assert_eq!(
                        diagnose(changed),
                        state,
                        "layers after the first fault never matter: {effective:?} vs {changed:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn spec_examples_and_masking() {
        let gateway = |b| sample(Lan, "gateway", b);
        let wan = |b: Burst| [sample(Wan, "1.1.1.1", b), sample(Wan, "8.8.8.8", b)];
        let dns = |b| sample(Dns, "dns", b);
        let tailnet = |b| sample(Tailnet, "tailnet", b);
        let fine = burst(10, 10, 1000, 100);
        let lost = Burst::lost(10);
        let tick = |lan: Burst, w: Burst, d: Burst, t: Burst| {
            let [a, b] = wan(w);
            health(&[gateway(lan), a, b, dns(d), tailnet(t)])
        };
        let down = |layer| LinkState::Down { layer };
        let loss = |layer| LinkState::Degraded {
            layer,
            reason: Loss,
        };
        for (name, ticks, expected) in [
            (
                "gateway fine, both wan targets down for two ticks: an ISP outage",
                vec![tick(fine, lost, fine, fine); 2],
                down(Wan),
            ),
            (
                "ICMP fine, DNS failing for two ticks",
                vec![tick(fine, fine, lost, fine); 2],
                down(Dns),
            ),
            (
                "lan down masks every later layer",
                vec![tick(lost, lost, lost, lost); 2],
                down(Lan),
            ),
            (
                "only tailnet down",
                vec![tick(fine, fine, fine, lost); 2],
                down(Tailnet),
            ),
            (
                "one tick of 100% loss is degraded, not yet down",
                vec![tick(fine, lost, fine, fine)],
                loss(Wan),
            ),
            (
                "everything fine",
                vec![tick(fine, fine, fine, fine)],
                LinkState::Healthy,
            ),
        ] {
            assert_eq!(*run(&ticks).last().unwrap(), expected, "{name}");
        }
    }

    /// The spec names the first layer that is down OR degraded, so a slow
    /// gateway hides an ISP outage. This pins that literal reading.
    #[test]
    fn degraded_lan_masks_down_wan() {
        let tick = [degraded(Latency), Lost, OK, OK];
        assert_eq!(
            run(&[tick, tick]),
            [LinkState::Degraded {
                layer: Lan,
                reason: Latency
            }; 2]
        );
    }

    #[test]
    fn streaks_need_consecutive_lost_ticks_and_recovery_is_immediate() {
        let wan = |h| [OK, h, OK, OK];
        let degraded_wan = LinkState::Degraded {
            layer: Wan,
            reason: Loss,
        };
        let down_wan = LinkState::Down { layer: Wan };
        assert_eq!(
            run(&[wan(Lost), wan(Lost), wan(Lost)]),
            [degraded_wan, down_wan, down_wan]
        );
        for gap in [Unknown, OK, degraded(Jitter)] {
            let states = run(&[wan(Lost), wan(gap), wan(Lost), wan(gap), wan(Lost)]);
            assert!(!states.contains(&down_wan), "{gap:?}: {states:?}");
        }
        // One good tick ends an outage; no recovery streak is required.
        assert_eq!(
            run(&[wan(Lost), wan(Lost), wan(OK)]),
            [degraded_wan, down_wan, LinkState::Healthy]
        );
        assert_eq!(
            run(&[wan(Lost), wan(Lost), wan(Unknown)])[2],
            LinkState::Healthy
        );
        // Streaks are per layer: wan's history does not make dns down.
        assert_eq!(
            run(&[wan(Lost), [OK, OK, Lost, OK]])[1],
            LinkState::Degraded {
                layer: Dns,
                reason: Loss
            }
        );
    }

    #[test]
    fn wan_targets_combine_by_the_healthiest_sample() {
        // Per-target outcomes against the wan defaults: 20% loss, 100 ms, 30 ms.
        let outcomes: [Option<Burst>; 6] = [
            None,
            Some(burst(10, 10, 8_000, 1_000)),
            Some(burst(10, 7, 8_000, 1_000)),
            Some(burst(10, 10, 150_000, 1_000)),
            Some(burst(10, 10, 50_000, 40_000)),
            Some(Burst::lost(10)),
        ];
        let (u, o, l, t, j, x) = (
            Unknown,
            OK,
            degraded(Loss),
            degraded(Latency),
            degraded(Jitter),
            Lost,
        );
        // Rows: 1.1.1.1; columns: 8.8.8.8; both in the order of `outcomes`.
        let expected = [
            [u, o, l, t, j, x],
            [o, o, o, o, o, o],
            [l, o, l, t, j, l],
            [t, o, t, t, j, t],
            [j, o, j, j, j, j],
            [x, o, l, t, j, x],
        ];
        for (a, row) in outcomes.iter().zip(expected) {
            for (b, want) in outcomes.iter().zip(row) {
                let samples: Vec<_> = [("1.1.1.1", a), ("8.8.8.8", b)]
                    .into_iter()
                    .filter_map(|(target, burst)| burst.map(|burst| sample(Wan, target, burst)))
                    .collect();
                let reading = assess(&samples, &DEFAULT_THRESHOLDS)[Wan as usize];
                assert_eq!(reading.health, want, "{a:?} + {b:?}");
                assert_eq!(reading.peak.is_none(), want == Unknown, "{a:?} + {b:?}");
            }
        }
        let peak = |samples: &[Sample]| assess(samples, &DEFAULT_THRESHOLDS)[Wan as usize].peak;
        // The peak describes the chosen target, not the worse one beside it.
        assert_eq!(
            peak(&[
                sample(Wan, "1.1.1.1", Burst::lost(10)),
                sample(Wan, "8.8.8.8", burst(10, 10, 8_000, 1_000))
            ]),
            Some(Peak {
                loss_percent: 0.0,
                rtt_us: Some(8_000),
                mdev_us: Some(1_000)
            })
        );
        // Tied targets contribute their worst values.
        assert_eq!(
            peak(&[
                sample(Wan, "1.1.1.1", burst(10, 7, 9_000, 2_000)),
                sample(Wan, "8.8.8.8", burst(10, 6, 8_000, 3_000))
            ]),
            Some(Peak {
                loss_percent: 40.0,
                rtt_us: Some(9_000),
                mdev_us: Some(3_000)
            })
        );
        assert_eq!(
            peak(&[
                sample(Wan, "1.1.1.1", Burst::lost(10)),
                sample(Wan, "8.8.8.8", Burst::lost(10))
            ]),
            Some(Peak {
                loss_percent: 100.0,
                rtt_us: None,
                mdev_us: None
            })
        );
    }

    #[test]
    fn targets_classify_at_each_layer_boundary() {
        // docs/network.md defaults: loss %, RTT ms, jitter ms.
        for (layer, loss, rtt_ms, mdev_ms) in [
            (Lan, 20, 20, 10),
            (Wan, 20, 100, 30),
            (Dns, 20, 250, 100),
            (Tailnet, 20, 150, 50),
        ] {
            let one = |b: Burst| health(&[sample(layer, "t", b)])[layer as usize];
            let (rtt, mdev) = (rtt_ms * 1000, mdev_ms * 1000);
            let fine = (rtt - 1, mdev - 1);
            for (b, want) in [
                (burst(100, 100 - loss, fine.0, fine.1), degraded(Loss)),
                (burst(100, 101 - loss, fine.0, fine.1), OK),
                (burst(100, 100, rtt, fine.1), degraded(Latency)),
                (burst(100, 100, rtt - 1, fine.1), OK),
                (burst(100, 100, fine.0, mdev), degraded(Jitter)),
                (burst(100, 100, fine.0, mdev - 1), OK),
                (Burst::lost(100), Lost),
                (Burst::lost(10), Lost),
                (burst(100, 1, rtt, mdev), degraded(Loss)),
                (burst(100, 100, rtt, mdev), degraded(Latency)),
            ] {
                assert_eq!(one(b), want, "{layer:?} {b:?}");
            }
            assert_eq!(
                health(&[sample(layer, "t", burst(10, 10, 1, 0))])
                    .iter()
                    .enumerate()
                    .filter(|(i, h)| *i != layer as usize && **h != Unknown)
                    .count(),
                0,
                "layers without a sample are unknown"
            );
        }
    }

    #[test]
    fn threshold_flag_overrides_listed_layers() {
        let parsed = Thresholds::parse(" wan:30/150/40 , dns:20/400/150").unwrap();
        assert_eq!(parsed.get(Wan), limits(30, 150, 40));
        assert_eq!(parsed.get(Dns), limits(20, 400, 150));
        assert_eq!(parsed.get(Lan), DEFAULT_THRESHOLDS.get(Lan));
        assert_eq!(parsed.get(Tailnet), DEFAULT_THRESHOLDS.get(Tailnet));
        assert_eq!(
            Thresholds::parse("lan:20/20/10,wan:20/100/30,dns:20/250/100,tailnet:20/150/50")
                .unwrap(),
            DEFAULT_THRESHOLDS
        );
        assert_eq!(Thresholds::default(), DEFAULT_THRESHOLDS);
        for invalid in [
            "",
            "wan",
            "wifi:20/100/30",
            "wan:20/100",
            "wan:20/100/30/1",
            "wan:20/100/x",
            "wan:0/100/30",
            "wan:101/100/30",
            "wan:20/0/30",
            "wan:20/1001/30",
            "wan:20/100/0",
            "wan:-1/100/30",
            "wan:20/100/30,wan:20/100/30",
            "wan:20/100/30,",
        ] {
            assert!(Thresholds::parse(invalid).is_err(), "{invalid:?}");
        }
    }
}
