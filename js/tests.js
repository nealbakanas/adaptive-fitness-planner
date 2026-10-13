// Rules tests. Open /tests.html to run them. They exercise the pure logic with synthetic data and never touch your saved data.
import { seed } from './seed.js';
import * as L from './logic.js';
import { migrate } from './store.js';
import * as FN from './fitnotes.js';
import * as G from './goals.js';
import * as M from './mobility.js';
import * as P from './programs.js';

const results = [];
const test = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name} — ${e.message}`]); }
};
const eq = (a, b, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, msg = 'assertion failed') => { if (!c) throw new Error(msg); };

const DAY = 864e5;
const NOON = d => { const x = new Date(Date.now() - d * DAY); x.setHours(12, 0, 0, 0); return x.getTime(); };
const ci = (over = {}) => ({ locationId: 'loc-basement', minutes: 45, fatigue: 1, sleep: null, intent: 'auto', split: false, ...over });
// Logs n identical sets as one session that day.
const done = (state, exerciseId, tier, reps, n, daysAgo = 0, load = null, blockId = 'b1') => {
  for (let i = 0; i < n; i++) state.sets.push({ id: L.uid(), sessionId: `s${daysAgo}-${tier}`, blockId, exerciseId, tier, load, reps, done: true, loggedAt: NOON(daysAgo) + i, bw: 235, refMax: null });
};

// ---------- guesses ----------
test('region guesses', () => {
  eq(L.guessRegion('Seated Broad Jump'), 'lower');
  eq(L.guessRegion('Pull Up'), 'upper');
  eq(L.guessRegion('Hang Clean High Pull'), 'full');
  eq(L.guessRegion('Block Rdl'), 'lower');
  eq(L.guessRegion('Barbell Row'), 'upper');
  eq(L.guessRegion('Something odd'), 'full');
});
test('explosive guesses', () => {
  ok(L.guessExplosive('Hang Snatch') && L.guessExplosive('Seated Broad Jump') && L.guessExplosive('Clap Push Up'));
  ok(!L.guessExplosive('Barbell Row') && !L.guessExplosive('Pull Up'));
});
test('guesses for real exercise names that used to come out wrong', () => {
  const expect = {
    'Block Pull': 'lower', 'Back Extension': 'lower', '20 Nordic Curls': 'lower', 'Glute-Ham Raise': 'lower', 'Calf Raise': 'lower',
    'Good Morning': 'lower', 'Snatch Grip Deadlift': 'lower', 'Clean Grip Rdl': 'lower', 'Push Press': 'full', 'Block Clean Pull': 'full',
    'Kettlebell Swing': 'full', 'Hanging Leg Raise': 'full', 'Telle Extension': 'upper', 'Leg Extension': 'lower', 'Close Grip Barbell Bench Press': 'upper',
  };
  for (const [n, r] of Object.entries(expect)) eq(L.guessRegion(n), r, n);
  ok(!L.guessExplosive('Snatch Grip Deadlift') && !L.guessExplosive('Clean Grip Rdl') && !L.guessExplosive('Block Pull'), 'grip pulls are not explosive');
  ok(L.guessExplosive('Push Press') && L.guessExplosive('Snatch High Pull') && L.guessExplosive('Double Bounce Squat'));
});

// ---------- seed shape ----------
test('seed has technique tier, jumps family and technique goal', () => {
  const s = seed();
  ok(L.TIERS.includes('TECH') && s.tiers.TECH);
  ok(s.families.some(f => f.id === 'fam-jumps'));
  ok(s.slots.some(sl => sl.tier === 'TECH') && s.slots.some(sl => sl.id === 'sl-t2-jumps' && sl.repMin === 12));
  ok(L.schemeOptions(s, 'TECH').length >= 4, 'technique schemes');
  eq([s.tiers.T1.repMin, s.tiers.T1.repMax, s.tiers.T1.intMin], [10, 15, 0.85], 'GZCL T1');
});
test('seed exercises carry region and explosive', () => {
  const s = seed();
  const get = id => s.exercises.find(e => e.id === id);
  eq([get('ex-back-squat').region, get('ex-back-squat').explosive], ['lower', false]);
  eq([get('ex-power-clean').region, get('ex-power-clean').explosive], ['full', true]);
  eq([get('ex-broad-jump').region, get('ex-broad-jump').explosive], ['lower', true]);
  eq([get('ex-wpullup').region, get('ex-wpullup').explosive], ['upper', false]);
});

// ---------- exercise and dose rules ----------
test('jumps can be picked for a T2 goal, and a goal can set its own reps', () => {
  const s = seed();
  const loc = s.locations[1];
  eq(L.pickExercise(s, 'fam-jumps', loc, 'T2')?.id, 'ex-broad-jump');
  eq(L.pickExercise(s, 'fam-squat', loc, 'T2')?.metric, 'load_reps', 'non-explosive still needs a load');
  eq(L.slotDose(s, s.slots.find(x => x.id === 'sl-t2-jumps')).repMin, 12);
  eq(L.slotDose(s, null, 'T2').repMin, 20);
});
test('scheme for explosive jumps: short sets, no more contacts than the goal allows', () => {
  const s = seed();
  const ex = s.exercises.find(e => e.id === 'ex-broad-jump');
  const dose = L.slotDose(s, s.slots.find(x => x.id === 'sl-t2-jumps'));
  eq([dose.repMin, dose.repMax], [12, 20]);
  for (const fatigue of [1, 3, 5]) {
    const sc = L.pickScheme(s, 'T2', ex, 30, ci({ fatigue }), dose);
    ok(sc && sc.reps <= 3, `fatigue ${fatigue}: got ${sc?.name}`);
    ok(L.doseFit(s, 'T2', sc, dose), `fatigue ${fatigue}: ${sc.name} fits 12-20 jumps`);
  }
});
test('non-explosive lifts still get more volume on a high-energy day', () => {
  const s = seed();
  const ex = s.exercises.find(e => e.id === 'ex-incline-bench');
  ok(L.pickScheme(s, 'T2', ex, 30, ci({ fatigue: 1 })).reps >= 6);
});

// ---------- crediting ----------
test('jump reps fill the jumps goal at its own minimum', () => {
  const s = seed();
  done(s, 'ex-broad-jump', 'T2', 3, 3);              // 9 reps: not enough
  eq(L.creditWeek(s).slots.get('sl-t2-jumps').filled, 0);
  done(s, 'ex-broad-jump', 'T2', 3, 1);              // 12 reps
  eq(L.creditWeek(s).slots.get('sl-t2-jumps').filled, 1);
});
test('technique sets fill only the technique goal, any load', () => {
  const s = seed();
  done(s, 'ex-power-clean', 'TECH', 2, 4, 0, 95);    // light, 8 reps
  const c = L.creditWeek(s);
  eq(c.slots.get('sl-tq-clean').filled, 1);
  eq(c.slots.get('sl-t2-clean').filled, 0, 'power goal untouched');
});
test('technique and pump sessions never lower the estimated max, however many there are', () => {
  const s = seed();
  done(s, 'ex-power-clean', 'T1', 2, 6, 20, 225);
  const before = Math.round(L.estimatedMax(s, 'ex-power-clean'));
  eq(before, 240);
  for (const d of [12, 9, 6, 3, 1]) done(s, 'ex-power-clean', 'TECH', 2, 5, d, 155);
  done(s, 'ex-power-clean', 'T3', 5, 3, 2, 95);
  eq(Math.round(L.estimatedMax(s, 'ex-power-clean')), before);
  const load = L.targetLoad(s, s.exercises.find(e => e.id === 'ex-power-clean'), 'T1', s.schemes.find(x => x.id === 's-t1-6x2'));
  ok(load >= 205, `T1 load after technique weeks: ${load}`);
});

// ---------- readiness ----------
test('heavy lower work yesterday: jumps and cleans wait, pull-ups do not matter', () => {
  const s = seed();
  done(s, 'ex-back-squat', 'T1', 3, 5, 1, 315);
  const get = id => s.exercises.find(e => e.id === id);
  const c = ci();
  ok(!L.powerReadiness(s, c, get('ex-broad-jump')).fresh, 'lower jumps not fresh');
  ok(!L.powerReadiness(s, c, get('ex-power-clean')).fresh, 'whole-body clean not fresh');
  ok(L.powerReadiness(s, c, { region: 'upper' }).fresh, 'upper explosive is fine');
});
test('heavy upper work yesterday: jumps stay fresh', () => {
  const s = seed();
  done(s, 'ex-wpullup', 'T1', 2, 6, 1, 90);
  ok(L.powerReadiness(s, ci(), s.exercises.find(e => e.id === 'ex-broad-jump')).fresh, 'jumps fresh');
  ok(!L.powerReadiness(s, ci(), s.exercises.find(e => e.id === 'ex-power-clean')).fresh, 'cleans use the whole body');
});
test('explosive T1 work does not count as heavy: jumps and cleans stay fresh the day after T1 cleans', () => {
  const s = seed();
  done(s, 'ex-power-clean', 'T1', 2, 6, 1, 225);
  ok(L.powerReadiness(s, ci(), s.exercises.find(e => e.id === 'ex-broad-jump')).fresh, 'jumps fresh');
  ok(L.powerReadiness(s, ci(), s.exercises.find(e => e.id === 'ex-power-clean')).fresh, 'cleans fresh');
  ok(L.buildSuggestion(s, ci()).blocks.some(b => b.exerciseId === 'ex-broad-jump'), 'jumps still suggested');
});
test('heavy work two days ago does not count', () => {
  const s = seed();
  done(s, 'ex-back-squat', 'T1', 3, 5, 2, 315);
  ok(L.powerReadiness(s, ci(), s.exercises.find(e => e.id === 'ex-broad-jump')).fresh);
});
test('a block does not make itself not-fresh', () => {
  const s = seed();
  done(s, 'ex-power-clean', 'T1', 2, 3, 0, 225, 'mine');
  ok(L.powerReadiness(s, ci(), s.exercises.find(e => e.id === 'ex-power-clean'), Date.now() + 1000, 'mine').fresh);
});
test('tired makes everything explosive not fresh', () => {
  const s = seed();
  ok(!L.powerReadiness(s, ci({ fatigue: 4 }), s.exercises.find(e => e.id === 'ex-broad-jump')).fresh);
  ok(!L.powerReadiness(s, ci({ fatigue: 3, sleep: 1 }), s.exercises.find(e => e.id === 'ex-broad-jump')).fresh);
});

// ---------- suggestions ----------
test('fresh day: power work first, no technique block', () => {
  const s = seed();
  const r = L.buildSuggestion(s, ci());
  ok(r.blocks.length > 0);
  const ex = id => s.exercises.find(e => e.id === id);
  ok(!r.blocks.some(b => b.tier === 'TECH'), 'no technique when fresh');
  const firstNon = r.blocks.findIndex(b => !ex(b.exerciseId).explosive);
  const lastExpl = r.blocks.map(b => ex(b.exerciseId).explosive).lastIndexOf(true);
  ok(firstNon === -1 || lastExpl < firstNon, 'explosive blocks come first');
  ok(r.ready.fresh);
});
test('tired day: no explosive power blocks, technique instead', () => {
  const s = seed();
  const r = L.buildSuggestion(s, ci({ fatigue: 5 }));
  const ex = id => s.exercises.find(e => e.id === id);
  ok(r.blocks.some(b => b.tier === 'TECH'), 'technique block present');
  ok(!r.blocks.some(b => (b.tier === 'T1' || b.tier === 'T2') && ex(b.exerciseId).explosive), 'no explosive power block');
  ok(r.ready.tired);
});
test('after heavy squats: lower jumps become technique-only, upper work is unaffected', () => {
  const s = seed();
  done(s, 'ex-back-squat', 'T1', 3, 5, 1, 315);
  const scored = L.scoreSlots(s, ci());
  const jumps = scored.find(x => x.slot.id === 'sl-t2-jumps');
  ok(jumps.why.some(w => w.includes('not fresh')), 'jump goal flagged not fresh');
  const tech = scored.find(x => x.slot.id === 'sl-tq-clean');
  ok(tech.why.some(w => w.includes('technique day')), 'technique goal boosted');
});
test('intent still works: sweat day skips T1', () => {
  const s = seed();
  const r = L.buildSuggestion(s, ci({ minutes: 20, intent: 'sweat', fatigue: 2 }));
  ok(!r.blocks.some(b => b.tier === 'T1'), 'no T1 on a sweat day');
});
test('block order keeps tier order within a rank', () => {
  const s = seed();
  const r = L.buildSuggestion(s, ci({ minutes: 90 }));
  const tiers = r.blocks.map(b => b.tier);
  ok(tiers.indexOf('T3') === -1 || tiers.indexOf('T3') > tiers.indexOf('T1') || tiers.indexOf('T1') === -1);
});

// ---------- migration ----------
test('v5 data upgrades to v6 without losing anything', () => {
  const s = seed();
  s.version = 5;
  delete s.tiers.TECH;
  s.families = s.families.filter(f => f.id !== 'fam-jumps');
  s.exercises = s.exercises.filter(e => e.familyId !== 'fam-jumps');
  s.schemes = s.schemes.filter(x => !/^s-(tq|t2-[45]x3)/.test(x.id));
  s.slots = s.slots.filter(x => !['sl-t2-jumps', 'sl-tq-clean'].includes(x.id));
  for (const e of s.exercises) { delete e.region; delete e.explosive; }
  s.exercises.push({ id: 'custom1', name: 'Seated Broad Jump', familyId: 'fam-squat', rank: 9, metric: 'reps', equipment: [] });
  s.slots.push({ id: 'mine', familyId: 'fam-squat', tier: 'T1', quota: 3, priority: 3 }); // user's own goal
  const m = migrate(s);
  eq(m.version, 15);
  ok(m.tiers.TECH && m.families.some(f => f.id === 'fam-jumps'));
  eq(m.exercises.find(e => e.id === 'ex-back-squat').region, 'lower');
  ok(m.exercises.find(e => e.id === 'ex-power-clean').explosive);
  eq([m.exercises.find(e => e.id === 'custom1').region, m.exercises.find(e => e.id === 'custom1').explosive], ['lower', true], 'custom exercise guessed');
  ok(m.slots.some(x => x.id === 'mine' && x.quota === 3), 'own goal untouched');
  ok(m.slots.some(x => x.id === 'sl-tq-clean') && m.slots.some(x => x.id === 'sl-t2-jumps'));
  ok(L.schemeOptions(m, 'TECH').length >= 4);
  const again = migrate(structuredClone(m));
  eq(again.slots.length, m.slots.length, 'idempotent goals');
  eq(again.exercises.length, m.exercises.length, 'idempotent exercises');
  eq(again.schemes.length, m.schemes.length, 'idempotent schemes');
});
test('a backup without a version number still gets every upgrade', () => {
  const s = seed();
  delete s.version;
  delete s.tiers.TECH;
  s.slots = s.slots.filter(x => x.id !== 'sl-t2-jumps');
  const m = migrate(s);
  eq(m.version, 15);
  ok(m.tiers.TECH, 'technique tier added');
});
test('v6 data gets the jumps cap without touching an edited goal', () => {
  const s = seed();
  s.version = 6;
  delete s.slots.find(x => x.id === 'sl-t2-jumps').repMax;
  eq(migrate(s).slots.find(x => x.id === 'sl-t2-jumps').repMax, 20);
  const t = seed();
  t.version = 6;
  t.slots.find(x => x.id === 'sl-t2-jumps').repMax = 30;
  eq(migrate(t).slots.find(x => x.id === 'sl-t2-jumps').repMax, 30);
});
test('user edited T1 dose is not overwritten by migration', () => {
  const s = seed();
  s.version = 4;
  s.tiers.T1 = { repMin: 12, repMax: 18, intMin: 0.8, intMax: 0.9 };
  eq(migrate(s).tiers.T1.repMin, 12);
});

// ---------- archive ----------
test('archived exercises are left out of suggestions and swaps', () => {
  const s = seed();
  const loc = s.locations[1];
  s.exercises.find(e => e.id === 'ex-back-squat').archived = true;
  eq(L.pickExercise(s, 'fam-squat', loc, 'T1')?.id, 'ex-front-squat', 'next by rank');
  ok(!L.alternatives(s, s.exercises.find(e => e.id === 'ex-front-squat'), loc).some(e => e.id === 'ex-back-squat'));
});

// ---------- FitNotes import ----------
const KG = lb => lb / 2.20462262;
const ago = d => L.dayKey(Date.now() - d * DAY);
const fnData = () => {
  const logs = [];
  let id = 1;
  const add = (ex, d, lb, reps, n = 1) => { for (let i = 0; i < n; i++) logs.push({ id: id++, ex, date: ago(d), kg: KG(lb), reps, distance: 0, secs: 0 }); };
  for (const d of [24, 17, 10, 3]) { add(1, d, 0, 10); add(1, d, 1, 8); add(1, d, 53, 3, 3); }    // Pull Up: bodyweight and +53
  for (const d of [16, 9, 2]) add(2, d, 225, 2, 6);                                               // Block Power Clean, heavy
  add(2, 1, 135, 3, 4);                                                                              // ...and a light day
  for (const d of [16, 9, 2]) { add(3, d, 1, 3, 4); add(3, d, 10, 3); }                            // Seated Broad Jump (one set holding 10 lb)
  for (const d of [19, 12, 5]) add(4, d, 30, 1, 6);                                                 // Sprints: distance typed as weight
  for (const d of [210, 200]) add(5, d, 315, 3, 5);                                                 // Barbell Squat, older
  for (const d of [17, 10, 3]) { add(6, d, 0, 10); add(6, d, 50, 10, 3); }                          // Dumbbell Row, one set with no weight
  add(7, 900, 120, 10, 3);                                                                           // Lat Pulldown, before the window
  for (const d of [11, 4]) { add(8, d, 25, 5, 3); add(8, d, 0, 5); }                               // Pistol Squat holding weight
  add(8, 30, 1, 5, 2);
  logs.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  return {
    exercises: [
      { id: 1, name: 'Pull Up', type: 0, category: 'Back' }, { id: 2, name: 'Block Power Clean', type: 0, category: 'Back' },
      { id: 3, name: 'Seated Broad Jump', type: 0, category: 'Legs' }, { id: 4, name: 'Sprints', type: 0, category: 'Legs' },
      { id: 5, name: 'Barbell Squat', type: 0, category: 'Legs' }, { id: 6, name: 'Dumbbell Row', type: 0, category: 'Back' },
      { id: 7, name: 'Lat Pulldown', type: 0, category: 'Back' }, { id: 8, name: 'Pistol Squat', type: 0, category: 'Legs' },
    ],
    logs,
  };
};
const fnPlan = (s, data) => FN.planImport(s, data, { cutoff: ago(730) });

test('FitNotes plan: matches by name and by how sets were logged', () => {
  const s = seed();
  const plan = fnPlan(s, fnData());
  const row = name => plan.rows.find(r => r.fnName === name);
  ok(!row('Lat Pulldown'), 'history before the window is left out');
  eq([row('Pull Up').target, row('Pull Up').mode, row('Pull Up').active], ['ex-wpullup', 'bw_load', true], 'Pull Up');
  eq([row('Barbell Squat').target, row('Barbell Squat').active], ['ex-back-squat', false], 'Barbell Squat');
  const clean = row('Block Power Clean');
  eq([clean.target, clean.mode, clean.family, clean.region, clean.explosive], ['new', 'load', 'Clean variations', 'full', true], 'clean');
  ok(clean.equipment.includes('barbell'), 'clean needs a barbell');
  const bj = row('Seated Broad Jump');
  eq([bj.target, bj.mode, bj.family, bj.region, bj.explosive, bj.equipment.length], ['new', 'reps', 'Jumps', 'lower', true, 0], 'broad jump');
  eq([row('Sprints').mode, row('Sprints').family], ['distance', 'Sprints']);
  eq([row('Dumbbell Row').mode, row('Dumbbell Row').equipment], ['load', ['dumbbells']]);
  eq([row('Pistol Squat').target, row('Pistol Squat').mode], ['ex-pistol', 'bw_load']);
  ok(FN.willAdopt(s, row('Pistol Squat')), 'unused starter exercise switches to weighted');
});
test('FitNotes import: converts sets, guesses tiers, and a second import adds nothing', () => {
  const s = seed();
  const data = fnData();
  const plan = fnPlan(s, data);
  const sum = FN.applyImport(s, data, plan, { bodyweight: 235 });
  const inWindow = data.logs.filter(r => r.ex !== 7);
  eq(sum.sets, inWindow.length, 'every set in the window');
  eq(sum.sessions, new Set(inWindow.map(r => r.date)).size, 'one session per day');
  eq([sum.created, sum.matched], [4, 3], 'created vs matched');
  eq(sum.adopted, ['Pistol squat']);
  const sets = id => s.sets.filter(x => x.exerciseId === id);
  const pu = sets('ex-wpullup');
  eq(pu.filter(x => x.load === 0).length, 8, 'bodyweight pull-ups (0 and 1 lb) have no added load');
  eq(pu.filter(x => x.load === 53).length, 12);
  ok(pu.every(x => x.bw === 235));
  const row = s.exercises.find(e => e.name === 'Dumbbell Row');
  eq(sets(row.id).filter(x => x.load === undefined).length, 3, 'loaded lift with no weight entered: weight unknown');
  const sprint = s.exercises.find(e => e.name === 'Sprints');
  ok(sets(sprint.id).every(x => x.distance === 30), 'sprint distances');
  const clean = s.exercises.find(e => e.name === 'Block Power Clean');
  eq([clean.metric, clean.explosive, clean.region, clean.maxReps, clean.archived], ['load_reps', true, 'full', 5, false]);
  eq(sets(clean.id).filter(x => x.load === 225).every(x => x.tier === 'T1'), true, 'heavy doubles are T1');
  eq(sets(clean.id).filter(x => x.load === 135).every(x => x.tier === 'T3'), true, 'the light day is T3');
  eq(Math.round(L.estimatedMax(s, clean.id)), 240, 'light day does not drag the max');
  ok(sets(s.exercises.find(e => e.name === 'Seated Broad Jump').id).every(x => x.tier === 'T2'), 'jumps are power work');
  eq(s.exercises.find(e => e.id === 'ex-pistol').metric, 'load_reps');
  ok(s.sessions.filter(x => x.source === 'imported').every(x => x.status === 'done' && !x.firstSetAt), 'imported sessions stay out of check-in stats');
  const m = sum.maxes.find(x => x.name === 'Block Power Clean');
  ok(m && Math.round(m.max) === 240 && !m.stale, 'summary max');
  ok(Math.round(sum.maxes.find(x => x.name === 'Weighted pull-up').added) === 82, 'pull-up max shown as added weight');
  // Again, with the same backup: nothing new.
  const before = { sets: s.sets.length, exercises: s.exercises.length, sessions: s.sessions.length };
  const plan2 = fnPlan(s, data);
  ok(plan2.rows.every(r => r.target !== 'new' && r.again), 'second import reuses the first one\'s choices');
  const sum2 = FN.applyImport(s, data, plan2, { bodyweight: 235 });
  eq([sum2.sets, sum2.skipped, sum2.created], [0, inWindow.length, 0]);
  eq({ sets: s.sets.length, exercises: s.exercises.length, sessions: s.sessions.length }, before);
});
test('FitNotes import: each family\'s usual choice follows what you do most, unless you use the current one here', () => {
  const s = seed();
  const data = fnData();
  const sum = FN.applyImport(s, data, fnPlan(s, data), { bodyweight: 235 });
  const clean = s.exercises.find(e => e.name === 'Block Power Clean');
  eq(s.families.find(f => f.id === 'fam-clean').defaultExerciseId, clean.id, 'clean family');
  eq(s.families.find(f => f.id === 'fam-jumps').defaultExerciseId, s.exercises.find(e => e.name === 'Seated Broad Jump').id, 'jumps family');
  ok(sum.defaults.some(d => d.includes('Block Power Clean')));
  const t = seed();
  done(t, 'ex-power-clean', 'T1', 2, 3, 40, 185); // Power clean logged in this app
  FN.applyImport(t, data, fnPlan(t, data), { bodyweight: 235 });
  eq(t.families.find(f => f.id === 'fam-clean').defaultExerciseId, 'ex-power-clean', 'your in-app choice stays');
});
test('T1 schemes are sets of 1-3, as GZCL defines them', () => {
  const s = seed();
  ok(L.schemeOptions(s, 'T1').every(sc => sc.reps <= 3), L.schemeOptions(s, 'T1').map(x => x.name).join(','));
  const old = seed();
  old.version = 6;
  old.schemes.find(x => x.id === 's-t1-3x5').tiers = ['T1'];
  ok(L.schemeOptions(migrate(old), 'T1').every(sc => sc.reps <= 3), 'upgrade moves 3x5 to T2');
});
test('FitNotes import: an exercise you already log here keeps how you log it', () => {
  const s = seed();
  done(s, 'ex-pistol', 'T3', 8, 3, 1);
  ok(!FN.guessMatch(s, { name: 'Pistol Squat' }, 'bw_load'), 'no silent switch for an exercise in use');
});
test('FitNotes import: imported sets this week count toward goals', () => {
  const s = seed();
  const data = fnData();
  FN.applyImport(s, data, fnPlan(s, data), { bodyweight: 235 });
  const wk = L.weekBounds(s);
  const thisWeek = s.sets.filter(x => x.src === 'fitnotes' && x.loggedAt >= wk.start && x.loggedAt < wk.end);
  ok(thisWeek.every(x => ['T1', 'T2', 'T3'].includes(x.tier)), 'every imported set has a tier');
});

// ---------- suggested goals ----------
// Twelve weeks, three workouts a week: cleans + jumps + squats on day one, pull-ups + dips (+ extras) on day two, cleans + curls on day three.
const history = (extras = []) => {
  const s = seed();
  s.settings.bodyweight = 235;
  for (let w = 0; w < 12; w++) {
    const [a, b, c] = [7 * w + 5, 7 * w + 3, 7 * w + 1];
    done(s, 'ex-power-clean', 'T1', 2, 6, a, 225, `pc${a}`);
    done(s, 'ex-broad-jump', 'T2', 3, 4, a, null, `bj${a}`);
    done(s, 'ex-back-squat', 'T1', 3, 5, a, 315, `sq${a}`);
    done(s, 'ex-wpullup', 'T2', 6, 4, b, 45, `pu${b}`);
    done(s, 'ex-wdip', 'T1', 3, 5, b, 90, `dp${b}`);
    for (const id of extras) done(s, id, 'T3', 12, 3, b, null, `${id}${b}`);
    done(s, 'ex-power-clean', 'T1', 2, 6, c, 225, `pc${c}`);
    done(s, 'ex-db-curl', 'T3', 12, 3, c, 30, `cu${c}`);
  }
  return s;
};
const fam = (s, r) => s.families.find(f => f.id === r.familyId).name;

test('suggested goals: explosive first, GZCL tiers, about one heavy lift per workout', () => {
  const s = history();
  const g = G.suggestGoals(s);
  eq([g.workouts, Math.round(g.perWeek), g.heavyCap, g.capacity], [36, 3, 3, 9]);
  const row = (name, tier) => g.rows.find(r => fam(s, r) === name && r.tier === tier);
  const clean = row('Clean variations', 'T1');
  eq([clean.kind, clean.quota, clean.priority], ['power-lift', 2, 3], 'cleans: heavy power, twice a week, high priority');
  eq(g.rows[0], clean, 'listed first');
  eq(row('Clean variations', 'TECH')?.quota, 1, 'a technique goal for tired days');
  const jumps = row('Jumps', 'T2');
  eq([jumps.kind, jumps.priority, jumps.repMin, jumps.repMax], ['power', 3, 12, 20], 'jumps');
  eq(row('Squat pattern', 'T1')?.kind, 'strength', 'squats keep T1 (lower body first)');
  const dip = row('Dip', 'T2');
  ok(dip && dip.kind === 'support' && /room for about 3 heavy/.test(dip.reason), 'dips move to T2 support: only 3 heavy slots');
  eq(row('Vertical pull', 'T2')?.kind, 'strength', 'moderate pull-ups stay T2');
  eq(row('Arms (pump)', 'T3')?.kind, 'accessory');
  const chest = g.rows.find(r => r.kind === 'press');
  ok(chest && chest.priority === 1 && /Chest/.test(chest.reason), 'chest kept in at low priority');
  const heavy = g.rows.filter(r => r.include && r.tier === 'T1').reduce((t, r) => t + r.quota, 0);
  eq(heavy, 3, 'heavy sessions a week');
  ok(g.rows.filter(r => r.include).reduce((t, r) => t + r.quota, 0) <= g.capacity, 'fits the week');
});
test('suggested goals: a crowded week drops accessories before anything else', () => {
  const s = history(['ex-hanging-knee', 'ex-ring-facepull', 'ex-ring-curl']);
  const g = G.suggestGoals(s);
  const on = g.rows.filter(r => r.include);
  ok(on.reduce((t, r) => t + r.quota, 0) <= g.capacity, 'fits');
  ok(g.rows.filter(r => !r.include).every(r => r.kind === 'accessory'), 'only accessories unticked');
  ok(on.some(r => r.kind === 'power-lift') && on.some(r => r.kind === 'press'), 'explosive and chest stay');
  ok(g.rows.filter(r => !r.include).every(r => /Left unticked/.test(r.reason)), 'says why');
});
test('suggested goals: not enough history gives no suggestions', () => {
  const s = seed();
  done(s, 'ex-back-squat', 'T1', 3, 5, 2, 315);
  eq(G.suggestGoals(s).rows.length, 0);
});
test('suggested goals: replace, add without duplicates, and undo', () => {
  const s = history();
  const g = G.suggestGoals(s);
  const original = s.slots.map(x => x.id);
  const before = G.applyGoals(s, g.rows, 'replace');
  eq(before.map(x => x.id), original, 'previous goals returned for undo');
  eq(s.slots.length, g.rows.filter(r => r.include).length);
  ok(s.slots.some(x => x.tier === 'TECH') && s.slots.find(x => x.familyId === 'fam-jumps').repMin === 12);
  const n = s.slots.length;
  G.applyGoals(s, g.rows, 'add');
  eq(s.slots.length, n, 'adding the same goals again adds nothing');
});
test('with suggested goals, a tired day does technique cleans instead of heavy ones', () => {
  const s = history();
  G.applyGoals(s, G.suggestGoals(s).rows, 'replace');
  const nextWeek = Date.now() + 7 * DAY; // this week's goals are already done in this history
  const r = L.buildSuggestion(s, ci({ fatigue: 4 }), nextWeek);
  ok(r.blocks.some(b => b.tier === 'TECH' && b.exerciseId === 'ex-power-clean'), 'technique cleans');
  ok(!r.blocks.some(b => b.tier !== 'TECH' && s.exercises.find(e => e.id === b.exerciseId).explosive), 'no explosive power work');
  const fresh = L.buildSuggestion(s, ci(), nextWeek);
  eq(fresh.blocks[0].exerciseId, 'ex-power-clean', 'fresh: power cleans first');
});
test('a heavy (T1) goal only uses lifts you have loaded, so it waits rather than becoming goblet squats', () => {
  const s = seed();
  const office = s.locations.find(l => l.id === 'loc-office');
  const basement = s.locations.find(l => l.id === 'loc-basement');
  eq(L.pickExercise(s, 'fam-squat', office, 'T1')?.id, 'ex-goblet', 'no history yet: anything loaded will do');
  done(s, 'ex-back-squat', 'T1', 3, 5, 3, 315);
  eq(L.pickExercise(s, 'fam-squat', office, 'T1'), null, 'office: no heavy squat available');
  eq(L.pickExercise(s, 'fam-squat', basement, 'T1')?.id, 'ex-back-squat');
  eq(L.pickExercise(s, 'fam-squat', office, 'T2')?.id, 'ex-goblet', 'moderate work can still use the goblet squat');
});
test('timed and distance sets count toward a goal, one per set', () => {
  const s = seed();
  s.exercises.push({ id: 'sprint', name: 'Sprints', familyId: 'fam-jumps', rank: 9, metric: 'distance', equipment: [], explosive: true, region: 'lower' });
  s.slots.find(x => x.id === 'sl-t2-jumps').repMin = 6;
  for (let i = 0; i < 6; i++) s.sets.push({ id: `sp${i}`, sessionId: 'x', blockId: 'b', exerciseId: 'sprint', tier: 'T2', distance: 30, reps: null, done: true, loggedAt: NOON(0) + i });
  eq(L.creditWeek(s).slots.get('sl-t2-jumps').filled, 1);
});

// ---------- supersets, extra time, energy ----------
test('Hyper Pro and leg attachment movements are accessories at the Basement, not the Office', () => {
  const s = seed();
  const ids = ['ex-nordic', 'ex-ghr', 'ex-seated-legcurl', 'ex-lying-legcurl', 'ex-back-ext-90', 'ex-back-ext', 'ex-reverse-hyper', 'ex-hip-thrust',
    'ex-sorensen', 'ex-belt-squat', 'ex-leg-ext', 'ex-reverse-nordic', 'ex-calf-raise', 'ex-ghd-situp', 'ex-trap3'];
  const get = id => s.exercises.find(e => e.id === id);
  ok(ids.every(get), 'all in the library');
  const [office, basement] = s.locations;
  ok(ids.every(id => L.isAvailable(get(id), basement) && !L.isAvailable(get(id), office)), 'Basement only');
  ok(ids.every(id => !get(id).explosive), 'none explosive');
  const pat = id => L.movementPattern(s, get(id));
  eq(['ex-nordic', 'ex-seated-legcurl', 'ex-back-ext', 'ex-reverse-hyper', 'ex-sorensen', 'ex-leg-ext', 'ex-reverse-nordic', 'ex-belt-squat', 'ex-calf-raise', 'ex-ghd-situp', 'ex-trap3'].map(pat),
    ['hinge', 'hinge', 'hinge', 'hinge', 'hinge', 'knee', 'knee', 'knee', 'calf', 'core', 'pull']);
  ok(L.pairScore(s, get('ex-back-squat'), get('ex-seated-legcurl')) === 3 && L.pairScore(s, { name: 'Romanian deadlift', familyId: null }, get('ex-leg-ext')) === 3, 'squat with leg curls, RDL with leg extensions');
});
test('v7 data gets the Hyper Pro movements without doubling ones you already have', () => {
  const s = seed();
  s.version = 7;
  const hyperIds = new Set(s.exercises.filter(e => e.equipment.includes('hyper-pro')).map(e => e.id));
  s.exercises = s.exercises.filter(e => !hyperIds.has(e.id));
  s.families = s.families.filter(f => !['fam-hams', 'fam-hinge', 'fam-quads', 'fam-calves'].includes(f.id));
  s.equipment = s.equipment.filter(e => e !== 'hyper-pro' && e !== 'leg-developer');
  for (const l of s.locations) l.equipment = l.equipment.filter(e => e !== 'hyper-pro' && e !== 'leg-developer');
  s.families.push({ id: 'my-hams', name: 'Hamstrings', defaultExerciseId: 'my-nordic' });
  s.exercises.push({ id: 'my-nordic', name: '20 Nordic Curls', familyId: 'my-hams', rank: 1, metric: 'reps', equipment: [] });
  s.exercises.push({ id: 'my-ghr', name: 'Glute-Ham Raise', familyId: 'my-hams', rank: 2, metric: 'reps', equipment: [] });
  const m = migrate(s);
  eq(m.version, 15);
  ok(m.locations.find(l => l.id === 'loc-basement').equipment.includes('leg-developer'), 'gear at the Basement');
  eq(m.exercises.filter(e => /glute-?ham/i.test(e.name)).length, 1, 'no second GHR');
  eq(m.exercises.find(e => e.id === 'my-ghr').equipment, ['hyper-pro'], 'your GHR now needs the Hyper Pro');
  eq(m.families.filter(f => f.name === 'Hamstrings').length, 1, 'your Hamstrings family is reused');
  eq(m.exercises.find(e => e.name === 'Seated leg curl').familyId, 'my-hams');
  eq(m.families.find(f => f.id === 'my-hams').defaultExerciseId, 'my-nordic', 'your usual choice stays');
  ok(m.exercises.some(e => e.id === 'ex-leg-ext') && m.families.some(f => f.id === 'fam-quads'), 'new families where needed');
  const again = migrate(structuredClone(m));
  eq(again.exercises.length, m.exercises.length, 'idempotent');
});
test('movement patterns from names', () => {
  const s = seed();
  const pat = name => L.movementPattern(s, { name, familyId: null });
  const expect = { 'Back squat': 'knee', 'Nordic curl': 'hinge', 'Leg curl': 'hinge', 'Block Rdl': 'hinge', 'Calf raise': 'calf',
    'Hanging leg raise': 'core', 'Weighted pull-up': 'pull', 'Barbell row': 'pull', 'DB curl': 'pull', 'Ring face pull': 'pull',
    'Weighted ring dip': 'push', 'Telle extension': 'push', 'Push-up': 'push', 'Leg extension': 'knee', 'Back extension': 'hinge',
    'Power clean': 'full', 'Seated broad jump': 'knee', 'Lateral raise': 'push' };
  for (const [n, p] of Object.entries(expect)) eq(pat(n), p, n);
});
test('upper body pairs with its antagonist, lower body with its complement', () => {
  const s = seed();
  const e = (name, extra = {}) => ({ name, familyId: null, ...extra });
  const score = (m, p) => L.pairScore(s, e(m), e(p));
  ok(score('Weighted pull-up', 'Telle extension') === 3 && score('Weighted ring dip', 'DB curl') === 3, 'push with pull');
  eq(score('Weighted pull-up', 'Barbell row'), 0, 'not pull with pull');
  ok(score('Back squat', 'Nordic curl') === 3 && score('Block Rdl', 'Leg extension') === 3, 'squat with hamstrings, hinge with quads');
  eq(score('Back squat', 'Goblet squat'), 0, 'not squat with squat');
  ok(score('Back squat', 'Calf raise') === 2 && score('Back squat', 'Hanging leg raise') === 2, 'calves and core fit');
  ok(score('Back squat', 'Nordic curl') > score('Back squat', 'DB curl'), 'a complement beats a different region');
  eq(L.pairScore(s, e('Seated broad jump', { explosive: true }), e('Nordic curl')), 0, 'jumps keep the legs fresh');
  ok(L.pairScore(s, e('Power clean', { explosive: true }), e('Hanging leg raise')) === 3, 'core with cleans');
});
test('superset idea for heavy squats is core or leg work that balances the squat, no barbell', () => {
  const s = seed();
  const p = L.suggestPair(s, ci(), s.exercises.find(e => e.id === 'ex-back-squat'), { excludeFamilies: ['fam-squat'] });
  ok(p, 'an idea');
  ok(['core', 'hinge', 'calf'].includes(L.movementPattern(s, p.exercise)) && !p.exercise.equipment.includes('barbell'), p.exercise.name);
});
test('a goal\'s main lift is never a superset idea, but its easier variations can be', () => {
  const s = seed();
  const rdl = { name: 'Romanian deadlift', familyId: null, region: 'lower' };
  const p = L.suggestPair(s, ci(), rdl);
  ok(p && p.exercise.id !== 'ex-back-squat', p?.exercise.name);
  ok(['knee', 'core'].includes(L.movementPattern(s, p.exercise)), `quad work or core balances the hinge: ${p?.exercise.name}`);
  ok(L.pairScore(s, rdl, s.exercises.find(e => e.id === 'ex-pistol')) === 3, 'pistols are a top match for a hinge');
});
test('superset idea for pull-ups is pushing work or core', () => {
  const s = seed();
  const p = L.suggestPair(s, ci(), s.exercises.find(e => e.id === 'ex-wpullup'), { excludeFamilies: ['fam-vpull'] });
  ok(p && ['push', 'core'].includes(L.movementPattern(s, p.exercise)), p?.exercise.name);
});
test('superset idea for cleans is core or upper body', () => {
  const s = seed();
  const p = L.suggestPair(s, ci(), s.exercises.find(e => e.id === 'ex-power-clean'), { excludeFamilies: ['fam-clean'] });
  ok(p && (p.exercise.familyId === 'fam-core' || p.exercise.region === 'upper'), p?.exercise.name);
});
test('a T3 goal already met today is not the superset pick', () => {
  const s = seed();
  const sq = s.exercises.find(e => e.id === 'ex-back-squat');
  ok(/open T3 goal/.test(L.suggestPair(s, ci(), sq, { excludeFamilies: ['fam-squat'] }).why), 'open core goal mentioned');
  done(s, 'ex-hanging-knee', 'T3', 12, 3, 0);
  const p = L.suggestPair(s, ci(), sq, { excludeFamilies: ['fam-squat'] });
  ok(p && !/open T3 goal/.test(p.why), `${p?.exercise.name}: ${p?.why}`);
});
test('extra time adds goal work from families not already in the workout', () => {
  const s = seed();
  const famOfB = b => s.exercises.find(e => e.id === b.exerciseId).familyId;
  const fams = L.buildSuggestion(s, ci({ minutes: 20 })).blocks.map(famOfB);
  const more = L.buildSuggestion(s, ci({ minutes: 20 }), Date.now(), { excludeFamilies: fams });
  ok(more.blocks.length > 0, 'something added');
  ok(more.blocks.every(b => !fams.includes(famOfB(b))), 'no repeats');
});
test('tired reasons talk about energy (5 fresh), not fatigue', () => {
  const s = seed();
  const r = L.powerReadiness(s, ci({ fatigue: 5 }), s.exercises.find(e => e.id === 'ex-broad-jump'));
  ok(r.reasons.some(x => /energy 1/.test(x)), r.reasons.join());
});

test('T3s superset with each other; main lifts stay free; an odd T3 makes a giant set', () => {
  const s = seed();
  const ex = id => s.exercises.find(e => e.id === id);
  const blk = (id, tier, exerciseId) => ({ id, tier, exerciseId });
  const two = [blk('m', 'T1', 'ex-back-squat'), blk('p', 'T2', 'ex-wpullup'), blk('a', 'T3', 'ex-db-curl'), blk('c', 'T3', 'ex-hanging-knee')];
  L.pairT3s(s, two);
  eq(two.map(b => b.pairOf ?? null), [null, null, null, 'a'], 'T1 and T2 free, the two T3s together');
  const three = [blk('m', 'T1', 'ex-back-squat'), blk('a', 'T3', 'ex-db-curl'), blk('c', 'T3', 'ex-hanging-knee'), blk('f', 'T3', 'ex-ring-facepull')];
  L.pairT3s(s, three);
  eq(three.map(b => b.pairOf ?? null), [null, null, 'a', 'a'], 'three T3s: one giant set');
  const lone = [blk('m', 'T1', 'ex-back-squat'), blk('p', 'T2', 'ex-wpullup'), blk('u', 'T3', 'ex-air-squat')];
  L.pairT3s(s, lone);
  eq(lone[2].pairOf, 'p', 'a single T3 joins a main lift it does not compete with');
  const four = [blk('a', 'T3', 'ex-db-curl'), blk('f', 'T3', 'ex-ring-facepull'), blk('t', 'T3', 'ex-db-oh-tri'), blk('k', 'T3', 'ex-hanging-knee')];
  L.pairT3s(s, four);
  eq(four.map(b => b.pairOf ?? null), [null, null, 'a', 'f'], 'curls pair with triceps (antagonists), face pulls with core');
  const added = [...two, blk('d', 'T3', 'ex-dead-bug')];
  L.pairT3s(s, added);
  eq(added.at(-1).pairOf, 'a', 'a T3 added later joins the T3 superset as a giant set');
  const r = L.buildSuggestion(s, ci({ minutes: 90 }));
  ok(r.blocks.filter(b => b.tier === 'T3').every(b => b.pairOf || r.blocks.some(x => x.pairOf === b.id)), 'every suggested T3 is grouped');
  ok(L.restCompatible(s, ex('ex-power-clean'), ex('ex-ring-facepull')) && !L.restCompatible(s, ex('ex-power-clean'), ex('ex-air-squat')));
});

// ---------- mobility ----------
test('mobility starter library: your 4 routines, 16 exercises and 9 Garage Strength drills, outside the strength library', () => {
  const s = seed();
  eq([s.mobility.routines.length, s.mobility.exercises.length], [4, 25]);
  ok(s.mobility.routines.every(r => r.items.length === 4 && r.items.every(id => s.mobility.exercises.some(e => e.id === id))), 'routines resolve');
  ok(s.mobility.exercises.every(e => e.parts.length && e.parts.every(p => M.BODY_PARTS.includes(p))), 'body parts');
  ok(!s.exercises.some(e => e.id.startsWith('mob-')), 'not in the strength library');
  const ex = id => s.mobility.exercises.find(e => e.id === id);
  eq(M.doseText(ex('mob-elephant-walk')), '3 × 10/side');
  eq(M.doseText(ex('mob-couch-stretch')), '3 × 45s/side');
  eq(M.doseText(ex('mob-horse-stance')), '4 × 30–45s');
  eq(M.doseText(ex('mob-jefferson-curl')), '3 × 6 · 4s down / 2s hold');
  eq(M.doseText(ex('mob-psoas-lift')), '3 × 10–12/side · 1s pause at top');
  ok(M.videoSearch('kneesovertoesguy elephant walk').startsWith('https://www.youtube.com/results?search_query=kneesovertoesguy%20elephant%20walk'));
});
test('mobility by body part: least recently done first, one per part, no repeats', () => {
  const s = seed();
  const parts = ['Adductors', 'Hamstrings'];
  const first = M.suggestForParts(s, parts);
  eq(first.length, 2);
  const ex = id => s.mobility.exercises.find(e => e.id === id);
  ok(ex(first[0]).parts.includes('Adductors') && first.some(id => ex(id).parts.includes('Hamstrings')), first.join());
  // Log the first pick: next time something else comes first for adductors.
  const item = M.newItem(s, ex(first[0]));
  item.sets[0].done = true; item.sets[0].at = Date.now();
  s.mobility.sessions.push({ id: 'm1', day: L.dayKey(), startedAt: Date.now(), status: 'done', items: [item] });
  ok(M.suggestForParts(s, ['Adductors'])[0] !== first[0], 'rotates to a move not done lately');
  ok(!M.suggestForParts(s, ['Adductors'], [first[0]]).includes(first[0]), 'excluded stays out');
  const ranked = M.rankForParts(s, ['Adductors', 'Hamstrings']);
  ok(ranked[0].hits === 2, 'a move covering both parts ranks first');
});
test('mobility logs: last time, prefilled loads, week summary, workouts count too', () => {
  const s = seed();
  const jc = s.mobility.exercises.find(e => e.id === 'mob-jefferson-curl');
  const a = M.newItem(s, jc);
  eq(a.sets.map(x => x.reps), [6, 6, 6]);
  a.sets[0] = { ...a.sets[0], done: true, at: Date.now() - DAY, load: 88, extra: '35+25+25' };
  a.note = 'tight hamstrings';
  s.mobility.sessions.push({ id: 'm1', day: L.dayKey(Date.now() - DAY), startedAt: Date.now() - DAY, status: 'done', items: [a] });
  const b = M.newItem(s, jc);
  eq([b.sets[0].load, b.sets[0].extra], [88, '35+25+25'], 'prefilled from last time');
  const last = M.lastFor(s, jc.id, b.id);
  eq(M.itemText(jc, last.item, 'lb'), '88 lb × 6 · Deficit (cm) 35+25+25');
  eq(last.item.note, 'tight hamstrings');
  const hang = s.mobility.exercises.find(e => e.id === 'mob-bar-hang');
  const c = M.newItem(s, hang);
  c.sets[0] = { ...c.sets[0], done: true, at: Date.now() };
  s.sessions.push({ id: 'w1', day: L.dayKey(), status: 'done', blocks: [], mobility: [c] });
  const wk = L.weekBounds(s);
  const sum = M.weekSummary(s, wk.start, wk.end);
  ok(sum.parts.includes('Shoulders') && sum.parts.includes('Lats'), 'workout mobility counts');
  ok(L.creditWeek(s).slots.size === s.slots.length && !L.creditWeek(s).assign.size, 'mobility never touches strength goals');
});
test('v8 data gets the mobility suite and keeps everything else', () => {
  const s = seed();
  s.version = 8;
  delete s.mobility;
  s.plans.push({ id: 'p', name: 'mine', items: [] });
  const m = migrate(s);
  eq(m.version, 15);
  eq(m.mobility.routines.length, 4);
  ok(m.plans.some(p => p.id === 'p'));
  const again = migrate(structuredClone(m));
  eq(again.mobility.exercises.length, 25, 'idempotent (16 plus the 9 Garage Strength drills)');
});

test('deficit RDL is a hamstring exercise with a weekly T2 goal', () => {
  const s = seed();
  const rdl = s.exercises.find(e => e.id === 'ex-deficit-rdl');
  eq([rdl.familyId, rdl.metric, rdl.region, rdl.explosive], ['fam-hams', 'load_reps', 'lower', false]);
  const goal = s.slots.find(x => x.exerciseId === 'ex-deficit-rdl');
  eq([goal.familyId, goal.tier, goal.quota], ['fam-hams', 'T2', 1]);
  eq(L.slotFor(s, rdl, 'T2')?.id, goal.id, 'its T2 sets count toward the goal');
  eq(L.slotFor(s, s.exercises.find(e => e.id === 'ex-nordic'), 'T2'), null, 'Nordics don\'t stand in for it');
  const loc = id => s.locations.find(l => l.id === id);
  eq(L.pickExercise(s, 'fam-hams', loc('loc-basement'), 'T2', 'ex-deficit-rdl')?.id, 'ex-deficit-rdl');
  eq(L.pickExercise(s, 'fam-hams', loc('loc-office'), 'T2', 'ex-deficit-rdl'), null, 'needs the barbell');
  const res = L.buildSuggestion(s, ci({ minutes: 90 }));
  ok(res.scored.some(c => c.slot.id === goal.id), 'scored for a basement session');
});
test('v9 data gets deficit RDLs and the T2 goal, reusing what you already have', () => {
  const s = seed();
  s.version = 9;
  s.exercises = s.exercises.filter(e => e.id !== 'ex-deficit-rdl');
  s.slots = s.slots.filter(x => x.id !== 'sl-t2-hams');
  const m = migrate(structuredClone(s));
  eq(m.version, 15);
  const rdl = m.exercises.find(e => e.id === 'ex-deficit-rdl');
  ok(rdl && rdl.familyId === 'fam-hams', 'added to Hamstrings');
  ok(m.slots.some(x => x.exerciseId === rdl.id && x.tier === 'T2'), 'goal added');
  const again = migrate(structuredClone(m));
  eq(again.exercises.filter(e => e.id === 'ex-deficit-rdl').length, 1, 'idempotent exercise');
  eq(again.slots.filter(x => x.exerciseId === 'ex-deficit-rdl').length, 1, 'idempotent goal');
  // Imported from FitNotes as "Deficit RDL" in its own family: that one gets the goal, no duplicate.
  const t = structuredClone(s);
  t.families.push({ id: 'f-imp', name: 'Romanian deadlift', defaultExerciseId: 'x-imp' });
  t.exercises.push({ ...rdl, id: 'x-imp', name: 'Deficit RDL', familyId: 'f-imp' });
  const n = migrate(t);
  ok(!n.exercises.some(e => e.id === 'ex-deficit-rdl'), 'no duplicate exercise');
  eq(n.slots.filter(x => x.exerciseId === 'x-imp').map(x => [x.familyId, x.tier]), [['f-imp', 'T2']]);
  // No Hamstrings family at all: it comes back with the RDL as its usual exercise.
  const u = structuredClone(s);
  u.families = u.families.filter(f => f.id !== 'fam-hams');
  u.exercises = u.exercises.filter(e => e.familyId !== 'fam-hams');
  const w = migrate(u);
  eq(w.families.find(f => f.id === 'fam-hams')?.defaultExerciseId, 'ex-deficit-rdl');
});

test('warm-up sets never count: max, goals, target load, heavy work', () => {
  const s = seed();
  const warm = (load, reps, tier = 'T1') => s.sets.push({ id: L.uid(), sessionId: 'w', blockId: 'b', exerciseId: 'ex-back-squat', tier, load, reps, done: true, warmup: true, loggedAt: NOON(0), bw: 235 });
  warm(135, 5); warm(225, 3); warm(275, 1);
  eq(L.estimatedMax(s, 'ex-back-squat'), null, 'no max from warm-ups');
  eq(L.lastLoad(s, 'ex-back-squat'), null, 'no target load from warm-ups');
  ok(![...L.creditWeek(s).slots.values()].some(r => r.days.size), 'no goal credit');
  eq(L.readinessSummary(s, ci()).heavy, [], 'warm-ups aren\'t heavy work');
  done(s, 'ex-back-squat', 'T1', 3, 5, 0, 300);
  ok(Math.round(L.estimatedMax(s, 'ex-back-squat')) === 330 && L.lastLoad(s, 'ex-back-squat') === 300, 'working sets still do');
});

test('focused workouts: upper and lower from the whole library, explosive first when fresh', () => {
  const s = seed();
  const names = res => res.blocks.map(b => `${b.tier} ${s.exercises.find(e => e.id === b.exerciseId).name}`);
  const region = id => s.exercises.find(e => e.id === id).region;
  const pat = id => L.movementPattern(s, s.exercises.find(e => e.id === id));
  const lower = L.buildFocus(s, ci({ minutes: 60 }), { region: 'lower', explosive: true });
  ok(lower.blocks.length >= 4, names(lower).join(', '));
  const first = s.exercises.find(e => e.id === lower.blocks[0].exerciseId);
  ok(first.explosive && first.region === 'lower' && lower.blocks[0].tier === 'T2', `explosive first: ${names(lower)}`);
  ok(lower.blocks.some(b => b.tier === 'T1'), 'a heavy main lift');
  ok(lower.blocks.every(b => ['lower', 'full'].includes(region(b.exerciseId)) || pat(b.exerciseId) === 'core'), `lower only: ${names(lower)}`);
  ok(lower.blocks.some(b => b.tier === 'T3') && lower.blocks.filter(b => b.tier === 'T3').every(b => b.pairOf || lower.blocks.some(x => x.pairOf === b.id)), 'T3s grouped');
  ok(lower.minutesUsed <= 60, 'fits the time');
  const upper = L.buildFocus(s, ci({ minutes: 60 }), { region: 'upper' });
  ok(upper.blocks.every(b => ['push', 'pull', 'core'].includes(pat(b.exerciseId))), `upper only: ${names(upper)}`);
  ok(new Set(upper.blocks.filter(b => b.tier !== 'T3').map(b => pat(b.exerciseId))).size === 2, 'push and pull main lifts');
  ok(!upper.blocks.some(b => s.exercises.find(e => e.id === b.exerciseId).explosive), 'no explosive work unless asked');
  // Power work leads with a family you have goals for: cleans, not jerks, until you add a jerk goal.
  const upx = L.buildFocus(s, ci({ minutes: 60 }), { region: 'upper', explosive: true });
  eq(upx.blocks[0].exerciseId, 'ex-power-clean');
  const withJerks = structuredClone(s);
  withJerks.slots.push({ id: 'sl-jerk', familyId: 'fam-jerk', tier: 'T2', quota: 1, priority: 2 });
  eq(L.buildFocus(withJerks, ci({ minutes: 60 }), { region: 'upper', explosive: true }).blocks[0].exerciseId, 'gs-split-jerk', 'jerks lead upper days once they are a goal');
  // Tired: explosive work becomes technique and the main lift drops to T2.
  const tired = L.buildFocus(s, ci({ minutes: 60, fatigue: 5 }), { region: 'lower', explosive: true });
  eq(tired.blocks[0].tier, 'TECH');
  ok(!tired.blocks.some(b => b.tier === 'T1'), `no T1 when tired: ${names(tired)}`);
  // Accessories only (for + Time), nothing from families already in the workout.
  const more = L.buildFocus(s, ci({ minutes: 20 }), { region: 'lower', accessoriesOnly: true }, Date.now(), { excludeFamilies: ['fam-hams'] });
  ok(more.blocks.length && more.blocks.every(b => b.tier === 'T3' && s.exercises.find(e => e.id === b.exerciseId).familyId !== 'fam-hams'), names(more).join(', '));
});
test('T2 power work comes in sets of 2-3 on a minute\'s rest, not sets of 5', () => {
  const s = seed();
  const clean = s.exercises.find(e => e.id === 'ex-power-clean');
  const slot = s.slots.find(x => x.id === 'sl-t2-clean');
  for (const fatigue of [1, 3, 5]) {
    const sc = L.pickScheme(s, 'T2', clean, 60, ci({ fatigue }), L.slotDose(s, slot));
    ok(sc.reps <= 3 && sc.restSec === 60 && sc.sets * sc.reps >= 20, `energy ${6 - fatigue}: ${sc.name}`);
  }
  const squat = s.exercises.find(e => e.id === 'ex-front-squat');
  ok(L.pickScheme(s, 'T2', squat, 60, ci({ fatigue: 1 })).reps >= 5, 'fresh strength work still gets its volume');
  eq(L.pickScheme(s, 'T2', squat, 60, ci({ fatigue: 5 })).name, '10×2', 'tired: low reps, many sets');
  const old = seed(); old.version = 12; old.schemes = old.schemes.filter(x => !['s-t2-10x2', 's-t2-10x3'].includes(x.id));
  const m = migrate(old);
  ok(['s-t2-10x2', 's-t2-10x3'].every(id => m.schemes.some(x => x.id === id && x.tiers.join() === 'T2' && x.restSec === 60)), 'v13 adds them');
});
test('a tired day fills leftover minutes with sets, never more reps per set', () => {
  const s = seed();
  const rdl = s.exercises.find(e => e.id === 'ex-deficit-rdl');
  const six = s.schemes.find(x => x.id === 's-t2-6x4');
  const blocks = [{ id: 'a', tier: 'T2', exerciseId: rdl.id, schemeId: six.id, slotId: 'sl-t2-hams' }];
  L.stretchToFit(s, blocks, 30, ci({ fatigue: 5 }));
  const tired = s.schemes.find(x => x.id === blocks[0].schemeId);
  ok(tired.reps <= 4 && tired.minutes > six.minutes, `tired: ${tired.name}`);
  const fresh = [{ id: 'a', tier: 'T2', exerciseId: rdl.id, schemeId: six.id, slotId: 'sl-t2-hams' }];
  L.stretchToFit(s, fresh, 30, ci({ fatigue: 1 }));
  ok(s.schemes.find(x => x.id === fresh[0].schemeId).minutes > six.minutes, 'fresh: any bigger scheme');
});
test('a heavy day adds one of your T1 lifts, trained heavy least recently and not right after heavy work there; jumps and cleans don\'t use up the two T2 lifts', () => {
  const s = seed();
  const wk = L.weekBounds(s);
  const fri = wk.start + 4 * DAY + 17 * 3600e3;
  // Monday to Thursday: every goal met; heavy squats Monday and heavy pull-ups Tuesday.
  s.slots.forEach((sl, d) => {
    const ex = L.pickExercise(s, sl.familyId, s.locations[1], sl.tier, sl.exerciseId);
    const day = sl.tier === 'T1' ? (sl.familyId === 'fam-squat' ? 0 : 1) : 2 + (d % 2);
    for (let q = 0; q < sl.quota; q++) for (let i = 0; i < 6; i++) {
      s.sets.push({ id: L.uid(), sessionId: `h${d}${q}`, blockId: `h${d}${q}`, exerciseId: ex.id, tier: sl.tier, load: 100, reps: sl.tier === 'T3' ? 12 : 5,
        done: true, loggedAt: wk.start + (day + q) * DAY + 9 * 3600e3 + i, bw: 200, countsManual: true, countsToward: sl.id });
    }
  });
  const ex = id => s.exercises.find(e => e.id === id);
  const r = L.buildSuggestion(s, ci({ minutes: 75, fatigue: 2, intent: 'heavy' }), fri);
  const names = r.blocks.map(b => `${b.tier} ${ex(b.exerciseId).name}`).join(', ');
  const t1 = r.blocks.filter(b => b.tier === 'T1').map(b => ex(b.exerciseId));
  eq(t1.length, 1, names);
  eq(t1[0].id, 'ex-back-squat', `your T1 lift trained heavy least recently (squats Monday, pull-ups Tuesday): ${names}`);
  // Heavy lower-body work yesterday: the heavy lift is the pull-up instead.
  const sore = structuredClone(s);
  for (let i = 0; i < 5; i++) sore.sets.push({ id: L.uid(), sessionId: 'thu', blockId: 'thu', exerciseId: 'ex-front-squat', tier: 'T1', load: 225, reps: 3,
    done: true, loggedAt: fri - DAY + i, bw: 200 });
  const r2 = L.buildSuggestion(sore, ci({ minutes: 75, fatigue: 2, intent: 'heavy' }), fri);
  eq(r2.blocks.filter(b => b.tier === 'T1').map(b => b.exerciseId), ['ex-wpullup'], 'after heavy squats yesterday');
  eq(r.blocks.filter(b => b.tier === 'T2' && !ex(b.exerciseId).explosive).length, 2, `two T2 strength lifts: ${names}`);
  ok(r.minutesUsed >= 70, `uses the 75 minutes: ${r.minutesUsed}`);
  const tired = L.buildSuggestion(s, ci({ minutes: 75, fatigue: 4, intent: 'heavy' }), fri);
  ok(!tired.blocks.some(b => b.tier === 'T1'), 'tired: no heavy lift added');
});
test('review fixes: + Time sees the session, heavy fill needs a max, one strength lift per pattern, T3s grouped, never over time', () => {
  const s = seed();
  s.settings.bodyweight = 200;
  const wk = L.weekBounds(s);
  const log = (id, tier, scheme, load, day, h) => {
    const sc = s.schemes.find(x => x.id === scheme);
    for (let i = 0; i < sc.sets; i++) s.sets.push({ id: L.uid(), sessionId: `r${id}${day}`, blockId: `r${id}${day}`, exerciseId: id, tier, schemeId: scheme,
      load, reps: sc.reps, done: true, loggedAt: wk.start + day * DAY + h * 3600e3 + i * 120e3, bw: 200 });
  };
  log('ex-back-ext', 'T3', 's-t3-4x12', 25, -6, 18);
  log('ex-back-squat', 'T1', 's-t1-5x3', 315, 0, 18);
  log('ex-wpullup', 'T1', 's-t1-5x3', 45, 1, 18);
  const thu = wk.start + 3 * DAY + 17.5 * 3600e3;
  const ex = id => s.exercises.find(e => e.id === id);
  const strength = b => (b.tier === 'T1' || b.tier === 'T2') && !ex(b.exerciseId).explosive;
  for (const c of [{ locationId: 'loc-office', minutes: 45, lean: null }, { locationId: 'loc-basement', minutes: 60, lean: 'lower' }]) {
    const r = L.buildSuggestion(s, ci({ ...c, fatigue: 1, intent: 'heavy' }), thu);
    const names = r.blocks.map(b => `${b.tier} ${ex(b.exerciseId).name}`).join(', ');
    ok(r.blocks.filter(b => b.tier === 'T1').every(b => L.estimatedMax(s, b.exerciseId) != null), `heavy fill only uses lifts with a max: ${names}`);
    const pats = r.blocks.filter(strength).map(b => L.movementPattern(s, ex(b.exerciseId)));
    eq(new Set(pats).size, pats.length, `one strength lift per pattern: ${names}`);
    ok(r.minutesUsed <= c.minutes, `${r.minutesUsed} of ${c.minutes} min`);
    // + Time three times: the session's heavy lift is seen, so no second T1.
    const fams = r.blocks.map(b => ex(b.exerciseId).familyId);
    for (let i = 0; i < 3; i++) {
      const more = L.buildSuggestion(s, ci({ ...c, minutes: 30, fatigue: 1, intent: 'heavy' }), thu, { excludeFamilies: fams, sessionBlocks: r.blocks });
      r.blocks.push(...more.blocks); fams.push(...more.blocks.map(b => ex(b.exerciseId).familyId));
    }
    ok(r.blocks.filter(b => b.tier === 'T1' && strength(b)).length <= 1, `+ Time adds no second heavy lift: ${r.blocks.filter(b => b.tier === 'T1').map(b => ex(b.exerciseId).name)}`);
  }
  // Ten sets of 2-3 stay out of a fresh day's strength work, even after 3×10 was just used.
  log('ex-front-squat', 'T2', 's-t2-3x10', 185, 2, 9);
  ok(L.pickScheme(s, 'T2', ex('ex-front-squat'), 60, ci({ fatigue: 1 })).reps >= 4, 'fresh T2 after 3×10 is not 10×3');
  const blocks = [{ id: 'x', tier: 'T2', exerciseId: 'ex-front-squat', schemeId: 's-t2-3x10' }];
  L.stretchToFit(s, blocks, 12, ci({ fatigue: 1 }));
  eq(blocks[0].schemeId, 's-t2-3x10', 'a fresh stretch never turns 3×10 into 10×2');
  // Office, short and tired: every T3 in a superset, within the time.
  const office = L.buildSuggestion(seed(), ci({ locationId: 'loc-office', minutes: 20, fatigue: 5, lean: 'lower' }));
  ok(office.blocks.filter(b => b.tier === 'T3').every(b => b.pairOf || office.blocks.some(x => x.pairOf === b.id)) && office.minutesUsed <= 20,
    office.blocks.map(b => `${b.tier} ${b.exerciseId}${b.pairOf ? '~' : ''}`).join(', '));
  // Focused workouts never run over, whatever the length.
  for (const minutes of [45, 60, 90]) for (const region of ['upper', 'lower']) for (const intent of ['auto', 'sweat']) {
    const f = L.buildFocus(s, ci({ minutes, intent, fatigue: 3 }), { region, explosive: true }, thu);
    ok(L.blocksMinutes(s, f.blocks) <= minutes + 1e-9, `${region} focus ${intent} ${minutes} min: ${L.blocksMinutes(s, f.blocks)}`);
  }
  // v13 keeps a T2 10×2 you already had instead of adding a duplicate.
  const old = seed(); old.version = 12; old.schemes = old.schemes.filter(x => !['s-t2-10x2', 's-t2-10x3'].includes(x.id));
  old.schemes.find(x => x.id === 's-t1-10x2').tiers.push('T2');
  eq(migrate(old).schemes.filter(x => x.tiers.includes('T2') && x.sets === 10 && x.reps === 2).length, 1, 'no duplicate 10×2');
});
test('extra heavy work sticks to your T1 goals\' lifts; support work tries your T2 goals\' lifts first', () => {
  const s = seed();
  const ex = id => s.exercises.find(e => e.id === id);
  const t1Core = ['ex-back-squat', 'ex-wpullup'];
  const t2Chosen = s.slots.filter(sl => sl.tier === 'T2').map(sl => sl.exerciseId ?? s.families.find(f => f.id === sl.familyId).defaultExerciseId);
  const wk = L.weekBounds(s);
  // Every goal met Monday to Wednesday.
  s.slots.forEach((sl, d) => {
    const e = L.pickExercise(s, sl.familyId, s.locations[1], sl.tier, sl.exerciseId);
    for (let q = 0; q < sl.quota; q++) for (let i = 0; i < 6; i++) s.sets.push({ id: L.uid(), sessionId: `c${d}${q}`, blockId: `c${d}${q}`, exerciseId: e.id, tier: sl.tier,
      load: 100, reps: sl.tier === 'T3' ? 12 : 5, done: true, loggedAt: wk.start + ((d + q) % 3) * DAY + 9 * 3600e3 + i, bw: 200, countsManual: true, countsToward: sl.id });
  });
  const fri = wk.start + 4 * DAY + 17 * 3600e3;
  const heavy = L.buildSuggestion(s, ci({ minutes: 75, fatigue: 2, intent: 'heavy' }), fri);
  const names = r => r.blocks.map(b => `${b.tier} ${ex(b.exerciseId).name}`).join(', ');
  const t1 = heavy.blocks.filter(b => b.tier === 'T1' && !ex(b.exerciseId).explosive);
  ok(t1.length === 1 && t1Core.includes(t1[0].exerciseId), `heavy day: one of your T1 lifts, ${names(heavy)}`);
  const t2 = heavy.blocks.filter(b => b.tier === 'T2' && !ex(b.exerciseId).explosive);
  ok(t2.some(b => t2Chosen.includes(b.exerciseId)), `support work includes a T2 goal's lift: ${names(heavy)}`);
  for (const region of ['upper', 'lower']) {
    const f = L.buildFocus(s, ci({ minutes: 60 }), { region }, fri);
    const ft1 = f.blocks.filter(b => b.tier === 'T1' && !ex(b.exerciseId).explosive);
    ok(ft1.every(b => t1Core.includes(b.exerciseId)), `${region} focus: heavy work is a T1 goal's lift, ${names(f)}`);
  }
  // No T1 lift for this half: the main lift is T2, not a new heavy lift.
  const upperOnly = structuredClone(s);
  upperOnly.slots = upperOnly.slots.filter(sl => !(sl.tier === 'T1' && sl.familyId === 'fam-squat'));
  const lower = L.buildFocus(upperOnly, ci({ minutes: 60 }), { region: 'lower' }, fri);
  ok(!lower.blocks.some(b => b.tier === 'T1' && !upperOnly.exercises.find(e => e.id === b.exerciseId).explosive)
    && lower.notes.some(n => /none of your T1 lifts/.test(n)), `lower focus with no lower T1 goal: ${lower.blocks.map(b => b.tier + ' ' + b.exerciseId).join(', ')}`);
  // No T1 goals at all: heavy work can still be any lift you've loaded.
  const noT1 = structuredClone(s);
  noT1.slots = noT1.slots.filter(sl => sl.tier !== 'T1');
  const any = L.buildSuggestion(noT1, ci({ minutes: 75, fatigue: 2, intent: 'heavy' }), fri);
  ok(any.blocks.filter(b => b.tier === 'T1').every(b => L.estimatedMax(noT1, b.exerciseId) != null), 'without T1 goals, a heavy lift needs a max');
});
test('long sessions fill their time, with a second exercise from a family already in when new ones run out', () => {
  const s = seed();
  const ex = id => s.exercises.find(e => e.id === id);
  for (const minutes of [60, 90]) {
    for (const intent of ['easy', 'auto']) {
      const r = L.buildSuggestion(s, ci({ minutes, intent, fatigue: 3 }));
      ok(r.minutesUsed >= minutes - 8 && r.minutesUsed <= minutes, `${intent} ${minutes} min suggestion: ${r.minutesUsed}`);
      ok(new Set(r.blocks.map(b => b.exerciseId)).size === r.blocks.length, 'no exercise twice');
    }
    for (const region of ['upper', 'lower']) {
      const f = L.buildFocus(s, ci({ minutes, intent: 'easy', fatigue: 3 }), { region });
      ok(f.minutesUsed >= minutes - 8 && L.blocksMinutes(s, f.blocks) <= minutes, `easy ${region} focus ${minutes} min: ${f.minutesUsed}`);
    }
  }
  // + Time on a focused workout never repeats an exercise already in it.
  const f = L.buildFocus(s, ci({ minutes: 60 }), { region: 'upper' });
  const more = L.buildFocus(s, ci({ minutes: 30 }), { region: 'upper', accessoriesOnly: true }, Date.now(),
    { excludeFamilies: f.blocks.map(b => ex(b.exerciseId).familyId), sessionBlocks: f.blocks });
  ok(more.blocks.length && more.blocks.every(b => !f.blocks.some(x => x.exerciseId === b.exerciseId)), more.blocks.map(b => ex(b.exerciseId).name).join(', '));
});
test('automatic T1/T2 picks never use accessories (no T2 clamp curls); a goal you name still does', () => {
  const s = seed();
  const ex = id => s.exercises.find(e => e.id === id);
  // Goals like an import's: heavy squats, pump work for pull-ups, upper back and arms; incline T2 yesterday.
  s.slots = [
    { id: 'g-sq', familyId: 'fam-squat', exerciseId: 'ex-back-squat', tier: 'T1', quota: 1, priority: 3 },
    { id: 'g-pu', familyId: 'fam-vpull', tier: 'T3', quota: 2, priority: 2 },
    { id: 'g-ub', familyId: 'fam-upperback', tier: 'T3', quota: 2, priority: 1 },
    { id: 'g-arms', familyId: 'fam-arms', tier: 'T3', quota: 2, priority: 1 },
  ];
  done(s, 'ex-back-squat', 'T1', 3, 5, 5, 315);
  done(s, 'ex-incline-bench', 'T2', 8, 3, 1, 155);
  const bad = [];
  for (const locationId of ['loc-basement', 'loc-office']) for (const intent of ['auto', 'heavy', 'sweat']) for (const lean of [null, 'upper', 'lower']) for (const fatigue of [1, 3]) {
    const c = ci({ locationId, minutes: 60, fatigue, intent, lean });
    const r = L.buildSuggestion(s, c);
    for (const b of r.blocks) if ((b.tier === 'T1' || b.tier === 'T2') && !['main', 'power'].includes(ex(b.exerciseId).role)) bad.push(`${JSON.stringify(c)}: ${b.tier} ${ex(b.exerciseId).name}`);
    for (const region of ['upper', 'lower']) for (const excl of [[], ['fam-vpull', 'fam-dip', 'fam-incline', 'fam-press', 'fam-ohp', 'fam-squat', 'fam-hinge', 'fam-hams']]) {
      const f = L.buildFocus(s, c, { region }, Date.now(), { excludeFamilies: excl });
      for (const b of f.blocks) if ((b.tier === 'T1' || b.tier === 'T2') && !['main', 'power'].includes(ex(b.exerciseId).role)) bad.push(`focus ${region} ${excl.length}: ${b.tier} ${ex(b.exerciseId).name}`);
    }
  }
  eq(bad, [], 'accessories at T1/T2');
  const r = L.buildSuggestion(s, ci({ minutes: 60, fatigue: 3 }));
  const pu = r.blocks.find(b => b.slotId === 'g-pu');
  ok(!pu || !ex(pu.exerciseId).equipment.includes('dip-belt'), `a T3 pull-up goal uses an unweighted move: ${pu && ex(pu.exerciseId).name}`);
  // Your own goal for an accessory at T2 still works.
  s.slots.push({ id: 'g-clamp', familyId: 'fam-grip', exerciseId: 'gs-clamp-curls', tier: 'T2', quota: 1, priority: 3 });
  ok(L.buildSuggestion(s, ci({ minutes: 60, fatigue: 1 })).blocks.some(b => b.exerciseId === 'gs-clamp-curls' && b.tier === 'T2'), 'named T2 goal honoured');
  // Roles: reviewed for the library, guessed for your own exercises, kept by the upgrade.
  eq([ex('gs-clamp-curls').role, ex('ex-back-squat').role, ex('gs-no-feet-snatch').role, ex('ex-box-jump').role], ['accessory', 'main', 'technique', 'power']);
  eq([L.guessRole('Cable lateral raise'), L.guessRole('Barbell row'), L.guessRole('Pogo hops', 'reps', true), L.guessRole('Hammer curl')], ['accessory', 'main', 'power', 'accessory']);
  eq(L.movementPattern(s, ex('gs-clamp-curls')), null, 'grip curls are not a pull');
  const old = seed(); old.version = 13;
  for (const e of old.exercises) { delete e.role; delete e.pattern; }
  old.exercises.find(e => e.id === 'ex-db-curl').role = 'main'; // a role you set yourself is kept
  old.exercises.push({ id: 'mine', name: 'Cable wrist curl', familyId: 'fam-arms', rank: 99, metric: 'load_reps', equipment: [] });
  const m = migrate(old);
  eq([m.exercises.find(e => e.id === 'gs-clamp-curls').role, m.exercises.find(e => e.id === 'ex-db-curl').role, m.exercises.find(e => e.id === 'mine').role, m.exercises.find(e => e.id === 'gs-clamp-curls').pattern],
    ['accessory', 'main', 'accessory', null]);
});
test('a tested 1RM sets T1/T2 loads for 16 weeks; stronger sets still win; an old or undated one only fills in', () => {
  const s = seed();
  const sq = s.exercises.find(e => e.id === 'ex-back-squat');
  eq(L.estimatedMax(s, sq.id), null, 'nothing yet');
  sq.testedMax = { load: 350, at: Date.now() - 7 * DAY };
  eq(L.estimatedMax(s, sq.id), 350);
  eq(L.maxSource(s, sq.id), 'tested');
  done(s, sq.id, 'T2', 8, 3, 2, 225); // lighter T2 work (e1RM ~285) doesn't drag it down
  eq(L.estimatedMax(s, sq.id), 350, 'tested max is a floor');
  done(s, sq.id, 'T1', 3, 5, 1, 345); // e1RM ~380: stronger sets win
  ok(L.estimatedMax(s, sq.id) > 370 && L.maxSource(s, sq.id) === 'sets', String(L.estimatedMax(s, sq.id)));
  const t1 = s.schemes.find(x => x.id === 's-t1-5x3');
  const old = seed(); const osq = old.exercises.find(e => e.id === 'ex-back-squat');
  osq.testedMax = { load: 400, at: Date.now() - 20 * 7 * DAY };
  eq(L.estimatedMax(old, osq.id), 400, 'old one fills in with no sets');
  done(old, osq.id, 'T1', 3, 5, 1, 300);
  ok(L.estimatedMax(old, osq.id) < 400, 'older than 16 weeks: your sets decide');
  ok(L.targetLoad(s, sq, 'T1', t1) > 300, 'T1 loads come from it');
  // Weighted bodyweight lifts: the max is added load, bodyweight on top.
  const wp = s.exercises.find(e => e.id === 'ex-wpullup');
  wp.testedMax = { load: 90, at: Date.now() };
  eq(L.estimatedMax(s, wp.id), null, 'needs your bodyweight');
  s.settings.bodyweight = 200;
  eq(L.estimatedMax(s, wp.id), 290);
  // v15 turns an old starting max into an undated tested one.
  const v14 = seed(); v14.version = 14;
  for (const e of v14.exercises) delete e.testedMax;
  v14.exercises.find(e => e.id === 'ex-front-squat').startMax = 275;
  const m = migrate(v14);
  eq([m.exercises.find(e => e.id === 'ex-front-squat').testedMax, m.exercises.find(e => e.id === 'ex-front-squat').startMax], [{ load: 275, at: null }, null]);
  eq(L.estimatedMax(m, 'ex-front-squat'), 275);
});
test('the week budget: minutes your goals take, room for more T2/T3, from your settings or check-ins', () => {
  const s = seed();
  const b = G.weekBudget(s);
  eq([b.workouts, b.minutes, b.total], [3, 45, 135], 'a starting guess with no history');
  eq(b.count, { T1: 2, T2: 6, T3: 6, TECH: 2 });
  ok(Math.abs(b.used - (2 * b.cost.T1 + 6 * b.cost.T2 + 6 * b.cost.T3 + 2 * b.cost.TECH)) < 1e-9);
  s.settings.week = { workouts: 5, minutes: 60 };
  const b2 = G.weekBudget(s);
  eq(b2.total, 300);
  ok(b2.addT2 === Math.floor(b2.room / b2.cost.T2) && b2.addT3 > b2.addT2 && b2.addT2 > 10, JSON.stringify(b2));
  eq(b2.guide, { T1: [2, 5], T2: [5, 10], T3: [10, 20] });
  // From check-ins: 8 workouts in 4 weeks, 60 minutes each.
  const h = seed();
  for (let i = 0; i < 8; i++) h.sessions.push({ id: `w${i}`, checkinAt: Date.now() - (i * 3 + 1) * DAY, firstSetAt: Date.now() - (i * 3 + 1) * DAY + 60e3, minutes: 60, blocks: [] });
  const b3 = G.weekBudget(h);
  eq([b3.workouts, b3.minutes, b3.fromHistory.workouts], [2, 60, true]);
});
test('Friday, every goal done: the hour still gets two complementary T2 lifts and T3 supersets', () => {
  const s = seed();
  const wk = L.weekBounds(s);
  const fri = wk.start + 4 * DAY + 10 * 3600e3;
  // Monday to Thursday: every goal met with its usual exercise.
  s.slots.forEach((sl, d) => {
    const ex = L.pickExercise(s, sl.familyId, s.locations[1], sl.tier, sl.exerciseId);
    for (let q = 0; q < sl.quota; q++) for (let i = 0; i < 6; i++) {
      s.sets.push({ id: L.uid(), sessionId: `f${d}${q}`, blockId: `f${d}${q}`, exerciseId: ex.id, tier: sl.tier, load: 100, reps: sl.tier === 'T3' ? 12 : 5,
        done: true, loggedAt: wk.start + ((d + q) % 4) * DAY + 9 * 3600e3 + i, bw: 200, countsManual: true, countsToward: sl.id });
    }
  });
  ok([...L.creditWeek(s, fri).slots.values()].every(r => r.filled >= r.slot.quota), 'all goals met');
  const r = L.buildSuggestion(s, ci({ minutes: 60, fatigue: 1 }), fri);
  const ex = id => s.exercises.find(e => e.id === id);
  const t2 = r.blocks.filter(b => b.tier === 'T2').map(b => ex(b.exerciseId));
  const names = r.blocks.map(b => `${b.tier} ${ex(b.exerciseId).name}`).join(', ');
  eq(t2.length, 2, names);
  ok(new Set(t2.map(e => L.movementPattern(s, e))).size === 2, `different patterns: ${names}`);
  const t1Lifts = s.slots.filter(sl => sl.tier === 'T1').map(sl => sl.exerciseId ?? s.families.find(f => f.id === sl.familyId).defaultExerciseId);
  ok(t2.every(e => !t1Lifts.includes(e.id) && e.familyId !== 'fam-arms'), `support lifts, not a T1 goal's lift or curls: ${names}`);
  const t3 = r.blocks.filter(b => b.tier === 'T3');
  ok(t3.length >= 4 && t3.every(b => b.pairOf || r.blocks.some(x => x.pairOf === b.id)), `T3 supersets: ${names}`);
  ok(t3.every(b => !ex(b.exerciseId).equipment.includes('dip-belt')), `no weighted pull-ups or dips as pump work: ${names}`);
  ok(r.minutesUsed >= 50 && r.minutesUsed <= 60, `uses the hour: ${r.minutesUsed}`);
});
test('goals nearly done: suggestion is thin but a focused workout still fills the time', () => {
  const s = seed();
  // Fill every goal except incline press this week.
  const credit = () => L.creditWeek(s);
  for (const sl of s.slots.filter(x => x.familyId !== 'fam-incline')) {
    const ex = L.pickExercise(s, sl.familyId, s.locations[1], sl.tier, sl.exerciseId) ?? s.exercises.find(e => e.familyId === sl.familyId);
    for (let q = 0; q < sl.quota; q++) {
      for (let i = 0; i < 6; i++) s.sets.push({ id: L.uid(), sessionId: `x${q}`, blockId: `b${sl.id}${q}`, exerciseId: ex.id, tier: sl.tier, load: 100, reps: 5, done: true,
        loggedAt: L.weekBounds(s).start + q * DAY + i, bw: 235, countsManual: true, countsToward: sl.id });
    }
  }
  const open = [...credit().slots.values()].filter(r => r.filled < r.slot.quota).map(r => r.slot.familyId);
  eq(open, ['fam-incline']);
  const thin = L.buildSuggestion(s, ci({ minutes: 60 }), Date.now(), { fill: false });
  ok(thin.blocks.length === 1, 'only incline from goals');
  const f = L.buildFocus(s, ci({ minutes: 60 }), { region: 'upper' });
  ok(f.blocks.length >= 4 && f.minutesUsed >= 40, `${f.blocks.length} blocks, ${f.minutesUsed} min`);
  // By default the suggestion fills the rest of the hour from the library, with T2 and T3 work.
  const name = id => s.exercises.find(e => e.id === id).name;
  const sug = L.buildSuggestion(s, ci({ minutes: 60 }));
  eq(sug.blocks.filter(b => b.slotId === 'sl-t2-incline').length, 1, 'the open goal is still in it');
  ok(sug.goalMinutes <= 15 && sug.minutesUsed >= 54 && sug.minutesUsed <= 60, `goals ${sug.goalMinutes} min, used ${sug.minutesUsed}: ${sug.blocks.map(b => name(b.exerciseId))}`);
  ok(sug.blocks.some(b => b.tier === 'T2' && b.slotId !== 'sl-t2-incline') && sug.blocks.filter(b => b.tier === 'T3').length >= 3, 'T2 and T3 fill');
  ok(/library/.test(sug.notes[0]), 'explained');
  // Leaning lower: the extra T2 lift is lower body and lower-body accessories come first.
  const low = L.buildSuggestion(s, ci({ minutes: 60, lean: 'lower' }));
  const extra = low.blocks.filter(b => b.slotId !== 'sl-t2-incline');
  ok(extra.filter(b => b.tier === 'T2').every(b => L.bodyRegion(s, s.exercises.find(e => e.id === b.exerciseId)) === 'lower'), `T2: ${extra.map(b => name(b.exerciseId))}`);
  const firstT3s = low.notes.filter(n => /^T3/.test(n)).slice(0, 3).join(' | ');
  ok(!/pull|push|dip|curl|press/i.test(firstT3s), `lower accessories first: ${firstT3s}`);
  // Easy day: no extra T2 lift, just accessories.
  const easy = L.buildSuggestion(s, ci({ minutes: 60, intent: 'easy' }));
  ok(!easy.blocks.some(b => b.tier === 'T2' && b.slotId !== 'sl-t2-incline'), 'no T2 fill on an easy day');
  ok(L.buildSuggestion(s, ci({ minutes: 60 }), Date.now(), { excludeFamilies: ['fam-incline'] }).minutesUsed >= 50, '+ Time fills from the library too');
});
test('lean: goals for the half you lean toward come first', () => {
  const s = seed();
  const score = (lean, fam) => L.scoreSlots(s, ci({ lean })).find(c => c.slot.familyId === fam)?.score;
  ok(score('lower', 'fam-squat') > score('either', 'fam-squat') && score('upper', 'fam-squat') < score('either', 'fam-squat'), 'squat');
  ok(score('upper', 'fam-vpull') > score('either', 'fam-vpull') && score('lower', 'fam-vpull') < score('either', 'fam-vpull'), 'pull-ups');
  eq(score('lower', 'fam-core'), score('either', 'fam-core'), 'core is neither half');
  eq(score('lower', 'fam-clean'), score('either', 'fam-clean'), 'cleans are whole body');
  const t1 = lean => L.buildSuggestion(s, ci({ minutes: 45, lean }), Date.now(), { fill: false }).blocks.find(b => b.tier === 'T1')?.exerciseId;
  eq(t1('lower'), 'ex-back-squat');
  eq(t1('upper'), 'ex-wpullup');
});
test('explosive lower: jumps, one or two cleans, then lower back, leg and core accessories, filling the hour', () => {
  const s = seed();
  const ex = b => s.exercises.find(e => e.id === b.exerciseId);
  const r = L.buildFocus(s, ci({ minutes: 60 }), { region: 'lower', explosive: true });
  const names = r.blocks.map(b => `${b.tier} ${ex(b).name}`).join(', ');
  eq(ex(r.blocks[0]).familyId, 'fam-jumps', names);
  const cleans = r.blocks.filter(b => ex(b).familyId === 'fam-clean');
  ok(cleans.length >= 1 && cleans.length <= 2 && r.blocks.indexOf(cleans[0]) === 1, `cleans after the jumps: ${names}`);
  ok(cleans.every(b => s.schemes.find(x => x.id === b.schemeId).reps <= 3), 'cleans in sets of 1-3');
  const t3 = r.blocks.filter(b => b.tier === 'T3').map(ex);
  ok(t3.length >= 2, names);
  ok(t3.some(e => /back extension|reverse hyper|sorensen/i.test(e.name)) && t3.some(e => L.movementPattern(s, e) === 'core'), `lower back and core: ${names}`);
  ok(r.blocks.every(b => L.bodyRegion(s, ex(b)) !== 'upper'), `nothing upper: ${names}`);
  ok(r.minutesUsed >= 55 && r.minutesUsed <= 60, `${r.minutesUsed} min: ${names}`);
  // 30 minutes: one clean, a couple of accessories.
  const short = L.buildFocus(s, ci({ minutes: 30 }), { region: 'lower', explosive: true });
  ok(short.blocks.filter(b => ex(b).familyId === 'fam-clean').length === 1 && short.minutesUsed <= 30, short.blocks.map(b => ex(b).name).join(', '));
});
test('focused workouts use the whole time block', () => {
  const s = seed();
  for (const region of ['upper', 'lower']) {
    for (const explosive of [false, true]) {
      for (const minutes of [30, 45, 60]) {
        const r = L.buildFocus(s, ci({ minutes }), { region, explosive });
        ok(r.minutesUsed <= minutes && r.minutesUsed >= minutes * 0.8, `${region}${explosive ? ' + explosive' : ''} ${minutes}: ${r.minutesUsed} min`);
      }
    }
  }
  // Goal lifts aren't accessory filler.
  const r = L.buildSuggestion(s, ci({ minutes: 90 }));
  ok(!r.blocks.some(b => b.tier === 'T3' && ['ex-wpullup', 'ex-wdip', 'ex-back-squat'].includes(b.exerciseId)), 'no goal lifts as T3');
});

test('T3 schemes: sets of 8-15, not 2×25, and hard bodyweight moves stay under their cap', () => {
  const s = seed();
  const ex = id => s.exercises.find(e => e.id === id);
  for (const fatigue of [1, 2, 3, 4, 5]) {
    for (const id of ['ex-ring-facepull', 'ex-db-curl', 'ex-calf-raise', 'ex-hanging-knee']) {
      const sc = L.pickScheme(s, 'T3', ex(id), 30, ci({ fatigue }));
      ok(sc.reps >= 8 && sc.reps <= 15, `${id} fatigue ${fatigue}: ${sc.name}`);
    }
  }
  eq(L.pickScheme(s, 'T3', ex('ex-ring-facepull'), 5, ci()).name, '2×25', 'only when 5 minutes is all there is');
  eq(L.pickScheme(s, 'T3', ex('ex-nordic'), 30, ci()).name, '6×5');
  ok(L.pickScheme(s, 'T3', ex('ex-ghr'), 30, ci()).reps <= 8, 'GHR under its cap');
  const f = L.buildFocus(s, ci({ minutes: 60 }), { region: 'lower' });
  ok(f.blocks.filter(b => b.tier === 'T3').every(b => s.schemes.find(x => x.id === b.schemeId).reps <= 15), 'focused workout accessories');
});
test('v10 data gets the new T3 schemes and rep caps, keeping caps you set', () => {
  const s = seed();
  s.version = 10;
  s.schemes = s.schemes.filter(x => !['s-t3-4x8', 's-t3-6x5'].includes(x.id));
  for (const e of s.exercises) if (['ex-nordic', 'ex-ghr', 'ex-reverse-nordic'].includes(e.id)) e.maxReps = null;
  s.exercises.find(e => e.id === 'ex-ghr').maxReps = 6;
  const m = migrate(s);
  eq(m.version, 15);
  ok(m.schemes.some(x => x.id === 's-t3-6x5') && m.schemes.some(x => x.id === 's-t3-4x8'));
  eq(['ex-nordic', 'ex-ghr', 'ex-reverse-nordic'].map(id => m.exercises.find(e => e.id === id).maxReps), [5, 6, 10], 'your own GHR cap of 6 kept');
  eq(migrate(structuredClone(m)).schemes.filter(x => x.id === 's-t3-6x5').length, 1, 'idempotent');
});

test('Air Alert 2: the chart, each week\'s dose, and moving through 12 weeks of 5 days', () => {
  const d = P.programDef('aa2');
  eq([P.weeksOf(d), d.days, d.exercises.length], [12, 5, 5]);
  ok(d.chart.every(w => w.length === 5), 'five exercises every week');
  eq(P.dayPlan(d, 1).map(e => `${e.name} ${e.sets}x${e.reps}`), ['Leap ups 2x25', 'Calf raises 2x10', 'Step ups 2x10', 'Thrust ups 2x15', 'Burnouts 1x100']);
  eq(P.dayPlan(d, 7).map(e => [e.sets, e.reps]), [[1, 125], [2, 45], [2, 25], [2, 50], [1, 700]]);
  eq(P.dayPlan(d, 12).map(e => [e.sets, e.reps]), [[2, 200], [2, 70], [2, 40], [2, 100], [1, 1200]]);
  eq(M.doseText(P.dayPlan(d, 1)[1]), '2 × 10/side', 'calf raises are each leg');
  const s = seed();
  eq(P.progress(s, 'aa2'), null, 'optional: not running until started');
  P.startProgram(s, 'aa2');
  for (let i = 0; i < 5; i++) P.advance(s, 'aa2');
  eq([P.progress(s, 'aa2').week, P.progress(s, 'aa2').day], [2, 1], 'five days make a week');
  for (let i = 0; i < 55; i++) P.advance(s, 'aa2');
  ok(P.progress(s, 'aa2').finished, 'done after 60 days');
  P.setWeek(s, 'aa2', 4);
  eq([P.progress(s, 'aa2').week, P.progress(s, 'aa2').day, P.progress(s, 'aa2').finished], [4, 1, false]);
  s.programs.aa2 = { stopped: true, verticals: [{ week: 1, value: 24 }] };
  eq(P.progress(s, 'aa2'), null, 'stopped');
  P.startProgram(s, 'aa2');
  eq(P.progress(s, 'aa2').verticals.length, 1, 'restarting keeps your verticals');
  // Program sessions aren't mobility: the week summary leaves them out.
  const item = { ...M.newItem(s, P.dayPlan(d, 1)[0]), def: P.dayPlan(d, 1)[0] };
  eq(item.sets.map(x => x.reps), [25, 25], 'rows prefilled with the week\'s reps');
  item.sets[0] = { ...item.sets[0], done: true, at: Date.now() };
  s.mobility.sessions.push({ id: 'p1', day: L.dayKey(), startedAt: Date.now(), status: 'done', items: [item], program: { id: 'aa2', week: 1, day: 1 } });
  const wk = L.weekBounds(s);
  eq(M.weekSummary(s, wk.start, wk.end).sessions, 0);
  eq(P.daysDoneByWeek(s, 'aa2'), { 1: 1 });
  ok(P.doneToday(s, 'aa2', L.dayKey()));
});

// ---------- render ----------
const fails = results.filter(r => r[0] === 'FAIL').length;
document.getElementById('summary').textContent = `${results.length - fails} passed, ${fails} failed`;
document.title = fails ? 'FAIL' : 'PASS';
document.getElementById('out').innerHTML = results.map(([k, n]) => `<div class="${k}">${k}  ${n.replace(/</g, '&lt;')}</div>`).join('');
