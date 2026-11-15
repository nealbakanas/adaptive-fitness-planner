// How the app is used, so cleanups and the roadmap follow what you actually do: screens (views and time), actions tapped,
// sheets closed without doing anything, and errors. A daily roll-up kept on this device under its own key, never in the
// training data, never synced, 180 days at most. Settings → Usage shows it and copies a summary.
//   log = { v: 1, days: { 'YYYY-MM-DD': { s: { screen: [views, ms] }, a: { action: n }, b: { sheet: [opened, backedOut] }, e: { error: n } } } }

export const KEEP_DAYS = 180;
export const MAX_SPAN = 30 * 60e3; // a screen left open longer than this (overnight) counts this much

const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const empty = () => ({ v: 1, days: {} });
const today = (log, t) => (log.days[dayKey(t)] ??= { s: {}, a: {}, b: {}, e: {} });

// ---------- recording (pure: each takes the log and returns nothing) ----------

export function addScreen(log, name, ms, view, t = Date.now()) {
  if (!name) return;
  const d = today(log, t), x = (d.s[name] ??= [0, 0]);
  if (view) x[0]++;
  x[1] += Math.max(0, Math.min(MAX_SPAN, Math.round(ms)));
}
export function addAction(log, name, t = Date.now()) { if (name) { const d = today(log, t); d.a[name] = (d.a[name] ?? 0) + 1; } }
export function addSheet(log, type, backedOut, t = Date.now()) {
  if (!type) return;
  const x = (today(log, t).b[type] ??= [0, 0]);
  x[0]++; if (backedOut) x[1]++;
}
export function addError(log, msg, t = Date.now()) {
  const k = String(msg || 'error').replace(/\s+/g, ' ').slice(0, 100);
  const d = today(log, t); d.e[k] = (d.e[k] ?? 0) + 1;
}
// Drops days older than KEEP_DAYS.
export function prune(log, t = Date.now()) {
  const cut = dayKey(t - KEEP_DAYS * 864e5);
  for (const k of Object.keys(log.days)) if (k < cut) delete log.days[k];
}

// ---------- the summary ----------

// Over the last `days` days: { days (with any use), ms, screens: [{ name, views, ms }], actions: [{ name, n }],
// backedOut: [{ name, opened, out }], unusedScreens, unusedActions, errors: [{ msg, n }] }. `known`: { screens, actions }
// the app has, for what's never used.
export function summarize(log, days = 30, known = { screens: [], actions: [] }, t = Date.now()) {
  const from = dayKey(t - (days - 1) * 864e5);
  const S = new Map(), A = new Map(), B = new Map(), E = new Map();
  let used = 0, ms = 0;
  for (const [k, d] of Object.entries(log.days)) {
    if (k < from || k > dayKey(t)) continue;
    used++;
    for (const [n, [v, m]] of Object.entries(d.s)) { const x = S.get(n) ?? { name: n, views: 0, ms: 0 }; x.views += v; x.ms += m; ms += m; S.set(n, x); }
    for (const [n, c] of Object.entries(d.a)) A.set(n, (A.get(n) ?? 0) + c);
    for (const [n, [o, b]] of Object.entries(d.b)) { const x = B.get(n) ?? { name: n, opened: 0, out: 0 }; x.opened += o; x.out += b; B.set(n, x); }
    for (const [n, c] of Object.entries(d.e)) E.set(n, (E.get(n) ?? 0) + c);
  }
  return {
    days: used, ms,
    screens: [...S.values()].sort((a, b) => b.ms - a.ms || b.views - a.views),
    actions: [...A].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
    backedOut: [...B.values()].filter(x => x.out).sort((a, b) => b.out - a.out || b.opened - a.opened),
    unusedScreens: known.screens.filter(n => !S.has(n)),
    unusedActions: known.actions.filter(n => !A.has(n)),
    errors: [...E].map(([msg, n]) => ({ msg, n })).sort((a, b) => b.n - a.n),
  };
}

const mins = ms => (ms >= 3600e3 ? `${Math.round(ms / 360e3) / 10} h` : `${Math.round(ms / 60e3)} min`);
export { mins as fmtTime };
// The summary as text, to paste to Claude.
export function summaryText(sum, days) {
  const lines = [`App usage, last ${days} days: used on ${sum.days} day${sum.days === 1 ? '' : 's'}, ${mins(sum.ms)} in all.`];
  if (sum.screens.length) lines.push('', 'Screens (time, views):', ...sum.screens.slice(0, 25).map(x => `- ${x.name}: ${mins(x.ms)}, ${x.views}`));
  if (sum.actions.length) lines.push('', 'Actions (taps):', sum.actions.slice(0, 40).map(x => `${x.name} ${x.n}`).join(', '));
  if (sum.backedOut.length) lines.push('', 'Sheets closed without doing anything (closed / opened):', sum.backedOut.slice(0, 15).map(x => `${x.name} ${x.out}/${x.opened}`).join(', '));
  if (sum.unusedScreens.length) lines.push('', `Screens never opened: ${sum.unusedScreens.join(', ')}`);
  if (sum.unusedActions.length) lines.push('', `Actions never used (${sum.unusedActions.length}): ${sum.unusedActions.join(', ')}`);
  if (sum.errors.length) lines.push('', 'Errors:', ...sum.errors.slice(0, 10).map(x => `- ${x.msg} (${x.n}×)`));
  return lines.join('\n');
}

// ---------- the live recorder (storage and timing) ----------

let key = null, log = empty(), cur = null, curAt = 0, sheet = null, sheetActs = 0, paused = false, dirty = false, on = () => true;
export function init(storageKey, isOn = () => true) {
  key = storageKey; on = isOn;
  try { log = JSON.parse(localStorage.getItem(key)) ?? empty(); if (log.v !== 1 || !log.days) log = empty(); } catch { log = empty(); }
  prune(log);
}
export const get = () => log;
export function flush() {
  if (!dirty || !key) return;
  try { localStorage.setItem(key, JSON.stringify(log)); dirty = false; } catch { /* full: usage isn't worth failing for */ }
}
setInterval(flush, 15e3);
const settle = (t = Date.now()) => { if (cur && !paused && on()) { addScreen(log, cur, t - curAt, false, t); dirty = true; } curAt = t; };
// The screen on show now (called after each render): a view when it changed, its time so far either way.
export function screen(name, t = Date.now()) {
  if (!on()) { cur = name; curAt = t; return; }
  settle(t);
  if (name !== cur) { cur = name; addScreen(log, name, 0, true, t); dirty = true; }
}
// A tap. `quiet` ones (closing a sheet, Yes and No, moving between tabs) aren't counted as features, but anything other
// than closing or saying no still means a sheet wasn't backed out of.
export function action(name, quiet = false) {
  if (!on() || !name) return;
  if (!quiet) { addAction(log, name); dirty = true; }
  if (sheet && name !== 'sheetClose' && name !== 'confirmNo') sheetActs++;
}
// The sheet on show (null when none): one closed with no action taken in it counts as backed out of.
export function sheetShown(type) {
  if (type === sheet) return;
  if (sheet && on()) { addSheet(log, sheet, sheetActs === 0); dirty = true; }
  sheet = type; sheetActs = 0;
}
export function error(msg) { if (on()) { addError(log, msg); dirty = true; } }
export function pause() { settle(); paused = true; flush(); }
export function resume() { paused = false; curAt = Date.now(); }
export function clear() { log = empty(); dirty = true; flush(); }
