// Fixed multi-week programs (Air Alert 2), outside the strength framework like mobility: no tiers, goals or maxes.
// A program session is a mobility-style session tagged with { program: { id, week, day } }; its items carry their own
// exercise definition (item.def) with that week's sets and reps. Progress is a pointer that moves one day per
// finished session. Pure functions; app.js does the screens.

const ex = (id, name, video, cues, extra = {}) => ({
  id, name, short: name.split(' ')[0].replace('Burnouts', 'Burn'), parts: [], sets: 1, reps: null, repsMax: null, hold: null, holdMax: null, perSide: false, tempo: '',
  restSec: 60, track: { reps: true, hold: false, load: false, extra: '' }, cues, video, notes: '', archived: false, ...extra,
});

// Air Alert II (TMT Sports): 12 weeks, Monday to Friday, the same workout every day of a week.
// Chart rows: [leap ups, calf raises, step ups, thrust ups, burnouts] as [sets, reps].
export const AIR_ALERT_2 = {
  id: 'aa2',
  name: 'Air Alert 2',
  days: 5,
  schedule: 'Monday to Friday, best in the afternoon. Eat 1–2 hours before training.',
  exercises: [
    ex('aa2-leapups', 'Leap ups', 'air alert leap ups',
      'Feet shoulder-width apart, jump up looking straight ahead. Come down about 1/4 of the way and jump right back up: that’s one. Don’t use your arms.'),
    ex('aa2-calfraises', 'Calf raises', 'air alert calf raises',
      'Stand on something so your heels aren’t touching anything (stairs, a book). All the way up, slowly down. One leg, then the other, completes a set.', { perSide: true }),
    ex('aa2-stepups', 'Step ups', 'air alert step ups',
      'One foot on a sturdy chair or bench (thigh parallel to the ground). Push yourself up off it with that leg, switch legs in the air, and land with the other foot on the bench.'),
    ex('aa2-thrustups', 'Thrust ups', 'air alert thrust ups',
      'Feet shoulder-width apart, legs locked. Jump using only your calves, bending your knees as little as possible.'),
    ex('aa2-burnouts', 'Burnouts', 'air alert burnouts',
      'Stand on something with your heels off the edge, up on your toes. Bounce up and down quickly in a small range without letting your heels drop until the set is done.', { restSec: 0 }),
  ],
  chart: [
    [[2, 25], [2, 10], [2, 10], [2, 15], [1, 100]],
    [[1, 50], [2, 20], [2, 15], [2, 20], [1, 200]],
    [[1, 75], [2, 25], [2, 15], [2, 25], [1, 300]],
    [[1, 75], [2, 30], [2, 20], [2, 30], [1, 400]],
    [[2, 50], [2, 35], [2, 20], [2, 35], [1, 500]],
    [[1, 100], [2, 40], [2, 25], [2, 40], [1, 600]],
    [[1, 125], [2, 45], [2, 25], [2, 50], [1, 700]],
    [[2, 75], [2, 50], [2, 30], [2, 60], [1, 800]],
    [[2, 100], [2, 55], [2, 30], [2, 70], [1, 900]],
    [[2, 125], [2, 60], [2, 35], [2, 80], [1, 1000]],
    [[2, 150], [2, 65], [2, 35], [2, 90], [1, 1100]],
    [[2, 200], [2, 70], [2, 40], [2, 100], [1, 1200]],
  ],
};

export const PROGRAMS = [AIR_ALERT_2];
export const programDef = id => PROGRAMS.find(p => p.id === id);
export const weeksOf = def => def.chart.length;

// The week's exercises with that week's dose, in chart order.
export function dayPlan(def, week) {
  return def.exercises.map((e, i) => {
    const [sets, reps] = def.chart[week - 1][i];
    return { ...e, sets, reps };
  });
}

// Where you are: { week, day } (1-based) or finished. Stored as state.programs[id] = { startedAt, week, day, finished, verticals };
// a program not running (never started, or stopped) is { stopped: true, verticals } or missing, and has no progress.
export function progress(state, id) {
  const p = state.programs?.[id];
  return p && !p.stopped ? p : null;
}

export function startProgram(state, id, now = Date.now()) {
  state.programs ??= {};
  state.programs[id] = { startedAt: now, week: 1, day: 1, finished: false, verticals: state.programs[id]?.verticals ?? [] };
  return state.programs[id];
}

// One finished session moves the pointer a day; after the week's last day, on to the next week.
export function advance(state, id) {
  const p = progress(state, id), def = programDef(id);
  if (!p || p.finished) return p;
  if (p.day < def.days) p.day++;
  else if (p.week < weeksOf(def)) { p.week++; p.day = 1; }
  else p.finished = true;
  return p;
}

export function setWeek(state, id, week) {
  const p = progress(state, id), def = programDef(id);
  if (!p) return null;
  p.week = Math.min(weeksOf(def), Math.max(1, week));
  p.day = 1;
  p.finished = false;
  return p;
}

// Finished sessions for a program (with something logged), oldest first.
export const programSessions = (state, id) => (state.mobility?.sessions || [])
  .filter(m => m.program?.id === id && m.status === 'done').sort((a, b) => a.startedAt - b.startedAt);

// Days done per week, for the progress chart: { week: count }.
export function daysDoneByWeek(state, id) {
  const out = {};
  for (const m of programSessions(state, id)) out[m.program.week] = (out[m.program.week] || 0) + 1;
  return out;
}

export const doneToday = (state, id, day) => programSessions(state, id).some(m => m.day === day);

export function lastSessionAt(state, id) {
  const s = programSessions(state, id).at(-1);
  return s ? s.startedAt : null;
}
