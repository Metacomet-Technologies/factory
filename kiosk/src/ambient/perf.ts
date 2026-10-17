export type AmbientPerf = {
  mode: string;
  frames: number;
  long_frames_50ms: number;
  long_frames_100ms: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  started_ms: number;
};

declare global {
  interface Window {
    __ambientPerf?: AmbientPerf;
  }
}

/**
 * `?perf=1` only: records every requestAnimationFrame interval and publishes
 * `window.__ambientPerf` every `interval` ms. Nothing leaves the page; the trial
 * script reads the object over the debugging port.
 */
export function startAmbientPerf(mode: string, interval = 10_000) {
  // 0.1 ms buckets up to 1 s; the last bucket holds every longer frame.
  const buckets = new Uint32Array(10_001);
  const started_ms = Date.now();
  let frames = 0;
  let long50 = 0;
  let long100 = 0;
  let last: number | undefined;
  const percentile = (q: number) => {
    if (frames === 0) return null;
    const rank = Math.ceil(q * frames);
    let seen = 0;
    for (let i = 0; i < buckets.length; i++) {
      seen += buckets[i] ?? 0;
      if (seen >= rank) return i / 10;
    }
    return null;
  };
  const publish = () => {
    window.__ambientPerf = {
      mode,
      frames,
      long_frames_50ms: long50,
      long_frames_100ms: long100,
      p50_ms: percentile(0.5),
      p95_ms: percentile(0.95),
      p99_ms: percentile(0.99),
      started_ms,
    };
  };
  let frame = requestAnimationFrame(function tick(now) {
    if (last !== undefined) {
      const delta = now - last;
      frames++;
      if (delta > 50) long50++;
      if (delta > 100) long100++;
      const bucket = Math.min(buckets.length - 1, Math.round(delta * 10));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    last = now;
    frame = requestAnimationFrame(tick);
  });
  publish();
  const timer = setInterval(publish, interval);
  return () => {
    cancelAnimationFrame(frame);
    clearInterval(timer);
  };
}
