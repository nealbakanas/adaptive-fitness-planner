// What you like, learned from what you do. Pure: no DOM, no storage. Every swap, hand-added exercise, removal and workout
// you finished as suggested is a small vote for or against an exercise; votes fade with a 6-week half-life. The result
// breaks ties in automatic picks and never overrides a goal that names an exercise.
//
// Swaps are read from `session.blocks[].swaps` ({ type: 'exercise' | 'add', from, to, reason, at }); removals from
// `session.removed[]` ({ exerciseId, tier, at, wasSuggested }). You can also say it outright: `exercise.pref` is
// 'fav' (a standing +2) or 'never' (left out of every automatic pick).

const DAY = 864e5;
export const HALF_LIFE_DAYS = 42;
export const CLAMP = 3;
export const COOL_OFF = -2;        // a score at or below this keeps an exercise out of automatic picks until it fades
export const PAIN_SKIP_DAYS = 14;  // after a swap away for pain
export const USUAL_AFTER = 2;      // swaps of X to the same Y before Y is "your usual" for X

// Reasons that say the swap was about today, not about the exercise.
const TEMPORARY = new Set(['Equipment busy', 'Time']);

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Every vote: { id, points, at, kind }. `kind` for readers of the explanation: to, add, kept, away, pain, removed.
export function tasteEvents(state) {
  if (state.settings?.learnTaste === false) return [];
  const since = state.settings?.tasteSince ?? 0;
  const setsByBlock = new Map();
  for (const s of state.sets) {
    if (!s.blockId) continue;
    const g = setsByBlock.get(s.blockId) ?? { n: 0, open: 0 };
    if (!s.warmup) { g.n++; if (!s.done) g.open++; }
    setsByBlock.set(s.blockId, g);
  }
  const out = [];
  const add = (id, points, at, kind) => { if (id && at >= since && points) out.push({ id, points, at, kind }); };
  for (const sess of state.sessions) {
    for (const b of sess.blocks || []) {
      for (const w of b.swaps || []) {
        if (w.type === 'add') add(w.to, 1, w.at, 'add');
        else if (w.type === 'exercise') {
          if (TEMPORARY.has(w.reason)) continue;
          add(w.to, 1.5, w.at, 'to');
          if (w.reason === 'Pain / niggle') add(w.from, -2, w.at, 'pain');
          else add(w.from, -1.5, w.at, 'away');
        }
      }
      // Suggested, never touched, and every set logged: a small vote for what you were given.
      const g = setsByBlock.get(b.id);
      const asSuggested = sess.source === 'suggested' || sess.source === 'focus';
      if (asSuggested && sess.status === 'done' && !(b.swaps || []).length && g && g.n > 0 && g.open === 0) add(b.exerciseId, 0.5, sess.firstSetAt ?? sess.checkinAt ?? 0, 'kept');
    }
    for (const r of sess.removed || []) if (r.wasSuggested) add(r.exerciseId, -1, r.at, 'removed');
  }
  return out;
}

// The taste picture at time `t`:
//   score    exerciseId -> number (votes decayed and clamped to ±3, plus 2 for a favorite)
//   skipUntil exerciseId -> time, after a swap away for pain
//   replaced  `${from}|${to}|${tier}` -> times swapped (for "your usual")
//   never    Set of exercise ids marked Never suggest
export function taste(state, t = Date.now()) {
  const raw = new Map(), skipUntil = new Map(), replaced = new Map(), never = new Set(), favs = new Set();
  for (const e of state.exercises) {
    if (e.pref === 'never') never.add(e.id);
    else if (e.pref === 'fav') favs.add(e.id);
  }
  for (const ev of tasteEvents(state)) {
    if (ev.at > t) continue;
    raw.set(ev.id, (raw.get(ev.id) ?? 0) + ev.points * 0.5 ** ((t - ev.at) / (HALF_LIFE_DAYS * DAY)));
    if (ev.kind === 'pain') skipUntil.set(ev.id, Math.max(skipUntil.get(ev.id) ?? 0, ev.at + PAIN_SKIP_DAYS * DAY));
  }
  if (state.settings?.learnTaste !== false) {
    const since = state.settings?.tasteSince ?? 0;
    for (const sess of state.sessions) for (const b of sess.blocks || []) for (const w of b.swaps || []) {
      if (w.type !== 'exercise' || TEMPORARY.has(w.reason) || w.at < since || w.at > t) continue;
      const k = `${w.from}|${w.to}|${b.tier}`;
      replaced.set(k, (replaced.get(k) ?? 0) + 1);
    }
  }
  const score = new Map();
  for (const [id, v] of raw) score.set(id, clamp(v, -CLAMP, CLAMP));
  for (const id of favs) score.set(id, (score.get(id) ?? 0) + 2);
  return { score, skipUntil, replaced, never, t };
}

export const tasteOf = (tr, id) => tr.score.get(id) ?? 0;

// Left out of automatic picks: marked Never suggest, skipped after a pain swap, or scored at or below the cool-off.
export const isExcluded = (tr, id, t = tr.t) => tr.never.has(id) || (tr.skipUntil.get(id) ?? 0) > t || tasteOf(tr, id) <= COOL_OFF;

// The exercise you usually swap `fromId` for at this tier (at least twice, the most often), among `candidates` (ids), or null.
export function usualReplacement(tr, fromId, tier, candidates) {
  let best = null, n = 0;
  for (const id of candidates) {
    const c = tr.replaced.get(`${fromId}|${id}|${tier}`) ?? 0;
    if (c >= USUAL_AFTER && c > n) { best = id; n = c; }
  }
  return best ? { id: best, count: n } : null;
}

// For the swap sheet: the exercises you've swapped `fromId` to, most often first: [{ id, count }].
export function replacements(tr, fromId, tier) {
  const out = [];
  for (const [k, count] of tr.replaced) {
    const [from, to, t] = k.split('|');
    if (from === fromId && t === tier) out.push({ id: to, count });
  }
  return out.sort((a, b) => b.count - a.count);
}
