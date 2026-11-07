// Library categories added after the first release: Arms split into Biceps and Triceps, and Shoulders for raises.
// One function, splitCategories, used for new installs (seed.js) and as the v31 upgrade (store.js). It changes only what
// still looks like the starter library, never twice, and nothing you've made yourself.

export const TRICEPS = /tricep|french press|skull|push ?down|overhead extension|seated barbell extension/i;
const DELTS = /lateral raise|delt raise|deltoid|front raise/i;

export const NEW_FAMILIES = [
  { id: 'fam-triceps', name: 'Triceps (pump)', region: 'upper' },
  { id: 'fam-shoulders', name: 'Shoulders (pump)', region: 'upper' },
];

// [id, name, familyId, metric, equipment, anytime]
const ROWS = [
  ['ex-cable-pushdown', 'Cable triceps pushdown', 'fam-triceps', 'load_reps', ['cable'], false],
  ['ex-band-pushdown', 'Band triceps pushdown', 'fam-triceps', 'reps', ['bands'], true],
  ['ex-skull-crusher', 'Skull crusher', 'fam-triceps', 'load_reps', ['barbell', 'bench'], false],
  ['ex-db-hammer-curl', 'DB hammer curl', 'fam-arms', 'load_reps', ['dumbbells'], false],
  ['ex-db-lateral-raise', 'DB lateral raise', 'fam-shoulders', 'load_reps', ['dumbbells'], false],
  ['ex-cable-lateral-raise', 'Cable lateral raise', 'fam-shoulders', 'load_reps', ['cable'], false],
  ['ex-band-lateral-raise', 'Band lateral raise', 'fam-shoulders', 'reps', ['bands'], true],
  ['ex-db-front-raise', 'DB front raise', 'fam-shoulders', 'load_reps', ['dumbbells'], false],
  ['ex-plate-front-raise', 'Plate front raise', 'fam-shoulders', 'load_reps', ['barbell'], false],
];
export const NEW_EXERCISES = ROWS.map(([id, name, familyId, metric, equipment, anytime]) => ({
  id, name, familyId, rank: 99, metric, equipment, anytime, region: 'upper', explosive: false, bodyweight: false,
  youtube: '', start: null, cues: '', startMax: null, testedMax: null, maxReps: null, restSec: null, role: 'accessory',
}));

const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const members = (s, famId) => s.exercises.filter(e => e.familyId === famId).sort((a, b) => a.rank - b.rank);
const renumber = (s, famId) => members(s, famId).forEach((e, i) => { e.rank = i + 1; });

// Moves exercises into a category; goals that name one go with it, and the old category's usual choice is fixed up.
function move(s, list, famId) {
  const olds = new Set(list.map(e => e.familyId));
  for (const e of list) {
    e.familyId = famId;
    for (const sl of s.slots) if (sl.exerciseId === e.id) sl.familyId = famId;
  }
  for (const id of olds) {
    const f = s.families.find(x => x.id === id);
    if (f && list.some(e => e.id === f.defaultExerciseId)) f.defaultExerciseId = members(s, id).find(e => !e.archived)?.id ?? null;
    renumber(s, id);
  }
}

// Adds a category unless there is one with its id or name. Returns it, or null when one of yours is already there.
function addFamily(s, f) {
  if (s.families.some(x => x.id === f.id || norm(x.name) === norm(f.name))) return null;
  const fam = { id: f.id, name: f.name, defaultExerciseId: null };
  s.families.push(fam);
  return fam;
}

export function splitCategories(s) {
  const arms = s.families.find(f => f.id === 'fam-arms');
  // Triceps out of Arms; Arms becomes Biceps (unless you renamed it). Each Arms goal gets a Triceps twin, so triceps work
  // keeps coming up as before.
  const tri = arms && addFamily(s, NEW_FAMILIES[0]);
  if (tri) {
    move(s, members(s, 'fam-arms').filter(e => TRICEPS.test(e.name)), tri.id);
    if (/^arms\b/i.test(arms.name)) arms.name = 'Biceps (pump)';
    for (const sl of s.slots.filter(x => x.familyId === 'fam-arms' && !x.exerciseId)) {
      if (!s.slots.some(x => x.id === `${sl.id}-triceps`)) s.slots.push({ ...sl, id: `${sl.id}-triceps`, familyId: tri.id });
    }
  }
  // Shoulders: the delt raises from Upper back, plus a few standard ones.
  const sh = addFamily(s, NEW_FAMILIES[1]);
  if (sh) move(s, members(s, 'fam-upperback').filter(e => DELTS.test(e.name)), sh.id);
  // New exercises, into categories that are there (yours by the same name are kept).
  for (const e of NEW_EXERCISES) {
    if (!s.families.some(f => f.id === e.familyId) || s.exercises.some(x => x.id === e.id || norm(x.name) === norm(e.name))) continue;
    s.exercises.push({ ...e, equipment: [...e.equipment], rank: members(s, e.familyId).length + 1 });
  }
  for (const f of s.families.filter(x => NEW_FAMILIES.some(n => n.id === x.id))) {
    renumber(s, f.id);
    f.defaultExerciseId ??= members(s, f.id).find(e => !e.archived)?.id ?? null;
  }
  for (const eq of ['cable', 'bands', 'dumbbells', 'barbell', 'bench']) if (s.equipment && !s.equipment.includes(eq)) s.equipment.push(eq);
  return s;
}
