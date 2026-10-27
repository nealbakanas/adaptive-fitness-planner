// Local persistence. The whole app state is one JSON blob so a backend can replace this later.
import { seed, defaultAnytime, HYPER_PRO_ONLY, gsExercise, EQUIPMENT, NOT_IN_BASEMENT, JUMP_TIER, JUMP_SCHEMES } from './seed.js';
import { GS_EQUIPMENT, GS_FAMILIES, GS_EXERCISES, GS_VIDEOS, gsVideo, EXERCISE_ROLES, PATTERN_OVERRIDES } from './library.js';
import { gsMobilityExercises } from './mobility.js';
import { guessRegion, guessExplosive, guessRole, isJump } from './logic.js';
import * as Vault from './vault.js';

// Test pages set their own key so they never touch real data.
const KEY = globalThis.AFP_STORAGE_KEY ?? 'afp.v1';

// Set when saved data exists but couldn't be opened. Saving stays off until you choose what to do,
// so a bug in an upgrade step can never overwrite your only copy.
export let loadProblem = null;
// True when this page load found no saved data (a first run, or the browser cleared it): see recover().
export let loadedFromSeed = false;
// Why the most recent save failed, or null once a save succeeds again.
export let lastSaveError = null;
let saveFailHandler = null;
export const onSaveFail = fn => { saveFailHandler = fn; };

export let state = load();
// The data version this build writes (an account copy with a higher one came from a newer build).
export const CURRENT_VERSION = seed().version;

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch (e) {
    loadProblem = { message: 'This browser is blocking storage, so nothing can be saved here.', raw: null };
    return seed();
  }
  if (!raw) { loadedFromSeed = true; return seed(); }
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
  if (s.version < 8) {
    // v8: Freak Athlete Hyper Pro + Leg Developer movements as accessories, the gear at the Basement.
    // Families and exercises you already have by the same name (e.g. imported from FitNotes) are reused, not doubled.
    const basement = s.locations.find(l => l.id === 'loc-basement');
    for (const eq of ['hyper-pro', 'leg-developer']) {
      if (!s.equipment.includes(eq)) s.equipment.push(eq);
      if (basement && !basement.equipment.includes(eq)) basement.equipment.push(eq);
    }
    const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const famIds = {};
    for (const fam of base.families) {
      const have = s.families.find(f => f.id === fam.id || norm(f.name) === norm(fam.name));
      if (have) famIds[fam.id] = have.id;
      else if (['fam-hams', 'fam-hinge', 'fam-quads', 'fam-calves'].includes(fam.id)) { s.families.push({ ...fam }); famIds[fam.id] = fam.id; }
    }
    for (const e of base.exercises) {
      if (!e.equipment.includes('hyper-pro')) continue;
      const have = s.exercises.find(x => x.id === e.id || norm(x.name) === norm(e.name));
      if (have) {
        if (HYPER_PRO_ONLY.includes(e.id) && !(have.equipment || []).length) have.equipment = [...e.equipment];
        continue;
      }
      const familyId = famIds[e.familyId];
      if (!familyId) continue;
      const rank = Math.max(0, ...s.exercises.filter(x => x.familyId === familyId).map(x => x.rank || 0)) + 1;
      s.exercises.push({ ...e, familyId, rank: familyId === e.familyId && !s.exercises.some(x => x.familyId === familyId) ? e.rank : rank });
      const fam = s.families.find(f => f.id === familyId);
      if (fam && !fam.defaultExerciseId) fam.defaultExerciseId = e.id;
    }
    s.version = 8;
  }
  if (s.version < 9) {
    // v9: the mobility suite, with its own exercises, routines and sessions.
    s.mobility ??= base.mobility;
    s.version = 9;
  }
  if (s.version < 10) {
    // v10: deficit Romanian deadlifts in Hamstrings, with a weekly T2 goal for them.
    // Reuses a Hamstrings family or deficit RDL you already have by the same name.
    const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const seedEx = base.exercises.find(e => e.id === 'ex-deficit-rdl');
    let rdl = s.exercises.find(e => e.id === seedEx.id || ['deficitromaniandeadlift', 'deficitrdl'].includes(norm(e.name)));
    if (!rdl) {
      let fam = s.families.find(f => f.id === 'fam-hams') ?? s.families.find(f => norm(f.name) === 'hamstrings');
      if (!fam) { fam = { ...base.families.find(f => f.id === 'fam-hams'), defaultExerciseId: seedEx.id }; s.families.push(fam); }
      const rank = Math.max(0, ...s.exercises.filter(x => x.familyId === fam.id).map(x => x.rank || 0)) + 1;
      rdl = { ...seedEx, familyId: fam.id, rank };
      s.exercises.push(rdl);
    }
    if (!s.slots.some(x => x.exerciseId === rdl.id && x.tier === 'T2')) {
      const id = s.slots.some(x => x.id === 'sl-t2-hams') ? `sl-t2-hams-${rdl.id}` : 'sl-t2-hams';
      s.slots.push({ id, familyId: rdl.familyId, exerciseId: rdl.id, tier: 'T2', quota: 1, priority: 2 });
    }
    s.version = 10;
  }
  if (s.version < 11) {
    // v11: T3 schemes for hard bodyweight moves (4×8, 6×5), and rep caps on Nordics, glute-ham raises and reverse Nordics
    // so they stop getting sets of 15-25. A cap you've already set is kept.
    for (const sc of base.schemes) if (['s-t3-4x8', 's-t3-6x5'].includes(sc.id) && !s.schemes.some(x => x.id === sc.id)) s.schemes.push(sc);
    for (const id of ['ex-nordic', 'ex-ghr', 'ex-reverse-nordic']) {
      const e = s.exercises.find(x => x.id === id);
      if (e && e.maxReps == null) e.maxReps = base.exercises.find(x => x.id === id).maxReps;
    }
    s.version = 11;
  }
  if (s.version < 12) {
    // v12: the Garage Strength Movement Library (js/library.js): six new families, ~230 exercises with their videos,
    // and nine mobility drills. Families and exercises you already have by the same name are reused, not doubled:
    // they only get the video if they don't have one. No goals are added, and the new gear isn't put at any location.
    const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const eq of GS_EQUIPMENT) if (!s.equipment.includes(eq)) s.equipment.push(eq);
    const famIds = {}, added = [];
    for (const fam of base.families) {
      const have = s.families.find(f => f.id === fam.id || norm(f.name) === norm(fam.name));
      if (have) { famIds[fam.id] = have.id; continue; }
      if (!GS_FAMILIES.some(f => f.id === fam.id) && !GS_EXERCISES.some(r => r[2] === fam.id)) continue;
      const f = { ...fam, defaultExerciseId: null };
      s.families.push(f);
      added.push([f, fam.defaultExerciseId]);
      famIds[fam.id] = fam.id;
    }
    const giveVideo = (have, url) => { if (have && !/^https?:\/\//i.test(have.youtube || '')) { have.youtube = url; have.start = null; } };
    for (const [id, video] of Object.entries(GS_VIDEOS)) {
      const name = base.exercises.find(e => e.id === id)?.name;
      giveVideo(s.exercises.find(e => e.id === id) ?? s.exercises.find(e => norm(e.name) === norm(name)), gsVideo(video));
    }
    for (const row of GS_EXERCISES) {
      const [id, name, familyId] = row;
      const have = s.exercises.find(e => e.id === id || norm(e.name) === norm(name));
      if (have) { giveVideo(have, gsVideo(row[5])); continue; }
      const fid = famIds[familyId];
      if (!fid) continue;
      const rank = Math.max(0, ...s.exercises.filter(e => e.familyId === fid).map(e => e.rank || 0)) + 1;
      s.exercises.push({ ...gsExercise(row, rank), familyId: fid });
    }
    // A family this step added: its usual exercise is the seed's if it came in, else its first one.
    for (const [f, def] of added) {
      f.defaultExerciseId = s.exercises.find(e => e.id === def && e.familyId === f.id)?.id ?? s.exercises.find(e => e.familyId === f.id)?.id ?? null;
    }
    for (const m of gsMobilityExercises()) {
      if (!s.mobility.exercises.some(e => e.id === m.id || norm(e.name) === norm(m.name))) s.mobility.exercises.push(m);
    }
    s.version = 12;
  }
  if (s.version < 13) {
    // v13: T2 in sets of 2-3 on a minute's rest (10×2, 10×3), so power work at T2 isn't stuck at sets of 5.
    // A T2 scheme you already have with the same sets and reps is kept instead (no duplicate rows).
    for (const sc of base.schemes) {
      if (!['s-t2-10x2', 's-t2-10x3'].includes(sc.id)) continue;
      if (!s.schemes.some(x => x.id === sc.id || (x.sets === sc.sets && x.reps === sc.reps && x.tiers.includes('T2')))) s.schemes.push(sc);
    }
    s.version = 13;
  }
  if (s.version < 14) {
    // v14: a role on every exercise (main lift, power, accessory, technique drill), so automatic T1/T2 picks never use
    // curls, raises or grip work. Library exercises get their reviewed role, your own a guess from the name; a role you
    // already set is kept. Plus the movement patterns the name rules got wrong.
    for (const e of s.exercises) {
      e.role ??= EXERCISE_ROLES[e.id] ?? guessRole(e.name, e.metric, e.explosive);
      if (e.id in PATTERN_OVERRIDES && !Object.hasOwn(e, 'pattern')) e.pattern = PATTERN_OVERRIDES[e.id];
    }
    s.version = 14;
  }
  if (s.version < 15) {
    // v15: tested 1-rep maxes with the day they were tested. An old "starting max" becomes an undated one, which still
    // counts only until you've logged sets, as before.
    for (const e of s.exercises) {
      if (e.testedMax === undefined) e.testedMax = e.startMax ? { load: e.startMax, at: null } : null;
      e.startMax = null;
    }
    s.version = 15;
  }
  if (s.version < 16) {
    // v16: onboarding for new installs. Anything saved before it is already set up.
    s.settings.onboarded = true;
    s.version = 16;
  }
  if (s.version < 17) {
    // v17: the Basement has no kettlebell, dip belt, pull-up bar, rings or dip station. Only a Basement that still has
    // the full starter gear list is changed; one you've edited is left alone.
    const basement = s.locations.find(l => l.id === 'loc-basement');
    if (basement && EQUIPMENT.every(eq => basement.equipment.includes(eq))) basement.equipment = basement.equipment.filter(eq => !NOT_IN_BASEMENT.includes(eq));
    s.version = 17;
  }
  if (s.version < 18) {
    // v18: jumps are their own category (the JUMP tier, in contacts), out of T2. T2 jump goals (naming a jump, or for a family
    // that is all jumps), and logged sets, workout blocks and plan items with jumps at T2 move to it. Goals keep their reps
    // and slot, so this week's credit is unchanged; blocks and plan items keep their scheme (and an open block its sets).
    s.tiers.JUMP ??= { ...JUMP_TIER };
    for (const sc of JUMP_SCHEMES) if (!s.schemes.some(x => x.id === sc.id)) s.schemes.push({ ...sc, tiers: [...sc.tiers] });
    const jump = id => isJump(s.exercises.find(e => e.id === id));
    const allJumps = fid => { const m = s.exercises.filter(e => e.familyId === fid && !e.archived); return m.length > 0 && m.every(e => isJump(e)); };
    for (const sl of s.slots) {
      if (sl.tier === 'T2' && (sl.exerciseId ? jump(sl.exerciseId) : sl.familyId === 'fam-jumps' || allJumps(sl.familyId))) sl.tier = 'JUMP';
    }
    for (const x of s.sets) if (x.tier === 'T2' && jump(x.exerciseId)) x.tier = 'JUMP';
    for (const ss of s.sessions) for (const b of ss.blocks || []) if (b.tier === 'T2' && jump(b.exerciseId)) b.tier = 'JUMP';
    for (const p of s.plans || []) for (const it of p.items || []) if (it.tier === 'T2' && jump(it.exerciseId)) it.tier = 'JUMP';
    s.version = 18;
  }
  if (s.version < 19) {
    // v19: every save is stamped (state.savedAt) so a second copy in IndexedDB (js/vault.js) can be compared with this one.
    // The key arrives as null from the defaults above; the next save fills it in.
    s.version = 19;
  }
  if (s.version < 20) {
    // v20: taste (js/taste.js). Settings learnTaste and tasteSince arrive from the defaults above, exercise.pref
    // ('fav' | 'never') and session.removed[] are optional, so nothing to move.
    s.version = 20;
  }
  if (s.version < 21) {
    // v21: pace (js/pace.js). Settings learnPace and paceSince arrive from the defaults above; it reads the sets as they are.
    s.version = 21;
  }
  if (s.version < 22) {
    // v22: weekly reviews (js/review.js). `reviews` arrives as [] from the defaults above; a goal with quota 0 is paused.
    s.version = 22;
  }
  return s;
}

// Returns false when nothing was written: storage full or blocked, or saving paused after a load problem.
// Each save also schedules the second copy in IndexedDB, even when localStorage failed: then it holds the only newest copy.
export function save() {
  if (loadProblem) return false;
  state.savedAt = Date.now();
  scheduleVault();
  for (const fn of saveListeners) { try { fn(); } catch (e) { console.warn(e); } }
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

// Called after every save (the cloud sync schedules itself from this).
const saveListeners = [];
export const onSave = fn => { saveListeners.push(fn); };

// ---------- the second copy and snapshots (js/vault.js) ----------

let vaultTimer = null;
function scheduleVault() {
  if (!Vault.available()) return;
  clearTimeout(vaultTimer);
  vaultTimer = setTimeout(flushVault, 2000);
}

// Writes the second copy now (also on the first save of a day with logged sets: a daily snapshot). Never throws.
export async function flushVault() {
  clearTimeout(vaultTimer);
  vaultTimer = null;
  if (loadProblem) return false;
  const json = JSON.stringify(state);
  const ok = await Vault.put(json);
  if (ok && Vault.needsDaily(await Vault.list(), state)) await Vault.snapshot(json, 'daily', Vault.summaryOf(state));
  return ok;
}

if (typeof document !== 'undefined') {
  // Leaving the page: don't wait out the 2 second delay.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && vaultTimer) flushVault(); });
  addEventListener('pagehide', () => { if (vaultTimer) flushVault(); });
}

// A snapshot of what's here right now, taken before something replaces it. The data is captured at once; the write
// finishes a moment later. Resolves the snapshot's time, or null. Skipped while saving is paused (the data isn't real).
export function snapshotNow(reason) {
  if (loadProblem) return Promise.resolve(null);
  return Vault.snapshot(JSON.stringify(state), reason, Vault.summaryOf(state));
}

// The vault's copy when it holds data this page didn't load: { at, json, summary }. See recover().
let recoveryCopy = null;
export const getRecoveryCopy = () => recoveryCopy;

// Run once at startup, before the first save. Resolves { kind, at }:
// - 'restored': nothing was saved here (the browser cleared it) but the second copy has your data: it's loaded back.
// - 'newer': the second copy is newer than what was saved here (a save to localStorage failed): offered, not applied.
// - 'offer': what's saved here can't be opened and the second copy can: offered on the load-problem banner.
// - 'none': nothing to do (also when IndexedDB is unavailable or slow: it gives up after `timeout` ms).
export async function recover({ timeout = 2500 } = {}) {
  const fresh = loadedFromSeed; // only the first run can say "nothing was saved here"
  loadedFromSeed = false;
  const work = (async () => {
    const v = await Vault.get();
    if (!v) return { kind: 'none' };
    let theirs;
    try { theirs = migrate(JSON.parse(v.json)); } catch { return { kind: 'none' }; }
    const worth = theirs.sets.length > 0 || theirs.sessions.length > 0 || theirs.settings.onboarded;
    const at = theirs.savedAt ?? v.at;
    const summary = Vault.summaryOf(theirs);
    if (loadProblem) {
      if (!loadProblem.raw || !worth) return { kind: 'none' };
      recoveryCopy = { at, json: v.json, summary };
      return { kind: 'offer', at };
    }
    if (fresh) {
      if (!worth) return { kind: 'none' };
      state = theirs;
      save();
      return { kind: 'restored', at, summary };
    }
    if (worth && (theirs.savedAt ?? 0) > (state.savedAt ?? 0) + 1000) {
      recoveryCopy = { at, json: v.json, summary };
      await Vault.snapshot(v.json, 'recovered', summary); // keep it whatever you choose: the next save replaces the second copy
      return { kind: 'newer', at, summary };
    }
    return { kind: 'none' };
  })();
  return Promise.race([work, new Promise(r => setTimeout(() => r({ kind: 'none' }), timeout))]);
}

// Takes the second copy over what's here (after a snapshot of what's here, unless that was unreadable). True when done.
export function useRecoveryCopy() {
  if (!recoveryCopy) return false;
  const copy = recoveryCopy;
  snapshotNow('before-restore');
  recoveryCopy = null;
  replaceState(JSON.parse(copy.json));
  return true;
}
export function dismissRecoveryCopy() { recoveryCopy = null; }

// Asks the browser not to clear this site's data on its own (storage.persist). Remembers the answer in
// settings.storagePersisted: true, false, or 'unsupported'. Resolves that value.
export async function requestPersist() {
  let result = 'unsupported';
  try {
    if (navigator.storage?.persist) result = !!((await navigator.storage.persisted?.()) || (await navigator.storage.persist()));
  } catch { result = false; }
  if (state.settings.storagePersisted !== result) { state.settings.storagePersisted = result; save(); }
  return result;
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
