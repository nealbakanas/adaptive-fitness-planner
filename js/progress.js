// The numbers behind the Progress page (History → Progress). Pure: no DOM, no storage. Everything takes a time
// window [from, to) so one range filter scopes every chart.
import * as L from './logic.js';
import * as Mo from './morning.js';

const DAY = 864e5;

export const RANGES = [['4w', '4 wk', 28], ['12w', '12 wk', 84], ['6m', '6 mo', 182], ['1y', '1 yr', 365], ['all', 'All', null]];
// [from, to) for a range key, ending today. 'all' starts at the first logged set.
export function rangeBounds(state, key, now = Date.now()) {
  const to = L.startOfDay(now) + DAY;
  const days = RANGES.find(r => r[0] === key)?.[2];
  if (days) return { from: to - days * DAY, to, days };
  const first = Math.min(to - DAY, ...state.sets.filter(s => s.done && s.loggedAt).map(s => s.loggedAt));
  const from = L.startOfDay(first);
  return { from, to, days: Math.max(1, Math.round((to - from) / DAY)) };
}

const working = (state, from, to) => state.sets.filter(s => s.done && !s.warmup && s.loggedAt >= from && s.loggedAt < to);
const num = v => (v === '' || v == null ? null : Number(v));

// Volume of a set: total load × reps (bodyweight included for weighted bodyweight lifts), loaded lifts only.
export function setVolume(state, s) {
  const ex = L.byId(state.exercises, s.exerciseId);
  if (ex?.metric !== 'load_reps' || !(num(s.reps) > 0)) return 0;
  return (L.setTotalLoad(state, s) || 0) * num(s.reps);
}

// Each workout with a set done in the window, oldest first: { id, t, day, volume, reps, sets }.
export function workouts(state, from, to) {
  const by = new Map();
  for (const s of working(state, from, to)) {
    const w = by.get(s.sessionId) ?? { id: s.sessionId, t: s.loggedAt, day: L.dayKey(s.loggedAt), volume: 0, reps: 0, sets: 0 };
    w.t = Math.min(w.t, s.loggedAt);
    w.volume += setVolume(state, s);
    if (num(s.reps) > 0) w.reps += num(s.reps);
    w.sets++;
    by.set(s.sessionId, w);
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

// Loaded lifts you have an estimated max for, most logged first: [{ id, name, count }].
export function liftOptions(state) {
  const n = new Map();
  for (const s of state.sets) if (s.done && !s.warmup && L.setE1rm(state, s)) n.set(s.exerciseId, (n.get(s.exerciseId) ?? 0) + 1);
  return [...n].map(([id, count]) => ({ id, name: L.byId(state.exercises, id)?.name ?? '?', count }))
    .filter(x => L.byId(state.exercises, x.id)?.metric === 'load_reps').sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Best estimated 1RM per day for one lift (sets of up to EST_MAX_REP_CAP reps): [{ t, day, v, load, reps }].
export function e1rmSeries(state, exerciseId, from, to) {
  const by = new Map();
  for (const s of working(state, from, to)) {
    if (s.exerciseId !== exerciseId || !(num(s.reps) >= 1) || num(s.reps) > L.EST_MAX_REP_CAP) continue;
    const v = L.setE1rm(state, s);
    if (!v) continue;
    const day = L.dayKey(s.loggedAt), cur = by.get(day);
    if (!cur || v > cur.v) by.set(day, { t: L.startOfDay(s.loggedAt) + DAY / 2, day, v, load: num(s.load) ?? 0, reps: num(s.reps) });
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

// Energy each day (1-5): the morning check when there is one, else the last check-in that day. [{ t, day, v, source }].
export function energySeries(state, from, to) {
  const by = new Map();
  for (const s of [...state.sessions].sort((a, b) => (a.checkinAt ?? 0) - (b.checkinAt ?? 0))) {
    if (s.source === 'imported' || !s.checkinAt || s.checkinAt < from || s.checkinAt >= to || !s.fatigue) continue;
    if (!state.sets.some(x => x.sessionId === s.id && x.done)) continue; // a check-in you didn't train after says little
    by.set(L.dayKey(s.checkinAt), { t: L.startOfDay(s.checkinAt) + DAY / 2, day: L.dayKey(s.checkinAt), v: 6 - s.fatigue, source: 'check-in' });
  }
  for (const e of Mo.morningOf(state).log) {
    const t = new Date(`${e.day}T12:00`).getTime();
    if (e.energy == null || t < from || t >= to) continue;
    by.set(e.day, { t, day: e.day, v: e.energy, source: 'morning' });
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

// Working sets by tier group: T1, T2, T3, Other (technique, jumps, conditioning).
export const tierGroup = tier => (tier === 'T1' || tier === 'T2' || tier === 'T3' ? tier : 'Other');

// Week by week: { start, sets: { T1, T2, T3, Other }, filled, quota } for every week overlapping the window.
export function weekly(state, from, to) {
  const out = [];
  for (let w = L.weekBounds(state, from).start; w < to; w = L.weekBounds(state, w + 8 * DAY).start) {
    const { start, end } = L.weekBounds(state, w + 3600e3);
    const sets = { T1: 0, T2: 0, T3: 0, Other: 0 };
    for (const s of working(state, Math.max(start, from), Math.min(end, to))) sets[tierGroup(s.tier)]++;
    const c = L.creditWeek(state, start + 3600e3);
    let filled = 0, quota = 0;
    for (const sl of state.slots) if (L.counted(state, sl)) { filled += Math.min(c.slots.get(sl.id)?.filled ?? 0, sl.quota); quota += sl.quota; }
    out.push({ start, end, sets, filled, quota });
  }
  return out;
}

// Per-week averages for the window, for the tiles: { workouts, volume, reps, energy }.
export function summary(state, from, to) {
  const weeks = Math.max(1, (to - from) / (7 * DAY));
  const ws = workouts(state, from, to);
  const en = energySeries(state, from, to);
  return {
    workouts: ws.length / weeks,
    volume: ws.reduce((x, w) => x + w.volume, 0) / weeks,
    reps: ws.reduce((x, w) => x + w.reps, 0) / weeks,
    energy: en.length ? en.reduce((x, e) => x + e.v, 0) / en.length : null,
  };
}

// Change in a lift's best estimated max across the window: { first, last, best, delta } or null with under 2 days.
export function liftChange(series) {
  if (series.length < 2) return null;
  const first = series[0].v, last = series[series.length - 1].v;
  return { first, last, best: Math.max(...series.map(x => x.v)), delta: last - first };
}

// One exercise, session by session in the window: { t, volume, reps, sets, hold (longest, s), jump (best) }.
export function exerciseSessions(state, exerciseId, from, to) {
  const by = new Map();
  for (const s of working(state, from, to)) {
    if (s.exerciseId !== exerciseId) continue;
    const w = by.get(s.sessionId) ?? { t: s.loggedAt, volume: 0, reps: 0, sets: 0, hold: 0, jump: 0 };
    w.t = Math.min(w.t, s.loggedAt);
    w.volume += setVolume(state, s);
    if (num(s.reps) > 0) w.reps += num(s.reps);
    w.hold = Math.max(w.hold, num(s.time) || 0);
    w.jump = Math.max(w.jump, num(s.jump) || 0);
    w.sets++;
    by.set(s.sessionId, w);
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}
