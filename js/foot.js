// Foot strength: daily rehab and prehab for the left big toe (bunion, old turf toe). Seven no-equipment exercises done
// barefoot, both feet, the left with an optional extra set. Pure: no DOM, no storage; mobility.js logs it like any routine.
//   Exercises carry `rows` (what each set is, per foot: [{ label, reps, hold, holdMax, repsMax }]), `sides` (log left and
//   right apart), `extraLeft` (an optional extra left set), `levels` (easier to harder versions), `rate` (a 1-5 control
//   rating per session). A logged item keeps its `level` and `control`; a set its `side` ('L' or 'R') and `label`.
import { loggedItems, sidedSets } from './mobility.js';
export { sidedSets };

export const ROUTINE_ID = 'mobr-foot';
export const WEEKLY = 5;                 // days a week with the whole routine done
export const PAIN_PART = 'Left big toe'; // in the morning check
export const PAIN_LIMIT = 3;             // over this two mornings running: a warning
export const CONTROL_READY = 4;          // a level is mastered after 3 sessions rated this or better
export const BALANCE_READY = 45;         // seconds on each foot, every set
export const CALF_LOAD_AT = 20;          // clean reps on the left before adding load
export const CALF_GAP = 3;               // left behind right by more than this: flagged

const DAY = 864e5;
const fx = (id, name, parts, def) => ({
  id, name, parts, sets: 1, reps: null, repsMax: null, hold: null, holdMax: null, perSide: true, tempo: '', restSec: 15,
  sides: true, extraLeft: true, levels: null, rate: false, track: { reps: false, hold: false, load: false, extra: '' },
  cues: '', video: '', notes: '', archived: false, ...def,
});

export const footExercises = () => [
  fx('foot-toe-mobility', 'Big toe mobility', ['Feet & toes'], {
    dose: 'Circles 30s each way, traction 3 × 10s · per foot',
    rows: [{ label: 'Circles ↻', hold: 30 }, { label: 'Circles ↺', hold: 30 }, { label: 'Traction × 3', hold: 10 }], hold: 30, track: { hold: true }, rate: true,
    cues: 'Hold the big toe at its base and circle it slowly, as big as is comfortable. Traction: pull the toe gently straight out from the joint, 10 seconds, three times.',
    video: 'big toe joint mobilization circles traction',
  }),
  fx('foot-toe-yoga', 'Toe yoga', ['Feet & toes'], {
    dose: '10 each way · per foot',
    rows: [{ label: 'Big toe up', reps: 10 }, { label: 'Others up', reps: 10 }], reps: 10, track: { reps: true }, rate: true,
    levels: ['Hand-assisted', 'Unassisted', 'Standing'],
    cues: 'Seated, foot flat. Lift the big toe while the other four press down; then press the big toe down and lift the other four. Hold the others down with a hand if they follow.',
    video: 'toe yoga exercise big toe',
  }),
  fx('foot-toe-abduction', 'Big toe abduction', ['Feet & toes'], {
    dose: '10 × 5s holds · per foot',
    rows: [{ label: '5s holds', reps: 10, hold: 5 }], reps: 10, hold: 5, track: { reps: true, hold: true }, rate: true,
    levels: ['Hand-assisted', 'Unassisted', 'Standing'],
    cues: 'Spread the big toe away from the second toe without lifting it, hold 5 seconds. Guide it with a finger to start. Small movement; that’s normal.',
    video: 'big toe abduction exercise bunion',
  }),
  fx('foot-short-foot', 'Short foot (arch doming)', ['Feet & toes'], {
    dose: '10 × 5–10s holds · per foot',
    rows: [{ label: 'Holds', reps: 10, hold: 5, holdMax: 10 }], reps: 10, hold: 5, holdMax: 10, track: { reps: true, hold: true }, rate: true,
    levels: ['Seated', 'Standing', 'Single-leg'],
    cues: 'Draw the ball of the foot toward the heel to raise the arch, toes long and relaxed (no curling). Hold 5-10 seconds.',
    video: 'short foot exercise arch doming',
  }),
  fx('foot-toe-press', 'Big toe isometric press', ['Feet & toes'], {
    dose: '2 × 30s · per foot',
    rows: [{ label: 'Press', hold: 30 }, { label: 'Press', hold: 30 }], sets: 2, hold: 30, track: { hold: true }, rate: true,
    cues: 'Press the big toe down into the floor as hard as is comfortable, the rest of the foot relaxed. 30 seconds.',
    video: 'big toe isometric press floor exercise',
  }),
  fx('foot-balance', 'Single-leg balance', ['Feet & toes', 'Calves & ankles'], {
    dose: '2 × 30–45s · per foot',
    rows: [{ label: 'Balance', hold: 30, holdMax: 45 }, { label: 'Balance', hold: 30, holdMax: 45 }], sets: 2, hold: 30, holdMax: 45, track: { hold: true },
    levels: ['Eyes open', 'Eyes closed', 'Unstable surface', 'With reaches'],
    cues: 'Barefoot, soft knee, big toe pressed into the floor. Keep the arch up; don’t grip with the toes.',
    video: 'single leg balance progression eyes closed',
  }),
  fx('foot-calf-raise', 'Single-leg calf raise (3s down)', ['Calves & ankles', 'Feet & toes'], {
    dose: '15–20 · 3s down · per foot',
    rows: [{ label: '3s down', reps: 15, repsMax: 20 }], reps: 15, repsMax: 20, tempo: '3s down', track: { reps: true, load: true },
    cues: 'Up through the big toe, 3 seconds down. Fingertips on a wall for balance. Skip it on days with other calf work.',
    video: 'single leg calf raise slow eccentric',
  }),
];
export const FOOT_ROUTINE = { id: ROUTINE_ID, name: 'Foot strength', items: footExercises().map(e => e.id), weekly: WEEKLY };

// Adds the exercises, the routine and the morning-check part to existing data (data version 34). Nothing you have is changed.
export function addFoot(s) {
  s.mobility ??= { exercises: [], routines: [], sessions: [] };
  for (const e of footExercises()) if (!s.mobility.exercises.some(x => x.id === e.id)) s.mobility.exercises.push(e);
  if (!s.mobility.routines.some(r => r.id === ROUTINE_ID)) s.mobility.routines.push({ ...FOOT_ROUTINE, items: [...FOOT_ROUTINE.items] });
  s.morning ??= { parts: [], log: [] };
  if (!s.morning.parts.includes(PAIN_PART)) s.morning.parts.push(PAIN_PART);
}

// ---------- logging ----------

// Each session's item for an exercise, newest first: [{ at, item }].
export const history = (state, exerciseId) => loggedItems(state).filter(x => x.item.exerciseId === exerciseId);
// The level to start from: last time's.
export const lastLevel = (state, ex) => history(state, ex.id)[0]?.item.level ?? 0;

// Ready for the next level? { next (index), why } or null. Rated exercises: the last 3 sessions at this level rated
// CONTROL_READY or better. Balance: every set at BALANCE_READY seconds on both feet, last session at this level.
export function readyForNext(state, ex, level = lastLevel(state, ex)) {
  if (!ex.levels || level >= ex.levels.length - 1) return null;
  const at = history(state, ex.id).filter(x => (x.item.level ?? 0) === level);
  if (ex.rate) {
    const r = at.slice(0, 3).map(x => x.item.control).filter(c => c != null);
    if (r.length === 3 && r.every(c => c >= CONTROL_READY)) return { next: level + 1, why: `control ${r.join(', ')} the last 3 times` };
    return null;
  }
  if (ex.id === 'foot-balance') {
    const sets = at[0]?.item.sets.filter(s => s.done && !s.optional) ?? [];
    const ok = side => { const xs = sets.filter(s => s.side === side); return xs.length > 0 && xs.every(s => Number(s.hold) >= BALANCE_READY); };
    if (ok('L') && ok('R')) return { next: level + 1, why: `${BALANCE_READY}s on both feet` };
  }
  return null;
}

// The calf raise, last time: best reps and load on each side, and what to do about it.
export function calfReport(state) {
  const last = history(state, 'foot-calf-raise')[0];
  if (!last) return null;
  const side = s => {
    const xs = last.item.sets.filter(x => x.done && x.side === s);
    return xs.length ? { reps: Math.max(...xs.map(x => Number(x.reps) || 0)), load: Math.max(0, ...xs.map(x => Number(x.load) || 0)) } : null;
  };
  const L = side('L'), R = side('R');
  return {
    at: last.at, L, R,
    addLoad: !!L && L.reps >= CALF_LOAD_AT,
    lagging: !!L && !!R && R.reps - L.reps > CALF_GAP ? R.reps - L.reps : 0,
  };
}

// ---------- days and the week ----------

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Which of the routine's exercises were done each day, from every session (done in chunks or all at once):
// Map day -> Set of exercise ids.
export function doneByDay(state, from = 0, to = Infinity) {
  const r = state.mobility?.routines.find(x => x.id === ROUTINE_ID);
  const want = new Set(r?.items ?? []);
  const out = new Map();
  for (const { item } of loggedItems(state)) {
    if (!want.has(item.exerciseId)) continue;
    for (const s of item.sets) {
      if (!s.done || !(s.at >= from && s.at < to)) continue;
      const k = dayKey(s.at);
      if (!out.has(k)) out.set(k, new Set());
      out.get(k).add(item.exerciseId);
    }
  }
  return out;
}
// The routine's exercises still to do today, in order (all of them once it's done, for another round). A calf raise
// is left out on a day with other calf work.
export function remainingToday(state, t = Date.now(), calfDay = false) {
  const r = state.mobility?.routines.find(x => x.id === ROUTINE_ID);
  if (!r) return [];
  const done = doneByDay(state, startOf(t), startOf(t) + DAY).get(dayKey(t)) ?? new Set();
  const need = r.items.filter(id => !(calfDay && id === 'foot-calf-raise'));
  const left = need.filter(id => !done.has(id));
  return left.length ? left : need;
}
const startOf = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
// A day counts when every exercise was done that day (the calf raise may be skipped).
export const dayComplete = (r, ids) => r.items.every(id => ids.has(id) || id === 'foot-calf-raise');
// Days in [from, to) with the whole routine done, and today's count of exercises done: { days, today, total }.
export function week(state, from, to, t = Date.now()) {
  const r = state.mobility?.routines.find(x => x.id === ROUTINE_ID);
  if (!r) return null;
  const byDay = doneByDay(state, from, to);
  const days = [...byDay.values()].filter(ids => dayComplete(r, ids)).length;
  return { days, target: r.weekly ?? WEEKLY, today: (byDay.get(dayKey(t))?.size ?? 0), total: r.items.length, doneToday: dayComplete(r, byDay.get(dayKey(t)) ?? new Set()) };
}

// ---------- the toe ----------

// The morning toe-pain score over the limit two mornings running (the latest two, ending today or yesterday): the scores,
// newest first, or null.
export function toeWarning(state, t = Date.now()) {
  const log = state.morning?.log ?? [];
  const score = k => log.find(e => e.day === k)?.pain?.[PAIN_PART];
  for (const end of [t, t - DAY]) {
    const a = score(dayKey(end)), b = score(dayKey(end - DAY));
    if (a > PAIN_LIMIT && b > PAIN_LIMIT) return [a, b];
  }
  return null;
}
