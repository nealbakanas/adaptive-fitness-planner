// How long you take, learned from when you log sets. Pure: no DOM, no storage. Two numbers feed the time estimates
// (js/logic.js blockMinutes): minutes per set for each exercise at a tier, and the changeover between exercises at each
// location. Wherever the data is thin the estimate keeps the fixed guesses (scheme minutes, WARMUP, settings.changeover).
//
// Timing comes from `set.loggedAt` only (check-in time says nothing: people check in long before they start). Many sets
// are logged in bursts after the fact, so the gaps are cleaned first: a gap under 20 seconds is a burst, one over
// 15 minutes is a break, and a workout where more than 40% of the gaps were either teaches nothing.

const MIN = 6e4;
export const WINDOW_WEEKS = 8;
export const BURST_SEC = 20;
export const BREAK_MIN = 15;
export const MAX_DROPPED = 0.4;
export const MIN_SESSIONS = 3;   // sessions with an exercise at a tier before its per-set time is used
export const MIN_CHANGEOVERS = 5; // changeover samples at a location before its changeover is used

const median = xs => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// A block's group: itself, or the block it's paired with (supersets and giant sets).
const groupOf = (blocks, b) => (b.pairOf && blocks.some(x => x.id === b.pairOf) ? b.pairOf : b.id);
export const pacedKey = (exerciseId, tier, paired) => `${exerciseId}|${tier}|${paired ? 'pair' : 'solo'}`;

// One workout's timing. Returns { skipped, bursty, gaps, kept, perSet: [{ key, minutes }], warm: [{ key, minutes }],
// changeovers: [minutes] } (minutes are per set, per warm-up, per changeover). `sets`: the workout's logged sets.
export function sessionPace(sess, sets, warmDefault = {}) {
  const blocks = (sess.blocks || []).filter(b => b.tier !== 'JUMP'); // jumps are done during the warm-up
  const byId = new Map(blocks.map(b => [b.id, b]));
  const mine = sets.filter(s => s.done && s.loggedAt && byId.has(s.blockId));
  const work = mine.filter(s => !s.warmup).sort((a, b) => a.loggedAt - b.loggedAt);
  const out = { skipped: true, bursty: false, gaps: 0, kept: 0, perSet: [], warm: [], changeovers: [] };
  if (work.length < 2) return out;
  const gaps = [];
  let bursts = 0;
  for (let i = 1; i < work.length; i++) {
    const a = work[i - 1], b = work[i], g = (b.loggedAt - a.loggedAt) / MIN;
    const ok = g * 60 >= BURST_SEC && g <= BREAK_MIN;
    if (g * 60 < BURST_SEC) bursts++;
    gaps.push({ a, b, g, ok });
  }
  out.gaps = gaps.length;
  out.kept = gaps.filter(x => x.ok).length;
  out.bursty = bursts / gaps.length > 0.5;
  if (gaps.length - out.kept > MAX_DROPPED * gaps.length) return out;
  out.skipped = false;

  // Warm-up, from logged warm-up sets: the first of them to the block's first working set.
  const warmOf = new Map();
  for (const b of blocks) {
    const w = mine.filter(s => s.warmup && s.blockId === b.id).map(s => s.loggedAt);
    const first = work.find(s => s.blockId === b.id);
    if (!w.length || !first) continue;
    const g = (first.loggedAt - Math.min(...w)) / MIN;
    if (g * 60 >= BURST_SEC && g <= BREAK_MIN) { warmOf.set(b.id, g); out.warm.push({ key: `${b.exerciseId}|${b.tier}`, minutes: g }); }
  }

  const grp = new Map(blocks.map(b => [b.id, groupOf(blocks, b)]));
  const members = new Map();
  for (const b of blocks) members.set(grp.get(b.id), [...(members.get(grp.get(b.id)) || []), b]);
  const firstOf = new Map(), lastOf = new Map();
  for (const w of work) { const g = grp.get(w.blockId); if (!firstOf.has(g)) firstOf.set(g, w); lastOf.set(g, w); }
  const inGroup = new Map(); // group -> kept gaps between its own sets
  const moves = [];
  for (const x of gaps) {
    const ga = grp.get(x.a.blockId), gb = grp.get(x.b.blockId);
    if (!x.ok) continue;
    if (ga === gb) {
      const m = members.get(ga);
      if (m.length === 1) out.perSet.push({ key: pacedKey(m[0].exerciseId, m[0].tier, false), minutes: x.g, group: ga });
      else inGroup.set(ga, [...(inGroup.get(ga) || []), x.g]);
    } else if (x.a === lastOf.get(ga) && x.b === firstOf.get(gb)) moves.push({ x, ga });
  }
  // From the last set of one exercise to the first of the next, less the next one's warm-up (logged, else the usual guess)
  // and the last set's own share (each set's time already counts its rest, the last one's too).
  for (const { x, ga } of moves) {
    const step = median(inGroup.get(ga) ?? out.perSet.filter(p => p.group === ga).map(p => p.minutes));
    if (step == null) continue;
    const nb = byId.get(x.b.blockId);
    const warm = warmOf.get(nb.id) ?? warmDefault[nb.tier] ?? 0;
    const c = x.g - warm - step;
    if (c >= 0) out.changeovers.push(c); // shorter than that: the warm-up or the sets weren't logged as done, so it says nothing
  }
  // A superset is timed as one group, first set to last, and split evenly between its blocks.
  for (const [g, gs] of inGroup) {
    const m = members.get(g);
    const n = work.filter(s => grp.get(s.blockId) === g).length;
    const total = (gs.reduce((t, x) => t + x, 0) / gs.length) * n;
    for (const b of m) {
      const k = work.filter(s => s.blockId === b.id).length;
      if (k) out.perSet.push({ key: pacedKey(b.exerciseId, b.tier, true), minutes: total / m.length / k });
    }
  }
  return out;
}

// Every finished workout in the window, timed: [{ session, ...sessionPace }], oldest first.
export function paceSamples(state, t = Date.now(), warmDefault = {}) {
  if (state.settings?.learnPace === false) return [];
  const since = Math.max(state.settings?.paceSince ?? 0, t - WINDOW_WEEKS * 7 * 864e5);
  const bySession = new Map();
  for (const s of state.sets) if (s.sessionId) bySession.set(s.sessionId, [...(bySession.get(s.sessionId) || []), s]);
  return state.sessions
    .filter(s => s.status === 'done' && s.source !== 'imported' && (s.firstSetAt ?? 0) >= since && s.firstSetAt <= t)
    .sort((a, b) => a.firstSetAt - b.firstSetAt)
    .map(s => ({ session: s, ...sessionPace(s, bySession.get(s.id) || [], warmDefault) }));
}

// The learned numbers:
//   perSet  key (pacedKey) -> { minutes, sessions }, only with MIN_SESSIONS or more
//   warm    `${exerciseId}|${tier}` -> minutes, from logged warm-up sets
//   change  locationId -> { minutes, samples, sessions }, only with MIN_CHANGEOVERS or more
//   all     every location's changeover, thin or not (for Settings)
//   bursty  the last finished workout was mostly logged in bursts
export function pace(state, t = Date.now(), warmDefault = {}) {
  const samples = paceSamples(state, t, warmDefault);
  const per = new Map(), warm = new Map(), change = new Map();
  for (const s of samples) {
    if (s.skipped) continue;
    for (const x of s.perSet) {
      const e = per.get(x.key) ?? { xs: [], sessions: new Set() };
      e.xs.push(x.minutes); e.sessions.add(s.session.id); per.set(x.key, e);
    }
    for (const x of s.warm) warm.set(x.key, [...(warm.get(x.key) || []), x.minutes]);
    const loc = s.session.locationId;
    if (loc && s.changeovers.length) {
      const e = change.get(loc) ?? { xs: [], sessions: new Set() };
      e.xs.push(...s.changeovers); e.sessions.add(s.session.id); change.set(loc, e);
    }
  }
  const out = { perSet: new Map(), warm: new Map(), change: new Map(), all: new Map(), bursty: !!samples.at(-1)?.bursty && samples.at(-1).skipped, used: samples.filter(s => !s.skipped).length };
  for (const [k, e] of per) if (e.sessions.size >= MIN_SESSIONS) out.perSet.set(k, { minutes: median(e.xs), sessions: e.sessions.size });
  for (const [k, xs] of warm) out.warm.set(k, median(xs));
  for (const [loc, e] of change) {
    const v = { minutes: median(e.xs), samples: e.xs.length, sessions: e.sessions.size };
    out.all.set(loc, v);
    if (e.xs.length >= MIN_CHANGEOVERS) out.change.set(loc, v);
  }
  return out;
}
