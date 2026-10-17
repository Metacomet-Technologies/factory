import { describe, expect, it } from "vite-plus/test";
import { initialLiveState, parseEvent, streamReducer } from "../api/stream";
import type {
  NetworkEvent,
  NetworkLayer,
  NetworkLinkState,
  NetworkReason,
  NetworkSeries,
  NetworkStatus,
  NetworkTarget,
} from "../api/types";
import { mbps } from "./format";
import {
  chartStart,
  eventBands,
  freshStatus,
  layerNow,
  layerRows,
  layerTrend,
  networkBadge,
  speedRows,
} from "./network";

const NOW = 1_800_000_000_000;
const target = (
  layer: NetworkLayer,
  name: string,
  received: number | null,
  avg_us = 9_000,
  ts_ms = NOW - 5_000,
): NetworkTarget => ({
  layer,
  target: name,
  probe: layer === "dns" ? "resolve" : layer === "tailnet" ? "tcp_connect" : "icmp",
  latest:
    received == null
      ? null
      : {
          ts_ms,
          layer,
          target: name,
          address: name,
          sent: 10,
          received,
          rtt:
            received === 0
              ? null
              : { min_us: avg_us - 500, avg_us, max_us: avg_us + 500, mdev_us: 200 },
        },
});
const status = (state: NetworkStatus["state"], targets = [target("wan", "1.1.1.1", 10)]) =>
  ({
    device_id: "factory-gpu",
    generated_at_ms: NOW,
    state,
    targets,
    warnings: [],
  }) satisfies NetworkStatus;
const event = (
  id: number,
  started_ms: number,
  ended_ms: number | null,
  link: NetworkLinkState = { state: "down", layer: "wan" },
): NetworkEvent => ({
  ...link,
  id,
  started_ms,
  ended_ms,
  end_reason: ended_ms == null ? null : "recovered",
  peak_loss_percent: 100,
  peak_rtt_us: null,
  peak_mdev_us: null,
});

describe("network state badge", () => {
  const layers = ["lan", "wan", "dns", "tailnet"] as const;
  const names = { lan: "LAN", wan: "WAN", dns: "DNS", tailnet: "Tailnet" };
  const reasons: NetworkReason[] = ["loss", "latency", "jitter"];
  it("labels healthy, every degraded layer and reason, and every down layer", () => {
    const fresh = (state: NetworkStatus["state"]) => networkBadge(freshStatus(status(state), NOW));
    expect(fresh({ state: "healthy" })).toEqual({ label: "Healthy", tone: "ok" });
    for (const layer of layers) {
      expect(fresh({ state: "down", layer })).toEqual({
        label: `Down · ${names[layer]}`,
        tone: "fail",
      });
      for (const reason of reasons)
        expect(fresh({ state: "degraded", layer, reason })).toEqual({
          label: `Degraded · ${names[layer]} ${reason}`,
          tone: "warn",
        });
    }
  });
  it("says No data before any sample, without a snapshot, and once samples are 90 s old", () => {
    const noData = { label: "No data", tone: "neutral" };
    const down = { state: "down", layer: "wan" } as const;
    expect(networkBadge(freshStatus(null, NOW))).toEqual(noData);
    expect(networkBadge(freshStatus(status(down, [target("wan", "1.1.1.1", null)]), NOW))).toEqual(
      noData,
    );
    const aged = (age: number) =>
      networkBadge(freshStatus(status(down, [target("wan", "1.1.1.1", 0, 0, NOW - age)]), NOW));
    expect(aged(90_000).label).toBe("Down · WAN");
    expect(aged(90_001)).toEqual(noData);
  });
});

describe("network formats", () => {
  it("renders rates in Mb/s without inventing zero", () => {
    expect(mbps(null)).toBe("—");
    expect(mbps(undefined)).toBe("—");
    expect(mbps(0)).toBe("0 Mb/s");
    expect(mbps(400_000)).toBe("0.4 Mb/s");
    expect(mbps(50_340_000)).toBe("50.3 Mb/s");
    expect(mbps(99_940_000)).toBe("99.9 Mb/s");
    expect(mbps(100_000_000)).toBe("100 Mb/s");
    expect(mbps(938_400_000)).toBe("938 Mb/s");
    expect(mbps(21_345_600_000)).toBe("21,346 Mb/s");
  });
});

describe("network history shapes", () => {
  const series = (layer: NetworkLayer, name: string, points: [number, number | null, number][]) =>
    ({
      layer,
      target: name,
      points: points.map(([ts_ms, avg, loss_percent]) => ({
        ts_ms,
        sample_count: 1,
        loss_percent,
        latency_ms: { min: avg, avg, max: avg },
        jitter_ms: null,
      })),
    }) satisfies NetworkSeries;
  const history = [
    series("lan", "gateway", [[0, 0.4, 0]]),
    series("wan", "1.1.1.1", [
      [60_000, 20, 0],
      [0, 9, 10],
      [120_000, null, 100],
    ]),
    series("wan", "8.8.8.8", [
      [0, 12, 0],
      [60_000, 11, 30],
      [120_000, null, 100],
    ]),
  ];
  it("reduces a layer to its healthiest target per bucket and keeps total loss null", () => {
    expect(layerTrend(history, "wan")).toEqual([
      { ts_ms: 0, latency: 9, loss: 0 },
      { ts_ms: 60_000, latency: 11, loss: 0 },
      { ts_ms: 120_000, latency: null, loss: 100 },
    ]);
    expect(layerTrend(history, "dns")).toEqual([]);
    expect(
      layerNow([target("wan", "1.1.1.1", 0), target("wan", "8.8.8.8", 7, 12_000)], "wan"),
    ).toEqual({ latency: 12, loss: 30 });
    expect(layerNow([target("wan", "1.1.1.1", null)], "wan")).toEqual({
      latency: null,
      loss: null,
    });
  });
  it("keys per-target chart columns by index, since target names contain dots", () => {
    const lines = layerRows(history, "wan");
    expect(lines.map((line) => line.target)).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(lines[0]!.points[0]).toEqual({ ts_ms: 0, latency0: 9, loss0: 10 });
    expect(lines[1]!.points[2]).toEqual({ ts_ms: 120_000, latency1: null, loss1: 100 });
  });
  it("gives each target its own points, so a missed bucket never breaks another line", () => {
    const lines = layerRows(
      [
        series("wan", "1.1.1.1", [
          [0, 9, 0],
          [30_000, 10, 0],
          [60_000, null, 100],
          [90_000, 11, 0],
        ]),
        series("wan", "8.8.8.8", [
          [90_000, 13, 0],
          [0, 12, 0],
        ]),
      ],
      "wan",
    );
    expect(lines).toEqual([
      {
        target: "1.1.1.1",
        points: [
          { ts_ms: 0, latency0: 9, loss0: 0 },
          { ts_ms: 30_000, latency0: 10, loss0: 0 },
          { ts_ms: 60_000, latency0: null, loss0: 100 },
          { ts_ms: 90_000, latency0: 11, loss0: 0 },
        ],
      },
      {
        target: "8.8.8.8",
        points: [
          { ts_ms: 0, latency1: 12, loss1: 0 },
          { ts_ms: 90_000, latency1: 13, loss1: 0 },
        ],
      },
    ]);
    expect(lines[1]!.points.every((point) => point.latency1 != null)).toBe(true);
  });
  it("clips event bands to the window and runs an open event to now", () => {
    const since = NOW - 3_600_000;
    const bands = eventBands(
      [
        event(1, NOW - 600_000, null),
        event(2, NOW - 1_200_000, NOW - 900_000),
        event(3, since - 60_000, since + 60_000),
        event(4, since - 120_000, since - 60_000),
        event(5, since - 120_000, since),
        event(6, NOW + 5_000, null),
        event(7, NOW - 300_000, NOW - 240_000, {
          state: "degraded",
          layer: "wan",
          reason: "latency",
        }),
      ],
      since,
      NOW,
    );
    expect(bands).toEqual([
      { id: 1, layer: "wan", tone: "fail", x1: NOW - 600_000, x2: NOW, open: true },
      { id: 2, layer: "wan", tone: "fail", x1: NOW - 1_200_000, x2: NOW - 900_000, open: false },
      { id: 3, layer: "wan", tone: "fail", x1: since, x2: since + 60_000, open: false },
      { id: 7, layer: "wan", tone: "warn", x1: NOW - 300_000, x2: NOW - 240_000, open: false },
    ]);
  });
  it("starts a chart at the oldest point inside the window, or at the window start", () => {
    expect(chartStart(1_000, [])).toBe(1_000);
    expect(chartStart(1_000, [5_000, 3_000, 4_000])).toBe(3_000);
    expect(chartStart(1_000, [500, 3_000])).toBe(1_000);
  });
  it("charts failed speed tests with null rates, never zero", () => {
    const [ok, failed] = speedRows([
      {
        id: 1,
        started_ms: 0,
        ended_ms: 10_000,
        outcome: "ok",
        download_bps: 938_000_000,
        upload_bps: 920_000_000,
        download_bytes: 440e6,
        upload_bytes: 290e6,
        idle_latency_ms: 9,
        download_loaded_latency_ms: 14,
        upload_loaded_latency_ms: 19,
        colo: "SBX",
      },
      {
        id: 2,
        started_ms: 20_000,
        ended_ms: 20_500,
        outcome: "failed",
        error: "HTTP 500",
        download_bytes: 0,
        upload_bytes: 0,
      },
    ]);
    expect(ok).toEqual({
      ts_ms: 0,
      download: 938,
      upload: 920,
      downloadLoaded: 14,
      uploadLoaded: 19,
      failed: false,
    });
    expect(failed).toEqual({
      ts_ms: 20_000,
      download: null,
      upload: null,
      downloadLoaded: null,
      uploadLoaded: null,
      failed: true,
    });
  });
});

describe("network stream events", () => {
  it("bumps the network revision on samples and speed tests and rejects malformed frames", () => {
    const sample = parseEvent({
      type: "network.sample",
      ts_ms: NOW,
      data: [target("wan", "1.1.1.1", 10).latest],
    });
    const empty = parseEvent({ type: "network.sample", ts_ms: NOW, data: [] });
    const test = parseEvent({
      type: "network.speedtest",
      ts_ms: NOW,
      data: { id: 3, started_ms: NOW - 10_000, ended_ms: NOW, outcome: "timeout" },
    });
    expect([sample?.type, empty?.type, test?.type]).toEqual([
      "network.sample",
      "network.sample",
      "network.speedtest",
    ]);
    let state = streamReducer(initialLiveState, sample!);
    state = streamReducer(state, test!);
    expect(state.networkRevision).toBe(2);
    expect(parseEvent({ type: "network.sample", ts_ms: NOW, data: null })).toBeNull();
    expect(parseEvent({ type: "network.sample", ts_ms: NOW, data: [{ target: 1 }] })).toBeNull();
    expect(
      parseEvent({
        type: "network.speedtest",
        ts_ms: NOW,
        data: { id: 3, started_ms: 1, ended_ms: 2, outcome: "slow" },
      }),
    ).toBeNull();
  });
});
