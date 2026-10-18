import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/lib/motion";
import type { AmbientMode } from "./mode";

// [dawn, night] from docs/design/kiosk-v2/tokens.json, mirrored here for the `static` sky
// image, which is rendered as a data URL and so cannot read the CSS tokens in index.css.
const COLORS = {
  "sky-0": ["#f7fafb", "#0b1016"],
  "sky-1": ["#ebf2f4", "#0f1820"],
  "sky-2": ["#e2ecee", "#16252f"],
  "sky-3": ["#efe0d6", "#2f3740"],
  "sky-4": ["#f2cdb5", "#6b4c42"],
  "ridge-far": ["#cfe0e3", "#1e2c35"],
  "ridge-mid": ["#a9c3c9", "#141f27"],
  "ridge-near": ["#8fb0b8", "#0c141a"],
  snow: ["#ffffff", "#f7e0d0"],
  rim: ["#00756c", "#3fd1c2"], // accent-text
} as const;

// The band is drawn in a 1728 × 360 box (`band-height`) and stretched to the viewport
// width. The ridgeline is generated from hand-placed Teton control points ("x,y", y down
// from the band top) plus a seeded jag; the Grand Teton peaks at x ≈ 910.
const W = 1728;
const H = 360;
const NEAR =
  "0,250 90,226 170,238 250,206 330,222 420,182 500,198 580,152 650,172 720,120 790,98 " +
  "840,72 872,90 910,32 946,72 986,58 1030,96 1080,82 1130,132 1200,150 1262,132 1330,174 " +
  "1400,160 1480,202 1560,190 1640,226 1728,214";
const FAR =
  "0,196 140,168 260,184 380,150 520,164 640,128 760,146 880,110 1010,132 1140,104 " +
  "1270,138 1400,120 1530,152 1640,136 1728,158";

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Three seeded jitter points between each pair of control points. */
function jag(controls: string, seed: number, amplitude: number) {
  const next = random(seed);
  const points = controls.split(" ").map((point) => point.split(",").map(Number));
  const out: string[] = [];
  points.forEach(([x = 0, y = 0], i) => {
    out.push(`${x} ${y}`);
    const [x2, y2] = points[i + 1] ?? [];
    if (x2 === undefined || y2 === undefined) return;
    for (let step = 1; step < 4; step++) {
      const t = step / 4;
      const jy = y + (y2 - y) * t + (next() - 0.5) * amplitude;
      out.push(`${(x + (x2 - x) * t).toFixed(1)} ${jy.toFixed(1)}`);
    }
  });
  return `M${out.join(" L")}`;
}

const RIM = jag(NEAR, 237, 18);
const NEAR_PATH = `${RIM} L${W} ${H} L0 ${H} Z`;
const FAR_PATH = `${jag(FAR, 227, 10)} L${W} ${H} L0 ${H} Z`;
const svgUrl = (svg: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${svg}</svg>`)}")`;
const SWEEP_MASK = svgUrl(
  `viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${NEAR_PATH}"/>`,
);

/**
 * `static` mode: the sky and ridge rendered once, blurred 18 px and saturated 170% like the
 * glass, as a viewport-sized image. Panels show it as a fixed background, so they look
 * frosted without a live backdrop-filter.
 */
function staticSky(dark: boolean, width: number, height: number) {
  const c = (name: keyof typeof COLORS) => COLORS[name][dark ? 1 : 0];
  const sky = [0, 0.4, 0.66, 0.84, 1]
    .map((offset, i) => `<stop offset="${offset}" stop-color="${c(`sky-${i}` as "sky-0")}"/>`)
    .join("");
  return svgUrl(
    `width="${width}" height="${height}"><defs>` +
      `<linearGradient id="s" x2="0" y2="1">${sky}</linearGradient>` +
      `<linearGradient id="n" x2="0" y2="1"><stop stop-color="${c("ridge-mid")}"/>` +
      `<stop offset="1" stop-color="${c("ridge-near")}"/></linearGradient>` +
      `<linearGradient id="w" gradientUnits="userSpaceOnUse" x2="0" y2="${H * 0.22}">` +
      `<stop stop-color="${c("snow")}" stop-opacity="${dark ? 0.75 : 0.95}"/>` +
      `<stop offset="1" stop-color="${c("snow")}" stop-opacity="0"/></linearGradient>` +
      `<filter id="b" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">` +
      `<feGaussianBlur stdDeviation="18" edgeMode="duplicate"/>` +
      `<feColorMatrix type="saturate" values="1.7"/></filter></defs>` +
      `<g filter="url(#b)"><rect width="100%" height="100%" fill="url(#s)"/>` +
      `<svg y="${height - H}" width="${width}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<path d="${FAR_PATH}" fill="${c("ridge-far")}" opacity="0.75"/>` +
      `<path d="${NEAR_PATH}" fill="url(#n)"/><path d="${NEAR_PATH}" fill="url(#w)"/>` +
      `<path d="${RIM}" fill="none" stroke="${c("rim")}" stroke-opacity="0.55" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` +
      `</svg></g>`,
  );
}

const starRandom = random(50);
const STARS = Array.from({ length: 50 }, () => {
  const size = starRandom() < 0.3 ? 2 : 1;
  return {
    left: `${(starRandom() * 100).toFixed(2)}%`,
    top: `${(starRandom() * 58).toFixed(2)}%`,
    width: size,
    height: size,
    animationDelay: `${(-starRandom() * 6).toFixed(2)}s`,
  } satisfies CSSProperties;
});

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

/** The kiosk backdrop: sky, Teton ridgeline band and the ambient layers for `mode`. */
export function AmbientScene({ mode, dark }: { mode: AmbientMode; dark: boolean }) {
  const reduced = useReducedMotion();
  const [size, setSize] = useState(viewport);
  useEffect(() => {
    if (mode !== "static") return;
    const resize = () => setSize(viewport());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [mode]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.ambient = mode;
    return () => {
      delete root.dataset.ambient;
    };
  }, [mode]);
  useLayoutEffect(() => {
    if (mode !== "static") return;
    const root = document.documentElement;
    root.style.setProperty("--fk-static-sky", staticSky(dark, size.width, size.height));
    return () => {
      root.style.removeProperty("--fk-static-sky");
    };
  }, [mode, dark, size]);
  return (
    <div
      className={cn("fk-backdrop", (reduced || mode === "none") && "fk-still")}
      data-ambient-scene={mode}
      aria-hidden="true"
    >
      {mode === "both" && (
        <div className="fk-night">
          <div className="fk-aurora" />
          <div className="fk-aurora fk-aurora-b" />
          {STARS.map((style, i) => (
            <i key={i} className="fk-star" style={style} />
          ))}
        </div>
      )}
      <div className="fk-band">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="fk-near" x2="0" y2="1">
              <stop offset="0" className="fk-near-0" />
              <stop offset="1" className="fk-near-1" />
            </linearGradient>
            <linearGradient id="fk-snow" gradientUnits="userSpaceOnUse" x2="0" y2={H * 0.22}>
              <stop offset="0" className="fk-snow-0" />
              <stop offset="1" className="fk-snow-1" />
            </linearGradient>
          </defs>
          <path className="fk-ridge-far" d={FAR_PATH} />
          <path fill="url(#fk-near)" d={NEAR_PATH} />
          <path fill="url(#fk-snow)" d={NEAR_PATH} />
          <path className="fk-rim" d={RIM} />
        </svg>
        {mode !== "none" && (
          <div
            className="fk-sweep-clip"
            style={{ maskImage: SWEEP_MASK, WebkitMaskImage: SWEEP_MASK }}
          >
            <div className="fk-sweep" />
          </div>
        )}
      </div>
    </div>
  );
}
