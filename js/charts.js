// Small SVG charts for the Progress page: a line over time and columns (plain or stacked). Pure: they return markup
// plus the data for the hover readout, which app.js wires up. One y-axis per chart, thin marks, recessive grid.
// Text in the SVG is escaped here; the readout is filled with textContent.

export const W = 340, H = 180;
const PAD = { l: 38, r: 12, t: 14, b: 24 };
export const COLORS = {
  series: '#3987e5',        // one series: blue
  Z1: '#5b6572', Z2: '#3987e5', Z3: '#199e70', Z4: '#e0a030', Z5: '#d95926', // heart-rate zones: easy to hard
  T1: '#d95926', T2: '#9085e9', T3: '#199e70', Other: '#5b6572', // tiers: the app's hues, stepped for the dark surface
  grid: '#2a313a', axis: '#3a434e', ink: '#8b97a6', surface: '#1a1f26',
};

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Round tick values that cover [lo, hi]: about `n` of them, steps of 1, 2, 2.5 or 5 × a power of ten.
// Counts (reps, sets, lb) never get fractional ticks.
export function niceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw));
  const start = Math.floor(lo / step) * step, out = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  if (out[out.length - 1] < hi) out.push(+(out[out.length - 1] + step).toFixed(10));
  return out;
}
// 950 · 1,200 · 12K
export const fmtNum = v => (Math.abs(v) >= 10000 ? `${+(v / 1000).toFixed(Math.abs(v) >= 1e5 ? 0 : 1)}K` : Math.round(v).toLocaleString('en-US'));
const fmtDay = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function frame(ticks, y, fmt) {
  return ticks.map(v => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}" stroke="${COLORS.grid}" stroke-width="1"/>
    <text x="${PAD.l - 6}" y="${y(v) + 4}" text-anchor="end" class="tick">${esc(fmt(v))}</text>`).join('');
}
// Three date labels along the bottom: first, middle, last.
function dateAxis(xs, ts) {
  if (!xs.length) return '';
  const idx = [...new Set([0, Math.floor((xs.length - 1) / 2), xs.length - 1])];
  return idx.map((i, k) => `<text x="${xs[i]}" y="${H - 6}" text-anchor="${k === 0 && idx.length > 1 ? 'start' : k === idx.length - 1 && idx.length > 1 ? 'end' : 'middle'}" class="tick">${esc(fmtDay(ts[i]))}</text>`).join('');
}

const svgOpen = (id, label) => `<svg viewBox="0 0 ${W} ${H}" class="chartsvg" data-chart="${esc(id)}" role="img" aria-label="${esc(label)}">`;
const crosshair = `<line class="xhair" x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" stroke="${COLORS.ink}" stroke-width="1" visibility="hidden"/>`;

// A line over time. points: [{ t, v, tip }] in time order (tip: the readout's lines). Returns { svg, hits }.
// `domain`: [lo, hi] to fix the y-axis (energy 1-5); otherwise it hugs the data with some room.
export function lineChart(id, label, points, { domain = null, fmt = fmtNum, unit = '' } = {}) {
  if (!points.length) return { svg: '', hits: [] };
  const vs = points.map(p => p.v);
  let lo = domain ? domain[0] : Math.min(...vs), hi = domain ? domain[1] : Math.max(...vs);
  if (!domain) { const pad = Math.max((hi - lo) * 0.15, hi * 0.03, 1); lo = Math.max(0, lo - pad); hi += pad; }
  const ticks = domain ? niceTicks(lo, hi, hi - lo <= 5 ? hi - lo : 4) : niceTicks(lo, hi);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const x = t => (t1 === t0 ? (PAD.l + W - PAD.r) / 2 : PAD.l + 6 + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r - 12));
  const y = v => PAD.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - PAD.t - PAD.b);
  const xs = points.map(p => x(p.t));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const dots = points.length <= 60 ? points.map((p, i) => `<circle cx="${xs[i].toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" fill="${COLORS.series}" stroke="${COLORS.surface}" stroke-width="2"/>`).join('') : '';
  const last = points[points.length - 1];
  const endLabel = `<text x="${Math.min(xs[xs.length - 1], W - PAD.r)}" y="${y(last.v) - 9}" text-anchor="end" class="endlabel">${esc(fmt(last.v))}${esc(unit)}</text>`;
  const svg = `${svgOpen(id, label)}${frame(ticks, y, fmt)}${crosshair}
    <path d="${path}" fill="none" stroke="${COLORS.series}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}${endLabel}
    <circle class="hdot" r="5" fill="${COLORS.series}" stroke="${COLORS.surface}" stroke-width="2" visibility="hidden"/>
    ${dateAxis(xs, points.map(p => p.t))}</svg>`;
  return { svg, hits: points.map((p, i) => ({ x: xs[i], y: y(p.v), tip: p.tip })) };
}

// Columns: bars [{ t, parts: [{ key, v }], tip }] (one part = a plain column). Stacked parts take COLORS[key] (or the
// series blue), with a 2px gap between segments. Columns are at most 24 wide; many columns get thin.
export function columnChart(id, label, bars, { fmt = fmtNum, max = null } = {}) {
  const totals = bars.map(b => b.parts.reduce((s, p) => s + Math.max(0, p.v), 0));
  if (!totals.some(v => v > 0)) return { svg: '', hits: [] };
  const top = max ?? Math.max(...totals, 1);
  const ticks = niceTicks(0, top);
  const y1 = ticks[ticks.length - 1];
  const y = v => PAD.t + (1 - v / y1) * (H - PAD.t - PAD.b);
  const plotW = W - PAD.l - PAD.r, band = plotW / bars.length;
  const bw = Math.max(1.5, Math.min(24, band * 0.7));
  const xs = bars.map((_, i) => PAD.l + band * (i + 0.5));
  const stacked = bars.some(b => b.parts.length > 1);
  const cols = bars.map((b, i) => {
    let base = 0;
    const segs = b.parts.filter(p => p.v > 0);
    return segs.map((p, k) => {
      const yTop = y(base + p.v), yBot = y(base);
      base += p.v;
      const gap = stacked && k > 0 ? 2 : 0;
      const h = Math.max(0, yBot - yTop - gap);
      const color = COLORS[p.key] ?? COLORS.series;
      const r = k === segs.length - 1 ? Math.min(4, bw / 2, h) : 0; // rounded data end, square at the baseline
      const x0 = xs[i] - bw / 2;
      if (!r) return `<rect x="${x0.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"/>`;
      const yb = yTop + h;
      return `<path d="M${x0.toFixed(1)},${yb.toFixed(1)}V${(yTop + r).toFixed(1)}q0,-${r} ${r},-${r}h${(bw - 2 * r).toFixed(1)}q${r},0 ${r},${r}V${yb.toFixed(1)}Z" fill="${color}"/>`;
    }).join('');
  }).join('');
  const svg = `${svgOpen(id, label)}${frame(ticks, y, fmt)}
    <line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0)}" y2="${y(0)}" stroke="${COLORS.axis}" stroke-width="1"/>
    <rect class="hband" x="0" y="${PAD.t}" width="${Math.max(bw + 6, 8)}" height="${H - PAD.t - PAD.b}" fill="#ffffff" opacity="0.06" visibility="hidden"/>
    ${cols}${dateAxis(xs, bars.map(b => b.t))}</svg>`;
  return { svg, hits: bars.map((b, i) => ({ x: xs[i], y: y(totals[i]), w: Math.max(bw + 6, 8), tip: b.tip })) };
}

// The hit nearest an x (viewBox units), or null.
export function nearest(hits, x) {
  let best = null, d = Infinity;
  for (const h of hits) { const e = Math.abs(h.x - x); if (e < d) { d = e; best = h; } }
  return best;
}
