// Mobility: its own exercises, routines and sessions, outside the strength framework (no tiers, goals or maxes).
// Pure functions plus the starter library; app.js does the screens.

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const BODY_PARTS = ['Hamstrings', 'Hip flexors', 'Adductors', 'Glutes', 'Quads & knees', 'Calves & ankles', 'Spine', 'Thoracic', 'Shoulders', 'Lats'];

export const videoSearch = q => (q ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` : null);

// "3 × 10/side", "4 × 30–45s", "3 × 6 · 4s down / 2s hold"
export function doseText(e) {
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
  return bits.join(' ') || 'done';
}

export const itemText = (ex, item, unit) => item.sets.filter(s => s.done).map(s => setText(ex, s, unit)).join(', ');

// A fresh item for a session, with rows prefilled from the dose and from last time's load and extra.
export function newItem(state, ex) {
  const last = lastFor(state, ex.id)?.item.sets.filter(s => s.done).at(-1);
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
  for (const m of state.mobility?.sessions || []) count(m.id, m.items);
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
  return { exercises, routines, sessions: [] };
}

