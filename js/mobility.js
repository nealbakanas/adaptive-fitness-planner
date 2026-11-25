// Mobility: its own exercises, routines and sessions, outside the strength framework (no tiers, goals or maxes).
// Pure functions plus the starter library; app.js does the screens.

import { GS_MOBILITY, gsVideo } from './library.js';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const BODY_PARTS = ['Hamstrings', 'Hip flexors', 'Adductors', 'Glutes', 'Quads & knees', 'Calves & ankles', 'Feet & toes', 'Spine', 'Thoracic', 'Shoulders', 'Lats', 'Chest', 'Arms & wrists'];

// A search phrase opens YouTube results; a link opens as is.
export const videoSearch = q => (!q ? null : /^https?:\/\//i.test(q) ? q : `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`);

// "3 × 10/side", "4 × 30–45s", "3 × 6 · 4s down / 2s hold"
export function doseText(e) {
  if (e.dose) return e.dose; // written out where sets × reps can't say it (foot strength)
  const range = (a, b, u = '') => (b && b !== a ? `${a}–${b}${u}` : `${a}${u}`);
  const what = e.hold ? range(e.hold, e.holdMax, 's') : range(e.reps ?? '', e.repsMax);
  return `${e.sets} × ${what}${e.perSide ? '/side' : ''}${e.tempo ? ` · ${e.tempo}` : ''}`;
}

// Every logged item (an exercise's sets in one session), from mobility sessions and from workouts.
export function loggedItems(state) {
  const out = [];
  const add = (sessionId, items) => {
    for (const item of items || []) {
      const done = item.sets.filter(s => s.done);
      if (done.length) out.push({ sessionId, item, at: Math.max(...done.map(s => s.at || 0)) });
    }
  };
  for (const m of state.mobility?.sessions || []) add(m.id, m.items);
  for (const s of state.sessions || []) add(s.id, s.mobility);
  return out.sort((a, b) => b.at - a.at);
}

// Most recent logged item for an exercise, other than `exceptItemId`.
export const lastFor = (state, exerciseId, exceptItemId = null) =>
  loggedItems(state).find(x => x.item.exerciseId === exerciseId && x.item.id !== exceptItemId) ?? null;

export function lastDoneAt(state) {
  const m = new Map();
  for (const x of loggedItems(state)) if (!m.has(x.item.exerciseId)) m.set(x.item.exerciseId, x.at);
  return m;
}

// One set as text: "25 lb × 8 · 45s · Depth parallel"
export function setText(ex, s, unit = 'lb') {
  const bits = [];
  if (s.load != null && s.load !== '') bits.push(`${s.load} ${unit}`);
  if (s.reps != null && s.reps !== '') bits.push(bits.length ? `× ${s.reps}` : `${s.reps}`);
  if (s.hold != null && s.hold !== '') bits.push(`${s.hold}s`);
  if (ex.track?.extra && s.extra != null && s.extra !== '') bits.push(`· ${ex.track.extra} ${s.extra}`);
  // Left or right, logged apart (foot strength), goes first: "L 10 8s".
  return s.side ? `${s.side} ${bits.join(' ') || 'done'}` : bits.join(' ') || 'done';
}

export const itemText = (ex, item, unit) => item.sets.filter(s => s.done).map(s => setText(ex, s, unit)).join(', ');

// The sets for an exercise logged left and right apart (`sides`): each of its `rows` for the left then the right, and an
// optional extra left set when it has `extraLeft` (dropped unless you tick it). Loads come from last time, per side.
export function sidedSets(ex, lastItem = null) {
  const rows = ex.rows ?? [{ reps: ex.reps, hold: ex.hold, holdMax: ex.holdMax, repsMax: ex.repsMax }];
  const mk = (row, side, extra = {}) => ({
    id: uid(), done: false, side, label: row.label ?? '',
    reps: ex.track?.reps ? (row.repsMax ?? row.reps ?? null) : null,
    hold: ex.track?.hold ? (row.holdMax ?? row.hold ?? null) : null,
    load: ex.track?.load ? (lastItem?.sets?.filter(x => x.done && x.side === side).at(-1)?.load ?? null) : null,
    extra: null, ...extra,
  });
  const out = [];
  for (const row of rows) out.push(mk(row, 'L'), mk(row, 'R'));
  if (ex.extraLeft) out.push(mk(rows.at(-1), 'L', { optional: true, label: 'Extra' }));
  return out;
}

// A fresh item for a session, with rows prefilled from the dose and from last time's load and extra.
export function newItem(state, ex) {
  const prev = lastFor(state, ex.id)?.item;
  // Left and right apart, at the level you were at last time.
  if (ex.sides) return { id: uid(), exerciseId: ex.id, sets: sidedSets(ex, prev), note: '', ...(ex.levels ? { level: prev?.level ?? 0 } : {}) };
  const last = prev?.sets.filter(s => s.done).at(-1);
  const sets = Array.from({ length: Math.max(1, ex.sets || 1) }, () => ({
    id: uid(), done: false,
    reps: ex.track?.reps ? (ex.repsMax ?? ex.reps ?? null) : null,
    hold: ex.track?.hold ? (ex.holdMax ?? ex.hold ?? null) : null,
    load: ex.track?.load ? (last?.load ?? null) : null,
    extra: ex.track?.extra ? (last?.extra ?? null) : null,
  }));
  return { id: uid(), exerciseId: ex.id, sets, note: '' };
}

// For picked body parts: candidates ranked by how many of the parts they cover, then least recently done
// (never done counts as oldest). The suggestion takes the best move for each part, a different one per part.
export function rankForParts(state, parts, exclude = []) {
  const last = lastDoneAt(state);
  const skip = new Set(exclude);
  return state.mobility.exercises
    .filter(e => !e.archived && !skip.has(e.id) && (!parts.length || e.parts.some(p => parts.includes(p))))
    .map(e => ({ e, hits: e.parts.filter(p => parts.includes(p)).length, last: last.get(e.id) ?? 0 }))
    .sort((a, b) => b.hits - a.hits || a.last - b.last || a.e.name.localeCompare(b.e.name));
}

export function suggestForParts(state, parts, exclude = []) {
  const ranked = rankForParts(state, parts, exclude);
  const picked = [];
  for (const p of parts) {
    const hit = ranked.find(r => r.e.parts.includes(p) && !picked.includes(r.e.id));
    if (hit) picked.push(hit.e.id);
  }
  return picked;
}

// Mobility this week: sessions (mobility-only ones and workouts with mobility) and the body parts covered.
export function weekSummary(state, start, end) {
  const days = new Set(), parts = new Set();
  let sessions = 0;
  const count = (id, items) => {
    const done = (items || []).filter(it => it.sets.some(s => s.done && s.at >= start && s.at < end));
    if (!done.length) return;
    sessions++;
    for (const it of done) {
      const ex = state.mobility.exercises.find(e => e.id === it.exerciseId);
      for (const p of ex?.parts || []) parts.add(p);
      for (const s of it.sets) if (s.done) days.add(new Date(s.at).toDateString());
    }
  };
  for (const m of state.mobility?.sessions || []) if (!m.program) count(m.id, m.items); // programs (Air Alert) aren't mobility
  for (const s of state.sessions || []) count(s.id, s.mobility);
  return { sessions, days: days.size, parts: BODY_PARTS.filter(p => parts.has(p)) };
}

// ---------- starter library: the four routines you've been running ----------

const mx = (id, name, parts, dose, restSec, track, cues, video, notes = '') => ({
  id, name, parts, sets: 3, reps: null, repsMax: null, hold: null, holdMax: null, perSide: false, tempo: '',
  ...dose, restSec, track: { reps: false, hold: false, load: false, extra: '', ...track }, cues, video, notes, archived: false,
});

export function mobilitySeed() {
  const exercises = [
    // Day 1: Long & Strong
    mx('mob-elephant-walk', 'Standing elephant walk', ['Hamstrings', 'Calves & ankles'], { reps: 10, perSide: true }, 45,
      { reps: true, extra: 'Blocks' }, 'Drive heel flat; dynamic hamstring glide', 'kneesovertoesguy elephant walk',
      'Week 1: 3 blocks, relatively easy. Week 2: 2 yoga blocks, painful but easy.'),
    mx('mob-couch-stretch', 'Active couch stretch / rear-foot elevated lunge', ['Hip flexors', 'Quads & knees'], { hold: 45, perSide: true }, 60,
      { hold: true }, 'Posterior pelvic tilt; squeeze trailing glute', 'squat university couch stretch',
      'Week 1: painful; tried 20+ butt pulses each side, left was really difficult. Week 2: still painful.'),
    mx('mob-jefferson-curl', 'Jefferson curl', ['Hamstrings', 'Spine'], { reps: 6, tempo: '4s down / 2s hold' }, 60,
      { reps: true, load: true, extra: 'Deficit (cm)' }, 'Chin to chest; slow segmented roll; knees locked', 'jefferson curl that fit friend',
      'Week 1: 70 lb, deficit 35+35+25. Week 2: 88 lb, deficit 35+25+25.'),
    mx('mob-psoas-lift', 'Straight-leg psoas lift', ['Hip flexors'], { reps: 10, repsMax: 12, perSide: true, tempo: '1s pause at top' }, 45,
      { reps: true, load: true, extra: 'Height (cm)' }, 'Torso upright; 1s pause at peak extension', 'tom merrick hip flexor compression',
      'Week 1: 3 × 12 with 70 lb kettlebell.'),
    // Day 2: All the Width
    mx('mob-cossack', 'Cossack squat', ['Adductors', 'Calves & ankles'], { reps: 8, perSide: true }, 60,
      { reps: true, load: true, extra: 'Depth' }, 'Keep working heel glued down; chest proud', 'calisthenicmovement cossack squat',
      'Week 1: 10 lb, parallel-ish depth, sets 2-3 deeper. Week 2: 25 lb, good.'),
    mx('mob-horse-stance', 'Loaded horse stance', ['Adductors', 'Quads & knees'], { sets: 4, hold: 30, holdMax: 45 }, 60,
      { hold: true, load: true }, '5 foot-lengths wide; thighs parallel to floor', 'tom merrick horse stance tutorial',
      'Week 1: 25 lb for 30s, 45s, 45s. Week 2: 25 lb for 45s, 55s, 55s.'),
    mx('mob-butterfly', 'Weighted butterfly stretch', ['Adductors', 'Glutes'], { hold: 60 }, 60,
      { hold: true, load: true, extra: 'Knee-to-floor (cm)' }, 'Sit tall; actively drive knees downward', 'weighted butterfly stretch adductors',
      'Week 1: 25 lb, far better on later sets; aiming for 15 pulses after 30s static. Week 2: 25 lb.'),
    mx('mob-straddle-gm', 'Wide-stance straddle good morning', ['Adductors', 'Hamstrings'], { reps: 10 }, 60,
      { reps: true, load: true }, 'Hinge deeply with flat back; bias adductors', 'seated straddle good morning pancake'),
    // Day 3: Bend Don't Break
    mx('mob-cobra', 'Active cobra / seal stretch', ['Spine', 'Hip flexors'], { reps: 10, tempo: '3s hold at top' }, 45,
      { reps: true, hold: true }, 'Extend through thoracic spine; hips stay down', 'range of strength cobra progression',
      'Week 1: 10/8/10.'),
    mx('mob-bridge-pushup', 'Elevated bridge push-up', ['Shoulders', 'Thoracic', 'Spine'], { sets: 4, reps: 5, repsMax: 8 }, 60,
      { reps: true, extra: 'Elevation (cm)' }, 'Hands elevated on bench/box; drive chest open', 'gmb fitness bridge progression',
      'Week 1: hands really far away.'),
    mx('mob-prayer-stretch', 'Bench thoracic extension (prayer stretch)', ['Thoracic', 'Lats'], { hold: 45 }, 45,
      { hold: true }, 'Elbows on bench holding dowel; drop head/chest', 'squat university bench lat prayer stretch'),
    mx('mob-reverse-hyper-hold', 'Reverse hyper / glute bridge hold', ['Glutes', 'Spine'], { reps: 12, tempo: '2s hold' }, 45,
      { reps: true, hold: true }, 'Posterior chain engagement; glute squeeze', 'athlean x reverse hyper form',
      'Week 1: 12/12/12, holds under 2s.'),
    // Day 4: Primal Roots
    mx('mob-bar-hang', 'Passive bar hang', ['Shoulders', 'Lats'], { hold: 30, holdMax: 45 }, 60,
      { hold: true }, 'Full dead hang; relax shoulder blades and lats', 'range of strength how to really hang',
      'Week 1: 45/45/45, insanely hard. Week 2: 45/45/45.'),
    mx('mob-db-pullover', 'DB pullover', ['Lats', 'Thoracic', 'Shoulders'], { reps: 10, tempo: '3s eccentric' }, 60,
      { reps: true, load: true, extra: 'Range' }, 'Deep shoulder flexion at end range; controlled ribcage', 'mind pump dumbbell pullover lat',
      'Week 1: 60 lb × 12 (not 3s eccentric), 10, 8: too heavy.'),
    mx('mob-seiza', 'Seiza / kneeling plantarflexion sit', ['Calves & ankles', 'Quads & knees'], { hold: 45, holdMax: 60 }, 45,
      { hold: true }, 'Sit on heels; tops of feet flat on floor', 'movement by david seiza stretch',
      'Week 1: 60/60/60, painful.'),
    mx('mob-atg-stepup', 'Poliquin / ATG step-up', ['Quads & knees', 'Calves & ankles'], { reps: 12, perSide: true }, 45,
      { reps: true, load: true, extra: 'Elevation' }, 'Drive knee far past toes; vertical torso', 'kneesovertoesguy poliquin step up',
      'Week 1: toe hurts.'),
  ];
  const routines = [
    { id: 'mobr-day1', name: 'Day 1: Long & Strong', items: ['mob-elephant-walk', 'mob-couch-stretch', 'mob-jefferson-curl', 'mob-psoas-lift'] },
    { id: 'mobr-day2', name: 'Day 2: All the Width', items: ['mob-cossack', 'mob-horse-stance', 'mob-butterfly', 'mob-straddle-gm'] },
    { id: 'mobr-day3', name: 'Day 3: Bend Don\'t Break', items: ['mob-cobra', 'mob-bridge-pushup', 'mob-prayer-stretch', 'mob-reverse-hyper-hold'] },
    { id: 'mobr-day4', name: 'Day 4: Primal Roots', items: ['mob-bar-hang', 'mob-db-pullover', 'mob-seiza', 'mob-atg-stepup'] },
  ];
  return { exercises: [...exercises, ...gsMobilityExercises(), ...mcgillExercises(), ...flowExercises()],
    routines: [...routines, { ...MCGILL_ROUTINE, items: [...MCGILL_ROUTINE.items] }, { ...FLOW_ROUTINE, items: [...FLOW_ROUTINE.items] }], sessions: [] };
}

// Stuart McGill's Big 3 for the low back: 10-second holds, fewer reps each set (5, 3, 1 on his reverse pyramid).
export const mcgillExercises = () => [
  mx('mob-mcgill-curl-up', 'McGill curl-up', ['Spine'], { reps: 5, tempo: '10s hold each' }, 30,
    { reps: true }, 'One knee bent, one leg straight, hands under the low back. Lift head and shoulders just off the floor as one piece, neck still. Switch legs each set.',
    'https://www.youtube.com/results?search_query=stuart+mcgill+curl+up', 'Big 3. Reverse pyramid: 5, 3, 1 reps.'),
  mx('mob-mcgill-side-plank', 'McGill side plank', ['Spine', 'Glutes'], { reps: 5, perSide: true, tempo: '10s hold each' }, 30,
    { reps: true }, 'On the elbow, knees bent to start (feet stacked when it gets easy). Hips forward, straight line from head to knees. Brace, breathe.',
    'https://www.youtube.com/results?search_query=stuart+mcgill+side+bridge', 'Big 3. Reverse pyramid: 5, 3, 1 reps per side.'),
  mx('mob-mcgill-bird-dog', 'McGill bird dog', ['Spine', 'Glutes', 'Shoulders'], { reps: 5, perSide: true, tempo: '10s hold each' }, 30,
    { reps: true }, 'Reach the opposite arm and leg long, no higher than level; back stays still. Make a fist and squeeze. Sweep the floor between reps.',
    'https://www.youtube.com/results?search_query=stuart+mcgill+bird+dog', 'Big 3. Reverse pyramid: 5, 3, 1 reps per side.'),
];
export const MCGILL_ROUTINE = { id: 'mobr-mcgill-big3', name: 'McGill Big 3', items: ['mob-mcgill-curl-up', 'mob-mcgill-side-plank', 'mob-mcgill-bird-dog'] };

// Adds the Big 3 and its routine to existing data (an exercise you already have by the same name is reused).
export function addMcgill(s) {
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  s.mobility ??= { exercises: [], routines: [], sessions: [] };
  const ids = [];
  for (const m of mcgillExercises()) {
    const have = s.mobility.exercises.find(e => e.id === m.id || norm(e.name) === norm(m.name));
    if (!have) s.mobility.exercises.push(m);
    ids.push(have?.id ?? m.id);
  }
  if (!s.mobility.routines.some(r => r.id === MCGILL_ROUTINE.id)) s.mobility.routines.push({ ...MCGILL_ROUTINE, items: ids });
}

// Mash & flow: a daily routine of flows, stretches and soft-tissue work ("mash": a lacrosse ball or foam roller, slow,
// pausing on the tight spots), one round of each, timed holds. About 25-30 minutes.
const flow = (id, name, parts, hold, holdMax, perSide, cues, video) =>
  mx(id, name, parts, { sets: 1, hold, holdMax, perSide }, 10, { hold: true }, cues, video);
export const flowExercises = () => [
  flow('mob-flow-ohs-dogs', 'Overhead squat + up dog + down dog', ['Shoulders', 'Thoracic', 'Hamstrings', 'Calves & ankles'], 45, 60, false,
    'Overhead squat with arms long, hands to the floor, walk out to up dog (hips down, chest open), push back to down dog (heels down), walk in and stand. Keep it moving.',
    'overhead squat to upward dog downward dog mobility flow'),
  flow('mob-flow-lunge-twist', 'Lunge + thoracic spine twist', ['Hip flexors', 'Thoracic'], 30, null, true,
    'Long lunge, back knee down or up; same-side hand inside the front foot, rotate the other arm up to the ceiling and follow it with your eyes.',
    'lunge with thoracic spine rotation stretch'),
  flow('mob-flow-wrist', 'Wrist flow', ['Arms & wrists'], 45, 60, false,
    'On hands and knees: fingers forward, sideways and back, rocking gently; palms up; circles. Ease in, no forcing.',
    'wrist mobility flow routine on all fours'),
  flow('mob-flow-scorpion', 'Scorpion', ['Spine', 'Hip flexors', 'Thoracic'], 30, 45, false,
    'Face down, arms out. Swing one heel across toward the opposite hand, shoulders staying on the floor; alternate, slow.',
    'scorpion stretch prone'),
  flow('mob-flow-upper-stretch', 'Best upper stretch in the world', ['Thoracic', 'Shoulders', 'Lats', 'Chest'], 30, 45, false,
    'Kneeling, hands on a bench or the floor in front, sink the chest down between the arms and breathe into the upper back; turn the palms up to feel it in the lats.',
    'best upper body stretch in the world thoracic lat'),
  flow('mob-mash-foot', 'Foot mash', ['Feet & toes'], 30, 45, true,
    'Standing, a lacrosse ball under the arch: lean in, roll heel to toes, pause on the sore spots. Go easy around the big toe joint.',
    'lacrosse ball foot mash plantar fascia'),
  flow('mob-mash-calf', 'Calf mash', ['Calves & ankles'], 45, 60, true,
    'Calf on a roller or ball, other leg crossed on top for pressure. Roll slowly, stop on a tight spot and turn the foot side to side.',
    'calf smash foam roller lacrosse ball'),
  flow('mob-mash-glute', 'Glute mash', ['Glutes'], 45, 60, true,
    'Sit on the ball, ankle crossed over the other knee, lean into the working side; small circles, then hold on the tight spots.',
    'lacrosse ball glute smash'),
  flow('mob-mash-quad', 'Quad mash', ['Quads & knees'], 45, 60, true,
    'Face down on a roller or ball, one thigh at a time; roll slowly from above the knee to the hip, bend and straighten the knee on a tight spot.',
    'quad smash foam roller'),
  flow('mob-flow-couch', 'Couch stretch', ['Hip flexors', 'Quads & knees'], 30, 45, true,
    'Back knee on the floor against a wall or couch, shin up it; front foot forward. Squeeze the back glute, ribs down, torso upright.',
    'couch stretch kelly starrett'),
  flow('mob-mash-shoulder', 'Shoulder mash', ['Shoulders'], 30, 45, true,
    'Ball between the back of the shoulder and a wall or the floor; small movements, then reach the arm across and back over it.',
    'lacrosse ball posterior shoulder smash'),
  flow('mob-mash-pec', 'Pec mash', ['Chest', 'Shoulders'], 30, 45, true,
    'Ball against a wall just in from the front of the shoulder; lean in and slowly move the arm up, down and behind you.',
    'lacrosse ball pec smash wall'),
  flow('mob-mash-trap', 'Trap mash', ['Shoulders'], 45, 60, true,
    'On your back, ball on the top of the shoulder blade beside the neck; lift the hips to load it, reach the arm overhead and back.',
    'lacrosse ball upper trap smash'),
  flow('mob-mash-lat', 'Lat mash', ['Lats'], 30, 45, true,
    'On your side, roller under the armpit, arm overhead; roll down the side of the back a few inches at a time, rolling slightly forward and back.',
    'foam roll lats'),
  flow('mob-mash-bicep', 'Bicep mash', ['Arms & wrists'], 30, null, true,
    'Ball on a table or the floor under the front of the upper arm; lean in and straighten and bend the elbow slowly.',
    'lacrosse ball bicep smash'),
  flow('mob-mash-tricep', 'Tricep mash', ['Arms & wrists'], 30, null, true,
    'On your side, back of the upper arm on a roller or ball, elbow bent; roll from the elbow to the armpit, bend and straighten on a tight spot.',
    'foam roller triceps smash'),
  flow('mob-mash-forearm', 'Forearm mash', ['Arms & wrists'], 30, null, true,
    'Forearm on a ball on the table, other hand pressing down; roll from wrist to elbow, both sides, opening and closing the hand.',
    'lacrosse ball forearm smash'),
];
export const FLOW_ROUTINE = { id: 'mobr-mash-flow', name: 'Mash & flow', items: flowExercises().map(e => e.id) };

// Adds Mash & flow to existing data (data version 37). Nothing you have is changed.
export function addFlow(s) {
  s.mobility ??= { exercises: [], routines: [], sessions: [] };
  for (const e of flowExercises()) if (!s.mobility.exercises.some(x => x.id === e.id)) s.mobility.exercises.push(e);
  if (!s.mobility.routines.some(r => r.id === FLOW_ROUTINE.id)) s.mobility.routines.push({ ...FLOW_ROUTINE, items: [...FLOW_ROUTINE.items] });
}

// Mobility drills from the Garage Strength Movement Library, at 2 × 10 to start.
export const gsMobilityExercises = () => GS_MOBILITY.map(([id, name, parts, video]) =>
  mx(id, name, parts, { sets: 2, reps: 10 }, 45, { reps: true }, '', gsVideo(video)));

