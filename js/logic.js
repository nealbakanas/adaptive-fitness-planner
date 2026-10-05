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
  if (tier === 'T1' || tier === 'T2') members = members.filter(e => e.metric === 'load_reps' || e.explosive);
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
const countsForMax = s => !s.tier || s.tier === 'T1' || s.tier === 'T2';

// Best e1RM across the last 3 T1/T2 sessions with this exercise, before `before`.
// Falls back to the exercise's starting max (added load for bodyweight moves).
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
  if (recent.length) return Math.max(...recent.map(r => r.e));
  const ex = byId(state.exercises, exerciseId);
  if (!ex?.startMax) return null;
  if (ex.bodyweight) return state.settings.bodyweight ? state.settings.bodyweight + ex.startMax : null;
  return ex.startMax;
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
    if (s.done && s.exerciseId === exerciseId && s.load != null && s.load !== '' && (!best || s.loggedAt > best.loggedAt)) best = s;
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
  if (!ex) return null;
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
    if (!s.done || s.loggedAt < start || s.loggedAt >= end) continue;
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
  return state.sets.some(s => s.done && s.tier === 'T1' && s.loggedAt >= from && s.loggedAt < t);
}

// Heavy (T1) work logged since the start of yesterday, as the set of body regions it taxed.
// Explosive T1 work (cleans, jumps) doesn't count: it's fast rather than grinding.
export function recentHeavyRegions(state, t = Date.now(), excludeBlockId = null) {
  const from = startOfDay(t) - DAY;
  const out = new Set();
  for (const s of state.sets) {
    if (!s.done || s.tier !== 'T1' || s.loggedAt < from || s.loggedAt >= t || s.blockId === excludeBlockId) continue;
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
  const sets = state.sets.filter(s => s.done && s.exerciseId === exerciseId).sort((a, b) => b.loggedAt - a.loggedAt);
  for (const s of sets) {
    if (!seen.some(x => x.sessionId === s.sessionId)) seen.push(s);
    if (seen.length >= n) break;
  }
  return seen.map(s => s.schemeId);
}

export const overRepCap = (ex, sc) => !!ex?.maxReps && sc.reps > ex.maxReps;

// Time and the exercise's rep cap are hard filters; dose fit, energy, variety and chunkability are soft weights.
export function pickScheme(state, tier, ex, budget, ci, dose = null) {
  const recent = recentSchemes(state, ex.id, 2);
  const e = energy(ci);
  let best = null, bestScore = -Infinity;
  for (const sc of schemeOptions(state, tier)) {
    if (sc.minutes > budget || overRepCap(ex, sc)) continue;
    let s = 0;
    if (doseFit(state, tier, sc, dose)) s += 3;
    if (e <= 2.5) s += (6 - sc.reps) * 0.3;          // low energy: low reps, many sets
    else if (e >= 3.5 && !ex.explosive) s += sc.sets * sc.reps * 0.04; // high energy: more volume, but not for power work
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

// Build one session: T1, then T2, technique and T3 until the time budget runs out.
export function buildSuggestion(state, ci, t = Date.now(), { excludeFamilies = [] } = {}) {
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
  blocks.sort((a, b) => blockRank(state, a) - blockRank(state, b)); // stable, so tier order holds within a rank
  pairT3s(state, blocks);
  return { blocks, scored, minutesUsed: ci.minutes - budget, ready: readinessSummary(state, ci, t) };
}

// ---------- supersets ----------

// Movement pattern from the exercise and family names. First match wins, so specific patterns come first
// ("leg curl" is hamstrings, not arms; "leg raise" is core, not shoulders).
const PATTERNS = [
  ['core', /\bcore\b|\babs?\b|plank|crunch|sit[- ]?up|leg raise|knee raise|rollout|ab[- ]?wheel|dead ?bug|hollow|pallof|l[- ]?sit|toes to bar|v[- ]?up/i],
  ['calf', /\bcalf|calves/i],
  ['hinge', /deadlift|\brdls?\b|romanian|good ?morning|back extension|hyperextension|hip thrust|glute|nordic|hamstring|\bghr\b|leg curl|swing|hinge|(block|rack|deficit) pulls?\b/i],
  ['full', /clean|snatch|jerk|thruster|burpee/i],
  ['knee', /squat|lunge|split|step[- ]?up|leg press|leg extension|pistol|jump|bound|\bhops?\b|skater/i],
  ['pull', /pull[- ]?ups?|chin[- ]?ups?|\brows?\b|pulldown|face pull|pull[- ]?apart|rear[- ]?delt|curl|shrug|vertical pull|upper back|\blats?\b/i],
  ['push', /\bdips?\b|press|push[- ]?ups?|bench|incline|tricep|telle|extension|skull|push ?down|raise|\bfly\b|chest|shoulder/i],
];
export function movementPattern(state, e) {
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
  const mainLifts = new Set(state.slots.filter(sl => sl.tier === 'T1' || sl.tier === 'T2')
    .map(sl => sl.exerciseId ?? byId(state.families, sl.familyId)?.defaultExerciseId));
  const since = Date.now() - 84 * DAY;
  const lately = state.sets.filter(x => x.done && x.loggedAt >= since);
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
