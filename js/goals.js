// Weekly goals suggested from your history: the movements you've trained lately and how often, with GZCL tiers
// for the lifts and explosive (athletic) work first. Pure functions; the Week tab shows the result for review.
import * as L from './logic.js';

const DAY = 864e5;
const BLOCKS_PER_WORKOUT = 3; // about what fits in a 45-minute workout
const CHEST = /bench|incline|chest|fly/i;
const SHOULDERS = /overhead|shoulder|military|lateral/i;
// Display order, and the order goals are kept when the week is too full (last kept longest).
const KIND_ORDER = ['power-lift', 'technique', 'power', 'strength', 'support', 'press', 'accessory'];
const TRIM_ORDER = ['accessory', 'technique', 'support', 'strength', 'power', 'press', 'power-lift'];

// Reps for crediting and "contacts": a timed or distance set (a sprint, a hold) counts as one.
const repsOf = s => Number(s.reps) > 0 ? Number(s.reps) : (s.time > 0 || s.distance > 0 ? 1 : 0);

// Per family: workout days, and which of them had explosive, loaded or each tier's work.
function familyStats(state, now, days) {
  const from = now - days * DAY;
  const byFam = new Map();
  const workouts = new Set();
  for (const s of state.sets) {
    if (!s.done || s.warmup || s.loggedAt < from || s.loggedAt >= now) continue;
    const ex = L.byId(state.exercises, s.exerciseId);
    if (!ex) continue;
    const day = L.dayKey(s.loggedAt);
    workouts.add(day);
    if (!byFam.has(ex.familyId)) {
      byFam.set(ex.familyId, { days: new Set(), explosive: new Set(), loaded: new Set(), tiers: { T1: new Set(), T2: new Set(), T3: new Set(), TECH: new Set() }, reps: new Map(), uses: new Map() });
    }
    const f = byFam.get(ex.familyId);
    f.days.add(day);
    if (ex.explosive) f.explosive.add(day);
    if (ex.metric === 'load_reps') f.loaded.add(day);
    f.tiers[s.tier]?.add(day);
    f.reps.set(day, (f.reps.get(day) ?? 0) + repsOf(s));
    if (!f.uses.has(ex.id)) f.uses.set(ex.id, new Set());
    f.uses.get(ex.id).add(day);
  }
  return { byFam, workouts: workouts.size };
}

const mostUsed = (state, f) => L.byId(state.exercises, [...f.uses].sort((a, b) => b[1].size - a[1].size)[0][0]);

// What to suggest, with a reason for each. Rows are editable before they become goals.
export function suggestGoals(state, { now = Date.now() } = {}) {
  let days = 84;
  let st = familyStats(state, now, days);
  if (st.workouts < 8) { days = 182; st = familyStats(state, now, days); } // too thin: look back six months
  const weeks = Math.round(days / 7);
  const perWeek = st.workouts / weeks;
  const result = { rows: [], weeks, workouts: st.workouts, perWeek, capacity: 0, heavyCap: 0 };
  if (st.workouts < 4) return result;

  const capacity = Math.max(3, Math.round(perWeek * BLOCKS_PER_WORKOUT));
  const heavyCap = Math.max(1, Math.round(perWeek)); // GZCL: one heavy (T1) lift per workout
  const minDays = Math.max(3, Math.round(weeks / 4)); // trained at least every few weeks
  const quotaOf = n => Math.min(3, Math.max(1, Math.round(n / weeks)));
  const usable = famId => L.familyMembers(state, famId).some(e => !e.archived);
  const rows = [];

  for (const [familyId, f] of st.byFam) {
    const fam = L.byId(state.families, familyId);
    const n = f.days.size;
    if (!fam || !usable(familyId)) continue;
    const top = mostUsed(state, f);
    const isPress = CHEST.test(fam.name) || SHOULDERS.test(fam.name);
    if (n < minDays && !isPress) continue;
    const explosive = f.explosive.size * 2 >= n;
    const loaded = f.loaded.size * 2 >= n;
    const base = { familyId, exerciseId: null, repMin: null, repMax: null, days: n, top: top?.name, region: top?.region ?? 'full', include: true };
    const where = `${n} of your last ${st.workouts} workouts, mostly ${top?.name}`;
    if (explosive && loaded) {
      rows.push({ ...base, kind: 'power-lift', tier: 'T1', quota: quotaOf(n), priority: 3,
        reason: `Explosive lift in ${where}. Heavy sets of 1–3 when you're fresh.` });
    } else if (explosive) {
      // About 12 contacts is a solid power dose (4×3); more than that and the reps stop being fast.
      const repMin = Math.min(12, Math.max(6, Math.round(L.median([...f.reps.values()]))));
      rows.push({ ...base, kind: 'power', tier: 'T2', quota: quotaOf(n), priority: base.region === 'upper' ? 2 : 3, repMin, repMax: Math.max(repMin, 20),
        reason: `Explosive work in ${where}: about ${repMin} reps a session.` });
    } else if (isPress) {
      rows.push({ ...base, kind: 'press', tier: 'T2', quota: 1, priority: 1,
        reason: `${CHEST.test(fam.name) ? 'Chest' : 'Shoulders'}: kept in at low priority, as you asked. In ${where}.` });
    } else if (loaded && (f.tiers.T1.size || f.tiers.T2.size)) {
      const tier = f.tiers.T1.size >= f.tiers.T2.size ? 'T1' : 'T2';
      rows.push({ ...base, kind: 'strength', tier, quota: quotaOf(n), priority: 2, heavyDays: f.tiers.T1.size,
        reason: tier === 'T1' ? `Heavy sets of 1–3 in ${f.tiers.T1.size} of ${n} workouts, mostly ${top?.name}.` : `Moderate sets in ${where}.` });
    } else {
      rows.push({ ...base, kind: 'accessory', tier: 'T3', quota: quotaOf(n), priority: 1, reason: `Accessory work in ${where}.` });
    }
  }

  // Technique: the main explosive lift also gets a lighter goal for tired days or after heavy work.
  const mainLift = rows.filter(r => r.kind === 'power-lift').sort((a, b) => b.days - a.days)[0];
  if (mainLift && state.tiers.TECH) {
    rows.push({ ...mainLift, kind: 'technique', tier: 'TECH', quota: 1, priority: 1,
      reason: `Lighter ${L.byId(state.families, mainLift.familyId).name.toLowerCase()} for days you're tired or after heavy work. Counts separately from the heavy goal.` });
  }

  // Chest and shoulders stay in even when they haven't been trained lately (low priority, once a week).
  const year = familyStats(state, now, 365).byFam;
  for (const [label, re] of [['Chest', CHEST], ['Shoulders', SHOULDERS]]) {
    if (rows.some(r => re.test(L.byId(state.families, r.familyId)?.name ?? ''))) continue;
    const fam = state.families.filter(x => re.test(x.name) && usable(x.id))
      .sort((a, b) => (year.get(b.id)?.days.size ?? 0) - (year.get(a.id)?.days.size ?? 0))[0];
    if (!fam) continue;
    const n = year.get(fam.id)?.days.size ?? 0;
    rows.push({ familyId: fam.id, exerciseId: null, repMin: null, repMax: null, days: 0, region: 'upper', include: true,
      kind: 'press', tier: 'T2', quota: 1, priority: 1,
      reason: `${label}: kept in at low priority, as you asked${n ? `. ${n} workouts in the last year` : ''}.` });
  }

  // One heavy lift per workout: explosive lifts first, then lower body (it carries over to jumping).
  const heavyOrder = { 'power-lift': 0, strength: 1 };
  const regionOrder = { lower: 0, full: 1, upper: 2 };
  let heavy = 0;
  for (const r of rows.filter(x => x.tier === 'T1')
    .sort((a, b) => heavyOrder[a.kind] - heavyOrder[b.kind] || regionOrder[a.region] - regionOrder[b.region] || b.days - a.days)) {
    if (heavy + r.quota <= heavyCap) { heavy += r.quota; continue; }
    if (r.kind === 'power-lift' && heavy < heavyCap) { r.quota = heavyCap - heavy; heavy = heavyCap; continue; }
    r.kind = 'support';
    r.tier = 'T2';
    r.reason += ` There's room for about ${heavyCap} heavy lift${heavyCap === 1 ? '' : 's'} a week, so this is T2 support work, which GZCL pairs with the heavy lifts.`;
  }

  // Room left for heavy work: lifts you've done heavy in at least 3 workouts (and a third of them) become T1, lower body first.
  for (const r of rows.filter(x => x.kind === 'strength' && x.tier === 'T2' && x.heavyDays >= Math.max(3, x.days / 3))
    .sort((a, b) => regionOrder[a.region] - regionOrder[b.region] || b.heavyDays - a.heavyDays)) {
    if (heavy + r.quota > heavyCap) continue;
    heavy += r.quota;
    r.tier = 'T1';
    r.reason = `Heavy sets of 1–3 in ${r.heavyDays} of ${r.days} workouts, mostly ${r.top}. A main lift: T1.`;
  }

  // Fit the week: trim accessories first, explosive lifts last.
  let total = rows.reduce((t, r) => t + r.quota, 0);
  for (const r of [...rows].sort((a, b) => TRIM_ORDER.indexOf(a.kind) - TRIM_ORDER.indexOf(b.kind) || a.days - b.days)) {
    while (total > capacity && r.quota > 1) { r.quota--; total--; }
    if (total > capacity) {
      r.include = false;
      total -= r.quota;
      r.reason += ` Left unticked so the week fits about ${perWeek.toFixed(1)} workouts.`;
    }
  }

  rows.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.days - a.days);
  rows.forEach((r, i) => { r.key = String(i); });
  return { ...result, rows, capacity, heavyCap };
}

// Turns the ticked rows into goals. Replace swaps out every current goal; add keeps them and skips duplicates.
// Returns the goals from before, for undo.
export function applyGoals(state, rows, mode = 'replace') {
  const before = state.slots.map(s => ({ ...s }));
  const fresh = rows.filter(r => r.include).map(r => ({
    id: L.uid(), familyId: r.familyId, exerciseId: r.exerciseId ?? null, tier: r.tier, quota: r.quota, priority: r.priority,
    repMin: r.repMin ?? null, ...(r.repMax ? { repMax: r.repMax } : {}),
  }));
  state.slots = mode === 'replace' ? fresh
    : [...state.slots, ...fresh.filter(g => !state.slots.some(s => s.familyId === g.familyId && s.tier === g.tier && !s.exerciseId))];
  return before;
}
