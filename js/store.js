// Local persistence. The whole app state is one JSON blob so a backend can replace this later.
import { seed, defaultAnytime } from './seed.js';
import { guessRegion, guessExplosive } from './logic.js';

// Test pages set their own key so they never touch real data.
const KEY = globalThis.AFP_STORAGE_KEY ?? 'afp.v1';

// Set when saved data exists but couldn't be opened. Saving stays off until you choose what to do,
// so a bug in an upgrade step can never overwrite your only copy.
export let loadProblem = null;
// Why the most recent save failed, or null once a save succeeds again.
export let lastSaveError = null;
let saveFailHandler = null;
export const onSaveFail = fn => { saveFailHandler = fn; };

export let state = load();

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch (e) {
    loadProblem = { message: 'This browser is blocking storage, so nothing can be saved here.', raw: null };
    return seed();
  }
  if (!raw) return seed();
  try {
    return migrate(JSON.parse(raw));
  } catch (e) {
    console.error('Could not open saved data', e);
    loadProblem = { message: `Your saved data couldn't be opened (${e.message}). Nothing will be saved until you choose what to do.`, raw };
    return seed();
  }
}

// Fill in any top-level keys added since the data was saved.
export function migrate(s) {
  const base = seed();
  s.version ??= 1; // before the defaults below, or a backup without a version would skip every upgrade
  for (const k of Object.keys(base)) if (s[k] === undefined) s[k] = base[k];
  s.settings = { ...base.settings, ...s.settings };
  // Equipment list: anything a location or exercise uses, plus whatever you've added.
  s.equipment = [...new Set([...s.equipment, ...s.locations.flatMap(l => l.equipment), ...s.exercises.flatMap(e => e.equipment || [])])];
  if (s.version < 2) {
    // v2: office kit (dip belt, kettlebells, ab wheel) and the ab wheel exercise
    const office = s.locations.find(l => l.id === 'loc-office');
    if (office) for (const eq of ['dip-belt', 'kettlebell', 'ab-wheel']) if (!office.equipment.includes(eq)) office.equipment.push(eq);
    const basement = s.locations.find(l => l.id === 'loc-basement');
    if (basement && !basement.equipment.includes('ab-wheel')) basement.equipment.push('ab-wheel');
    if (!s.exercises.some(e => e.id === 'ex-ab-wheel') && s.families.some(f => f.id === 'fam-core')) {
      s.exercises.push(base.exercises.find(e => e.id === 'ex-ab-wheel'));
    }
    s.version = 2;
  }
  if (s.version < 3) {
    // v3: weighted ring dips, for dipping at the office where there's no dip station
    if (!s.exercises.some(e => e.id === 'ex-wring-dip') && s.families.some(f => f.id === 'fam-dip')) {
      s.exercises.push(base.exercises.find(e => e.id === 'ex-wring-dip'));
    }
    s.version = 3;
  }
  if (s.version < 4) {
    // v4: T1 dose now matches how heavy work is really done (sets of 2-3), plus 6x2 / 8x2 schemes and the anytime flag
    if (s.tiers.T1.repMin === 15 && s.tiers.T1.repMax === 25) { s.tiers.T1.repMin = 10; s.tiers.T1.repMax = 20; }
    for (const sc of base.schemes) if (['s-t1-6x2', 's-t1-8x2'].includes(sc.id) && !s.schemes.some(x => x.id === sc.id)) s.schemes.push(sc);
    for (const e of s.exercises) if (e.anytime === undefined) e.anytime = defaultAnytime(e.equipment || [], !!e.bodyweight);
    s.version = 4;
  }
  if (s.version < 5) {
    // v5: GZCL tier doses. Only replace values that are still one of the old defaults.
    const t1 = s.tiers.T1, t2 = s.tiers.T2;
    const old = (t, lo, hi, a, b) => t.repMin === lo && t.repMax === hi && t.intMin === a && t.intMax === b;
    if (old(t1, 15, 25, 0.8, 0.9) || old(t1, 10, 20, 0.8, 0.9)) s.tiers.T1 = { ...t1, repMin: 10, repMax: 15, intMin: 0.85, intMax: 1.0 };
    if (old(t2, 20, 30, 0.65, 0.8)) s.tiers.T2 = { ...t2, intMax: 0.85 };
    for (const sc of base.schemes) if (['s-t1-10x1', 's-t1-4x3'].includes(sc.id) && !s.schemes.some(x => x.id === sc.id)) s.schemes.push(sc);
    const five = s.schemes.find(x => x.id === 's-t1-5x5');
    if (five && five.tiers.join() === 'T1,T2') five.tiers = ['T2']; // sets of 5 are T2 in GZCL
    s.version = 5;
  }
  if (s.version < 6) {
    // v6: explosive/technique. Body region and explosive flag on every exercise, a Jumps family, technique schemes and goals.
    if (!s.equipment.includes('box')) s.equipment.push('box');
    const basement = s.locations.find(l => l.id === 'loc-basement');
    if (basement && !basement.equipment.includes('box')) basement.equipment.push('box');
    s.tiers.TECH ??= base.tiers.TECH;
    if (!s.families.some(f => f.id === 'fam-jumps')) {
      s.families.push(base.families.find(f => f.id === 'fam-jumps'));
      for (const e of base.exercises) if (e.familyId === 'fam-jumps' && !s.exercises.some(x => x.id === e.id)) s.exercises.push(e);
    }
    for (const e of s.exercises) {
      const seedEx = base.exercises.find(b => b.id === e.id);
      if (e.region === undefined) e.region = seedEx ? seedEx.region : guessRegion(e.name);
      if (e.explosive === undefined) e.explosive = seedEx ? seedEx.explosive : guessExplosive(e.name);
    }
    for (const sc of base.schemes) if (/^s-(tq|t2-[45]x3)/.test(sc.id) && !s.schemes.some(x => x.id === sc.id)) s.schemes.push(sc);
    for (const sl of base.slots) {
      if (!['sl-t2-jumps', 'sl-tq-clean'].includes(sl.id)) continue;
      if (!s.slots.some(x => x.familyId === sl.familyId && x.tier === sl.tier)) s.slots.push(sl);
    }
    s.version = 6;
  }
  if (s.version < 7) {
    // v7: jump goals cap contacts per session; T1 is sets of 1-3 (GZCL), so the starter 3x5 moves to T2;
    // exercises can be archived; history imports.
    const jumps = s.slots.find(x => x.id === 'sl-t2-jumps');
    if (jumps && jumps.repMax === undefined) jumps.repMax = 20;
    const threeFives = s.schemes.find(x => x.id === 's-t1-3x5');
    if (threeFives && threeFives.tiers.join() === 'T1') threeFives.tiers = ['T2'];
    s.version = 7;
  }
  return s;
}

// Returns false when nothing was written: storage full or blocked, or saving paused after a load problem.
export function save() {
  if (loadProblem) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    lastSaveError = null;
    return true;
  } catch (e) {
    console.warn('Could not save', e);
    lastSaveError = e.name === 'QuotaExceededError' ? 'storage is full' : e.message;
    saveFailHandler?.(e);
    return false;
  }
}

// After a load problem: start using the app's normal saving again (the unreadable data is replaced).
export function resolveLoadProblem() {
  loadProblem = null;
}

export function replaceState(next) {
  state = migrate(next);
  loadProblem = null;
  return save();
}

export function resetState() {
  state = seed();
  loadProblem = null;
  return save();
}

// Named side copies, e.g. a snapshot taken just before an import so it can be undone.
const copyKey = name => `${KEY}.${name}`;
export function keepCopy(name, data = state) {
  try { localStorage.setItem(copyKey(name), JSON.stringify(data)); return true; } catch { return false; }
}
export function readCopy(name) {
  try { const raw = localStorage.getItem(copyKey(name)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function hasCopy(name) {
  try { return localStorage.getItem(copyKey(name)) != null; } catch { return false; }
}
export function dropCopy(name) {
  try { localStorage.removeItem(copyKey(name)); } catch { /* nothing to drop */ }
}
