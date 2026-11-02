// The morning check: about 10 seconds a day. Energy (1-5) and pain (0-10) for each body part you track, scored with
// the same test movement every morning. Pure: no DOM, no storage. From THP's "pain versus hurt": up to 3/10 is fine if
// it settles within 48 hours; above that, isometrics instead of jumping.
//   state.morning = { parts: ['Knee', ...], log: [{ id, day, at, energy, pain: { Knee: 2 } }] }

export const PAIN_LIMIT = 3;            // over this, the part's jumps become isometrics today
export const SETTLE_DAYS = 3;           // sore (any score) this many mornings running = it didn't settle within 48 hours
export const KEEP_DAYS = 400;
export const PART_IDEAS = ['Knee', 'Ankle / Achilles', 'Low back', 'Hip', 'Shoulder'];

const DAY = 864e5;
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const keyTime = k => new Date(`${k}T12:00`).getTime();

// What helps each kind of part: the isometric holds (mobility exercise ids) that stand in for its jumps, and whether
// the part's pain stops jumping. Parts that match nothing are tracked and flagged only.
export const RELIEF = [
  { match: /knee|patell|quad|tendon/i, jumps: true, holds: ['mob-spanish-squat-hold'] },
  { match: /ankle|achilles|calf|calves|foot|feet|shin|heel/i, jumps: true, holds: ['mob-calf-iso-hold'] },
  { match: /back|spine|lumbar/i, jumps: true, holds: ['mob-mcgill-curl-up', 'mob-mcgill-side-plank', 'mob-mcgill-bird-dog'] },
  { match: /hip|groin|glute/i, jumps: true, holds: [] },
];
export const reliefOf = part => RELIEF.find(r => r.match.test(part)) ?? { jumps: false, holds: [] };

export const morningOf = state => state.morning ?? { parts: [], log: [] };
export const entryFor = (state, t = Date.now()) => morningOf(state).log.find(e => e.day === dayKey(t)) ?? null;

// Saves today's check (replacing an earlier one today). `energy` 1-5 or null; `pain` { part: 0-10 }.
export function record(state, { energy = null, pain = {} }, t = Date.now()) {
  state.morning ??= { parts: [], log: [] };
  const day = dayKey(t);
  const clean = {};
  for (const p of state.morning.parts) if (pain[p] != null && pain[p] !== '') clean[p] = Math.max(0, Math.min(10, Math.round(Number(pain[p]))));
  const e = energy == null ? null : Math.max(1, Math.min(5, Math.round(Number(energy))));
  const old = state.morning.log.find(x => x.day === day);
  const entry = { id: old?.id ?? `mc-${day}`, day, at: t, energy: e, pain: clean };
  state.morning.log = [entry, ...state.morning.log.filter(x => x.day !== day)].sort((a, b) => b.day.localeCompare(a.day));
  const cutoff = dayKey(t - KEEP_DAYS * DAY);
  state.morning.log = state.morning.log.filter(x => x.day >= cutoff);
  return entry;
}

export function setParts(state, parts) {
  state.morning ??= { parts: [], log: [] };
  state.morning.parts = [...new Set(parts.map(p => String(p).trim()).filter(Boolean))];
}

// Parts over the limit this morning: [{ part, score, relief }].
export function overLimit(state, t = Date.now()) {
  const e = entryFor(state, t);
  if (!e) return [];
  return Object.entries(e.pain).filter(([, n]) => n > PAIN_LIMIT).map(([part, score]) => ({ part, score, relief: reliefOf(part) }));
}

// Parts whose pain stops jumping today (over the limit and a jumping part), or [] when jumping is fine.
export const jumpPain = (state, t = Date.now()) => overLimit(state, t).filter(x => x.relief.jumps);

// Today's isometric holds for those parts, as mobility exercise ids that exist in your data.
export function reliefHolds(state, t = Date.now()) {
  const have = new Set((state.mobility?.exercises || []).filter(e => !e.archived).map(e => e.id));
  return [...new Set(jumpPain(state, t).flatMap(x => x.relief.holds))].filter(id => have.has(id));
}

// Days in [start, end) with a pain flag: a part over the limit, or a part sore SETTLE_DAYS mornings running (it didn't
// settle within 48 hours). Returns [{ day, parts }].
export function painFlags(state, start, end) {
  const log = morningOf(state).log;
  const byDay = new Map(log.map(e => [e.day, e]));
  const out = [];
  for (const e of log) {
    const t = keyTime(e.day);
    if (t < start || t >= end) continue;
    const parts = Object.entries(e.pain).filter(([part, n]) => {
      if (n > PAIN_LIMIT) return true;
      if (!(n > 0)) return false;
      for (let i = 1; i < SETTLE_DAYS; i++) if (!(byDay.get(dayKey(t - i * DAY))?.pain[part] > 0)) return false;
      return true;
    }).map(([part]) => part);
    if (parts.length) out.push({ day: e.day, parts });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

// Average morning energy in [start, end), or null with no entries.
export function averageEnergy(state, start, end) {
  const xs = morningOf(state).log.filter(e => e.energy != null && keyTime(e.day) >= start && keyTime(e.day) < end).map(e => e.energy);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// "Energy 4 · Knee 2 · Low back 5"
export function entryText(e) {
  if (!e) return '';
  return [e.energy != null ? `Energy ${e.energy}` : null, ...Object.entries(e.pain).map(([p, n]) => `${p} ${n}`)].filter(Boolean).join(' · ');
}
