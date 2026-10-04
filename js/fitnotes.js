// FitNotes import: read a .fitnotes backup (an SQLite database) and fold its history into the app.
// Reading the file needs sql.js. Everything after that is plain functions over rows, so it can be tested without a file.
import * as L from './logic.js';
import { defaultAnytime } from './seed.js';

const SQLJS = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.2/';
const KG_TO_LB = 2.20462262;
const DAY = 864e5;
const REF_DAYS = 84; // tier guesses compare a set with that lift's best from the 12 weeks before it

export const MODES = [['load', 'Weight × reps'], ['bw_load', 'Bodyweight + added weight'], ['reps', 'Reps only'], ['time', 'Time'], ['distance', 'Distance']];
const MODE_FIELDS = {
  load: { metric: 'load_reps', bodyweight: false },
  bw_load: { metric: 'load_reps', bodyweight: true },
  reps: { metric: 'reps', bodyweight: false },
  time: { metric: 'time', bodyweight: false },
  distance: { metric: 'distance', bodyweight: false },
};
export const modeOf = e => e.metric === 'load_reps' ? (e.bodyweight ? 'bw_load' : 'load') : e.metric === 'none' ? 'reps' : e.metric;

// ---------- reading the file ----------

let sqlReady = null;
function loadSql() {
  sqlReady ??= new Promise((resolve, reject) => {
    if (globalThis.initSqlJs) return resolve(globalThis.initSqlJs);
    const s = document.createElement('script');
    s.src = `${SQLJS}sql-wasm.js`;
    s.onload = () => resolve(globalThis.initSqlJs);
    s.onerror = () => reject(new Error('Couldn’t download the SQLite reader. Check your internet connection and try again.'));
    document.head.appendChild(s);
  }).then(init => init({ locateFile: f => SQLJS + f }));
  sqlReady.catch(() => { sqlReady = null; }); // a later attempt retries the download
  return sqlReady;
}

const NOT_FITNOTES = 'That file isn’t a FitNotes backup. Make a backup in FitNotes and pick the .fitnotes file it saves.';

// Exercises and logged sets from a backup, oldest first. Weights stay in kg here; conversion happens on import.
export async function readBackup(bytes) {
  const SQL = await loadSql();
  let db;
  try {
    db = new SQL.Database(bytes);
    const rows = sql => {
      const r = db.exec(sql)[0];
      return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
    };
    const tables = new Set(rows("select name from sqlite_master where type = 'table'").map(r => r.name));
    if (!tables.has('training_log') || !tables.has('exercise')) throw new Error(NOT_FITNOTES);
    return {
      exercises: rows(`select e._id as id, e.name, e.exercise_type_id as type, c.name as category
        from exercise e left join Category c on c._id = e.category_id`),
      logs: rows(`select _id as id, exercise_id as ex, date, metric_weight as kg, reps, distance, duration_seconds as secs
        from training_log order by date, _id`),
    };
  } catch (e) {
    throw e.message === NOT_FITNOTES ? e : new Error(NOT_FITNOTES);
  } finally {
    db?.close();
  }
}

// ---------- guesses ----------

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const toLb = kg => Math.round((kg || 0) * KG_TO_LB * 2) / 2;
// FitNotes has no "bodyweight" weight: those sets were saved as 0 lb, or 1 lb since 2023.
const noWeight = kg => toLb(kg) < 2;

const BODYWEIGHT_NAME = /pull ?-?ups?|chin ?-?ups?|\bdips?\b|push ?-?ups?|muscle ?-?ups?|pistol|nordic|glute[- ]?ham|\bghr\b|inverted row|ring row|hanging|plank|l[- ]?sit|handstand|lever|burpee|air squat/i;
const JUMP_NAME = /jump|bound|\bhops?\b|skip|broad|plyo/i;

// How the sets were recorded: weight, bodyweight plus added weight, reps, time or distance.
export function guessMode(ex, logs) {
  if (ex.type === 3) return 'time';
  if (ex.type === 1) return logs.some(r => r.distance > 0) ? 'distance' : 'time';
  if (/sprint/i.test(ex.name)) return 'distance'; // sprint distances were typed in the weight column
  if (JUMP_NAME.test(ex.name)) return 'reps';    // the odd held weight on a jump isn't the point of it
  const loaded = logs.filter(r => !noWeight(r.kg)).length;
  if (BODYWEIGHT_NAME.test(ex.name)) return loaded ? 'bw_load' : 'reps';
  return loaded >= logs.length / 4 ? 'load' : 'reps';
}

export function guessEquipment(name, mode) {
  const n = String(name || '').toLowerCase();
  const eq = [];
  if (/ab[- ]?wheel/.test(n)) eq.push('ab-wheel');
  else if (/\bdbs?\b|dumbbell/.test(n)) eq.push('dumbbells');
  else if (/\bkbs?\b|kettlebell/.test(n)) eq.push('kettlebell');
  else if (/\bbands?\b/.test(n)) eq.push('bands');
  else if (/\brings?\b/.test(n)) eq.push('rings');
  else if (/cable|pulldown|push ?down|face pull/.test(n)) eq.push('cable');
  else if (/machine|smith|leg press|hack squat|leg curl|leg extension/.test(n)) eq.push('machine');
  else if (/pull ?-?ups?|chin ?-?ups?|hanging|muscle ?-?ups?|toes to bar/.test(n)) eq.push('pullup-bar');
  else if (/\bdips?\b/.test(n)) eq.push('dip-station');
  else if (mode === 'load' && /clean|snatch|jerk|deadlift|\brdls?\b|romanian|good ?morning|squat|bench|press|row|thruster|pulls?\b|hip thrust|lunge/.test(n)
    && !/pistol|goblet|split|jump|push ?-?ups?/.test(n)) {
    eq.push('barbell');
    if (/squat|bench/.test(n)) eq.push('rack');
    if (/bench/.test(n)) eq.push('bench');
  }
  if (/box jump|depth jump|box step/.test(n)) eq.push('box');
  if (mode === 'bw_load' && /pull ?-?ups?|chin ?-?ups?|\bdips?\b/.test(n)) eq.push('dip-belt');
  return eq;
}

// First match wins: specific patterns come before general ones.
const FAMILY_RULES = [
  [/(clean|snatch)[- ]?grip/i, null, 'Hinge'],
  [/snatch/i, null, 'Snatch variations'],
  [/clean|high pull/i, 'fam-clean', 'Clean variations'],
  [/sprint/i, null, 'Sprints'],
  [/jump|bound|\bhops?\b|skater|plyo/i, 'fam-jumps', 'Jumps'],
  [/nordic|glute[- ]?ham|\bghr\b|leg curl|hamstring/i, null, 'Hamstrings'],
  [/calf/i, null, 'Calves'],
  [/deadlift|\brdls?\b|romanian|good ?morning|back extension|hyperextension|hip thrust|(block|rack|deficit) pulls?\b|swing/i, null, 'Hinge'],
  [/squat|pistol|lunge|split|step[- ]?up|leg press|leg extension/i, 'fam-squat', 'Squat pattern'],
  [/pull ?-?ups?|chin ?-?ups?|pulldown|muscle ?-?ups?/i, 'fam-vpull', 'Vertical pull'],
  [/\bdips?\b/i, 'fam-dip', 'Dip'],
  [/push ?-?ups?/i, null, 'Push-ups'],
  [/plank|crunch|sit[- ]?up|ab[- ]?wheel|rollout|leg raise|knee raise|dead ?bug|hollow|l[- ]?sit|v[- ]?up|twist|pallof|toes to bar/i, 'fam-core', 'Core'],
  [/incline/i, 'fam-incline', 'Incline press'],
  [/bench|floor press|chest press/i, null, 'Bench press'],
  [/curl|tricep|telle|extension|push ?down|skull|kickback/i, 'fam-arms', 'Arms (pump)'],
  [/overhead|shoulder|military|push press|jerk|behind the neck|\bohp\b|press/i, null, 'Overhead press'],
  [/row/i, null, 'Rows'],
  [/face pull|pull[- ]?apart|rear delt|reverse fly|raise|shrug/i, 'fam-upperback', 'Upper back (pump)'],
];

// Family name for a new exercise: one of yours when a rule points at it, else the rule's name. Null if nothing fits.
export function guessFamily(state, name) {
  const rule = FAMILY_RULES.find(([re]) => re.test(name || ''));
  if (!rule) return null;
  const [, id, fallback] = rule;
  return (id && L.byId(state.families, id)?.name) || fallback;
}

// FitNotes names for the starter exercises, keyed by the name with only letters and digits.
const ALIASES = {
  barbellsquat: 'ex-back-squat', backsquat: 'ex-back-squat', squat: 'ex-back-squat',
  barbellfrontsquat: 'ex-front-squat', frontsquat: 'ex-front-squat',
  bulgariansplitsqua: 'ex-bss', bulgariansplitsquat: 'ex-bss', gobletsquat: 'ex-goblet', pistolsquat: 'ex-pistol', airsquat: 'ex-air-squat',
  pullup: 'ex-pullup', pullups: 'ex-pullup', chinup: 'ex-chinup', chinups: 'ex-chinup', ringrow: 'ex-ring-row',
  parallelbartricepsdip: 'ex-bar-dip', bardip: 'ex-bar-dip', dip: 'ex-bar-dip', dips: 'ex-bar-dip', ringdip: 'ex-ring-dip', ringdips: 'ex-ring-dip',
  pushup: 'ex-pushup', pushups: 'ex-pushup', ringpushup: 'ex-ring-pushup',
  powerclean: 'ex-power-clean', hangclean: 'ex-hang-clean', hangpowerclean: 'ex-hang-power-clean', cleanpull: 'ex-clean-pull',
  inclinebarbellbenchpress: 'ex-incline-bench', inclinebenchpress: 'ex-incline-bench', inclinedumbbellbenchpress: 'ex-incline-db', inclinedbpress: 'ex-incline-db',
  bandpullapart: 'ex-band-pullapart', dumbbellcurl: 'ex-db-curl', dbcurl: 'ex-db-curl',
  hanginglegraise: 'ex-hanging-leg', hangingkneeraise: 'ex-hanging-knee', abwheelrollout: 'ex-ab-wheel', deadbug: 'ex-dead-bug',
  boxjump: 'ex-box-jump', depthjump: 'ex-depth-jump', broadjump: 'ex-broad-jump', jumpsquat: 'ex-jump-squat', skaterjump: 'ex-skater-jump', jumplunge: 'ex-jump-lunge',
};
// Weighted and plain versions of the same movement in the starter library.
const WEIGHTED = { 'ex-pullup': 'ex-wpullup', 'ex-chinup': 'ex-wchinup', 'ex-bar-dip': 'ex-wdip', 'ex-ring-dip': 'ex-wring-dip' };
const PLAIN = Object.fromEntries(Object.entries(WEIGHTED).map(([a, b]) => [b, a]));

// Logged in this app (imported history doesn't count): such an exercise keeps how it's logged.
export const isUsed = (state, ex) => state.sets.some(s => s.done && s.exerciseId === ex.id && s.src !== 'fitnotes');

// An existing exercise for this FitNotes one, matched by name and by how the sets were logged.
// FitNotes "Pull Up" with added weight lands on "Weighted pull-up", not on the reps-only "Pull-up".
export function guessMatch(state, ex, mode) {
  const n = norm(ex.name);
  const find = id => id && L.byId(state.exercises, id);
  const cand = state.exercises.find(e => norm(e.name) === n) || find(ALIASES[n]);
  if (!cand) return null;
  if (modeOf(cand) === mode) return cand;
  const sibling = find(mode === 'bw_load' ? WEIGHTED[cand.id] : mode === 'reps' ? PLAIN[cand.id] : null);
  if (sibling && modeOf(sibling) === mode) return sibling;
  return isUsed(state, cand) ? null : cand; // an unused starter exercise can switch to how you did it
}

// The existing exercise will switch how it's logged to match the history (only if you haven't used it here).
export function willAdopt(state, row) {
  const t = row.target !== 'new' && L.byId(state.exercises, row.target);
  return !!t && modeOf(t) !== row.mode && !isUsed(state, t);
}

// ---------- plan ----------

// One row per FitNotes exercise with sets since `cutoff` (YYYY-MM-DD), pre-filled with best guesses.
// "Active" means 3+ workouts in the last year: those are the ones worth checking by hand.
export function planImport(state, data, { cutoff, now = Date.now() }) {
  const lastYear = L.dayKey(now - 365 * DAY);
  const logsByEx = new Map();
  for (const r of data.logs) {
    if (r.date < cutoff) continue;
    if (!logsByEx.has(r.ex)) logsByEx.set(r.ex, []);
    logsByEx.get(r.ex).push(r);
  }
  const earlier = state.imports?.fitnotes?.map ?? {};
  const rows = [];
  for (const ex of data.exercises) {
    const logs = logsByEx.get(ex.id);
    if (!logs?.length) continue;
    const mode = guessMode(ex, logs);
    const recent = new Set(logs.filter(r => r.date >= lastYear).map(r => r.date)).size;
    const active = recent >= 3;
    const before = L.byId(state.exercises, earlier[ex.id]);
    const match = before || guessMatch(state, ex, mode);
    rows.push({
      fnId: ex.id, fnName: ex.name, sets: logs.length, sessions: new Set(logs.map(r => r.date)).size, recent,
      last: logs.at(-1).date, active, again: !!before,
      target: match ? match.id : 'new',
      // Used when the target is a new exercise.
      name: ex.name.trim(), mode,
      family: guessFamily(state, ex.name) ?? (active ? ex.name.trim() : `${ex.category || 'Other'} (FitNotes)`),
      region: L.guessRegion(ex.name), explosive: L.guessExplosive(ex.name), equipment: guessEquipment(ex.name, mode),
      archive: !active,
    });
  }
  rows.sort((a, b) => b.recent - a.recent || b.sessions - a.sessions || a.fnName.localeCompare(b.fnName));
  return { rows, cutoff, sets: rows.reduce((n, r) => n + r.sets, 0) };
}

// ---------- apply ----------

const noon = date => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };

function familyNamed(state, name) {
  const n = String(name || '').trim() || 'Other';
  let fam = state.families.find(f => f.name.toLowerCase() === n.toLowerCase());
  if (!fam) {
    fam = { id: L.uid(), name: n, defaultExerciseId: null };
    state.families.push(fam);
  }
  return fam;
}

function createExercise(state, row) {
  const fam = familyNamed(state, row.family);
  const f = MODE_FIELDS[row.mode];
  for (const eq of row.equipment) if (!state.equipment.includes(eq)) state.equipment.push(eq);
  const ex = {
    id: L.uid(), name: row.name.trim() || row.fnName, familyId: fam.id,
    rank: (L.familyMembers(state, fam.id).at(-1)?.rank ?? 0) + 1,
    metric: f.metric, bodyweight: f.bodyweight, equipment: [...row.equipment],
    anytime: defaultAnytime(row.equipment, f.bodyweight), region: row.region, explosive: row.explosive, archived: !!row.archive,
    youtube: '', start: null, cues: '', startMax: null, restSec: null,
    maxReps: row.mode === 'load' && /clean|snatch|jerk/i.test(row.name) ? 5 : null, // Olympic lifts: no sets of 8+
  };
  state.exercises.push(ex);
  if (!fam.defaultExerciseId && !ex.archived) fam.defaultExerciseId = ex.id;
  return ex;
}

// FitNotes set -> the fields this app uses for that exercise.
function convert(r, ex, bodyweight) {
  const out = { reps: r.reps ?? 0 };
  const w = toLb(r.kg);
  if (ex.metric === 'load_reps') {
    if (ex.bodyweight) { out.load = w < 2 ? 0 : w; out.bw = bodyweight; }
    else if (w >= 2) out.load = w; // 0 or 1 lb on a loaded lift means no weight was entered
  } else if (ex.metric === 'time') {
    if (r.secs > 0) out.time = r.secs;
  } else if (ex.metric === 'distance') {
    const d = r.distance > 0 ? r.distance : w;
    if (d > 0) out.distance = d;
  }
  return out;
}

const totalOf = (ex, c, bodyweight) => ex.bodyweight ? bodyweight + (c.load ?? 0) : c.load;

// GZCL guess: sets of 1-3 at 85%+ of the lift's recent best are T1, sets up to 8 at 65%+ are T2, the rest T3.
// Jumps and sprints count as power work (T2); other unweighted work as T3.
function guessTier(ex, c, ref, bodyweight) {
  if (ex.metric !== 'load_reps') return ex.explosive ? 'T2' : 'T3';
  const total = totalOf(ex, c, bodyweight);
  if (total == null || !ref) return 'T3';
  const pct = total / ref;
  if (c.reps <= 3 && pct >= 0.85) return 'T1';
  if (c.reps <= 8 && pct >= 0.65) return 'T2';
  return 'T3';
}

// Adds the planned exercises, one session per FitNotes workout day, and the sets. Sets already imported are skipped,
// so importing a newer backup later only adds what's new. Returns a summary for the results screen.
export function applyImport(state, data, plan, { bodyweight, now = Date.now() }) {
  const sum = { sets: 0, sessions: 0, created: 0, archived: 0, matched: 0, adopted: [], defaults: [], skipped: 0, maxes: [] };
  const imp = ((state.imports ??= {}).fitnotes ??= {});
  imp.map ??= {};

  const target = new Map(); // FitNotes exercise id -> exercise here
  for (const row of plan.rows) {
    let ex = row.target !== 'new' && L.byId(state.exercises, row.target);
    if (ex) {
      if (willAdopt(state, row)) { Object.assign(ex, MODE_FIELDS[row.mode]); sum.adopted.push(ex.name); }
      sum.matched++;
    } else {
      ex = createExercise(state, row);
      sum.created++;
      if (ex.archived) sum.archived++;
    }
    target.set(row.fnId, ex);
    imp.map[row.fnId] = ex.id;
  }

  // Each day's best e1RM per lift, starting 12 weeks before the cutoff so early sets have something to compare with.
  const refStart = L.dayKey(noon(plan.cutoff) - REF_DAYS * DAY);
  const converted = new Map();
  const days = new Map(); // exercise id -> Map(date -> best e1RM)
  for (const r of data.logs) {
    const ex = r.date >= refStart && target.get(r.ex);
    if (!ex) continue;
    const c = convert(r, ex, bodyweight);
    converted.set(r.id, c);
    const e = ex.metric === 'load_reps' && L.epley(totalOf(ex, c, bodyweight), c.reps);
    if (!e) continue;
    if (!days.has(ex.id)) days.set(ex.id, new Map());
    const m = days.get(ex.id);
    if (!(m.get(r.date) >= e)) m.set(r.date, e);
  }
  // Reference for a day: the best of the 12 weeks before it, or the day's own best if there's nothing earlier.
  const ref = new Map();
  for (const [id, m] of days) {
    const list = [...m].map(([date, e]) => [noon(date), e, date]).sort((a, b) => a[0] - b[0]);
    list.forEach(([t, e, date], i) => {
      let best = 0;
      for (let j = i - 1; j >= 0 && t - list[j][0] <= REF_DAYS * DAY; j--) best = Math.max(best, list[j][1]);
      ref.set(`${id}|${date}`, best || e);
    });
  }

  const have = new Set(state.sets.map(s => s.id));
  const sessions = new Map(state.sessions.map(s => [s.id, s]));
  let seq = 0, prevDate = null;
  for (const r of data.logs) {
    if (r.date < plan.cutoff || !target.has(r.ex)) continue;
    if (r.date !== prevDate) { seq = 0; prevDate = r.date; }
    seq++;
    const id = `fn-${r.id}`;
    if (have.has(id)) { sum.skipped++; continue; }
    const ex = target.get(r.ex);
    const c = converted.get(r.id);
    const sid = `fn-${r.date}`;
    if (!sessions.has(sid)) {
      const s = { id: sid, day: r.date, checkinAt: noon(r.date), firstSetAt: null, status: 'done', source: 'imported', locationId: null, minutes: null, blocks: [] };
      state.sessions.push(s);
      sessions.set(sid, s);
      sum.sessions++;
    }
    state.sets.push({
      id, sessionId: sid, blockId: `${sid}-${ex.id}`, exerciseId: ex.id, tier: guessTier(ex, c, ref.get(`${ex.id}|${r.date}`), bodyweight),
      ...c, done: true, loggedAt: noon(r.date) + seq * 1000, src: 'fitnotes',
    });
    sum.sets++;
  }

  // A family's usual exercise becomes the one you've done most in the last year, unless you've been
  // logging the current one in this app (then it's your choice and stays).
  const lastYear = L.dayKey(now - 365 * DAY);
  const recentDays = new Map(); // exercise id -> Set of workout dates
  for (const r of data.logs) {
    const ex = r.date >= lastYear && target.get(r.ex);
    if (!ex) continue;
    if (!recentDays.has(ex.id)) recentDays.set(ex.id, new Set());
    recentDays.get(ex.id).add(r.date);
  }
  const recentCount = ex => recentDays.get(ex?.id)?.size ?? 0;
  for (const fam of state.families) {
    const top = L.familyMembers(state, fam.id).filter(e => !e.archived && recentCount(e))
      .sort((a, b) => recentCount(b) - recentCount(a))[0];
    const cur = L.byId(state.exercises, fam.defaultExerciseId);
    if (!top || top === cur || (cur && (isUsed(state, cur) || recentCount(cur) >= recentCount(top)))) continue;
    fam.defaultExerciseId = top.id;
    sum.defaults.push(`${fam.name}: ${top.name}`);
  }

  for (const row of plan.rows) {
    const ex = target.get(row.fnId);
    if (!row.active || ex.metric !== 'load_reps') continue;
    const max = L.estimatedMax(state, ex.id, now);
    if (max) sum.maxes.push({ name: ex.name, max, added: ex.bodyweight ? max - bodyweight : null, last: row.last, stale: now - noon(row.last) > REF_DAYS * DAY });
  }
  sum.maxes = sum.maxes.slice(0, 12);
  imp.at = now;
  imp.cutoff = plan.cutoff;
  return sum;
}
