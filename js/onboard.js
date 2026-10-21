// Onboarding: a short setup for new users (and "Set up again" in Settings) that turns a few choices into weekly goals.
// Pure functions on a draft; app.js does the screens. Finishing replaces goals, locations and a few settings, never history.
import * as L from './logic.js';
import { weekBudget, usualWeek } from './goals.js';

export const STEPS = ['welcome', 'you', 'where', 'week', 'heavy', 'support', 'pump', 'maxes', 'review'];

// Families offered as power work (T2) and as accessory areas (T3), in display order.
export const POWER_FAMILIES = ['fam-jumps', 'fam-clean', 'fam-snatch', 'fam-jerk'];
export const PUMP_FAMILIES = ['fam-upperback', 'fam-arms', 'fam-core', 'fam-hips', 'fam-hams', 'fam-hinge', 'fam-calves', 'fam-grip'];
const OLYMPIC = ['fam-clean', 'fam-snatch', 'fam-jerk'];
const PATTERN_GROUPS = [['knee', 'Squat'], ['hinge', 'Hinge'], ['push', 'Push'], ['pull', 'Pull']];

// A fresh install that hasn't been set up yet.
export const isNewUser = state => state.settings.onboarded === false && !state.sets.length && !state.sessions.length;

const goalLift = (state, sl) => sl.exerciseId ?? L.byId(state.families, sl.familyId)?.defaultExerciseId;
const roleOf = e => e.role ?? L.guessRole(e.name, e.metric, e.explosive);

// A draft prefilled from the current setup: the starter goals for a new user, your own goals when you set up again.
export function startDraft(state, now = Date.now()) {
  const wk = usualWeek(state, now);
  const t1 = {}, t2 = {}, power = {}, pump = {};
  for (const sl of state.slots) {
    const e = L.byId(state.exercises, goalLift(state, sl));
    if (sl.tier === 'T1' && e && roleOf(e) === 'main') t1[e.id] = sl.quota;
    else if ((sl.tier === 'T2' || sl.tier === 'JUMP') && POWER_FAMILIES.includes(sl.familyId)) power[sl.familyId] = sl.quota;
    else if (sl.tier === 'T2' && e && roleOf(e) === 'main') t2[e.id] = sl.quota;
    else if (sl.tier === 'T3' && PUMP_FAMILIES.includes(sl.familyId)) pump[sl.familyId] = sl.quota;
  }
  const maxes = {};
  for (const id of [...Object.keys(t1), ...Object.keys(t2)]) {
    const load = L.byId(state.exercises, id)?.testedMax?.load;
    if (load) maxes[id] = load;
  }
  return {
    step: 0,
    unit: state.settings.unit || 'lb',
    bodyweight: state.settings.bodyweight ?? null,
    locations: state.locations.map(l => ({ id: l.id, name: l.name, equipment: [...l.equipment] })),
    week: { workouts: state.settings.week?.workouts ?? wk.workouts, minutes: state.settings.week?.minutes ?? wk.minutes },
    t1, t2, power, pump, maxes,
  };
}

const usableHere = (draft, e) => !e.archived && draft.locations.some(loc => L.isAvailable(e, loc));

// Main lifts you can do at one of your locations, grouped by movement: [[label, [exercise...]]].
export function strengthChoices(state, draft) {
  const lifts = state.exercises.filter(e => usableHere(draft, e) && e.metric === 'load_reps' && !e.explosive && roleOf(e) === 'main');
  const groups = PATTERN_GROUPS.map(([p, label]) => [label, lifts.filter(e => L.movementPattern(state, e) === p)]);
  const rest = lifts.filter(e => !PATTERN_GROUPS.some(([p]) => L.movementPattern(state, e) === p));
  if (rest.length) groups.push(['Other', rest]);
  return groups.map(([label, list]) => [label, list.sort((a, b) => (a.familyId === b.familyId ? a.rank - b.rank : 0) || a.name.localeCompare(b.name))])
    .filter(([, list]) => list.length);
}

// Families with something you can do at one of your locations.
const familiesWith = (state, draft, ids, ok) => ids.map(id => L.byId(state.families, id))
  .filter(f => f && state.exercises.some(e => e.familyId === f.id && usableHere(draft, e) && ok(e)));
export const powerChoices = (state, draft) => familiesWith(state, draft, POWER_FAMILIES, e => roleOf(e) === 'power');
export const pumpChoices = (state, draft) => familiesWith(state, draft, PUMP_FAMILIES, e => roleOf(e) === 'accessory');

// The weekly goals the draft describes. Heavy and support lifts are named goals; power and accessories are family-wide.
// An Olympic lift family also gets a technique goal for tired days, as Suggest from history does.
export function buildSlots(state, draft) {
  const ex = id => L.byId(state.exercises, id);
  const slots = [];
  const add = (sl) => slots.push({ id: L.uid(), ...sl });
  for (const [id, quota] of Object.entries(draft.t1)) if (ex(id)) add({ familyId: ex(id).familyId, exerciseId: id, tier: 'T1', quota, priority: 3 });
  for (const [id, quota] of Object.entries(draft.t2)) if (ex(id)) add({ familyId: ex(id).familyId, exerciseId: id, tier: 'T2', quota, priority: 2 });
  for (const [fid, quota] of Object.entries(draft.power)) {
    add({ familyId: fid, tier: fid === 'fam-jumps' ? 'JUMP' : 'T2', quota, priority: 2, ...(fid === 'fam-jumps' ? { repMin: 12, repMax: 20 } : {}) });
    if (OLYMPIC.includes(fid)) add({ familyId: fid, tier: 'TECH', quota: 1, priority: 1 });
  }
  for (const [fid, quota] of Object.entries(draft.pump)) add({ familyId: fid, tier: 'T3', quota, priority: 1 });
  return slots;
}

// The week budget for the draft's goals and week (see goals.js weekBudget).
export function draftBudget(state, draft) {
  return weekBudget({ ...state, slots: buildSlots(state, draft), settings: { ...state.settings, week: { ...draft.week } } });
}

// Puts the draft into the state: settings, locations, goals and tested maxes. Logged history is untouched.
export function applyDraft(state, draft, now = Date.now()) {
  const st = state.settings;
  if (draft.unit !== st.unit) { st.unit = draft.unit; st.increment = draft.unit === 'kg' ? 2.5 : 5; }
  st.bodyweight = draft.bodyweight > 0 ? Number(draft.bodyweight) : null;
  st.week = { workouts: Number(draft.week.workouts) || null, minutes: Number(draft.week.minutes) || null };
  state.locations = draft.locations.map(l => ({ id: l.id, name: l.name.trim() || 'Gym', equipment: [...l.equipment] }));
  state.equipment = [...new Set([...state.equipment, ...state.locations.flatMap(l => l.equipment)])];
  state.slots = buildSlots(state, draft);
  for (const [id, load] of Object.entries(draft.maxes)) {
    const e = L.byId(state.exercises, id);
    if (!e || !(Number(load) > 0) || Number(load) === Number(e.testedMax?.load)) continue;
    e.testedMax = { load: Number(load), at: now };
  }
  st.onboarded = true;
  return state;
}
