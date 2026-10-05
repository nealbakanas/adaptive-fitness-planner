// Rules tests. Open /tests.html to run them. They exercise the pure logic with synthetic data and never touch your saved data.
import { seed } from './seed.js';
import * as L from './logic.js';
import { migrate } from './store.js';
import * as FN from './fitnotes.js';
import * as G from './goals.js';

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
  eq(m.version, 7);
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
  eq(m.version, 7);
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
test('superset idea for heavy squats: not lower body, no barbell, an open T3 goal first', () => {
  const s = seed();
  const p = L.suggestPair(s, ci(), s.exercises.find(e => e.id === 'ex-back-squat'), { excludeFamilies: ['fam-squat'] });
  ok(p, 'an idea');
  ok(p.exercise.region !== 'lower' && !p.exercise.explosive && !p.exercise.equipment.includes('barbell'), p.exercise.name);
  ok(/open T3 goal/.test(p.why), p.why);
});
test('superset idea for pull-ups is core or not upper body', () => {
  const s = seed();
  const p = L.suggestPair(s, ci(), s.exercises.find(e => e.id === 'ex-wpullup'), { excludeFamilies: ['fam-vpull'] });
  ok(p && (p.exercise.familyId === 'fam-core' || p.exercise.region !== 'upper'), p?.exercise.name);
});
test('superset idea for cleans is core or upper body', () => {
  const s = seed();
  const p = L.suggestPair(s, ci(), s.exercises.find(e => e.id === 'ex-power-clean'), { excludeFamilies: ['fam-clean'] });
  ok(p && (p.exercise.familyId === 'fam-core' || p.exercise.region === 'upper'), p?.exercise.name);
});
test('a T3 goal already met today is not the superset pick', () => {
  const s = seed();
  done(s, 'ex-hanging-knee', 'T3', 12, 3, 0);
  const p = L.suggestPair(s, ci(), s.exercises.find(e => e.id === 'ex-back-squat'), { excludeFamilies: ['fam-squat'] });
  ok(p && p.exercise.familyId !== 'fam-core', p?.exercise.name);
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

// ---------- render ----------
const fails = results.filter(r => r[0] === 'FAIL').length;
document.getElementById('summary').textContent = `${results.length - fails} passed, ${fails} failed`;
document.title = fails ? 'FAIL' : 'PASS';
document.getElementById('out').innerHTML = results.map(([k, n]) => `<div class="${k}">${k}  ${n.replace(/</g, '&lt;')}</div>`).join('');
