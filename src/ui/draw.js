// Canvas charts. Each draw function paints one chart and returns a hit-test
// function for the hover tooltip: (x, y) in CSS pixels -> text or null.
// Colours come from CSS custom properties so light and dark themes work.

import { MONTHS, fmt, pct } from "../core/model.js";

/** @typedef {import("../core/simulate.js").SimResult} SimResult */
/** @typedef {import("../core/sizer.js").SizeResult} SizeResult */
/** @typedef {(x: number, y: number) => {text: string, x?: number, y?: number} | null} HitTest */

/**
 * @typedef {object} Palette
 * @property {string} fg
 * @property {string} muted
 * @property {string} grid
 * @property {string} axis
 * @property {string} surface
 * @property {string[]} series
 * @property {string} crit
 * @property {string} seqLo
 * @property {string} seqHi
 * @property {string} neutral
 */

/** @returns {Palette} */
export function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (/** @type {string} */ name) => s.getPropertyValue(name).trim();
  return {
    fg: v("--fg"),
    muted: v("--muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    surface: v("--chart-bg"),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--s${i}`)),
    crit: v("--crit"),
    seqLo: v("--seq-lo"),
    seqHi: v("--seq-hi"),
    neutral: v("--neutral"),
  };
}

const FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Size the canvas backing store to its CSS box and the device pixel ratio.
 * @param {HTMLCanvasElement} canvas
 * @returns {{ctx: CanvasRenderingContext2D, w: number, h: number}}
 */
function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, canvas.clientWidth);
  const h = Math.max(80, canvas.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = FONT;
  return { ctx, w, h };
}

/**
 * @param {string} hex #rrggbb
 * @returns {[number, number, number]}
 */
function rgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [128, 128, 128];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @param {number} t 0..1
 * @returns {[number, number, number]}
 */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * "Nice" linear ticks.
 * @param {number} lo
 * @param {number} hi
 * @param {number} count
 * @returns {number[]}
 */
export function ticks(lo, hi, count) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  /** @type {number[]} */
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step)
    out.push(Number(v.toPrecision(10)));
  return out;
}

/**
 * Daily energy per state as one horizontal stacked bar.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{label: string, value: number, color: string}>} segments mWh
 * @returns {HitTest}
 */
export function drawStackedBar(canvas, segments) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  const total = segments.reduce((a, s) => a + s.value, 0);
  const x0 = 8;
  const width = w - 16;
  const y = 8;
  const bh = Math.min(36, h - 34);
  /** @type {Array<{a: number, b: number, s: {label: string, value: number}}>} */
  const spans = [];
  let x = x0;
  for (const s of segments) {
    const sw = total > 0 ? (s.value / total) * width : 0;
    if (sw > 0) {
      ctx.fillStyle = s.color;
      ctx.fillRect(x, y, Math.max(0.5, sw - 2), bh);
      spans.push({ a: x, b: x + sw, s });
    }
    x += sw;
  }
  ctx.fillStyle = p.muted;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("0", x0, y + bh + 6);
  ctx.textAlign = "right";
  ctx.fillText(`${fmt(total)} mWh/day at the battery`, x0 + width, y + bh + 6);
  return (mx, my) => {
    if (my < y || my > y + bh) return null;
    const hit = spans.find((sp) => mx >= sp.a && mx < sp.b);
    if (!hit) return null;
    return { text: `${hit.s.label}: ${fmt(hit.s.value)} mWh/day (${pct(hit.s.value / total)})` };
  };
}

/**
 * Share of the usable window (floor to full) held at the end of an hour.
 * @param {SimResult} r
 * @param {number} idx
 * @returns {number}
 */
function usable(r, idx) {
  const span = 1 - r.limits.socMin;
  return span > 0 ? Math.min(1, Math.max(0, (r.soc[idx] - r.limits.socMin) / span)) : 0;
}

/**
 * Day x hour heatmap of the usable charge (floor = lightest, full =
 * darkest in light mode); downtime in the critical colour.
 * @param {HTMLCanvasElement} canvas
 * @param {SimResult} r
 * @returns {HitTest}
 */
export function drawHeatmap(canvas, r) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  const left = 34;
  const bottom = 20;
  const top = 4;
  const right = 6;
  const pw = w - left - right;
  const ph = h - top - bottom;
  const cw = pw / r.days;
  const ch = ph / 24;
  const lo = rgb(p.seqLo);
  const hi = rgb(p.seqHi);
  const crit = rgb(p.crit);
  const img = ctx.createImageData(Math.max(1, Math.round(pw)), Math.max(1, Math.round(ph)));
  const iw = img.width;
  const ih = img.height;
  for (let py = 0; py < ih; py++) {
    const hour = Math.min(23, Math.floor((py / ih) * 24));
    for (let px = 0; px < iw; px++) {
      const day = Math.min(r.days - 1, Math.floor((px / iw) * r.days));
      const idx = day * 24 + hour;
      const c = idx >= r.hours ? lo : r.down[idx] > 0.5 ? crit : mix(lo, hi, usable(r, idx));
      const o = (py * iw + px) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  // putImageData ignores the transform, so place it in device pixels.
  const tmp = document.createElement("canvas");
  tmp.width = iw;
  tmp.height = ih;
  /** @type {CanvasRenderingContext2D} */ (tmp.getContext("2d")).putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, left, top, pw, ph);
  ctx.fillStyle = p.muted;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const hr of [0, 6, 12, 18])
    ctx.fillText(`${String(hr).padStart(2, "0")}h`, left - 4, top + (hr + 0.5) * ch);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  let lastLabel = -Infinity;
  for (let d = 0; d < r.days; d++) {
    const date = new Date(r.startMs + d * 86400000);
    if (date.getUTCDate() !== 1) continue;
    const x = left + d * cw;
    ctx.fillStyle = p.axis;
    ctx.fillRect(x, top + ph, 1, 4);
    if (x - lastLabel > 26) {
      ctx.fillStyle = p.muted;
      ctx.fillText(MONTHS[date.getUTCMonth()], x + 2, top + ph + 5);
      lastLabel = x;
    }
  }
  return (mx, my) => {
    if (mx < left || mx > left + pw || my < top || my > top + ph) return null;
    const day = Math.min(r.days - 1, Math.floor((mx - left) / cw));
    const hour = Math.min(23, Math.floor((my - top) / ch));
    const idx = day * 24 + hour;
    if (idx >= r.hours) return null;
    const date = new Date(r.startMs + idx * 3600000);
    const when = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${String(hour).padStart(2, "0")}:00`;
    const state = r.down[idx] > 0 ? `, node down ${pct(r.down[idx])} of the hour` : "";
    return {
      text: `${when}: charge ${pct(r.soc[idx])} (${pct(usable(r, idx))} of the usable window)${state}`,
    };
  };
}

/**
 * Monthly stored harvest against delivered load, with downtime marks.
 * @param {HTMLCanvasElement} canvas
 * @param {SimResult} r
 * @returns {HitTest}
 */
export function drawMonthly(canvas, r) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  const months = r.months.map((m, i) => ({ ...m, i })).filter((m) => m.days > 0);
  const maxV = Math.max(
    1e-9,
    ...months.map((m) => Math.max(m.harvestWh, m.loadWh, m.offeredWh * 0)),
  );
  const yt = ticks(0, maxV * 1.1, 4);
  const top = 18;
  const bottom = 20;
  const left = 44;
  const right = 6;
  const ph = h - top - bottom;
  const pw = w - left - right;
  const yMax = yt[yt.length - 1] || maxV;
  const Y = (/** @type {number} */ v) => top + ph - (v / yMax) * ph;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of yt) {
    ctx.fillStyle = p.grid;
    ctx.fillRect(left, Math.round(Y(t)), pw, 1);
    ctx.fillStyle = p.muted;
    ctx.fillText(fmt(t), left - 4, Y(t));
  }
  ctx.save();
  ctx.translate(10, top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("Wh", 0, 0);
  ctx.restore();
  const slot = pw / months.length;
  const bw = Math.max(2, Math.min(18, slot / 2 - 3));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  months.forEach((m, k) => {
    const cx = left + slot * (k + 0.5);
    /** @type {Array<[number, string]>} */
    const bars = [
      [m.harvestWh, p.series[0]],
      [m.loadWh, p.series[1]],
    ];
    bars.forEach(([v, color], j) => {
      const x = cx + (j === 0 ? -bw - 1 : 1);
      const y = Y(v);
      ctx.fillStyle = color;
      roundTop(ctx, x, y, bw, top + ph - y, Math.min(4, bw / 2));
    });
    ctx.fillStyle = p.muted;
    ctx.fillText(MONTHS[m.i].slice(0, slot < 30 ? 1 : 3), cx, top + ph + 5);
    if (m.downtimeHours > 0.05) {
      ctx.fillStyle = p.crit;
      ctx.beginPath();
      ctx.moveTo(cx - 5, 2);
      ctx.lineTo(cx + 5, 2);
      ctx.lineTo(cx, 10);
      ctx.fill();
    }
  });
  ctx.fillStyle = p.axis;
  ctx.fillRect(left, top + ph, pw, 1);
  return (mx, my) => {
    if (mx < left || mx > left + pw || my > top + ph + 18) return null;
    const k = Math.min(months.length - 1, Math.floor((mx - left) / slot));
    const m = months[k];
    const down = m.downtimeHours > 0 ? `, down ${fmt(m.downtimeHours)} h` : ", no downtime";
    return {
      text: `${MONTHS[m.i]}: stored ${fmt(m.harvestWh)} Wh, delivered ${fmt(m.loadWh)} Wh, charger offered ${fmt(m.offeredWh)} Wh${down}`,
    };
  };
}

/**
 * Rectangle with rounded top corners (bars anchored to the baseline).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function roundTop(ctx, x, y, w, h, r) {
  if (h <= 0) return;
  const rr = Math.min(r, h, w / 2);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

/**
 * One week of hourly series.
 * @param {HTMLCanvasElement} canvas
 * @param {SimResult} r
 * @param {number} startDay
 * @param {"soc" | "flow"} kind
 * @returns {HitTest}
 */
export function drawWeek(canvas, r, startDay, kind) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  const h0 = startDay * 24;
  const n = Math.min(7 * 24, r.hours - h0);
  const top = 8;
  const bottom = 20;
  const left = 44;
  const right = 6;
  const pw = w - left - right;
  const ph = h - top - bottom;
  const X = (/** @type {number} */ i) => left + ((i + 0.5) / n) * pw;
  /** @type {Array<{data: Float32Array, color: string, label: string, scale: number}>} */
  let lines;
  let yMax;
  let unit;
  if (kind === "soc") {
    lines = [{ data: r.soc.subarray(h0, h0 + n), color: p.series[0], label: "charge", scale: 100 }];
    yMax = 100;
    unit = "%";
  } else {
    lines = [
      { data: r.chargeW.subarray(h0, h0 + n), color: p.series[0], label: "stored", scale: 1000 },
      { data: r.loadW.subarray(h0, h0 + n), color: p.series[1], label: "load", scale: 1000 },
    ];
    let m = 0;
    for (const l of lines) for (const v of l.data) m = Math.max(m, v * 1000);
    yMax = m > 0 ? m * 1.1 : 1;
    unit = "mW";
  }
  const yt = ticks(0, yMax, 4);
  const yTop = kind === "soc" ? 100 : yt[yt.length - 1];
  const Y = (/** @type {number} */ v) => top + ph - (v / yTop) * ph;
  // Downtime shading.
  ctx.fillStyle = p.crit;
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < n; i++)
    if (r.down[h0 + i] > 0) ctx.fillRect(left + (i / n) * pw, top, pw / n + 0.5, ph);
  ctx.globalAlpha = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of yt) {
    if (t > yTop + 1e-9) continue;
    ctx.fillStyle = p.grid;
    ctx.fillRect(left, Math.round(Y(t)), pw, 1);
    ctx.fillStyle = p.muted;
    ctx.fillText(`${fmt(t)}`, left - 4, Y(t));
  }
  ctx.save();
  ctx.translate(10, top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText(unit, 0, 0);
  ctx.restore();
  if (kind === "soc") {
    ctx.strokeStyle = p.crit;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, Y(r.limits.socMin * 100));
    ctx.lineTo(left + pw, Y(r.limits.socMin * 100));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  for (const l of lines) {
    ctx.strokeStyle = l.color;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const y = Y(l.data[i] * l.scale);
      if (i === 0) ctx.moveTo(X(i), y);
      else ctx.lineTo(X(i), y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = p.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let d = 0; d <= Math.floor(n / 24); d++) {
    const x = left + ((d * 24) / n) * pw;
    ctx.fillStyle = p.axis;
    ctx.fillRect(Math.round(x), top + ph, 1, 4);
    if (d * 24 < n) {
      const date = new Date(r.startMs + (h0 + d * 24) * 3600000);
      ctx.fillStyle = p.muted;
      ctx.fillText(`${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`, x + pw / 14, top + ph + 5);
    }
  }
  ctx.fillStyle = p.axis;
  ctx.fillRect(left, top + ph, pw, 1);
  return (mx) => {
    if (mx < left || mx > left + pw) return null;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((mx - left) / pw) * n)));
    const idx = h0 + i;
    const date = new Date(r.startMs + idx * 3600000);
    const when = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCHours()).padStart(2, "0")}:00`;
    const down = r.down[idx] > 0 ? `; node down ${pct(r.down[idx])} of the hour` : "";
    const text =
      kind === "soc"
        ? `${when}: charge ${pct(r.soc[idx])}${down}`
        : `${when}: stored ${fmt(r.chargeW[idx] * 1000)} mW, load ${fmt(r.loadW[idx] * 1000)} mW${down}`;
    return { text, x: X(i) };
  };
}

/**
 * Sizing chart: every grid point on log axes, the Pareto frontier and the
 * lowest-cost point.
 * @param {HTMLCanvasElement} canvas
 * @param {SizeResult} s
 * @param {{wp: number, mah: number}} current
 * @returns {HitTest}
 */
export function drawPareto(canvas, s, current) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  const top = 10;
  const bottom = 34;
  const left = 66;
  const right = 12;
  const pw = w - left - right;
  const ph = h - top - bottom;
  const xs = s.panelWp;
  const ys = s.batteryMah;
  const lx = (/** @type {number} */ v) => Math.log(v);
  const x0 = lx(xs[0]) - 0.15;
  const x1 = lx(xs[xs.length - 1]) + 0.15;
  const y0 = lx(ys[0]) - 0.15;
  const y1 = lx(ys[ys.length - 1]) + 0.15;
  const X = (/** @type {number} */ v) => left + ((lx(v) - x0) / (x1 - x0 || 1)) * pw;
  const Y = (/** @type {number} */ v) => top + ph - ((lx(v) - y0) / (y1 - y0 || 1)) * ph;
  ctx.fillStyle = p.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  xs.forEach((v, i) => {
    ctx.fillStyle = p.grid;
    ctx.fillRect(Math.round(X(v)), top, 1, ph);
    if (i % Math.ceil(xs.length / Math.max(2, Math.floor(pw / 48))) === 0) {
      ctx.fillStyle = p.muted;
      ctx.fillText(fmt(v), X(v), top + ph + 4);
    }
  });
  ctx.fillText("panel (Wp, log scale)", left + pw / 2, top + ph + 18);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ys.forEach((v, j) => {
    ctx.fillStyle = p.grid;
    ctx.fillRect(left, Math.round(Y(v)), pw, 1);
    if (j % Math.ceil(ys.length / Math.max(2, Math.floor(ph / 18))) === 0) {
      ctx.fillStyle = p.muted;
      ctx.fillText(fmt(v), left - 6, Y(v));
    }
  });
  ctx.save();
  ctx.translate(9, top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = p.muted;
  ctx.fillText("battery (mAh, log)", 0, 0);
  ctx.restore();
  /** @type {Array<{x: number, y: number, text: string}>} */
  const pts = [];
  xs.forEach((wp, i) =>
    ys.forEach((mah, j) => {
      const d = s.downtime[i][j];
      const x = X(wp);
      const y = Y(mah);
      const ok = d <= s.target && !s.peakLimited[j];
      ctx.lineWidth = 1.5;
      if (s.peakLimited[j]) {
        ctx.strokeStyle = p.muted;
        ctx.beginPath();
        ctx.moveTo(x - 3, y - 3);
        ctx.lineTo(x + 3, y + 3);
        ctx.moveTo(x + 3, y - 3);
        ctx.lineTo(x - 3, y + 3);
        ctx.stroke();
      } else if (ok) {
        ctx.fillStyle = p.series[0];
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.fill();
      } else {
        ctx.strokeStyle = p.muted;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
        ctx.stroke();
      }
      const status = s.peakLimited[j]
        ? `too small for the peak current (under ${fmt(s.minMahForPeak)} mAh)`
        : d === 0
          ? "no downtime"
          : `down ${fmt(d)} h/year`;
      pts.push({ x, y, text: `${fmt(wp)} Wp + ${fmt(mah)} mAh: ${status}` });
    }),
  );
  if (s.frontier.length > 0) {
    ctx.strokeStyle = p.series[1];
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.frontier.forEach((f, k) => {
      if (k === 0) ctx.moveTo(X(f.wp), Y(f.capacityMah));
      else ctx.lineTo(X(f.wp), Y(f.capacityMah));
    });
    ctx.stroke();
    for (const f of s.frontier) {
      ctx.fillStyle = p.series[1];
      ctx.strokeStyle = p.surface;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(f.wp), Y(f.capacityMah), 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
  }
  if (s.best) {
    const bx = X(s.best.wp);
    const by = Y(s.best.capacityMah);
    ctx.strokeStyle = p.fg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, 9, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = p.fg;
    ctx.textAlign = bx > left + pw * 0.7 ? "right" : "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("lowest cost", bx + (bx > left + pw * 0.7 ? -12 : 12), by - 6);
  }
  // Current design: a cross-hair marker if it lies inside the plotted range.
  if (current.wp > 0 && current.mah > 0) {
    const cx = X(current.wp);
    const cy = Y(current.mah);
    if (cx >= left && cx <= left + pw && cy >= top && cy <= top + ph) {
      ctx.strokeStyle = p.fg;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx - 5, cy - 5, 10, 10);
    }
  }
  return (mx, my) => {
    let best = null;
    let bd = 12 * 12;
    for (const pt of pts) {
      const d = (pt.x - mx) ** 2 + (pt.y - my) ** 2;
      if (d < bd) {
        bd = d;
        best = pt;
      }
    }
    return best ? { text: best.text, x: best.x, y: best.y } : null;
  };
}
