// Pure rules: estimated max, dose crediting, slot scoring, scheme/exercise choice.
// No DOM access here so it stays testable and tunable.

// TECH is technique work: explosive movements practiced when tired or after heavy work, with its own weekly goal.
export const TIERS = ['T1', 'T2', 'T3', 'TECH'];
const BUILD_ORDER = ['T1', 'T2', 'TECH', 'T3'];
export const WARMUP = { T1: 3, T2: 0, T3: 0, TECH: 0 }; // minutes added on top of a scheme
export const EST_MAX_REP_CAP = 10;             // sets above this rep count don't feed estimated max
const DAY = 864e5;

export const byId = (arr, id) => arr.find(x => x.id === id);
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------- dates ----------

export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function startOfDay(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function weekBounds(state, t = Date.now()) {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() - ((d.getDay() - state.settings.weekStartDay + 7) % 7));
  const start = d.getTime();
  d.setDate(d.getDate() + 7);
  return { start, end: d.getTime() };
}

// Days remaining in the week, counting today (1..7).
export function daysLeftInWeek(state, t = Date.now()) {
  const { end } = weekBounds(state, t);
  return Math.max(1, Math.round((end - startOfDay(t)) / DAY));
}

// ---------- exercises ----------

// Best guesses from a name, used when you add an exercise or import one. Always editable.
// Rules run in order and the first match wins, so specific patterns come before general ones.
const REGION_RULES = [
  // Hinges and hamstring work, including clean- or snatch-grip pulls and pulls from blocks or a rack.
  [/deadlift|\brdls?\b|romanian|good ?mornings?|back extension|hyperextension|reverse hyper|glute[- ]?ham|\bghr\b|nordic|hamstring|hip thrust|glute bridge|calf|(block|rack|deficit) pulls?\b|(clean|snatch)[- ]?grip/i, 'lower'],
  // Whole-body lifts and core work.
  [/clean|snatch|jerk|push press|swing|thruster|burpee|carry|get[- ]?up|slam|throw|toss/i, 'full'],
  [/plank|crunch|sit[- ]?up|ab[- ]?wheel|rollout|leg raise|knee raise|dead ?bug|hollow|l[- ]?sit|v[- ]?up|twist|pallof|toes to bar/i, 'full'],
  [/squat|lunge|jump|hop|bound|leg press|leg curl|leg extension|step[- ]?up|sprint|sled|pistol|skater|split/i, 'lower'],
  [/pull|chin|push|press|dip|curl|row|raise|fly|flye|extension|bench|tricep|bicep|shrug|face|muscle[- ]?up|handstand|lever/i, 'upper'],
];
export function guessRegion(name) {
  return REGION_RULES.find(([re]) => re.test(name || ''))?.[1] ?? 'full';
}
// Grip names ("clean-grip RDL") and plain deadlifts aren't explosive even though they mention a quick lift.
export const guessExplosive = name => !/(clean|snatch)[- ]?grip|deadlift|\brdl\b|romanian/i.test(name || '')
  && /jump|hop|bound|skip|sprint|clean|snatch|jerk|push press|swing|throw|toss|slam|plyo|clap|bounce|high pull|depth/i.test(name || '');

// What an exercise may be prescribed as, from its name: explosive → power; not loaded or isolation/pump work → accessory
// (T3 only); else a main lift that T1/T2 picks may use. Editable per exercise.
const ACCESSORY_NAME = /curl|raise|\bfl(y|ys|ies)\b|flye|extension|kickback|push ?down|shrug|wrist|forearm|grip|pinch|roller|band|pull[- ]?apart|face pull|calf|calves|lateral|rear[- ]?delt|crunch|twist|pallof|plank|rotation|abduct|adduct|hyper|sorensen/i;
export function guessRole(name, metric = 'load_reps', explosive = false) {
  if (explosive) return 'power';
  return metric !== 'load_reps' || ACCESSORY_NAME.test(name || '') ? 'accessory' : 'main';
}
// Automatic T1/T2 strength picks use main lifts only; exercises from before roles existed count by their name.
export const isMainLift = e => (e?.role ?? guessRole(e?.name, e?.metric, e?.explosive)) === 'main';

export function isAvailable(ex, loc) {
  return !!loc && (ex.equipment || []).every(e => loc.equipment.includes(e));
}

export function familyMembers(state, familyId) {
  return state.exercises.filter(e => e.familyId === familyId).sort((a, b) => a.rank - b.rank);
}

// Family alternatives available here, closest rank first.
export function alternatives(state, cur, loc) {
  return familyMembers(state, cur.familyId)
    .filter(e => e.id !== cur.id && !e.archived && isAvailable(e, loc))
    .sort((a, b) => Math.abs(a.rank - cur.rank) - Math.abs(b.rank - cur.rank) || a.rank - b.rank);
}

// Family's usual exercise if equipment allows, else closest available by rank.
// T1/T2 need a load x reps exercise, otherwise the work could never fill the slot.
// A goal's named exercise, else the family's usual exercise, else the closest available by rank.
export function pickExercise(state, familyId, loc, tier, preferredId = null) {
  const fam = byId(state.families, familyId);
  let members = familyMembers(state, familyId).filter(e => !e.archived && isAvailable(e, loc));
  // Heavy and moderate work needs a load to measure, unless it's explosive (jumps count by reps).
  if (tier === 'T1' || tier === 'T2') {
    members = members.filter(e => e.metric === 'load_reps' || e.explosive);
    // A family-wide heavy or moderate goal uses a main lift or power exercise when the family has one, not its accessories.
    const real = members.filter(e => (e.role ?? guessRole(e.name, e.metric, e.explosive)) !== 'accessory' || e.id === preferredId);
    if (real.length) members = real;
  }
  // A family-wide pump (T3) goal uses an unweighted move when there is one: pull-ups, not weighted pull-ups 3×15.
  if (tier === 'T3' && !preferredId) {
    const light = members.filter(e => !(e.equipment || []).includes('dip-belt'));
    if (light.length) members = light;
  }
  // Heavy work means a lift you've actually loaded: once any lift in the family has a max, T1 only uses those.
  // So a heavy squat goal waits for the barbell instead of turning into goblet squats at the office.
  if (tier === 'T1' && familyMembers(state, familyId).some(e => !e.archived && estimatedMax(state, e.id) != null)) {
    members = members.filter(e => estimatedMax(state, e.id) != null);
  }
  if (!members.length) return null;
  // A goal that names an exercise only takes that exercise (no goblet squats for a back-squat T1).
  if (preferredId) return members.find(e => e.id === preferredId) ?? null;
  const def = members.find(e => e.id === fam?.defaultExerciseId);
  if (def) return def;
  const defRank = byId(state.exercises, fam?.defaultExerciseId)?.rank ?? 0;
  return [...members].sort((a, b) => Math.abs(a.rank - defRank) - Math.abs(b.rank - defRank) || a.rank - b.rank)[0];
}

// ---------- estimated max ----------

export function epley(total, reps) {
  if (!(total > 0) || !(reps >= 1) || reps > EST_MAX_REP_CAP) return null;
  return reps === 1 ? total : total * (1 + reps / 30);
}

// Total load moved: bodyweight movements add the bodyweight recorded with the set.
export function setTotalLoad(state, s) {
  const ex = byId(state.exercises, s.exerciseId);
  if (!ex || ex.metric !== 'load_reps') return null;
  const added = s.load === '' || s.load == null ? null : Number(s.load);
  if (ex.bodyweight) {
    const bw = s.bw ?? state.settings.bodyweight;
    return bw ? bw + (added || 0) : null;
  }
  return added;
}

export const setE1rm = (state, s) => epley(setTotalLoad(state, s), Number(s.reps));

// Only heavy and moderate work (T1/T2) sets the max. Light technique or pump sessions would
// otherwise push real sessions out of the window and drag every suggested load down.
// Warm-up sets never count: not toward a max, a goal, a target load or the heavy-work rules.
const countsForMax = s => !s.warmup && (!s.tier || s.tier === 'T1' || s.tier === 'T2');

// Best e1RM across the last 3 T1/T2 sessions with this exercise, before `before`.
// Falls back to the exercise's starting max (added load for bodyweight moves).
// A 1-rep max you tested and typed in, as a total load (bodyweight added for weighted bodyweight lifts), with the day it
// was tested (null for an undated one, like the old "starting max"). Null if none.
export const TESTED_MAX_WEEKS = 16;
export function testedMaxOf(state, ex) {
  const tm = ex?.testedMax ?? (ex?.startMax ? { load: ex.startMax, at: null } : null);
  if (!tm || !(Number(tm.load) > 0)) return null;
  const total = ex.bodyweight ? (state.settings.bodyweight ? state.settings.bodyweight + Number(tm.load) : null) : Number(tm.load);
  return total == null ? null : { total, at: tm.at ?? null };
}

// Where the estimated max comes from: 'tested' (your typed-in 1RM is the higher, and recent), 'sets' (your logged sets), or null.
export function maxSource(state, exerciseId, before = Infinity) {
  const m = estimatedMax(state, exerciseId, before);
  if (m == null) return null;
  const tested = testedMaxOf(state, byId(state.exercises, exerciseId));
  return tested && Math.abs(tested.total - m) < 1e-9 ? 'tested' : 'sets';
}

// Best of the last 3 sessions' heavy and moderate sets. A tested 1RM from the last 16 weeks is a floor (lighter T2 work
// can't drag the loads down, and stronger sets still win); an older or undated one is used only when there are no sets.
export function estimatedMax(state, exerciseId, before = Infinity) {
  const bySession = new Map();
  for (const s of state.sets) {
    if (!s.done || s.exerciseId !== exerciseId || s.loggedAt >= before || !countsForMax(s)) continue;
    const e = setE1rm(state, s);
    if (!e) continue;
    const cur = bySession.get(s.sessionId);
    if (!cur || e > cur.e) bySession.set(s.sessionId, { e, t: s.loggedAt });
  }
  const recent = [...bySession.values()].sort((a, b) => b.t - a.t).slice(0, 3);
  const fromSets = recent.length ? Math.max(...recent.map(r => r.e)) : null;
  const tested = testedMaxOf(state, byId(state.exercises, exerciseId));
  const now = before === Infinity ? Date.now() : before;
  if (!tested || (tested.at != null && tested.at > now)) return fromSets;
  const fresh = tested.at != null && now - tested.at <= TESTED_MAX_WEEKS * 7 * DAY;
  return fresh ? Math.max(fromSets ?? 0, tested.total) : fromSets ?? tested.total;
}

function dayBest(state, s) {
  const k = dayKey(s.loggedAt);
  let best = null;
  for (const o of state.sets) {
    if (!o.done || o.exerciseId !== s.exerciseId || !countsForMax(o) || dayKey(o.loggedAt) !== k) continue;
    const e = setE1rm(state, o);
    if (e && (!best || e > best)) best = e;
  }
  return best;
}

// Intensity for a scheme's reps-per-set (~2 reps in reserve by Epley), clamped to the tier's range.
export function targetPct(cfg, reps) {
  if (cfg.intMin == null) return null;
  return clamp(1 / (1 + (reps + 2) / 30), cfg.intMin, cfg.intMax);
}

export function lastLoad(state, exerciseId) {
  let best = null;
  for (const s of state.sets) {
    if (s.done && !s.warmup && s.exerciseId === exerciseId && s.load != null && s.load !== '' && (!best || s.loggedAt > best.loggedAt)) best = s;
  }
  return best ? Number(best.load) : null;
}

// Load to enter in the set row (added load for bodyweight moves). Never needs manual recalculation.
export function targetLoad(state, ex, tier, scheme) {
  if (ex.metric !== 'load_reps') return null;
  const cfg = state.tiers[tier];
  if (cfg.intMin == null) return lastLoad(state, ex.id);
  const max = estimatedMax(state, ex.id);
  if (!max) return lastLoad(state, ex.id);
  let total = max * targetPct(cfg, scheme.reps);
  if (ex.bodyweight) {
    if (!state.settings.bodyweight) return null;
    total -= state.settings.bodyweight;
  }
  return snapLoad(state, ex, Math.max(0, total));
}

// Kettlebell moves snap to the nearest bell you own; everything else rounds to the load increment.
export function snapLoad(state, ex, load) {
  const bells = state.settings.kettlebells || [];
  if (ex.equipment?.includes('kettlebell') && !ex.equipment.includes('barbell') && bells.length) {
    return bells.reduce((best, b) => Math.abs(b - load) < Math.abs(best - load) ? b : best);
  }
  const inc = state.settings.increment || 5;
  return Math.round(load / inc) * inc;
}

// ---------- crediting ----------

// Reps a goal needs per day: the goal's own minimum if it has one, else the tier's.
export function slotDose(state, slot, tier = slot?.tier) {
  const c = state.tiers[tier];
  const repMin = slot?.repMin ?? c.repMin;
  return { repMin, repMax: Math.max(slot?.repMax ?? c.repMax, repMin) };
}

export function doseMet(cfg, tier, agg) {
  if (tier === 'T3') return agg.reps >= cfg.repMin || agg.sets >= (cfg.setMin || 3);
  return agg.reps >= cfg.repMin;
}

// Which slot a set counts toward, before any manual tag. T1/T2 require the intensity floor.
// Goal for an exercise at a tier: one naming this exercise, else a family-wide one. Goals naming another exercise don't match.
export function slotFor(state, ex, tier) {
  const cands = state.slots.filter(sl => sl.familyId === ex.familyId && sl.tier === tier);
  return cands.find(sl => sl.exerciseId === ex.id) || cands.find(sl => !sl.exerciseId) || null;
}

export function autoSlotFor(state, s) {
  const ex = byId(state.exercises, s.exerciseId);
  if (!ex || s.warmup) return null;
  const slot = slotFor(state, ex, s.tier);
  if (!slot) return null;
  if (s.tier === 'T3' || s.tier === 'TECH') return slot.id;
  if (ex.metric !== 'load_reps') return ex.explosive ? slot.id : null; // jumps count by reps
  const total = setTotalLoad(state, s);
  const ref = s.refMax || dayBest(state, s);
  if (total == null || !ref) return null;
  return total >= state.tiers[s.tier].intMin * ref - 0.01 ? slot.id : null;
}

export function slotForSet(state, s) {
  if (s.countsManual) return s.countsToward ?? null;
  return autoSlotFor(state, s);
}

// Weekly quota progress. A slot gets one exposure per day whose counted sets meet the dose,
// so chunks spread across a day add up.
export function creditWeek(state, t = Date.now()) {
  const { start, end } = weekBounds(state, t);
  const today = dayKey(t);
  const slots = new Map(state.slots.map(sl => [sl.id, { slot: sl, days: new Map(), exposures: 0, filled: 0, todayMet: false }]));
  const assign = new Map();
  for (const s of state.sets) {
    if (!s.done || s.warmup || s.loggedAt < start || s.loggedAt >= end) continue;
    const slotId = slotForSet(state, s);
    assign.set(s.id, slotId);
    const r = slotId && slots.get(slotId);
    if (!r) continue;
    const k = dayKey(s.loggedAt);
    const agg = r.days.get(k) || { reps: 0, sets: 0 };
    agg.reps += Number(s.reps) > 0 ? Number(s.reps) : (s.time > 0 || s.distance > 0 ? 1 : 0); // a timed or distance set counts as one
    agg.sets += 1;
    r.days.set(k, agg);
  }
  for (const r of slots.values()) {
    const cfg = { ...state.tiers[r.slot.tier], ...slotDose(state, r.slot) };
    for (const [k, agg] of r.days) {
      agg.met = doseMet(cfg, r.slot.tier, agg);
      if (agg.met) {
        r.exposures++;
        if (k === today) r.todayMet = true;
      }
    }
    r.filled = Math.min(r.exposures, r.slot.quota);
  }
  return { slots, assign, start, end };
}

// ---------- suggestion ----------

export const INTENT = {
  auto: { T1: 1, T2: 1, T3: 1, TECH: 1 },
  heavy: { T1: 2, T2: 1, T3: 0.6, TECH: 0.5 },
  sweat: { T1: 0.5, T2: 1.5, T3: 1.4, TECH: 0.8 },
  easy: { T1: 0.2, T2: 0.5, T3: 1.8, TECH: 1.5 },
};

// 1 (flat) .. 5 (great). Stored as fatigue (1 fresh .. 5 wrecked) = 6 - the energy picked at check-in; sleep 1..5 is optional.
export function energy(ci) {
  let e = 6 - (ci.fatigue || 3);
  if (ci.sleep) e = (2 * e + ci.sleep) / 3;
  return e;
}

function hadT1Recently(state, t) {
  const from = startOfDay(t) - DAY;
  return state.sets.some(s => s.done && !s.warmup && s.tier === 'T1' && s.loggedAt >= from && s.loggedAt < t);
}

// Heavy (T1) work logged since the start of yesterday, as the set of body regions it taxed.
// Explosive T1 work (cleans, jumps) doesn't count: it's fast rather than grinding.
export function recentHeavyRegions(state, t = Date.now(), excludeBlockId = null) {
  const from = startOfDay(t) - DAY;
  const out = new Set();
  for (const s of state.sets) {
    if (!s.done || s.warmup || s.tier !== 'T1' || s.loggedAt < from || s.loggedAt >= t || s.blockId === excludeBlockId) continue;
    const ex = byId(state.exercises, s.exerciseId);
    if (ex?.explosive) continue;
    out.add(ex?.region || 'full');
  }
  return out;
}

// Whole-body work conflicts with any heavy work; lower/upper only conflict with the same region.
export const regionConflict = (region, heavy) => heavy.size > 0 && (region === 'full' || heavy.has('full') || heavy.has(region));

// Explosive work is power work when you're fresh, and technique work when tired or after heavy work in the same region.
export function powerReadiness(state, ci, ex, t = Date.now(), excludeBlockId = null) {
  const reasons = [];
  if (energy(ci) <= 2.5) reasons.push(`tired (energy ${6 - (ci.fatigue || 3)}${ci.sleep ? `, sleep ${ci.sleep}` : ''})`);
  const heavy = recentHeavyRegions(state, t, excludeBlockId);
  if (regionConflict(ex.region || 'full', heavy)) reasons.push(`heavy ${[...heavy].join('/')} work since yesterday`);
  return { fresh: reasons.length === 0, reasons };
}

export function readinessSummary(state, ci, t = Date.now()) {
  const tired = energy(ci) <= 2.5;
  return { fresh: !tired, tired, heavy: [...recentHeavyRegions(state, t)] };
}

export function scoreSlots(state, ci, t = Date.now()) {
  const loc = byId(state.locations, ci.locationId);
  const credit = creditWeek(state, t);
  const daysLeft = daysLeftInWeek(state, t);
  const recentT1 = state.settings.recovery?.t1AfterT1 && hadT1Recently(state, t);
  const out = [];
  for (const sl of state.slots) {
    const r = credit.slots.get(sl.id);
    const remaining = sl.quota - r.filled;
    if (remaining <= 0 || r.todayMet) continue;
    const exercise = pickExercise(state, sl.familyId, loc, sl.tier, sl.exerciseId);
    if (!exercise) continue;

    const why = [];
    let score = (sl.priority || 1) * remaining / daysLeft;
    why.push(`priority ${sl.priority} × ${remaining} left ÷ ${daysLeft}d`);
    const im = INTENT[ci.intent || 'auto'][sl.tier];
    if (im !== 1) { score *= im; why.push(`${ci.intent} ×${im}`); }
    const power = !!exercise.explosive && (sl.tier === 'T1' || sl.tier === 'T2');
    const ready = exercise.explosive ? powerReadiness(state, ci, exercise, t) : null;
    let waits = false;
    if (power) {
      if (ready.fresh) { score *= 1.2; why.push('fresh for power work ×1.2'); }
      else { waits = true; why.push(`not fresh for power work (${ready.reasons.join('; ')})`); }
    } else if (sl.tier === 'T1') {
      if (ci.fatigue >= 4) { score *= 0.4; why.push('low energy ×0.4'); }
      else if (ci.fatigue === 3) { score *= 0.8; why.push('middling energy ×0.8'); }
      if (ci.sleep && ci.sleep <= 2) { score *= 0.7; why.push('poor sleep ×0.7'); }
      if (recentT1) { score *= 0.5; why.push('T1 in last day ×0.5'); }
    }
    if (sl.tier === 'T3' && ci.fatigue >= 4) { score *= 1.3; why.push('low energy ×1.3'); }
    if (sl.tier === 'TECH' && ready) {
      if (ready.fresh) { score *= 0.4; why.push('fresh: power work comes first ×0.4'); }
      else { score *= 1.6; why.push(`${ready.reasons.join('; ')}: technique day ×1.6`); }
    }
    // The day's lean: work for that half of the body first, the other half only if it's much more urgent.
    const lean = leanOf(ci), half = lean && bodyRegion(state, exercise);
    if (lean && half === lean) { score *= 1.5; why.push(`leaning ${lean} ×1.5`); }
    else if (half) { score *= 0.5; why.push(`leaning ${lean} ×0.5`); }
    // A short pocket of time, or a day you'll split up: favor things you can do right now with no setup.
    if ((ci.split || ci.minutes <= 20) && exercise.anytime) { score *= 1.5; why.push('can do anywhere ×1.5'); }
    out.push({ slot: sl, exercise, score, why, waits });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const schemeOptions = (state, tier) => state.schemes.filter(s => s.tiers.includes(tier));

export function doseFit(state, tier, sc, dose = null) {
  const c = dose || state.tiers[tier];
  const total = sc.sets * sc.reps;
  return total >= c.repMin && total <= c.repMax;
}

function recentSchemes(state, exerciseId, n) {
  const seen = [];
  const sets = state.sets.filter(s => s.done && !s.warmup && s.exerciseId === exerciseId).sort((a, b) => b.loggedAt - a.loggedAt);
  for (const s of sets) {
    if (!seen.some(x => x.sessionId === s.sessionId)) seen.push(s);
    if (seen.length >= n) break;
  }
  return seen.map(s => s.schemeId);
}

export const overRepCap = (ex, sc) => !!ex?.maxReps && sc.reps > ex.maxReps;
// Ten sets of 2-3 on a short rest: for power work (explosive lifts) and tired days, not a fresh day's strength work.
const powerSets = sc => sc.sets >= 10 && sc.reps <= 3;

// Time and the exercise's rep cap are hard filters; dose fit, energy, variety and chunkability are soft weights.
export function pickScheme(state, tier, ex, budget, ci, dose = null) {
  const recent = recentSchemes(state, ex.id, 2);
  const e = energy(ci);
  let best = null, bestScore = -Infinity;
  for (const sc of schemeOptions(state, tier)) {
    if (sc.minutes > budget || overRepCap(ex, sc)) continue;
    if (tier === 'T2' && powerSets(sc) && !ex.explosive && e > 2.5) continue;
    let s = 0;
    if (doseFit(state, tier, sc, dose)) s += 3;
    if (e <= 2.5) s += tier === 'T3' ? sc.sets * 0.1 : (6 - sc.reps) * 0.3; // low energy: low reps, many sets (T3: more, shorter sets)
    else if (e >= 3.5 && !ex.explosive && tier !== 'T3') s += sc.sets * sc.reps * 0.04; // high energy: more volume, but not for power work
    // T3 is already volume work: sets of 8-15 keep the reps good, so 2×25 is only for a tight squeeze on time.
    if (tier === 'T3') s -= Math.max(0, sc.reps - 15) * 0.15 + Math.max(0, 8 - sc.reps) * 0.1;
    if (ex.explosive && sc.reps <= 3) s += 1;          // power work: sets of 1-3 keep every rep fast
    if (recent.includes(sc.id)) s -= 1;
    if (ci.split && sc.sets >= 5) s += 0.5;
    if (s > bestScore) { best = sc; bestScore = s; }
  }
  return best;
}

const TIER_CAP = { T1: 1, T2: 2, T3: 3, TECH: 2 };

// Explosive power work goes first while you're fresh, then technique, then everything else in tier order.
const blockRank = (state, b) => {
  const ex = byId(state.exercises, b.exerciseId);
  if (!ex?.explosive) return 2;
  return b.tier === 'TECH' ? 1 : (b.tier === 'T1' || b.tier === 'T2') ? 0 : 2;
};

// Build one session: T1, then T2, technique and T3 until the time budget runs out, then fill any time left.
// `fill` (on by default) tops the session up from the library when the goals don't use all the time.
// `sessionBlocks`: the workout so far, when this fills extra time (+ Time), so its lifts count.
export function buildSuggestion(state, ci, t = Date.now(), { excludeFamilies = [], fill = true, sessionBlocks = [] } = {}) {
  const scored = scoreSlots(state, ci, t);
  const top = scored[0]?.score || 0;
  let budget = ci.minutes;
  const blocks = [];
  const count = { T1: 0, T2: 0, T3: 0, TECH: 0 };
  const famUsed = new Set(excludeFamilies); // e.g. T1 weighted dips and T3 dips both open: do them on different days
  for (const tier of BUILD_ORDER) {
    for (const c of scored.filter(x => x.slot.tier === tier)) {
      if (c.waits) { c.note = 'power work waits for a fresh day'; continue; }
      if (count[tier] >= TIER_CAP[tier]) { c.note = `${tier} cap reached`; continue; }
      if (famUsed.has(c.slot.familyId)) { c.note = 'same family already in this session'; continue; }
      if (c.score < 0.25 * top) { c.note = 'score too low vs. top pick'; continue; }
      // A tier the chosen intent pushes down must be nearly as urgent as the top pick, otherwise
      // tier order would still fill the session with it (sweat day, 5x5 squats).
      if (INTENT[ci.intent || 'auto'][tier] < 1 && c.score < 0.6 * top) { c.note = `${ci.intent} intent favors other work`; continue; }
      const sc = pickScheme(state, tier, c.exercise, budget - WARMUP[tier], ci, slotDose(state, c.slot));
      if (!sc) { c.note = 'no scheme fits remaining time'; continue; }
      blocks.push({ id: uid(), tier, slotId: c.slot.id, exerciseId: c.exercise.id, schemeId: sc.id, swaps: [] });
      c.picked = true;
      famUsed.add(c.slot.familyId);
      budget -= sc.minutes + WARMUP[tier];
      count[tier]++;
    }
  }
  sortBlocks(state, blocks); // stable, so tier order holds within a rank
  pairT3s(state, blocks);
  const goalMinutes = Math.round(blocksMinutes(state, blocks));
  // Goals (nearly) done: use the rest of the time anyway.
  let notes = [];
  if (fill && ci.minutes - goalMinutes >= 5) {
    const f = fillTime(state, ci, t, blocks, ci.minutes - goalMinutes, [...famUsed], sessionBlocks);
    blocks.push(...f.blocks);
    notes = f.notes;
    sortBlocks(state, blocks);
    pairT3s(state, blocks);
    stretchToFit(state, blocks, ci.minutes, ci);
  }
  return { blocks, scored, notes, goalMinutes, minutesUsed: Math.round(blocksMinutes(state, blocks)), ready: readinessSummary(state, ci, t) };
}

// ---------- supersets ----------

// Movement pattern from the exercise and family names. First match wins, so specific patterns come first
// ("leg curl" is hamstrings, not arms; "leg raise" is core, not shoulders).
const PATTERNS = [
  ['core', /\bcore\b|\babs?\b|plank|crunch|sit[- ]?up|leg raise|knee raise|rollout|ab[- ]?wheel|dead ?bug|hollow|pallof|l[- ]?sit|toes to bar|v[- ]?up/i],
  ['calf', /\bcalf|calves/i],
  ['knee', /reverse nordic|sissy/i],
  ['hinge', /reverse hyper|sorensen|deadlift|\brdls?\b|romanian|good ?morning|back extension|hyperextension|hip thrust|glute|nordic|hamstring|\bghr\b|leg curl|swing|hinge|(block|rack|deficit) pulls?\b/i],
  ['full', /clean|snatch|jerk|thruster|burpee/i],
  ['push', /overhead press|military press/i], // before squat words: "banded press in split" is a press
  ['knee', /squat|lunge|split|step[- ]?up|leg press|leg extension|pistol|jump|bound|\bhops?\b|skater/i],
  ['pull', /\btrap\b|pull[- ]?ups?|chin[- ]?ups?|\brows?\b|pulldown|face pull|pull[- ]?apart|rear[- ]?delt|curl|shrug|vertical pull|upper back|\blats?\b/i],
  ['push', /\bdips?\b|press|push[- ]?ups?|bench|incline|tricep|telle|extension|skull|push ?down|raise|\bfly\b|chest|shoulder/i],
];
export function movementPattern(state, e) {
  if (e && Object.hasOwn(e, 'pattern')) return e.pattern; // set where the name rules get it wrong
  const text = `${e?.name ?? ''} ${byId(state.families, e?.familyId)?.name ?? ''}`;
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;
}
const PATTERN_REGION = { push: 'upper', pull: 'upper', knee: 'lower', hinge: 'lower', calf: 'lower', core: 'core', full: 'full' };
const OPPOSITE = { push: 'pull', pull: 'push', knee: 'hinge', hinge: 'knee' };

// How well e fits in mainEx's rest, 0 (don't) .. 3 (best). Upper body: antagonists (push with pull).
// Lower body: complements (hamstrings and hips with squats, quads with hinges; calves with either).
// Explosive main lifts keep their partner away from the legs, so jumps and cleans stay fast.
export function pairScore(state, mainEx, e) {
  const m = movementPattern(state, mainEx), p = movementPattern(state, e);
  if (!p || p === 'full') return 0;
  if (p === 'core') return mainEx?.explosive ? 3 : 2;
  const mr = PATTERN_REGION[m] ?? mainEx?.region ?? 'full', pr = PATTERN_REGION[p];
  if (mainEx?.explosive || m === 'full') return pr === 'upper' && mr !== 'upper' ? 2 : pr === 'upper' && OPPOSITE[m] === p ? 2 : 0;
  if (OPPOSITE[m] === p) return 3;
  if (p === 'calf' && mr === 'lower') return 2;
  if (p === m) return 0;
  return pr !== mr ? 1 : 0;
}
export const restCompatible = (state, mainEx, e) => pairScore(state, mainEx, e) > 0;

function pairWhy(state, mainEx, e) {
  const m = movementPattern(state, mainEx), p = movementPattern(state, e);
  if (p === 'core') return 'core work, so the main lift stays fresh';
  if (mainEx?.explosive || m === 'full') return 'upper-body work, so your legs stay fresh for power';
  if (OPPOSITE[m] === p) return { push: 'pushing work to balance the pull', pull: 'pulling work to balance the push', hinge: 'hamstring and hip work to balance the squat', knee: 'quad work to balance the hinge' }[p];
  if (p === 'calf') return 'calves, which the main lift barely tires';
  return `${PATTERN_REGION[p]}-body work while the main lift's muscles rest`;
}

// T3 work always comes grouped. A group is a leader block plus the blocks whose pairOf points at it.
// Free T3s superset with each other in twos, best-matched pairs first; an odd one out joins a T3 pair as a
// giant set, else the free T1/T2/technique block it suits best. Supersets on main lifts stay optional.
// Mutates and returns the blocks.
export function pairT3s(state, blocks) {
  const ex = b => byId(state.exercises, b.exerciseId);
  const grouped = b => !!b.pairOf || blocks.some(x => x.pairOf === b.id);
  const fit = (a, b) => Math.max(pairScore(state, ex(a), ex(b)), pairScore(state, ex(b), ex(a)));
  const free = blocks.filter(b => b.tier === 'T3' && !grouped(b));
  while (free.length >= 2) {
    const lead = free.shift();
    const i = free.reduce((best, x, j) => fit(lead, x) > fit(lead, free[best]) ? j : best, 0);
    free.splice(i, 1)[0].pairOf = lead.id;
  }
  if (!free.length) return blocks;
  const lone = free[0];
  const t3Group = blocks.find(b => b.tier === 'T3' && !b.pairOf && b !== lone && blocks.filter(x => x.pairOf === b.id).length === 1);
  if (t3Group) { lone.pairOf = t3Group.id; return blocks; }
  const best = blocks.filter(b => b.tier !== 'T3' && !grouped(b))
    .sort((a, b) => pairScore(state, ex(b), ex(lone)) - pairScore(state, ex(a), ex(lone)))[0];
  if (best) lone.pairOf = best.id;
  return blocks;
}

// A T3 to do in a main lift's rest: the best-matched movement (see pairScore), no barbell setup, not explosive.
// Prefers an open T3 goal, then exercises you've done lately.
export function suggestPair(state, ci, mainEx, { excludeFamilies = [], credit = creditWeek(state) } = {}) {
  const loc = byId(state.locations, ci.locationId);
  // A T1/T2 goal's own lift is a main lift, not something to squeeze into a rest; its easier variations are fair game.
  const skip = new Set(excludeFamilies);
  const goalLift = sl => sl.exerciseId ?? byId(state.families, sl.familyId)?.defaultExerciseId;
  const mainLifts = new Set(state.slots.filter(sl => sl.tier === 'T1' || sl.tier === 'T2').map(goalLift));
  // Heavy-goal lifts: support work picks a different lift for the pattern when there is one, so it complements them.
  const t1Lifts = new Set(state.slots.filter(sl => sl.tier === 'T1').map(goalLift));
  // Families with a heavy or moderate goal hold the main lifts (squats before leg extensions, chin-ups before curls).
  const goalFamilies = new Set(state.slots.filter(sl => sl.tier === 'T1' || sl.tier === 'T2').map(sl => sl.familyId));
  const since = Date.now() - 84 * DAY;
  const lately = state.sets.filter(x => x.done && !x.warmup && x.loggedAt >= since);
  const recent = new Set(lately.map(x => x.exerciseId));
  const heavyLately = new Set(lately.filter(x => x.tier === 'T1' || x.tier === 'T2').map(x => x.exerciseId));
  let best = null;
  for (const e of state.exercises) {
    if (e.archived || skip.has(e.familyId) || mainLifts.has(e.id) || e.explosive || !isAvailable(e, loc)) continue;
    if ((e.equipment || []).some(x => x === 'barbell' || x === 'rack')) continue;
    const fit = pairScore(state, mainEx, e);
    if (!fit) continue;
    const slot = slotFor(state, e, 'T3');
    const r = slot && credit.slots.get(slot.id);
    const open = r && r.filled < slot.quota && !r.todayMet;
    let score = fit * 2;
    if (open) score += 2 + (slot.priority || 1);
    if (recent.has(e.id)) score += 1.5; // something you actually do beats filler
    if (heavyLately.has(e.id)) score -= 2; // trained heavy lately: a main lift, not rest-period filler
    if (byId(state.families, e.familyId)?.defaultExerciseId === e.id) score += 0.5;
    if (e.anytime) score += 0.5;
    const why = `${open ? 'open T3 goal · ' : ''}${pairWhy(state, mainEx, e)}`;
    if (!best || score > best.score) best = { exercise: e, score, why };
  }
  return best;
}

// ---------- focused workouts and filling the time ----------
// For when the weekly goals are (nearly) done but you have time and energy: an upper- or lower-body workout
// from the whole library, optionally led by explosive work. Same rules as the goal-driven suggestion:
// power work only when fresh (else technique), heavy work eased when tired or after heavy work in the region,
// schemes that fit the time, T3s grouped. Goals still get credit for anything that matches them.
// The same library picks top up a goal-driven suggestion, so the time you check in with is always used.

const FOCUS_MAIN = { upper: ['push', 'pull'], lower: ['knee', 'hinge'] };
// Accessory rotations, repeated until the time is used. Lower days follow GZCL: lower back, legs and core first.
// 'back' is lower-back work (back extensions, reverse hypers), picked from hinge moves.
const FOCUS_T3 = {
  upper: ['pull', 'push', 'pull', 'core', 'push'],
  lower: ['back', 'knee', 'core', 'hinge', 'calf'],
  either: ['pull', 'knee', 'push', 'back', 'core', 'calf'],
};
export const FOCUS_REGIONS = Object.keys(FOCUS_MAIN);
const LOWER_BACK = /reverse hyper|sorensen|back extension|hyperextension|good ?morning/i;
const PATTERN_LABEL = { push: 'pushing', pull: 'pulling', knee: 'squat pattern', hinge: 'hinge', back: 'lower back', calf: 'calves', core: 'core' };
// About one exercise per 5 minutes (a superset partner counts half, so all-accessory days need that many), never fewer than 10.
const maxBlocks = minutes => Math.max(10, Math.round(minutes / 5));
const tierOrder = tier => BUILD_ORDER.indexOf(tier);
// Explosive work keeps the order it was picked in (jumps before cleans); the rest goes in tier order.
const sortBlocks = (state, blocks) => blocks.sort((a, b) => blockRank(state, a) - blockRank(state, b)
  || (blockRank(state, a) === 2 ? tierOrder(a.tier) - tierOrder(b.tier) : 0));

// Minutes a workout takes: scheme plus warm-up, with superset partners at half (their sets fit in the other's rest).
export function blocksMinutes(state, blocks) {
  return blocks.reduce((m, b) => m + ((byId(state.schemes, b.schemeId)?.minutes || 0) + WARMUP[b.tier]) * (b.pairOf ? 0.5 : 1), 0);
}

// When the library runs out before the time does: more sets on the T2 and T3 work (3×15 → 4×12, 3×10 → 5×5),
// the cheapest step that fits first. Explosive and T1 work keep their schemes. On a tired day (with the check-in
// given) a step never raises the reps per set, so 6×4 can become 10×2 but not 5×5; on other days it never moves a
// strength lift into ten sets of 2-3. Mutates the blocks.
export function stretchToFit(state, blocks, minutes, ci = null) {
  const tired = !!ci && energy(ci) <= 2.5;
  for (;;) {
    const left = minutes - blocksMinutes(state, blocks);
    let best = null;
    for (const b of blocks) {
      const ex = byId(state.exercises, b.exerciseId), cur = byId(state.schemes, b.schemeId);
      if (!ex || !cur || ex.explosive || (b.tier !== 'T2' && b.tier !== 'T3')) continue;
      const dose = slotDose(state, byId(state.slots, b.slotId), b.tier);
      for (const sc of schemeOptions(state, b.tier)) {
        if (sc.minutes <= cur.minutes || overRepCap(ex, sc) || !doseFit(state, b.tier, sc, dose)) continue;
        if (tired ? sc.reps > cur.reps : powerSets(sc)) continue;
        if (b.tier === 'T3' && (sc.reps > 15 || (sc.reps < 8 && !ex.maxReps))) continue; // sets of 8-15, as in pickScheme
        const cost = (sc.minutes - cur.minutes) * (b.pairOf ? 0.5 : 1);
        if (cost <= left && (!best || cost < best.cost)) best = { b, sc, cost };
      }
    }
    if (!best) return blocks;
    best.b.schemeId = best.sc.id;
  }
}

// Groups the T3s from scratch, so adding blocks one at a time can't strand a T3 outside every superset.
function regroup(state, blocks) {
  for (const b of blocks) delete b.pairOf;
  sortBlocks(state, blocks);
  return pairT3s(state, blocks);
}

// While the workout runs over (a T3 that ended up outside a superset costs its full time), drop the last T3 from
// `removable` (library picks) and regroup. Mutates `blocks` and `removable`; returns the dropped blocks.
function trimToFit(state, blocks, minutes, removable) {
  const dropped = [];
  while (regroup(state, blocks) && blocksMinutes(state, blocks) > minutes + 1e-9) {
    const i = removable.findLastIndex(b => b.tier === 'T3');
    if (i < 0) break;
    const [gone] = removable.splice(i, 1);
    if (blocks !== removable) blocks.splice(blocks.indexOf(gone), 1);
    dropped.push(gone);
  }
  return dropped;
}

// The day's lean (upper or lower), or null for either.
export const leanOf = ci => (ci?.lean === 'upper' || ci?.lean === 'lower' ? ci.lean : null);

// Upper, lower, or neither (core and whole-body work), from the movement pattern, else the exercise's region.
export function bodyRegion(state, e) {
  const r = PATTERN_REGION[movementPattern(state, e)] ?? e?.region;
  return r === 'upper' || r === 'lower' ? r : null;
}

// Picks from the whole library at the location, spending `minutes`. Collects blocks and notes.
// `taken`: exercises already in the workout (goal picks, the session so far), never picked again.
function libraryKit(state, ci, t, minutes, excludeFamilies, present = [], taken = []) {
  const loc = byId(state.locations, ci.locationId);
  const famUsed = new Set(excludeFamilies);
  const pattern = e => movementPattern(state, e);
  // When each exercise and pattern was last trained (pattern: heavy or moderate work only; patLastT1: heavy only).
  const exLast = new Map(), patLast = new Map(), patLastT1 = new Map();
  for (const s of state.sets) {
    if (!s.done || s.warmup || s.loggedAt >= t) continue;
    const e = byId(state.exercises, s.exerciseId);
    if (!e) continue;
    exLast.set(e.id, Math.max(exLast.get(e.id) ?? 0, s.loggedAt));
    if (s.tier === 'T1' || s.tier === 'T2') patLast.set(pattern(e), Math.max(patLast.get(pattern(e)) ?? 0, s.loggedAt));
    if (s.tier === 'T1') patLastT1.set(pattern(e), Math.max(patLastT1.get(pattern(e)) ?? 0, s.loggedAt));
  }
  const lately = e => (exLast.get(e.id) ?? 0) >= t - 182 * DAY; // something you actually do
  const isDefault = e => byId(state.families, e.familyId)?.defaultExerciseId === e.id;
  const usable = e => !e.archived && !famUsed.has(e.familyId) && isAvailable(e, loc);
  // A T1/T2 goal's own lift is a main lift, not accessory filler (as in suggestPair).
  const goalLift = sl => sl.exerciseId ?? byId(state.families, sl.familyId)?.defaultExerciseId;
  const mainLifts = new Set(state.slots.filter(sl => sl.tier === 'T1' || sl.tier === 'T2').map(goalLift));
  // Heavy-goal lifts: support work picks a different lift for the pattern when there is one, so it complements them.
  const t1Lifts = new Set(state.slots.filter(sl => sl.tier === 'T1').map(goalLift));
  // Families with a heavy or moderate goal hold the main lifts (squats before leg extensions, chin-ups before curls).
  const goalFamilies = new Set(state.slots.filter(sl => sl.tier === 'T1' || sl.tier === 'T2').map(sl => sl.familyId));
  // Your chosen lifts stay the core of the work: heavy (T1) work only uses your T1 goals' lifts, the one each goal would
  // use here, when you have T1 goals; support (T2) work tries your T2 goals' lifts first. Swap still offers the rest.
  const hasT1Goals = state.slots.some(sl => sl.tier === 'T1');
  const t1Core = new Set(state.slots.filter(sl => sl.tier === 'T1').map(sl => pickExercise(state, sl.familyId, loc, 'T1', sl.exerciseId)?.id).filter(Boolean));
  const t2Chosen = new Set(state.slots.filter(sl => sl.tier === 'T2').map(goalLift));
  // Power work (jumps, cleans) leads with a family you have any goal for.
  const anyGoalFamilies = new Set(state.slots.map(sl => sl.familyId));
  // Once every family is in use: another move from a family this workout already uses, if it's a different
  // movement (triceps after curls). Families from the goals or the session so far stay off limits.
  const famPatterns = new Map();
  // Last resort while time is left: any exercise not in the workout yet, from any family (a second core or upper-back move).
  const takenIds = new Set(taken);
  const spare = e => !e.archived && isAvailable(e, loc) && !takenIds.has(e.id) && !k.blocks.some(b => b.exerciseId === e.id);
  const reusable = e => !e.archived && isAvailable(e, loc) && famPatterns.has(e.familyId) && !takenIds.has(e.id)
    && !famPatterns.get(e.familyId).has(pattern(e)) && !k.blocks.some(b => b.exerciseId === e.id);
  const k = {
    blocks: [], notes: [], budget: minutes, lately, isDefault, turn: 0,
    // Patterns that already have a strength lift (T1/T2, not jumps or cleans), so the next lift goes somewhere else.
    present: new Set(present.map(id => pattern(byId(state.exercises, id)))),
    count: tier => k.blocks.filter(b => b.tier === tier).length,
    add(e, tier, why, dose = null) {
      const slot = slotFor(state, e, tier);
      const sc = pickScheme(state, tier, e, k.budget - WARMUP[tier], ci, dose ?? slotDose(state, slot, tier));
      if (!sc) return false;
      // T3s go in supersets, and a partner's sets fit in the other's rest: every second one costs half.
      const share = tier === 'T3' && k.count('T3') % 2 === 1 ? 0.5 : 1;
      k.blocks.push({ id: uid(), tier, slotId: slot?.id ?? null, exerciseId: e.id, schemeId: sc.id, swaps: [] });
      famUsed.add(e.familyId);
      famPatterns.set(e.familyId, (famPatterns.get(e.familyId) ?? new Set()).add(pattern(e)));
      if ((tier === 'T1' || tier === 'T2') && !e.explosive) k.present.add(pattern(e));
      k.budget -= (sc.minutes + WARMUP[tier]) * share;
      k.notes.push(`${tier} ${e.name}: ${why}`);
      return true;
    },
    // Explosive exercises for a region (whole-body lifts count for either). `sameFamily` allows a second clean variation.
    explosives(region, { load = null, sameFamily = null } = {}) {
      return state.exercises.filter(e => e.explosive && !e.archived && isAvailable(e, loc) && (e.role ?? 'power') === 'power'
        && (!famUsed.has(e.familyId) || e.familyId === sameFamily) && !k.blocks.some(b => b.exerciseId === e.id)
        && (region === 'any' || e.region === region || e.region === 'full')
        && (load == null || (e.metric === 'load_reps') === load))
        .sort((a, b) => anyGoalFamilies.has(b.familyId) - anyGoalFamilies.has(a.familyId) || (b.region === region) - (a.region === region)
          || lately(b) - lately(a) || isDefault(b) - isDefault(a) || a.rank - b.rank);
    },
    // A loaded lift for a movement pattern. T1: one of your T1 goals' lifts when you have T1 goals, else one with a max
    // (T1 insists when any has one; `needMax` always). T2: your T2 goals' lifts first, and not a T1 goal's own lift when
    // another fits. Then lifts from goal families, ones you do, with a max, the family's usual one.
    main(p, tier, needMax = false) {
      let c = state.exercises.filter(e => usable(e) && !e.explosive && e.metric === 'load_reps' && isMainLift(e) && pattern(e) === p);
      if (tier === 'T1' && hasT1Goals) c = c.filter(e => t1Core.has(e.id));
      else if (needMax || (tier === 'T1' && c.some(e => estimatedMax(state, e.id) != null))) c = c.filter(e => estimatedMax(state, e.id) != null);
      const t1Goal = e => tier === 'T2' && t1Lifts.has(e.id);
      const chosen = e => tier === 'T2' && t2Chosen.has(e.id);
      return c.sort((a, b) => t1Goal(a) - t1Goal(b) || chosen(b) - chosen(a) || goalFamilies.has(b.familyId) - goalFamilies.has(a.familyId) || lately(b) - lately(a)
        || (estimatedMax(state, b.id) != null) - (estimatedMax(state, a.id) != null) || isDefault(b) - isDefault(a) || a.rank - b.rank)[0] ?? null;
    },
    // A lift from the patterns given that don't have a strength lift in the workout yet, trained heavy least recently.
    // For a T1 lift, "heavy" means T1: T2 work in a pattern doesn't make it look recently trained.
    strength(patterns, why, tier = 'T2', { needMax = false } = {}) {
      const t1Ago = p => (tier === 'T1' ? patLastT1.get(p) ?? 0 : 0);
      const order = patterns.filter(p => !k.present.has(p))
        .sort((a, b) => t1Ago(a) - t1Ago(b) || (patLast.get(a) ?? 0) - (patLast.get(b) ?? 0));
      for (const p of order) {
        const e = k.main(p, tier, needMax);
        if (e && k.add(e, tier, `${PATTERN_LABEL[p]}, ${why}`)) return true;
      }
      return false;
    },
    // No rack setups or weighted pull-ups and dips (dip belt: those are main lifts); the ones you do but haven't done for longest first.
    // `level`: 0 a family not used yet, 1 a different movement in a family this workout added, 2 anything not in the workout.
    accessory(p, level = 0) {
      const fits = [usable, reusable, spare][level];
      // Accessories may need a bar or plates; main lifts come in only without a barbell setup; drills never.
      const role = x => x.role ?? guessRole(x.name, x.metric, x.explosive);
      const base = state.exercises.filter(x => fits(x) && !x.explosive && !mainLifts.has(x.id) && ['accessory', 'main'].includes(role(x))
        && !(x.equipment || []).some(q => q === 'rack' || q === 'dip-belt' || (q === 'barbell' && role(x) !== 'accessory')));
      const of = q => base.filter(x => pattern(x) === q);
      const c = p === 'back' ? (of('hinge').some(x => LOWER_BACK.test(x.name)) ? of('hinge').filter(x => LOWER_BACK.test(x.name)) : of('hinge')) : of(p);
      return c.sort((a, b) => lately(b) - lately(a) || (exLast.get(a.id) ?? 0) - (exLast.get(b.id) ?? 0) || a.rank - b.rank)[0] ?? null;
    },
    // Go round the rotation until the time is used (or nothing else fits), at each of `levels` in turn (see accessory).
    // `limit` caps how many this call adds; returns how many it added.
    // The rotation carries on where the last call stopped, so one-at-a-time calls alternate (pull, push, pull, core...).
    accessories(rotation, maxBlocks, limit = Infinity, levels = [0, 1]) {
      const stop = Math.min(maxBlocks, k.blocks.length + limit), n = k.blocks.length;
      for (const level of levels) {
        for (let misses = 0; k.budget >= 5 && k.blocks.length < stop && misses < rotation.length; k.turn++) {
          const p = rotation[k.turn % rotation.length];
          const e = k.accessory(p, level);
          const why = () => level === 2 ? `another ${p === 'core' ? 'core' : PATTERN_LABEL[p]} accessory to fill the time`
            : p === 'core' ? 'core' : `${PATTERN_LABEL[p]} accessory${k.lately(e) ? ', not done for a while' : ''}`;
          if (e && k.add(e, 'T3', why())) misses = 0;
          else misses++;
        }
      }
      return k.blocks.length - n;
    },
  };
  return k;
}

// Explosive lower-body work: jumps, then a clean, and a second clean variation when there's time.
// Not fresh: one technique block instead (a clean if there is one). Returns whether anything was added.
function explosiveLower(state, ci, t, k) {
  const jump = k.explosives('lower', { load: false }).find(e => e.region === 'lower');
  const clean = k.explosives('full', { load: true })[0];
  const lead = clean ?? jump;
  if (!lead) { k.notes.push('No lower-body explosive exercise is available here, so this is a plain lower-body workout.'); return false; }
  const rd = powerReadiness(state, ci, lead, t);
  if (!rd.fresh) return k.add(lead, 'TECH', `technique instead of power (${rd.reasons.join('; ')})`);
  if (jump) k.add(jump, 'T2', 'jumps first, while you\'re fresh');
  if (clean) {
    k.add(clean, 'T1', 'clean variation for power');
    // A second clean variation if it still leaves room for a few accessories.
    const second = k.explosives('full', { load: true, sameFamily: clean.familyId }).find(e => e.familyId === clean.familyId);
    // Power reps (sets of 1-3, 10-20 in all), not a 5×5: it's speed work after the main clean.
    if (second && ci.intent !== 'easy' && k.budget >= 30) k.add(second, 'T2', 'second clean variation, lighter', { repMin: 10, repMax: 20 });
  }
  return k.blocks.length > 0;
}

// `sessionBlocks`: the workout so far, when this adds accessories for extra time (+ Time), so none is picked twice.
export function buildFocus(state, ci, { region, explosive = false, accessoriesOnly = false }, t = Date.now(), { excludeFamilies = [], sessionBlocks = [] } = {}) {
  const k = libraryKit(state, ci, t, ci.minutes, excludeFamilies, [], sessionBlocks.map(b => b.exerciseId));
  const tired = energy(ci) <= 2.5;
  const easy = ci.intent === 'easy';
  // Explosive lower days are led by jumps and cleans; they stand in for the heavy lifts.
  let led = false;
  if (explosive && !accessoriesOnly) {
    if (region === 'lower') led = explosiveLower(state, ci, t, k);
    else {
      // Explosive work for this region first; whole-body lifts (cleans) count for either.
      const e = k.explosives(region)[0];
      if (!e) k.notes.push(`No ${region}-body explosive exercise is available here, so this is a plain ${region}-body workout.`);
      else {
        const rd = powerReadiness(state, ci, e, t);
        if (rd.fresh) k.add(e, e.metric === 'load_reps' ? 'T1' : 'T2', 'explosive work first, while you\'re fresh');
        else k.add(e, 'TECH', `technique instead of power (${rd.reasons.join('; ')})`);
      }
    }
  }

  if (!accessoriesOnly && !led) {
    // Main lift: the pattern trained heavy least recently. Second lift: the other pattern, moderate.
    const heavyHere = regionConflict(region, recentHeavyRegions(state, t));
    const mainTier = tired || easy || heavyHere ? 'T2' : 'T1';
    if (mainTier === 'T2') k.notes.push(`Main lift at T2, not T1: ${tired ? 'low energy' : easy ? 'easy day' : `heavy ${region}-body work since yesterday`}.`);
    // Heavy work is one of your T1 lifts; when none fits this half or this place, the main lift is moderate instead.
    const main = k.strength(FOCUS_MAIN[region], 'main lift, trained heavy least recently', mainTier)
      || (mainTier === 'T1' && k.strength(FOCUS_MAIN[region], `main lift at T2: none of your T1 lifts is a ${region}-body lift you can do here`));
    if (!main) k.notes.push(`No loaded ${region}-body lift here, so accessories fill in.`);
    if (!easy) k.strength(FOCUS_MAIN[region], 'to balance it');
  }

  // Accessories, then more T2 work if there's still time, then accessories again. After jumps and cleans,
  // a couple of accessories (lower back, legs, core) come before any T2 lift.
  const cap = maxBlocks(ci.minutes);
  k.accessories(FOCUS_T3[region], cap, led ? 3 : Infinity);
  if (!accessoriesOnly && !easy && k.budget >= 10 && k.blocks.length < cap) k.strength(FOCUS_MAIN[region], 'to fill the time');
  k.accessories(FOCUS_T3[region], cap);
  settle(state, k, ci, FOCUS_T3[region], !accessoriesOnly);
  return { blocks: k.blocks, notes: k.notes, minutesUsed: Math.round(blocksMinutes(state, k.blocks)), ready: readinessSummary(state, ci, t) };
}

// Removes a dropped block's line from "How this was built".
const dropNote = (state, k, b) => { const head = `${b.tier} ${byId(state.exercises, b.exerciseId)?.name}:`; k.notes = k.notes.filter(n => !n.startsWith(head)); };

// Groups the T3s, then uses any time the grouping freed up (partners take half their minutes) for more
// accessories, then more sets. Mutates k.blocks.
function settle(state, k, ci, rotation, stretch = true) {
  const minutes = ci.minutes;
  for (;;) {
    regroup(state, k.blocks);
    const n = k.blocks.length;
    k.budget = minutes - blocksMinutes(state, k.blocks);
    // One more accessory: a new family or movement first, else another exercise from one already in.
    if (!k.accessories(rotation, maxBlocks(minutes), 1)) k.accessories(rotation, maxBlocks(minutes), 1, [2]);
    if (k.blocks.length === n) break;
  }
  for (const b of trimToFit(state, k.blocks, minutes, k.blocks)) dropNote(state, k, b);
  if (stretch) stretchToFit(state, k.blocks, minutes, ci);
}

// Tops up a goal-driven suggestion from the library so the whole time block is used: on a heavy day with no heavy
// lift yet, a T1 lift; then T2 lifts up to two (not on an easy day); then T3s, leaning toward the day's region if one was picked.
function fillTime(state, ci, t, blocks, budget, famUsed, sessionBlocks = []) {
  const lean = leanOf(ci);
  const isStrength = b => (b.tier === 'T1' || b.tier === 'T2') && !byId(state.exercises, b.exerciseId)?.explosive;
  const k = libraryKit(state, ci, t, budget, famUsed, [...sessionBlocks, ...blocks].filter(isStrength).map(b => b.exerciseId),
    [...sessionBlocks, ...blocks].map(b => b.exerciseId));
  const intro = `Your open goals fill ${ci.minutes - budget} of your ${ci.minutes} minutes, so the rest is from your library${lean ? `, leaning ${lean}-body` : ''}:`;
  // The half you lean toward first; the other half only once that one has a strength lift in each pattern.
  const halves = lean ? [FOCUS_MAIN[lean], FOCUS_MAIN[lean === 'upper' ? 'lower' : 'upper']] : [[...FOCUS_MAIN.upper, ...FOCUS_MAIN.lower]];
  const pick = (tier, why, opts = {}, ok = () => true) => halves.some(ps => k.strength(ps.filter(ok), why, tier, opts));
  const strengthIn = tier => [...sessionBlocks, ...blocks, ...k.blocks].filter(b => b.tier === tier && isStrength(b)).length;
  // Heavy day, not tired, no heavy lift in the session yet: one T1 lift you've loaded (it has an estimated max), from a
  // pattern whose half of the body hasn't had heavy work since yesterday.
  if (ci.intent === 'heavy' && energy(ci) > 2.5 && !strengthIn('T1') && k.budget >= 15) {
    const heavy = recentHeavyRegions(state, t);
    pick('T1', 'heavy day, no heavy work there since yesterday', { needMax: true }, p => !regionConflict(PATTERN_REGION[p], heavy));
  }
  // Up to two T2 strength lifts in the session (goal ones count; jumps and cleans are power work and don't),
  // each from a pattern with no strength lift yet, least recently trained heavy first.
  while (ci.intent !== 'easy' && k.budget >= 15 && strengthIn('T2') < 2 && pick('T2', 'to fill the time'));
  const all = () => [...blocks, ...k.blocks];
  const room = maxBlocks(ci.minutes) - blocks.length;
  // A lean is a bias, not a limit: once that half of the library runs out, the rest of the time still gets used.
  const rotations = lean ? [FOCUS_T3[lean], FOCUS_T3.either] : [FOCUS_T3.either];
  for (const r of rotations) k.accessories(r, room);
  // Grouping T3s into supersets frees time (a partner counts half): group them, then add one more while one fits.
  for (;;) {
    const merged = regroup(state, all());
    k.budget = ci.minutes - blocksMinutes(state, merged);
    const n = k.blocks.length;
    // A new family or movement from either rotation first, else another exercise from a family already in.
    for (const level of [[0, 1], [2]]) for (const r of rotations) if (k.blocks.length === n) k.accessories(r, room, 1, level);
    if (k.blocks.length === n) break;
  }
  // Never over the time: a T3 that ends up outside a superset costs its full minutes.
  for (const b of trimToFit(state, all(), ci.minutes, k.blocks)) dropNote(state, k, b);
  return { blocks: k.blocks, notes: k.blocks.length ? [intro, ...k.notes] : [] };
}

// ---------- analytics ----------

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function sessionStats(state, start = 0, end = Infinity) {
  const done = state.sessions.filter(s => s.checkinAt >= start && s.checkinAt < end && s.firstSetAt);
  const bySource = { suggested: 0, swapped: 0, custom: 0 };
  for (const s of done) bySource[s.source] = (bySource[s.source] || 0) + 1;
  return {
    count: done.length,
    medianToFirstSet: median(done.map(s => (s.firstSetAt - s.checkinAt) / 1000)),
    bySource,
  };
}
