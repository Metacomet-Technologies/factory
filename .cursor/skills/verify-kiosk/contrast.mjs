// Rendered contrast audit for the device matrix (devices.mjs). A copy of auditContrast in
// kiosk/scripts/screenshots.ts; keep the two in step when the scene changes.
/**
 * Rendered contrast, measured in the browser. Glass panels are translucent, so every text
 * element's background is its ancestor stack composited over the worst case of what the scene
 * can show behind its rect: the sky gradient at those heights, the far ridge, and below the
 * ridgeline the ridges, the snow at the highest peak and the alpenglow sweep, plus the aurora
 * where its ellipses sit; each raw and at the glass's 170% saturation. Text must reach 4.5:1
 * against every one of them; a control's boundary (border or fill, else its glyph) 3:1.
 */
export async function auditContrast(page, name) {
  const result = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const parse = (color) => {
      const rgb = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(color);
      if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]];
      const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(color);
      if (srgb)
        return [
          +srgb[1] * 255,
          +srgb[2] * 255,
          +srgb[3] * 255,
          srgb[4] === undefined ? 1 : +srgb[4],
        ];
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top, under) => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const luminance = ([r, g, b]) => {
      const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((value) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const ratio = (a, b) => {
      const l1 = luminance(a),
        l2 = luminance(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    // backdrop-filter: saturate(s), the SVG saturate matrix applied to the scene colour.
    const saturate = ([r, g, b, a], s) => [
      (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
      (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
      (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
      a,
    ];
    const probe = document.createElement("span");
    probe.hidden = true;
    document.body.append(probe);
    const token = (tokenName) => {
      probe.style.color = `var(--${tokenName})`;
      return parse(getComputedStyle(probe).color);
    };
    const ridgeFar = token("ridge-far");
    const ridgeMid = token("ridge-mid");
    const ridgeNear = token("ridge-near");
    const snow = token("snow");
    const sweepColor = token("primary");
    const ok = token("ok");
    const background = token("background");
    probe.remove();
    const rootStyle = getComputedStyle(document.documentElement);
    const sweepOpacity = parseFloat(rootStyle.getPropertyValue("--sweep-opacity"));
    const snowOpacity = parseFloat(rootStyle.getPropertyValue("--snow-opacity"));
    // The scene's geometry, read from the rendered backdrop: the sky gradient stops, the band
    // and where its ridgelines start, the snow fade and the aurora ellipses.
    const backdrop = document.querySelector(".fk-backdrop");
    const skyStops = backdrop
      ? [
          ...getComputedStyle(backdrop).backgroundImage.matchAll(
            /(rgba?\([^)]*\)|color\(srgb [^)]*\)) ([\d.]+)%/g,
          ),
        ].map((match) => ({ color: parse(match[1]), at: +match[2] / 100 }))
      : [];
    const skyAt = (y) => {
      const t = Math.min(1, Math.max(0, y / innerHeight));
      const next = skyStops.findIndex((stop) => stop.at >= t);
      if (next <= 0) return (skyStops[Math.max(next, 0)] ?? { color: background }).color;
      const from = skyStops[next - 1],
        to = skyStops[next];
      const k = (t - from.at) / (to.at - from.at || 1);
      return from.color.map((value, i) => value + (to.color[i] - value) * k);
    };
    const bandTop = document.querySelector(".fk-band")?.getBoundingClientRect().top ?? Infinity;
    const rimBox = document.querySelector(".fk-rim")?.getBBox();
    const nearTop = bandTop + (rimBox?.y ?? 0);
    const nearBottom = bandTop + (rimBox ? rimBox.y + rimBox.height : 0);
    const farTop = bandTop + (document.querySelector(".fk-ridge-far")?.getBBox().y ?? 0);
    const snowFade = +(document.querySelector("#fk-snow")?.getAttribute("y2") ?? 1);
    const snowAlpha = Math.max(0, snowOpacity * (1 - (rimBox?.y ?? 0) / snowFade));
    const auroras = [...document.querySelectorAll(".fk-aurora")]
      .map((aurora) => aurora.getBoundingClientRect())
      .filter((rect) => rect.height > 0);
    /** What the scene can show behind a viewport rect; each colour raw and glass-saturated. */
    const sceneBehind = (rect) => {
      if (!backdrop) return [background];
      const top = Math.max(0, Math.min(rect.top, innerHeight - 1));
      const bottom = Math.max(top + 1, Math.min(rect.bottom, innerHeight));
      const samples = [];
      if (top < nearBottom) {
        const ys = [
          top,
          Math.min(bottom, nearBottom),
          ...skyStops.map((stop) => stop.at * innerHeight).filter((y) => y > top && y < bottom),
        ];
        for (const y of ys) {
          samples.push(skyAt(y));
          if (auroras.some((aurora) => y >= aurora.top && y <= aurora.bottom))
            samples.push(over([ok[0], ok[1], ok[2], 0.32], skyAt(y)));
        }
        if (bottom > farTop) {
          const far = [ridgeFar[0], ridgeFar[1], ridgeFar[2], 0.75];
          samples.push(over(far, skyAt(Math.max(top, farTop))), over(far, skyAt(bottom)));
        }
      }
      if (bottom > nearTop) {
        const sweep = [sweepColor[0], sweepColor[1], sweepColor[2], sweepOpacity];
        samples.push(
          ridgeMid,
          ridgeNear,
          over([snow[0], snow[1], snow[2], snowAlpha], ridgeMid),
          over(sweep, ridgeMid),
          over(sweep, ridgeNear),
        );
      }
      return [...samples, ...samples.map((color) => saturate(color, 1.7))];
    };
    const root = document.getElementById("root");
    /** Background colours from `element` up to #root, inner first, plus the inherited opacity. */
    const stack = (element, rect) => {
      const layers = [];
      let opacity = 1;
      let opaque = false;
      for (let node = element; node && node !== root; node = node.parentElement) {
        const css = getComputedStyle(node);
        opacity *= parseFloat(css.opacity);
        if (opaque) continue;
        const color = parse(css.backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] >= 1) opaque = true;
      }
      const bases = opaque ? [layers.pop()] : sceneBehind(rect);
      const compose = (base) => layers.reduceRight((under, layer) => over(layer, under), base);
      return { backgrounds: bases.map(compose), opacity };
    };
    const worst = (foreground, backgrounds) =>
      backgrounds.reduce((min, background) => {
        const fg = over(foreground, background);
        return Math.min(min, ratio(fg, background));
      }, Infinity);
    const rgba = ([r, g, b, a]) =>
      `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(2)})`;
    const visible = (element) => {
      if (element.closest("svg, script, style, [hidden]")) return false;
      const css = getComputedStyle(element);
      if (css.visibility === "hidden" || css.display === "none") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };
    const text = [];
    for (const element of document.querySelectorAll("body *")) {
      if (!visible(element)) continue;
      const content = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? "")
        .join(" ")
        .trim();
      if (!content) continue;
      const { backgrounds, opacity } = stack(element, element.getBoundingClientRect());
      const color = parse(getComputedStyle(element).color);
      const foreground = [color[0], color[1], color[2], color[3] * opacity];
      const value = worst(foreground, backgrounds);
      const against = backgrounds.reduce((a, b) =>
        ratio(over(foreground, a), a) < ratio(over(foreground, b), b) ? a : b,
      );
      text.push({
        text: content.slice(0, 40),
        ratio: value,
        foreground: rgba(foreground),
        background: rgba(against),
      });
    }
    const controls = [];
    for (const element of document.querySelectorAll(
      'button, input, select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"]',
    )) {
      if (!visible(element)) continue;
      if (element.matches(":disabled, [aria-disabled='true']")) continue;
      const css = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const outer = stack(element.parentElement, rect).backgrounds;
      const cues = [];
      const borderColor = parse(css.borderTopColor);
      if (parseFloat(css.borderTopWidth) > 0 && css.borderTopStyle !== "none" && borderColor[3] > 0)
        cues.push(["border", worst(borderColor, outer)]);
      const fill = parse(css.backgroundColor);
      if (fill[3] > 0) cues.push(["fill", worst(fill, outer)]);
      if (!cues.length) {
        const { backgrounds, opacity } = stack(element, rect);
        const color = parse(css.color);
        cues.push([
          "glyph",
          worst([color[0], color[1], color[2], color[3] * opacity], backgrounds),
        ]);
      }
      const [cue, value] = cues.reduce((best, next) => (next[1] > best[1] ? next : best));
      controls.push({
        control:
          (element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "").slice(0, 40) ||
          element.className.toString().slice(0, 40),
        ratio: value,
        cue,
      });
    }
    return { text, controls };
  });
  const textMin = result.text.reduce((min, entry) => (entry.ratio < min.ratio ? entry : min));
  const controlMin = result.controls.reduce((min, entry) =>
    entry.ratio < min.ratio ? entry : min,
  );
  const failures = {
    text: result.text.filter((entry) => entry.ratio < 4.5),
    controls: result.controls.filter((entry) => entry.ratio < 3),
  };
  if (failures.text.length || failures.controls.length)
    throw new Error(`${name}: contrast failures ${JSON.stringify(failures)}`);
  console.log(
    `${name}: text ≥ ${textMin.ratio.toFixed(2)}:1 ("${textMin.text}"), controls ≥ ${controlMin.ratio.toFixed(2)}:1 ("${controlMin.control}" ${controlMin.cue})`,
  );
  return { textMin, controlMin, failures };
}
