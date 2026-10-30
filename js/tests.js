// Rules tests. Open /tests.html to run them. They exercise the pure logic with synthetic data and never touch your saved data.
import { seed } from './seed.js';
import * as L from './logic.js';
import { migrate } from './store.js';
import * as FN from './fitnotes.js';
import * as G from './goals.js';
import * as M from './mobility.js';
import * as P from './programs.js';
import * as O from './onboard.js';
import * as V from './vault.js';
import * as Store from './store.js';
import * as Cloud from './cloud.js';
import * as Sync from './sync.js';
import { mergeStates, mergeById, mergeObject } from './merge.js';
import { installFake } from './fake-supabase.js';

const results = [];
const pass = name => results.push(['PASS', name]), fail = (name, e) => results.push(['FAIL', `${name} — ${e.message}`]);
const test = (name, fn) => {
  try { fn(); pass(name); } catch (e) { fail(name, e); }
};
// Tests that wait on IndexedDB or the fake server. They share one browser database and one fake network, so they run one
// at a time, in order, after the plain tests; the summary waits for the last.
let queue = Promise.resolve();
const atest = (name, fn) => { queue = queue.then(() => fn().then(() => pass(name), e => fail(name, e))); };
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
    const sc = L.pickScheme(s, 'JUMP', ex, 30, ci({ fatigue }), dose);
    ok(sc && sc.reps <= 3, `fatigue ${fatigue}: got ${sc?.name}`);
    ok(L.doseFit(s, 'JUMP', sc, dose), `fatigue ${fatigue}: ${sc.name} fits 12-20 jumps`);
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
  done(s, 'ex-broad-jump', 'JUMP', 3, 3);            // 9 contacts: not enough
  eq(L.creditWeek(s).slots.get('sl-t2-jumps').filled, 0);
  done(s, 'ex-broad-jump', 'JUMP', 3, 1);            // 12 contacts
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
  ok(L.buildSuggestion(s, ci({ jumps: true })).blocks.some(b => b.exerciseId === 'ex-broad-jump' && b.tier === 'JUMP'), 'jumps still suggested when asked for');
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
test('after heavy squats: cleans become technique-only; jumps are your call (Add jumps)', () => {
  const s = seed();
  done(s, 'ex-back-squat', 'T1', 3, 5, 1, 315);
  const scored = L.scoreSlots(s, ci());
  ok(!scored.find(x => x.slot.id === 'sl-t2-jumps').waits, 'jumps are not power work that waits');
  ok(scored.find(x => x.slot.id === 'sl-t2-clean').waits, 'the clean goal waits');
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
  eq(m.version, 24);
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
  eq(m.version, 24);
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
  ok(sets(s.exercises.find(e => e.name === 'Seated Broad Jump').id).every(x => x.tier === 'JUMP'), 'jumps are their own category');
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
  ok(thisWeek.every(x => ['T1', 'T2', 'T3', 'JUMP'].includes(x.tier)), 'every imported set has a tier');
});

// ---------- suggested goals ----------
// Twelve weeks, three workouts a week: cleans + jumps + squats on day one, pull-ups + dips (+ extras) on day two, cleans + curls on day three.
const history = (extras = []) => {
  const s = seed();
  s.settings.bodyweight = 235;
  for (let w = 0; w < 12; w++) {
    const [a, b, c] = [7 * w + 5, 7 * w + 3, 7 * w + 1];
    done(s, 'ex-power-clean', 'T1', 2, 6, a, 225, `pc${a}`);
    done(s, 'ex-broad-jump', 'JUMP', 3, 4, a, null, `bj${a}`);
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
  const jumps = row('Jumps', 'JUMP');
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
  for (let i = 0; i < 6; i++) s.sets.push({ id: `sp${i}`, sessionId: 'x', blockId: 'b', exerciseId: 'sprint', tier: 'JUMP', distance: 30, reps: null, done: true, loggedAt: NOON(0) + i });
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
  eq(m.version, 24);
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
  eq(m.version, 24);
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
  eq(m.version, 24);
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
  const lower = L.buildFocus(s, ci({ minutes: 60, jumps: true }), { region: 'lower', explosive: true });
  ok(lower.blocks.length >= 4, names(lower).join(', '));
  const first = s.exercises.find(e => e.id === lower.blocks[0].exerciseId);
  ok(first.explosive && first.region === 'lower' && lower.blocks[0].tier === 'JUMP', `jumps first when asked for: ${names(lower)}`);
  ok(lower.blocks.some(b => b.tier === 'T1'), 'a heavy main lift');
  ok(lower.blocks.every(b => ['lower', 'full'].includes(region(b.exerciseId)) || pat(b.exerciseId) === 'core'), `lower only: ${names(lower)}`);
  ok(lower.blocks.some(b => b.tier === 'T3') && lower.blocks.filter(b => b.tier === 'T3').every(b => b.pairOf || lower.blocks.some(x => x.pairOf === b.id)), 'T3s grouped');
  ok(lower.minutesUsed <= 60, 'fits the time');
  const upper = L.buildFocus(s, ci({ minutes: 60 }), { region: 'upper' });
  ok(upper.blocks.every(b => ['push', 'pull', 'core'].includes(pat(b.exerciseId))), `upper only: ${names(upper)}`);
  // Main lifts come from your T1/T2 goal families: at the Basement that's pressing (the pull-up goals need the Office bar),
  // so no chest-supported row stands in as a T2; at the Office it's push and pull.
  const goalFams = new Set(s.slots.filter(sl => sl.tier === 'T1' || sl.tier === 'T2').map(sl => sl.familyId));
  ok(upper.blocks.filter(b => b.tier === 'T1' || b.tier === 'T2').every(b => goalFams.has(s.exercises.find(e => e.id === b.exerciseId).familyId)), `main lifts from goal families: ${names(upper)}`);
  const office = L.buildFocus(s, ci({ minutes: 60, locationId: 'loc-office' }), { region: 'upper' });
  ok(new Set(office.blocks.filter(b => b.tier !== 'T3').map(b => pat(b.exerciseId))).size === 2, `push and pull main lifts at the Office: ${names(office)}`);
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
test('the starter Basement is a barbell setup; the upgrade fixes an untouched one and leaves an edited one', () => {
  const s = seed();
  const base = s.locations.find(l => l.id === 'loc-basement');
  ok(['barbell', 'rack', 'bench', 'dumbbells', 'box', 'hyper-pro'].every(eq => base.equipment.includes(eq)), base.equipment.join());
  ok(!['kettlebell', 'dip-belt', 'pullup-bar', 'rings', 'dip-station'].some(eq => base.equipment.includes(eq)), base.equipment.join());
  const old = seed(); old.version = 16;
  old.locations.find(l => l.id === 'loc-basement').equipment = ['barbell', 'rack', 'bench', 'dumbbells', 'kettlebell', 'dip-belt', 'pullup-bar', 'rings', 'dip-station', 'bands', 'ab-wheel', 'box', 'hyper-pro', 'leg-developer', 'cable'];
  eq(migrate(old).locations.find(l => l.id === 'loc-basement').equipment, ['barbell', 'rack', 'bench', 'dumbbells', 'bands', 'ab-wheel', 'box', 'hyper-pro', 'leg-developer', 'cable', 'assault-bike'], 'and v23 adds the bike');
  const edited = seed(); edited.version = 16;
  edited.locations.find(l => l.id === 'loc-basement').equipment = ['barbell', 'rack', 'pullup-bar'];
  eq(migrate(edited).locations.find(l => l.id === 'loc-basement').equipment, ['barbell', 'rack', 'pullup-bar', 'assault-bike'], 'yours is kept (plus the bike)');
});
test('a heavy day adds one of your T1 lifts, trained heavy least recently and not right after heavy work there; jumps and cleans don\'t use up the two T2 lifts', () => {
  const s = seed();
  const wk = L.weekBounds(s);
  const fri = wk.start + 4 * DAY + 17 * 3600e3;
  // Monday to Thursday: every goal met; heavy squats Monday and heavy pull-ups Tuesday.
  s.slots.forEach((sl, d) => {
    const ex = (L.pickExercise(s, sl.familyId, s.locations[1], sl.tier, sl.exerciseId) ?? L.pickExercise(s, sl.familyId, s.locations[0], sl.tier, sl.exerciseId)); // pull-ups and dips are at the Office
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
  eq(r2.blocks.filter(b => b.tier === 'T1').map(b => b.exerciseId), [], 'after heavy squats yesterday: no pull-up bar in the Basement, so no heavy lift');
  const r3 = L.buildSuggestion(sore, ci({ locationId: 'loc-office', minutes: 75, fatigue: 2, intent: 'heavy' }), fri);
  eq(r3.blocks.filter(b => b.tier === 'T1').map(b => b.exerciseId), ['ex-wpullup'], 'at the Office it is the pull-up');
  // Two at the Basement: your T2-goal families there are hinge and push (squats took the T1; pull-ups and dips need the Office).
  eq(r.blocks.filter(b => b.tier === 'T2' && !ex(b.exerciseId).explosive).length, 2, `fresh 75 minutes: the T2 strength lifts your goals allow here: ${names}`);
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
    const e = (L.pickExercise(s, sl.familyId, s.locations[1], sl.tier, sl.exerciseId) ?? L.pickExercise(s, sl.familyId, s.locations[0], sl.tier, sl.exerciseId)); // pull-ups and dips are at the Office
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
  eq(b.count, { T1: 2, T2: 4, T3: 6, TECH: 2, JUMP: 2, COND: 1 });
  ok(Math.abs(b.used - (2 * b.cost.T1 + 4 * b.cost.T2 + 6 * b.cost.T3 + 2 * b.cost.TECH + 2 * b.cost.JUMP + b.cost.COND)) < 1e-9);
  s.settings.week = { workouts: 5, minutes: 60 };
  const b2 = G.weekBudget(s);
  eq(b2.total, 300);
  ok(b2.addT2 === Math.floor(b2.room / b2.cost.T2) && b2.addT3 > b2.addT2 && b2.addT2 >= 8, JSON.stringify(b2));
  eq(b2.guide, { T1: [2, 5], T2: [5, 10], T3: [10, 20] });
  // From check-ins: 8 workouts in 4 weeks, 60 minutes each.
  const h = seed();
  for (let i = 0; i < 8; i++) h.sessions.push({ id: `w${i}`, checkinAt: Date.now() - (i * 3 + 1) * DAY, firstSetAt: Date.now() - (i * 3 + 1) * DAY + 60e3, minutes: 60, blocks: [] });
  const b3 = G.weekBudget(h);
  eq([b3.workouts, b3.minutes, b3.fromHistory.workouts], [2, 60, true]);
});
test('fresh days get a third (or fourth) T2 before more than 4-6 T3s; tired days stay at two', () => {
  const s = seed();
  s.slots = []; // what the fill step itself chooses, with no goals taking the time
  const ex = id => s.exercises.find(e => e.id === id);
  for (const [minutes, t2, t3cap] of [[45, 2, 4], [60, 3, 4], [90, 3, 6]]) {
    const r = L.buildSuggestion(s, ci({ minutes, fatigue: 1, intent: 'auto' }));
    const str = r.blocks.filter(b => b.tier === 'T2' && !ex(b.exerciseId).explosive).length;
    const t3 = r.blocks.filter(b => b.tier === 'T3').length;
    const names = r.blocks.map(b => `${b.tier} ${ex(b.exerciseId).name}`).join(', ');
    ok(str >= Math.min(t2, 3) && t3 <= t3cap, `${minutes} min fresh: ${str} T2 strength, ${t3} T3: ${names}`);
    ok(r.minutesUsed >= minutes - 8, `${minutes} min filled: ${r.minutesUsed}`);
  }
  const tired = L.buildSuggestion(s, ci({ minutes: 60, fatigue: 4 }));
  ok(tired.blocks.filter(b => b.tier === 'T2' && !ex(b.exerciseId).explosive).length <= 2, 'tired: no more than two T2 strength lifts');
});
test('wrecked short day: at most one T2, the rest T3s; regenerate rotates the library picks', () => {
  const s = seed();
  const ex = id => s.exercises.find(e => e.id === id);
  for (const lean of ['lower', 'upper', 'either']) {
    for (const fatigue of [5, 4]) {
      const r = L.buildSuggestion(s, ci({ minutes: 30, fatigue, lean }));
      const names = r.blocks.map(b => `${b.tier} ${ex(b.exerciseId).name}`).join(', ');
      ok(r.blocks.filter(b => b.tier === 'T2').length <= 1, `${lean}, energy ${6 - fatigue}: one T2 at most: ${names}`);
      if (!r.blocks.some(b => b.tier === 'T1' || b.tier === 'TECH')) ok(r.blocks.filter(b => b.tier === 'T3').length >= 2, `${lean}, energy ${6 - fatigue}: a bunch of T3s: ${names}`); // an urgent heavy goal may still take the slot
      ok(r.minutesUsed <= 30 && r.minutesUsed >= 22, `fills the half hour: ${r.minutesUsed}`);
    }
  }
  const sig = r => r.blocks.map(b => b.exerciseId).join();
  const base = L.buildSuggestion(s, ci({ minutes: 75, fatigue: 3, lean: 'lower' }));
  const sigs = new Set([sig(base)]);
  for (let v = 1; v <= 4; v++) sigs.add(sig(L.buildSuggestion(s, { ...ci({ minutes: 75, fatigue: 3, lean: 'lower' }), variant: v })));
  ok(sigs.size >= 2, 'regenerating gives different workouts');
  const again = L.buildSuggestion(s, { ...ci({ minutes: 75, fatigue: 3, lean: 'lower' }), variant: 2 });
  eq(sig(again), sig(L.buildSuggestion(s, { ...ci({ minutes: 75, fatigue: 3, lean: 'lower' }), variant: 2 })), 'same variant, same workout');
  ok(again.minutesUsed >= 67 && again.minutesUsed <= 75, `regenerated workout still fills the time: ${again.minutesUsed}`);
});
test('chosen mix: the T2/T3 counts you ask for, for the half you lean toward, within the time', () => {
  const s = seed();
  const ex = id => s.exercises.find(e => e.id === id);
  const c = { locationId: s.locations[1].id, minutes: 60, fatigue: 3, intent: 'auto', lean: 'lower' };
  const r = L.buildMix(s, c, { T1: 0, T2: 1, T3: 6 });
  const n = t => r.blocks.filter(b => b.tier === t).length;
  eq([n('T1'), n('T2'), n('T3')], [0, 1, 6]);
  ok(r.blocks.every(b => L.bodyRegion(s, ex(b.exerciseId)) !== 'upper'), 'lower lean: no upper-body blocks');
  ok(r.minutesUsed <= 60, `within the time: ${r.minutesUsed}`);
  const tight = L.buildMix(s, { ...c, minutes: 20 }, { T1: 0, T2: 1, T3: 10 });
  ok(tight.minutesUsed <= 20 && tight.notes.some(x => /^Only/.test(x)), 'what does not fit is dropped and said so');
});
test('jumps are their own category: only with Add jumps, one block, never a T2, toward the jumps goal', () => {
  const s = seed();
  const ex = b => s.exercises.find(e => e.id === b.exerciseId);
  for (const [minutes, fatigue, lean, intent] of [[30, 1, 'lower', 'auto'], [45, 3, 'either', 'easy'], [60, 5, 'upper', 'auto'], [90, 2, 'lower', 'heavy']]) {
    const c = ci({ minutes, fatigue, lean, intent });
    const label = `${minutes} min, energy ${6 - fatigue}, ${lean}, ${intent}`;
    for (const r of [L.buildSuggestion(s, c), L.buildFocus(s, c, { region: 'lower', explosive: true }), L.buildMix(s, c, { T1: 0, T2: 1, T3: 4 })]) {
      ok(!r.blocks.some(b => L.isJump(ex(b))), `${label}: no jumps unless asked: ${r.blocks.map(b => ex(b).name)}`);
    }
    for (const r of [L.buildSuggestion(s, { ...c, jumps: true }), L.buildFocus(s, { ...c, jumps: true }, { region: 'upper' }), L.buildMix(s, { ...c, jumps: true }, { T1: 0, T2: 1, T3: 4 })]) {
      const j = r.blocks.filter(b => L.isJump(ex(b)));
      ok(j.length === 1 && j[0].tier === 'JUMP' && j[0].slotId === 'sl-t2-jumps', `${label}: one JUMP block toward the goal: ${r.blocks.map(b => `${b.tier} ${ex(b).name}`)}`);
      ok(r.minutesUsed <= minutes, `${label}: within the time`);
      ok(s.schemes.find(x => x.id === j[0].schemeId).tiers.includes('JUMP'), 'a jump scheme');
    }
  }
  // Goal met this week: jumps still come in when you ask for them.
  for (let d = 0; d < 2; d++) s.sets.push(...Array.from({ length: 4 }, (_, i) => ({ id: `j${d}${i}`, sessionId: `j${d}`, blockId: `j${d}`, exerciseId: 'ex-broad-jump', tier: 'JUMP', reps: 4, done: true, loggedAt: L.weekBounds(s).start + d * DAY + i })));
  eq(L.creditWeek(s).slots.get('sl-t2-jumps').filled, 2);
  ok(L.buildSuggestion(s, ci({ minutes: 45, jumps: true })).blocks.some(b => b.tier === 'JUMP'), 'jumps when asked, goal or not');
});
test('review fixes: jumps off never set the bar for other goals; a regenerated mix counts what you started', () => {
  const s = seed();
  s.slots = s.slots.filter(x => ['sl-t2-jumps', 'sl-t3-arms'].includes(x.id));
  const r = L.buildSuggestion(s, ci({ minutes: 30, lean: 'lower' }), Date.now(), { fill: false });
  ok(r.blocks.some(b => b.slotId === 'sl-t3-arms'), `the upper T3 goal isn't dropped against the (off) jumps goal: ${JSON.stringify(r.scored.map(c => [c.slot.id, c.note]))}`);
  const t = seed();
  const c = ci({ minutes: 45, lean: 'lower' });
  const first = L.buildMix(t, c, { T1: 0, T2: 1, T3: 6 });
  const kept = first.blocks.filter(b => b.tier === 'T2').concat(first.blocks.filter(b => b.tier === 'T3').slice(0, 2));
  const again = L.buildMix(t, { ...c, minutes: 25, variant: 1 }, { T1: 0, T2: 1, T3: 6 }, Date.now(), { sessionBlocks: kept, excludeFamilies: kept.map(b => t.exercises.find(e => e.id === b.exerciseId).familyId) });
  eq(again.blocks.filter(b => b.tier === 'T2').length, 0, 'the T2 you started counts');
  ok(again.blocks.filter(b => b.tier === 'T3').length <= 4, 'four more T3s at most');
});
test('a 30-minute upper + explosive Basement day never makes pump work (chest-supported rows) a T2; jumps take no time', () => {
  const s = seed();
  const ex = b => s.exercises.find(e => e.id === b.exerciseId);
  // Pressing was heavy yesterday, so the main lift is T2, and the pull-up goals need the Office bar.
  s.slots.push({ id: 'sl-t1-ohp', familyId: 'fam-ohp', exerciseId: 'gs-z-press', tier: 'T1', quota: 1, priority: 3 });
  done(s, 'gs-z-press', 'T1', 3, 5, 1, 135);
  for (const lean of [null, 'upper']) for (const fatigue of [1, 2, 3]) {
    const r = L.buildFocus(s, ci({ minutes: 30, fatigue, lean }), { region: 'upper', explosive: true });
    const names = r.blocks.map(b => `${b.tier} ${ex(b).name}`).join(', ');
    ok(!r.blocks.some(b => (b.tier === 'T1' || b.tier === 'T2') && ex(b).familyId === 'fam-upperback'), `no upper-back T2: ${names}`);
    const withJumps = L.buildFocus(s, ci({ minutes: 30, fatigue, lean, jumps: true }), { region: 'upper', explosive: true });
    eq(withJumps.minutesUsed, r.minutesUsed, `jumps don't use the time: ${withJumps.blocks.map(b => `${b.tier} ${ex(b).name}`)}`);
    ok(withJumps.blocks.some(b => b.tier === 'JUMP'), 'jumps still there');
  }
  eq(L.blocksMinutes(s, [{ tier: 'JUMP', schemeId: 's-j-5x3' }]), 0);
  eq(G.tierCost(s, 'JUMP'), 0, 'the week budget leaves jumps out');
});
test('setup: a new user starts with nothing picked; setting up again starts from your goals', () => {
  const s = seed();
  const d = O.startDraft(s);
  eq([d.t1, d.t2, d.power, d.pump], [{}, {}, {}, {}]);
  eq(O.buildSlots(s, d), []);
  s.settings.onboarded = true;
  ok(Object.keys(O.startDraft(s).t1).length === 2, 'your own (here the starter) goals when you set up again');
});
test('setup: a starter pick your gear hides (weighted dips, no dip station) is never saved as a goal', () => {
  const s = seed();
  s.settings.onboarded = true; // set up again, starting from the starter goals
  const d = O.startDraft(s);
  ok('ex-wdip' in d.t2, 'the starter has a weighted-dip T2');
  const shown = O.strengthChoices(s, d).flatMap(([, l]) => l.map(e => e.id));
  ok(!shown.includes('ex-wdip'), 'not offered: no location has a dip station');
  ok(!('ex-wdip' in O.picks(s, d, 't2')), 'left out of the picks you see');
  ok(!O.buildSlots(s, d).some(sl => sl.exerciseId === 'ex-wdip'), 'and of the saved goals');
  d.locations[0].equipment.push('dip-station');
  ok(O.buildSlots(s, d).some(sl => sl.exerciseId === 'ex-wdip' && sl.tier === 'T2'), 'back once a location has the gear');
});
test('workout time counts warm-ups and the changeover to each exercise (Settings → You), not jumps', () => {
  const s = seed();
  const sc = id => s.schemes.find(x => x.id === id).minutes;
  eq(L.blockMinutes(s, { tier: 'T1', schemeId: 's-t1-5x3' }), sc('s-t1-5x3') + 5 + 2, 'heavy: ramp-up and changeover');
  eq(L.blockMinutes(s, { tier: 'T2', schemeId: 's-t2-3x8' }), sc('s-t2-3x8') + 2 + 2);
  eq(L.blockMinutes(s, { tier: 'T3', schemeId: 's-t3-3x15', pairOf: 'x' }), (sc('s-t3-3x15') + 2) / 2, 'a superset partner at half');
  eq(L.blockMinutes(s, { tier: 'JUMP', schemeId: 's-j-4x3' }), 0);
  // 45 minutes, lower, energy 4, jumps: the jumps plus three or four exercises, not six.
  const r = L.buildSuggestion(s, ci({ minutes: 45, fatigue: 2, lean: 'lower', jumps: true }));
  const names = r.blocks.map(b => `${b.tier} ${s.exercises.find(e => e.id === b.exerciseId).name}`).join(', ');
  ok(r.blocks.some(b => b.tier === 'JUMP') && r.blocks.filter(b => b.tier !== 'JUMP').length <= 4 && r.minutesUsed <= 45, `${r.minutesUsed} min: ${names}`);
  s.settings.changeover = 0;
  ok(Math.abs(L.blocksMinutes(s, r.blocks) - (r.minutesUsed - 2 * r.blocks.filter(b => b.tier !== 'JUMP').reduce((n, b) => n + (b.pairOf ? 0.5 : 1), 0))) < 1, 'the setting is the changeover per exercise');
});
test('progression: every prescribed rep at a load last time means +increment next time; short means the same load', () => {
  const s = seed();
  const ex = id => s.exercises.find(e => e.id === id);
  const sc = id => s.schemes.find(x => x.id === id);
  const log = (exerciseId, tier, schemeId, load, reps, daysAgo, sessionId) => reps.forEach((r, i) => s.sets.push({ id: L.uid(), sessionId, blockId: sessionId,
    exerciseId, tier, schemeId, load, reps: r, done: true, loggedAt: NOON(daysAgo) + i, bw: 200 }));
  log('ex-back-squat', 'T1', 's-t1-5x3', 300, [3, 3, 3, 3, 3], 7, 'a');
  const squat = ex('ex-back-squat');
  eq(L.targetLoad(s, squat, 'T1', sc('s-t1-5x3')), 305, 'every rep at 300: 305');
  const p = L.progression(s, squat, 'T1', sc('s-t1-5x3'));
  ok(p.up && p.last.load === 300 && p.last.complete);
  eq(L.progression(s, squat, 'T1', sc('s-t1-6x2')), null, 'another rep scheme: from your max instead');
  eq(L.progression(s, squat, 'T1', sc('s-t1-5x3'), NOON(-70)), null, 'ten weeks later: from your max again');
  log('ex-back-squat', 'T1', 's-t1-5x3', 305, [3, 3, 3, 2, 2], 3, 'b');
  eq(L.targetLoad(s, squat, 'T1', sc('s-t1-5x3')), 305, 'two reps short at 305: 305 again');
  eq(L.lastOutcome(s, 'ex-back-squat', 'T1').short, 2);
  // Today's own sets don't count as last time while you're doing it.
  log('ex-back-squat', 'T1', 's-t1-5x3', 305, [3, 3, 3, 3, 3], 0, 'today');
  eq(L.targetLoad(s, squat, 'T1', sc('s-t1-5x3'), NOON(0) - 1), 305, 'during today: still 305');
  eq(L.targetLoad(s, squat, 'T1', sc('s-t1-5x3')), 310, 'next time: 310');
  // T2 is tracked on its own: +5 from its own last time, not a jump to what the heavy squats imply.
  log('ex-back-squat', 'T2', 's-t2-3x8', 225, [8, 8, 8], 2, 'c');
  eq(L.targetLoad(s, squat, 'T2', sc('s-t2-3x8')), 230);
  // The suggestion keeps last time's scheme for a T1/T2 lift so it can progress (no variety swap to 6×2).
  eq(L.pickScheme(s, 'T1', squat, 60, ci({ fatigue: 2 }))?.id, 's-t1-5x3', 'same scheme as last time');
  // AMRAP last set: prescribed to double the reps is +5, more than double is +10, short of prescribed is the same load.
  const amrap = (last, daysAgo, id) => { log('ex-front-squat', 'T1', 's-t1-6x3', 200, [3, 3, 3, 3, 3, last], daysAgo, id); s.sets.filter(x => x.sessionId === id).at(-1).amrap = true; };
  const front = ex('ex-front-squat');
  amrap(6, 9, 'f1');
  eq([L.targetLoad(s, front, 'T1', sc('s-t1-6x3')), L.progression(s, front, 'T1', sc('s-t1-6x3')).steps], [205, 1], '6 on the AMRAP set of 3 (double): +5');
  amrap(7, 8, 'f2');
  eq(L.targetLoad(s, front, 'T1', sc('s-t1-6x3')), 210, '7 (more than double): +10');
  amrap(2, 7, 'f3');
  eq(L.targetLoad(s, front, 'T1', sc('s-t1-6x3')), 200, '2 on the AMRAP set: short, same load');
  // Kettlebell moves go to the next bell you own.
  s.exercises.push({ id: 'kb', name: 'KB press', familyId: 'fam-ohp', rank: 9, metric: 'load_reps', equipment: ['kettlebell'], role: 'main' });
  log('kb', 'T2', 's-t2-3x8', 40, [8, 8, 8], 2, 'd');
  eq(L.targetLoad(s, ex('kb'), 'T2', sc('s-t2-3x8')), 45);
});
test('v18: jumps move out of T2 into their own tier; goals keep their reps and this week keeps its credit', () => {
  const s = seed();
  s.version = 17;
  delete s.tiers.JUMP;
  s.schemes = s.schemes.filter(x => !x.tiers.includes('JUMP'));
  const goal = s.slots.find(x => x.id === 'sl-t2-jumps');
  goal.tier = 'T2';
  done(s, 'ex-broad-jump', 'T2', 4, 3);
  done(s, 'ex-power-clean', 'T2', 5, 3, 0, 155);
  s.sessions.push({ id: 'open1', status: 'open', blocks: [{ id: 'bj', tier: 'T2', exerciseId: 'ex-box-jump', schemeId: 's-t2-4x3' }, { id: 'pc', tier: 'T2', exerciseId: 'ex-power-clean', schemeId: 's-t2-5x3' }] });
  s.plans.push({ id: 'p', items: [{ tier: 'T2', exerciseId: 'ex-jump-squat', schemeId: 's-t2-4x3' }] });
  const m = migrate(s);
  eq(m.version, 24);
  ok(m.tiers.JUMP && L.schemeOptions(m, 'JUMP').length >= 5, 'tier and schemes');
  eq([goal.tier, goal.repMin, goal.repMax], ['JUMP', 12, 20]);
  ok(m.sets.filter(x => x.exerciseId === 'ex-broad-jump').every(x => x.tier === 'JUMP') && m.sets.filter(x => x.exerciseId === 'ex-power-clean').every(x => x.tier === 'T2'), 'jump sets move, cleans stay');
  eq(L.creditWeek(m).slots.get('sl-t2-jumps').filled, 1, 'this week still counts');
  const [bj, pc] = m.sessions.find(x => x.id === 'open1').blocks;
  eq([bj.tier, pc.tier, bj.schemeId], ['JUMP', 'T2', 's-t2-4x3'], 'open block moves, keeping the scheme its sets were made from');
  eq(m.plans[0].items[0].tier, 'JUMP');
  // Your own all-jumps family with a family-wide T2 goal moves too; a mixed family's goal stays.
  const t = seed();
  t.version = 17;
  t.families.push({ id: 'plyo', name: 'Plyometrics' }, { id: 'mixed', name: 'Mixed' });
  t.exercises.push({ id: 'p1', name: 'Hurdle hops', familyId: 'plyo', rank: 1, metric: 'reps', equipment: [], explosive: true, region: 'lower' },
    { id: 'p2', name: 'Pogo jumps', familyId: 'mixed', rank: 1, metric: 'reps', equipment: [], explosive: true, region: 'lower' },
    { id: 'p3', name: 'Med ball throw', familyId: 'mixed', rank: 2, metric: 'reps', equipment: [], explosive: true, region: 'upper' });
  t.slots.push({ id: 'g1', familyId: 'plyo', tier: 'T2', quota: 1 }, { id: 'g2', familyId: 'mixed', tier: 'T2', quota: 1 });
  const mt = migrate(t);
  eq([mt.slots.find(x => x.id === 'g1').tier, mt.slots.find(x => x.id === 'g2').tier], ['JUMP', 'T2']);
  const again = migrate(structuredClone(m));
  eq(again.schemes.length, m.schemes.length, 'idempotent');
});
test('Friday, every goal done: the hour still gets two complementary T2 lifts and T3 supersets', () => {
  const s = seed();
  const wk = L.weekBounds(s);
  const fri = wk.start + 4 * DAY + 10 * 3600e3;
  // Monday to Thursday: every goal met with its usual exercise.
  s.slots.forEach((sl, d) => {
    const ex = (L.pickExercise(s, sl.familyId, s.locations[1], sl.tier, sl.exerciseId) ?? L.pickExercise(s, sl.familyId, s.locations[0], sl.tier, sl.exerciseId)); // pull-ups and dips are at the Office
    for (let q = 0; q < sl.quota; q++) for (let i = 0; i < 6; i++) {
      s.sets.push({ id: L.uid(), sessionId: `f${d}${q}`, blockId: `f${d}${q}`, exerciseId: ex.id, tier: sl.tier, load: 100, reps: sl.tier === 'T3' ? 12 : sl.tier === 'COND' ? 20 : 5,
        done: true, loggedAt: wk.start + ((d + q) % 4) * DAY + 9 * 3600e3 + i, bw: 200, countsManual: true, countsToward: sl.id });
    }
  });
  ok([...L.creditWeek(s, fri).slots.values()].every(r => r.filled >= r.slot.quota), 'all goals met');
  const r = L.buildSuggestion(s, ci({ minutes: 60, fatigue: 1 }), fri);
  const ex = id => s.exercises.find(e => e.id === id);
  const t2 = r.blocks.filter(b => b.tier === 'T2').map(b => ex(b.exerciseId));
  const names = r.blocks.map(b => `${b.tier} ${ex(b.exerciseId).name}`).join(', ');
  eq(t2.length, 3, `fresh hour: three T2 lifts: ${names}`);
  ok(r.blocks.filter(b => b.tier === 'T3').length <= 4, `at most 4 T3s in an hour: ${names}`);
  ok(new Set(t2.map(e => L.movementPattern(s, e))).size === t2.length, `each in a different pattern: ${names}`);
  const t1Lifts = s.slots.filter(sl => sl.tier === 'T1').map(sl => sl.exerciseId ?? s.families.find(f => f.id === sl.familyId).defaultExerciseId);
  ok(t2.every(e => !t1Lifts.includes(e.id) && e.familyId !== 'fam-arms'), `support lifts, not a T1 goal's lift or curls: ${names}`);
  const t3 = r.blocks.filter(b => b.tier === 'T3');
  ok(t3.length >= 2 && t3.every(b => b.pairOf || r.blocks.some(x => x.pairOf === b.id)), `T3 supersets: ${names}`);
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
      for (let i = 0; i < 6; i++) s.sets.push({ id: L.uid(), sessionId: `x${q}`, blockId: `b${sl.id}${q}`, exerciseId: ex.id, tier: sl.tier, load: 100, reps: sl.tier === 'COND' ? 20 : 5, done: true,
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
  ok(sug.blocks.some(b => b.tier === 'T2' && b.slotId !== 'sl-t2-incline') && sug.blocks.filter(b => b.tier === 'T3').length >= 2, 'T2 and T3 fill');
  ok(/library/.test(sug.notes[0]), 'explained');
  // Leaning lower: the extra T2 lift is lower body and lower-body accessories come first.
  const low = L.buildSuggestion(s, ci({ minutes: 60, lean: 'lower' }));
  const extra = low.blocks.filter(b => b.slotId !== 'sl-t2-incline');
  ok(extra.filter(b => b.tier === 'T2').every(b => L.bodyRegion(s, s.exercises.find(e => e.id === b.exerciseId)) === 'lower'), `T2: ${extra.map(b => name(b.exerciseId))}`);
  const firstT3s = low.notes.filter(n => /^T3/.test(n)).slice(0, 3).join(' | ');
  ok(!/pull|push|dip|curl|press/i.test(firstT3s), `lower accessories first: ${firstT3s}`);
  // Easy day: still 1-2 T2s, in shorter, lighter schemes, and the time is filled. With Add jumps: jumps and one T2.
  const easy = L.buildSuggestion(s, ci({ minutes: 45, intent: 'easy', fatigue: 2, lean: 'lower', jumps: true }));
  const t2 = easy.blocks.filter(b => b.tier === 'T2');
  ok(t2.length === 1 && easy.blocks.some(b => b.tier === 'JUMP'), `easy lower day: jumps and a T2: ${easy.blocks.map(b => b.tier + ' ' + name(b.exerciseId))}`);
  const easyNoJumps = L.buildSuggestion(s, ci({ minutes: 45, intent: 'easy', fatigue: 2, lean: 'lower' })).blocks;
  ok(!easyNoJumps.some(b => L.isJump(s.exercises.find(e => e.id === b.exerciseId))) && easyNoJumps.filter(b => b.tier === 'T2').length === 2, `no jumps unless asked: ${easyNoJumps.map(b => b.tier + ' ' + name(b.exerciseId))}`);
  ok(t2.every(b => { const sc = s.schemes.find(x => x.id === b.schemeId); return sc.minutes <= 10; }), 'lighter schemes');
  ok(easy.minutesUsed >= 40, `fills the time: ${easy.minutesUsed}`);
  const easyUp = L.buildSuggestion(s, ci({ minutes: 45, intent: 'easy', fatigue: 2, lean: 'upper' }));
  ok(!easyUp.blocks.some(b => s.exercises.find(e => e.id === b.exerciseId).region === 'lower' && s.exercises.find(e => e.id === b.exerciseId).explosive), 'no jumps when leaning upper');
  ok(L.buildSuggestion(s, ci({ minutes: 60 }), Date.now(), { excludeFamilies: ['fam-incline'] }).minutesUsed >= 50, '+ Time fills from the library too');
});
test('lean: goals for the half you lean toward come first', () => {
  const s = seed();
  s.locations[1].equipment = [...s.equipment]; // lean scoring, not gear: a basement with everything
  const score = (lean, fam) => L.scoreSlots(s, ci({ lean })).find(c => c.slot.familyId === fam)?.score;
  ok(score('lower', 'fam-squat') > score('either', 'fam-squat') && score('upper', 'fam-squat') < score('either', 'fam-squat'), 'squat');
  ok(score('upper', 'fam-vpull') > score('either', 'fam-vpull') && score('lower', 'fam-vpull') < score('either', 'fam-vpull'), 'pull-ups');
  eq(score('lower', 'fam-core'), score('either', 'fam-core'), 'core is neither half');
  eq(score('lower', 'fam-clean'), score('either', 'fam-clean'), 'cleans are whole body');
  const t1 = lean => L.buildSuggestion(s, ci({ minutes: 45, lean }), Date.now(), { fill: false }).blocks.find(b => b.tier === 'T1')?.exerciseId;
  eq(t1('lower'), 'ex-back-squat');
  eq(t1('upper'), 'ex-wpullup');
});
test('explosive lower: jumps (when asked for), one or two cleans, then lower back, leg and core accessories, filling the hour', () => {
  const s = seed();
  const ex = b => s.exercises.find(e => e.id === b.exerciseId);
  const r = L.buildFocus(s, ci({ minutes: 60, jumps: true }), { region: 'lower', explosive: true });
  const names = r.blocks.map(b => `${b.tier} ${ex(b).name}`).join(', ');
  eq([ex(r.blocks[0]).familyId, r.blocks[0].tier], ['fam-jumps', 'JUMP'], names);
  const off = L.buildFocus(s, ci({ minutes: 60 }), { region: 'lower', explosive: true });
  ok(!off.blocks.some(b => L.isJump(ex(b))) && ex(off.blocks[0]).familyId === 'fam-clean', 'no jumps unless asked: cleans lead');
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
  eq(m.version, 24);
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

// ---------- data safety (js/vault.js) ----------
test('snapshots: the newest 14 daily and 10 of every other kind are kept', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ at: 1000 + i, reason: 'daily' });
  for (let i = 0; i < 14; i++) rows.push({ at: 5000 + i, reason: i % 2 ? 'before-import' : 'before-erase' });
  const gone = new Set(V.pruneKeys(rows));
  eq(gone.size, 6 + 4);
  ok([...gone].filter(at => at < 5000).every(at => at < 1006), 'the oldest dailies go');
  ok([...gone].filter(at => at >= 5000).every(at => at < 5004), 'the oldest action snapshots go');
  eq(V.pruneKeys(rows.slice(0, 5)), [], 'few snapshots: nothing goes');
});
test('daily snapshot: one a day, only on a day with logged sets', () => {
  const s = seed();
  const now = new Date(); now.setHours(15, 0, 0, 0);
  eq(V.needsDaily([], s, now.getTime()), false, 'nothing logged today');
  s.sets.push({ id: 'a', done: true, loggedAt: now.getTime() - 3600e3, exerciseId: 'ex-back-squat' });
  eq(V.needsDaily([], s, now.getTime()), true, 'a set today, no snapshot yet');
  eq(V.needsDaily([{ at: now.getTime() - 7200e3, reason: 'daily' }], s, now.getTime()), false, 'already taken today');
  eq(V.needsDaily([{ at: now.getTime() - 7200e3, reason: 'before-import' }], s, now.getTime()), true, 'a before-action snapshot is not the daily one');
  eq(V.needsDaily([{ at: now.getTime() - 86400e3, reason: 'daily' }], s, now.getTime()), true, 'yesterday\'s does not count');
  s.sets[0].warmup = true;
  eq(V.needsDaily([], s, now.getTime()), false, 'warm-ups do not count');
});
test('backup reminder: 3 finished workouts or 7 days with one, since your last backup; Not now waits 3 days', () => {
  const s = seed();
  const now = Date.now();
  const done = d => ({ id: L.uid(), status: 'done', firstSetAt: now - d * DAY, blocks: [] });
  eq(V.backupNudge(s, now), false, 'no workouts');
  s.sessions.push(done(2), done(1));
  eq(V.backupNudge(s, now), false, 'two recent workouts');
  s.sessions.push(done(0));
  eq(V.backupNudge(s, now), true, 'three workouts, never backed up');
  s.settings.lastExportAt = now - 3600e3;
  eq(V.backupNudge(s, now), false, 'just backed up');
  s.settings.lastExportAt = now - 1.5 * DAY;
  eq(V.backupNudge(s, now), false, 'two workouts since a backup 1.5 days ago');
  s.settings.lastExportAt = now - 2.5 * DAY;
  eq(V.backupNudge(s, now), true, 'three workouts since a backup 2.5 days ago');
  const t = seed();
  t.sessions.push(done(8));
  eq(V.backupNudge(t, now), true, 'one workout 8 days ago, never backed up');
  t.settings.lastExportAt = now - 2 * DAY;
  eq(V.backupNudge(t, now), false, 'that workout is older than the backup');
  t.sessions.push(done(1));
  t.settings.lastExportAt = now - 9 * DAY;
  eq(V.backupNudge(t, now), true, 'a workout since a week-old backup');
  t.settings.backupSnoozeUntil = now + 2 * DAY;
  eq(V.backupNudge(t, now), false, 'Not now');
  eq(V.backupNudge(t, now + 3 * DAY), true, 'and it comes back');
});
test('v19: data saved before it opens with savedAt unset, and the summary counts workouts and working sets', () => {
  const s = seed();
  s.version = 18;
  delete s.savedAt;
  const m = migrate(s);
  eq([m.version, m.savedAt], [24, null]);
  s.sessions.push({ id: 'x', firstSetAt: 1 }, { id: 'y', firstSetAt: null });
  s.sets.push({ done: true, warmup: false }, { done: true, warmup: true }, { done: false });
  eq(V.summaryOf(s), { version: 24, workouts: 1, sets: 1 });
});
atest('the vault: a second copy, snapshots that list newest first, and pruning', async () => {
  if (!V.available()) return; // no IndexedDB here (the rules also run outside a browser)
  await V.wipe();
  ok(await V.usable(), 'opens');
  eq(await V.get(), null, 'empty at first');
  ok(await V.put('{"a":1}'));
  eq((await V.get()).json, '{"a":1}');
  ok(await V.put('{"a":2}'));
  eq((await V.get()).json, '{"a":2}', 'one copy, replaced');
  for (let i = 0; i < 16; i++) await V.snapshot(`{"n":${i}}`, 'daily', { workouts: i, sets: i * 5, version: 19 });
  for (let i = 0; i < 12; i++) await V.snapshot(`{"m":${i}}`, i % 2 ? 'before-import' : 'before-paste', { workouts: 1, sets: 1, version: 19 });
  const rows = await V.list();
  eq([rows.filter(r => r.reason === 'daily').length, rows.filter(r => r.reason !== 'daily').length], [14, 10], 'pruned to 14 and 10');
  ok(rows.every((r, i) => !i || rows[i - 1].at > r.at), 'newest first, each at unique');
  ok(!('json' in rows[0]), 'the list carries no data');
  const newestDaily = rows.find(r => r.reason === 'daily');
  eq([JSON.parse((await V.read(newestDaily.at)).json).n, newestDaily.workouts], [15, 15], 'the newest daily is the last one taken');
  eq(await V.read(1), null, 'unknown time');
  await V.wipe();
  eq(await V.list(), [], 'wiped');
});

// ---------- taste (js/taste.js) ----------
import * as T from './taste.js';
// A state with swap and removal events on a past session: [{ type, from, to, reason, tier, daysAgo }].
const tasteState = (events = [], extra = {}) => {
  const s = seed();
  s.sessions.push({ id: 'ts', status: 'done', source: 'swapped', checkinAt: Date.now() - 3 * DAY, firstSetAt: Date.now() - 3 * DAY, blocks: events.map((ev, i) => ({
    id: `tb${i}`, tier: ev.tier ?? 'T3', exerciseId: ev.to ?? ev.from, schemeId: 's-t3-3x15', swaps: [{ type: ev.type ?? 'exercise', from: ev.from, to: ev.to, reason: ev.reason, at: Date.now() - (ev.daysAgo ?? 3) * DAY }] })), ...extra });
  return s;
};
test('taste: each signal is worth what the spec says, and fades with a 6-week half-life', () => {
  const sc = (events, id) => T.tasteOf(T.taste(tasteState(events)), id);
  const near = (a, b) => Math.abs(a - b) < 0.1;
  ok(near(sc([{ from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 0 }], 'ex-leg-ext'), 1.5), 'swapped to');
  ok(near(sc([{ from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 0 }], 'ex-calf-raise'), -1.5), 'swapped away');
  ok(near(sc([{ from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 0, reason: 'Preference' }], 'ex-calf-raise'), -1.5), 'Preference counts');
  ok(near(sc([{ type: 'add', to: 'ex-leg-ext', daysAgo: 0 }], 'ex-leg-ext'), 1), 'added by hand');
  ok(near(sc([{ from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 0, reason: 'Pain / niggle' }], 'ex-calf-raise'), -2), 'pain');
  eq(sc([{ from: 'ex-calf-raise', to: 'ex-leg-ext', reason: 'Equipment busy' }], 'ex-calf-raise'), 0, 'equipment busy is not taste');
  eq(sc([{ from: 'ex-calf-raise', to: 'ex-leg-ext', reason: 'Time' }], 'ex-leg-ext'), 0, 'neither is time');
  ok(near(sc([{ from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 42 }], 'ex-leg-ext'), 0.75), 'half after six weeks');
  eq(sc(Array(6).fill({ from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 0 }), 'ex-leg-ext'), 3, 'clamped to +3');
  eq(sc(Array(6).fill({ from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 0 }), 'ex-calf-raise'), -3, 'and -3');
  // Removed after being suggested: -1; one you added yourself says nothing; kept and fully logged: +0.5.
  const r = tasteState([], { removed: [{ exerciseId: 'ex-db-curl', tier: 'T3', at: Date.now(), wasSuggested: true }, { exerciseId: 'ex-leg-ext', tier: 'T3', at: Date.now(), wasSuggested: false }] });
  ok(near(T.tasteOf(T.taste(r), 'ex-db-curl'), -1) && T.tasteOf(T.taste(r), 'ex-leg-ext') === 0, 'removed');
  const k = tasteState([], { source: 'suggested', blocks: [{ id: 'kb', tier: 'T3', exerciseId: 'ex-db-curl', swaps: [] }, { id: 'kb2', tier: 'T3', exerciseId: 'ex-leg-ext', swaps: [] }] });
  k.sets.push({ id: 'k1', sessionId: 'ts', blockId: 'kb', exerciseId: 'ex-db-curl', done: true }, { id: 'k2', sessionId: 'ts', blockId: 'kb2', exerciseId: 'ex-leg-ext', done: true }, { id: 'k3', sessionId: 'ts', blockId: 'kb2', exerciseId: 'ex-leg-ext', done: false });
  ok(T.tasteOf(T.taste(k), 'ex-db-curl') > 0.4 && T.tasteOf(T.taste(k), 'ex-leg-ext') === 0, 'suggested and kept needs every set logged');
});
test('taste: favorites, Never suggest, pain, the cool-off, Forget, and the switch', () => {
  const s = tasteState([{ from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 0 }, { from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 0 }]);
  let tr = T.taste(s);
  ok(T.isExcluded(tr, 'ex-calf-raise') && !T.isExcluded(tr, 'ex-leg-ext'), 'two swaps away reach the cool-off');
  ok(!T.isExcluded(T.taste(s, Date.now() + 40 * DAY), 'ex-calf-raise'), 'and it fades');
  s.exercises.find(e => e.id === 'ex-leg-ext').pref = 'never';
  s.exercises.find(e => e.id === 'ex-calf-raise').pref = 'fav';
  tr = T.taste(s);
  ok(T.isExcluded(tr, 'ex-leg-ext') && !T.isExcluded(tr, 'ex-calf-raise') && T.tasteOf(tr, 'ex-calf-raise') >= -1, 'Never suggest, and a favorite is held up');
  const pain = T.taste(tasteState([{ from: 'ex-nordic', to: 'ex-ghr', reason: 'Pain / niggle', daysAgo: 1 }]));
  ok(T.isExcluded(pain, 'ex-nordic') && T.isExcluded(T.taste(tasteState([{ from: 'ex-nordic', to: 'ex-ghr', reason: 'Pain / niggle', daysAgo: 1 }]), Date.now()), 'ex-nordic'), 'pain skips it');
  ok(pain.skipUntil.get('ex-nordic') > Date.now() + 12 * DAY, 'for about two weeks');
  const f = tasteState([{ from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 5 }, { from: 'ex-calf-raise', to: 'ex-leg-ext', daysAgo: 5 }]);
  f.settings.tasteSince = Date.now() - DAY;
  eq(T.taste(f).score.size, 0, 'Forget: earlier events are ignored, history stays');
  f.settings.tasteSince = null; f.settings.learnTaste = false;
  eq(T.taste(f).score.size, 0, 'the switch off: nothing learned');
  f.exercises.find(e => e.id === 'ex-leg-ext').pref = 'never';
  ok(T.isExcluded(T.taste(f), 'ex-leg-ext'), 'but what you said outright still counts');
});
test('taste: your usual replacement needs two swaps at the same tier, not equipment busy or time', () => {
  const swap = (reason, tier = 'T2', n = 2) => Array.from({ length: n }, () => ({ from: 'ex-power-clean', to: 'ex-hang-clean', reason, tier }));
  const usual = (events, tier = 'T2') => T.usualReplacement(T.taste(tasteState(events)), 'ex-power-clean', tier, ['ex-hang-clean', 'ex-box-jump']);
  eq(usual(swap(undefined)), { id: 'ex-hang-clean', count: 2 });
  eq(usual(swap(undefined, 'T2', 1)), null, 'once is not a habit');
  eq(usual(swap('Equipment busy')), null);
  eq(usual(swap(undefined, 'T1')), null, 'another tier');
  eq(T.replacements(T.taste(tasteState(swap(undefined))), 'ex-power-clean', 'T2'), [{ id: 'ex-hang-clean', count: 2 }]);
});
test('taste in the builders: your usual replacement is picked and explained; Never suggest never shows; named goals hold; Learn off changes nothing', () => {
  const swaps = Array.from({ length: 2 }, () => ({ from: 'ex-power-clean', to: 'ex-hang-clean', tier: 'T2' }));
  const s = tasteState(swaps);
  const name = id => s.exercises.find(e => e.id === id).name;
  const c = ci({ minutes: 60, fatigue: 1, lean: 'lower' });
  const r = L.buildSuggestion(s, c);
  ok(r.blocks.some(b => b.exerciseId === 'ex-hang-clean') && !r.blocks.some(b => b.exerciseId === 'ex-power-clean'), `Hang clean instead: ${r.blocks.map(b => name(b.exerciseId))}`);
  ok(r.scored.some(x => x.why.some(w => /you usually swap Power clean for Hang clean/.test(w))), 'and it says why');
  // Never suggest: nowhere in any automatic pick, over many builds.
  const never = tasteState();
  for (const id of ['ex-back-ext', 'ex-belt-squat', 'ex-ab-wheel', 'ex-power-clean', 'ex-hang-clean']) never.exercises.find(e => e.id === id).pref = 'never';
  const bad = [];
  for (const minutes of [30, 45, 60, 90]) for (const lean of [null, 'lower', 'upper']) for (const variant of [0, 1, 2, 3]) {
    const cc = ci({ minutes, lean, variant, fatigue: 1 });
    for (const [kind, res] of [['suggest', L.buildSuggestion(never, cc)], ['focus', L.buildFocus(never, cc, { region: 'lower', explosive: true })], ['mix', L.buildMix(never, cc, { T1: 0, T2: 1, T3: 5 })]]) {
      for (const b of res.blocks) if (['ex-back-ext', 'ex-belt-squat', 'ex-ab-wheel', 'ex-power-clean', 'ex-hang-clean'].includes(b.exerciseId)) bad.push(`${kind} ${minutes} ${lean} ${variant}: ${name(b.exerciseId)}`);
    }
  }
  eq(bad.slice(0, 3), [], 'Never suggest exercises came up');
  // A goal that names an exercise is never changed by taste.
  const named = tasteState([{ from: 'ex-deficit-rdl', to: 'ex-nordic', daysAgo: 0 }, { from: 'ex-deficit-rdl', to: 'ex-nordic', daysAgo: 0 }]);
  named.exercises.find(e => e.id === 'ex-deficit-rdl').pref = 'never';
  ok(L.buildSuggestion(named, ci({ minutes: 60, fatigue: 1, lean: 'lower' })).blocks.some(b => b.exerciseId === 'ex-deficit-rdl'), 'the named Deficit RDL goal still gets its lift');
  // With Learn off, a history of swaps changes nothing.
  const off = tasteState([...swaps, { from: 'ex-calf-raise', to: 'ex-leg-ext' }, { from: 'ex-calf-raise', to: 'ex-leg-ext' }]);
  off.settings.learnTaste = false;
  const plain = seed();
  for (const cc of [ci({ minutes: 45, lean: 'lower' }), ci({ minutes: 90, fatigue: 3 }), ci({ minutes: 30, fatigue: 5, intent: 'easy' }), ci({ minutes: 60, variant: 2 })]) {
    eq(L.buildSuggestion(off, cc).blocks.map(b => b.exerciseId), L.buildSuggestion(plain, cc).blocks.map(b => b.exerciseId), 'Learn off: the same suggestion');
    eq(L.buildFocus(off, cc, { region: 'lower' }).blocks.map(b => b.exerciseId), L.buildFocus(plain, cc, { region: 'lower' }).blocks.map(b => b.exerciseId));
  }
});
test('taste: a favorite breaks a tie, and a build with taste stays fast', () => {
  const s = seed();
  const c = ci({ minutes: 90, fatigue: 1, lean: 'lower' });
  const base = L.buildFocus(s, c, { region: 'lower' }).blocks.map(b => b.exerciseId);
  const calf = base.find(id => L.movementPattern(s, s.exercises.find(e => e.id === id)) === 'calf');
  ok(!!calf, 'a 90-minute lower day reaches the calves');
  const other = s.exercises.find(e => e.id !== calf && e.role === 'accessory' && L.movementPattern(s, e) === 'calf' && L.isAvailable(e, s.locations[1]) && e.familyId === s.exercises.find(x => x.id === calf).familyId);
  ok(!!other, 'another calf exercise');
  other.pref = 'fav';
  const after = L.buildFocus(s, c, { region: 'lower' }).blocks.map(b => b.exerciseId);
  ok(base.indexOf(calf) < base.indexOf(other.id) && after.indexOf(other.id) < after.indexOf(calf), `${other.name} comes before ${s.exercises.find(e => e.id === calf).name} once it is a favorite`);
  // Speed, with a real history of swaps.
  const busy = tasteState(Array.from({ length: 60 }, (_, i) => ({ from: i % 2 ? 'ex-calf-raise' : 'ex-leg-ext', to: 'ex-ab-wheel', daysAgo: i })));
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) L.buildSuggestion(busy, ci({ minutes: 45 + (i % 4) * 15, lean: i % 2 ? 'lower' : 'upper', variant: i % 3 }));
  const per = (performance.now() - t0) / 40;
  ok(per < 40, `a suggestion takes ${per.toFixed(1)} ms`);
});

// ---------- cloud sync (js/merge.js, js/cloud.js, js/sync.js, against js/fake-supabase.js) ----------
const rec = (id, extra = {}) => ({ id, ...extra });
test('merge: records on either side are kept; one-sided edits win; real conflicts go to the newer side', () => {
  const base = [rec('a', { n: 1 }), rec('b', { n: 1 })];
  const local = [rec('a', { n: 2 }), rec('b', { n: 1 }), rec('c', { n: 1 })];
  const remote = [rec('a', { n: 1 }), rec('b', { n: 9 }), rec('d', { n: 1 })];
  eq(mergeById(base, local, remote, 'local').map(x => `${x.id}${x.n}`), ['a2', 'b9', 'c1', 'd1'], 'each side\'s own edit and addition');
  eq(mergeById(base, [rec('a', { n: 2 })], [rec('a', { n: 3 })], 'local')[0].n, 2, 'conflict: local newer');
  eq(mergeById(base, [rec('a', { n: 2 })], [rec('a', { n: 3 })], 'remote')[0].n, 3, 'conflict: remote newer');
  eq(mergeById(null, [rec('a', { n: 1 })], [rec('a', { n: 2 }), rec('z')], 'remote').map(x => `${x.id}${x.n ?? ''}`), ['a2', 'z'], 'no base: union, newer wins');
});
test('merge: a deletion on one side sticks unless the other side edited the record', () => {
  const base = [rec('x', { n: 1 }), rec('y', { n: 1 }), rec('w', { n: 1 })];
  eq(mergeById(base, [rec('y', { n: 1 }), rec('w', { n: 1 })], base, 'local').map(x => x.id), ['y', 'w'], 'deleted here, untouched there: gone');
  eq(mergeById(base, base, [rec('y', { n: 1 }), rec('w', { n: 1 })], 'local').map(x => x.id), ['x', 'y', 'w'].slice(1), 'deleted there, untouched here: gone');
  eq(mergeById(base, [rec('y', { n: 1 })], [rec('x', { n: 5 }), rec('y', { n: 1 })], 'local').map(x => x.id), ['y', 'x'], 'deleted here but edited there: kept');
  eq(mergeById(base, [rec('x', { n: 7 }), rec('y', { n: 1 })], [rec('y', { n: 1 })], 'remote').map(x => `${x.id}${x.n}`), ['x7', 'y1'], 'edited here but deleted there: kept');
});
test('merge: settings merge key by key; whole states keep both devices\' work and this device\'s timer', () => {
  eq(mergeObject({ a: 1, b: 1, c: { d: 1, e: 1 } }, { a: 2, b: 1, c: { d: 2, e: 1 } }, { a: 1, b: 3, c: { d: 1, e: 5 } }, 'local'), { a: 2, b: 3, c: { d: 2, e: 5 } });
  const base = seed(), local = structuredClone(base), remote = structuredClone(base);
  local.settings.bodyweight = 210; local.savedAt = 2000; local.timer = { endsAt: 1 };
  remote.settings.unit = 'kg'; remote.savedAt = 1000; remote.equipment.push('sled');
  local.sessions.push({ id: 'ls', blocks: [] }); remote.sessions.push({ id: 'rs', blocks: [] });
  remote.exercises = remote.exercises.filter(e => e.id !== 'ex-nordic');
  const m = mergeStates(base, local, remote);
  eq([m.settings.bodyweight, m.settings.unit], [210, 'kg']);
  eq(m.sessions.map(x => x.id), ['ls', 'rs']);
  ok(!m.exercises.some(e => e.id === 'ex-nordic'), 'the remote deletion carried over');
  ok(m.equipment.includes('sled') && m.savedAt === 2000 && m.timer.endsAt === 1);
  eq(migrate(m).version, 24);
});
test('sync plan: what to do for each situation', () => {
  const P = o => Sync.planSync({ hasBase: true, baseRev: 3, remote: { rev: 3 }, localChanged: false, localEmpty: false, baseHadData: true, remoteEmpty: false, ...o }).action;
  eq(P({ remote: null }), 'upload');
  eq(P({ hasBase: false, baseRev: null }), 'ask');
  eq(P({ hasBase: false, baseRev: null, remoteEmpty: true }), 'push');
  eq(Sync.planSync({ hasBase: false, remote: { rev: 2 }, localEmpty: true, remoteEmpty: false }).choice, 'account');
  eq(Sync.planSync({ hasBase: false, remote: { rev: 2 }, localEmpty: false, remoteEmpty: false }).choice, 'merge');
  eq(P({}), 'none');
  eq(P({ localChanged: true }), 'push');
  eq(P({ remote: { rev: 4 } }), 'pull');
  eq(P({ remote: { rev: 4 }, localChanged: true }), 'merge');
  eq(P({ remote: { rev: 2 }, localChanged: true }), 'push');
  eq(P({ localEmpty: true, localChanged: true }), 'ask', 'a device that looks erased never pushes over the account');
  eq(P({ remote: { rev: 4 }, localEmpty: true, localChanged: true }), 'ask');
  eq(P({ localEmpty: true, baseHadData: false, localChanged: true }), 'push', 'a device that never had data is not "erased"');
});
const loggedData = (n, tag) => {
  const s = seed();
  s.settings.onboarded = true;
  for (let i = 0; i < n; i++) s.sets.push({ id: `${tag}${i}`, sessionId: `${tag}s`, blockId: `${tag}b`, exerciseId: 'ex-back-squat', tier: 'T1', load: 200, reps: 3, done: true, loggedAt: Date.now() - i * 1000 });
  s.sessions.push({ id: `${tag}s`, status: 'done', firstSetAt: Date.now() - 9e4, checkinAt: Date.now() - 1e5, blocks: [] });
  s.savedAt = Date.now();
  return s;
};
const EMAIL = 'me@example.com';
// A signed-in device holding `data`, against a fresh fake project.
async function signedInDevice(data = loggedData(4, 'a')) {
  const fake = installFake();
  Cloud.reset();
  await V.wipe();
  Store.replaceState(structuredClone(data));
  await Cloud.sendCode(EMAIL);
  await Cloud.verifyCode(EMAIL, '123456');
  return fake;
}
const withFake = async fn => { try { await fn(globalThis.__fake); } finally { globalThis.__fake?.restore(); globalThis.__fake = null; } };
atest('cloud: a code signs you in, a bad code does not, and the link\'s address is the app\'s own', async () => {
  const fake = installFake();
  try {
    Cloud.reset();
    await Cloud.sendCode(EMAIL);
    eq(fake.sent[0].email, EMAIL);
    ok(fake.sent[0].redirect.startsWith(location.origin), 'the link comes back to this app');
    let bad = null;
    try { await Cloud.verifyCode(EMAIL, '000000'); } catch (e) { bad = e; }
    ok(bad && /code didn.t work/.test(bad.message) && !Cloud.signedIn(), 'a wrong code');
    await Cloud.verifyCode(EMAIL, '123456');
    ok(Cloud.signedIn() && Cloud.email() === EMAIL && Cloud.record().session.user.id === fake.users.get(EMAIL));
    eq(await Cloud.getRemote(), null, 'the account starts empty');
    eq(await Cloud.insertRemote({ saved_at: new Date().toISOString(), workouts: 0, sets: 0, data: { a: 1 } }), true);
    eq(await Cloud.insertRemote({ saved_at: new Date().toISOString(), workouts: 0, sets: 0, data: { a: 2 } }), 'conflict', 'a second first-upload');
    eq(await Cloud.updateRemote(1, { data: { a: 3 } }), true);
    eq(await Cloud.updateRemote(1, { data: { a: 4 } }), 'conflict', 'a stale rev');
    eq([(await Cloud.getRemote({ withData: true })).rev, (await Cloud.getRemote({ withData: true })).data.a], [2, 3]);
    ok(!('data' in await Cloud.getRemote()), 'the cheap look has no data');
  } finally { fake.restore(); }
});
atest('cloud: a password account can be created, signed into, and a wrong password or an existing email says so', async () => {
  const fake = installFake();
  try {
    Cloud.reset();
    let e1 = null; try { await Cloud.signInWithPassword(EMAIL, 'secret12'); } catch (e) { e1 = e; }
    ok(e1 && /don.t match/.test(e1.message) && !Cloud.signedIn(), 'no account yet');
    let weak = null; try { await Cloud.signUp(EMAIL, 'abc'); } catch (e) { weak = e; }
    ok(weak && /at least 6/.test(weak.message), 'the server\'s message for a weak password');
    ok(await Cloud.signUp(EMAIL, 'secret12') && Cloud.signedIn() && Cloud.email() === EMAIL, 'create account signs you in');
    Cloud.reset();
    let dup = null; try { await Cloud.signUp(EMAIL, 'secret12'); } catch (e) { dup = e; }
    ok(dup && /already has an account/.test(dup.message), 'creating it twice');
    let bad = null; try { await Cloud.signInWithPassword(EMAIL, 'nope-nope'); } catch (e) { bad = e; }
    ok(bad && /don.t match/.test(bad.message) && !Cloud.signedIn());
    ok(await Cloud.signInWithPassword(EMAIL, 'secret12') && Cloud.signedIn());
    eq(await Cloud.getRemote(), null, 'and the account\'s row is reachable');
    // With "Confirm email" left on in Supabase, sign-up returns no session: say what to do.
    Cloud.reset(); fake.passwords.clear(); fake.confirmEmail = true;
    let conf = null; try { await Cloud.signUp('new@example.com', 'secret12'); } catch (e) { conf = e; }
    ok(conf && /confirm/i.test(conf.message) && /Confirm email/.test(conf.message) && !Cloud.signedIn());
  } finally { fake.restore(); }
});
atest('cloud: an expired token is refreshed, a stale one retried, offline is told apart, a dead session signs you out', async () => {
  const fake = installFake();
  try {
    Cloud.reset();
    await Cloud.sendCode(EMAIL); await Cloud.verifyCode(EMAIL, '123456');
    Cloud.update({ session: { ...Cloud.record().session, expires_at: 1 } });
    await Cloud.getRemote();
    ok(fake.log.some(l => l.startsWith('POST /auth/v1/token')) && Cloud.record().session.expires_at > Date.now() / 1000, 'refreshed before the call');
    fake.expireTokens = true;
    eq(await Cloud.getRemote(), null, 'a 401 is retried after a refresh');
    fake.offline = true;
    let off = null; try { await Cloud.getRemote(); } catch (e) { off = e; }
    ok(off?.offline, 'offline');
    fake.offline = false;
    Cloud.update({ session: { ...Cloud.record().session, expires_at: 1, refresh_token: 'garbage' } });
    let dead = null; try { await Cloud.getRemote(); } catch (e) { dead = e; }
    ok(dead?.auth && !Cloud.signedIn(), 'a refresh the server refuses signs you out');
  } finally { fake.restore(); }
});
test('cloud: coming back from the emailed link takes the session from the address', () => {
  Cloud.reset();
  const b64 = o => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = `${b64({ alg: 'none' })}.${b64({ sub: 'u-1', email: 'x@y.z' })}.sig`;
  const before = location.hash;
  location.hash = `#access_token=${token}&expires_in=3600&refresh_token=r1&token_type=bearer&type=magiclink`;
  eq(Cloud.takeSessionFromUrl(), 'signedIn');
  ok(Cloud.signedIn() && Cloud.email() === 'x@y.z' && location.hash === '', 'signed in, address cleared');
  location.hash = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
  eq(Cloud.takeSessionFromUrl(), 'Email link is invalid or has expired');
  eq(Cloud.takeSessionFromUrl(), null, 'nothing in the address');
  Cloud.reset();
  location.hash = before;
});
atest('sync: the first upload, then nothing to do, then a change is pushed', async () => {
  const fake = globalThis.__fake = await signedInDevice();
  await withFake(async () => {
    eq((await Sync.sync()).kind, 'uploaded');
    const row = fake.row(EMAIL);
    eq([row.rev, row.sets, row.workouts, row.data.sets.length, row.data.timer], [1, 4, 1, 4, null]);
    eq(Cloud.record().baseRev, 1);
    fake.log.length = 0;
    eq((await Sync.sync()).kind, 'none');
    ok(!fake.log.some(l => l.startsWith('PATCH') || l.startsWith('POST /rest')), 'nothing sent when nothing changed');
    Store.state.settings.bodyweight = 222; Store.save();
    eq((await Sync.sync()).kind, 'pushed');
    eq([fake.row(EMAIL).rev, fake.row(EMAIL).data.settings.bodyweight], [2, 222]);
  });
});
atest('sync: the other device saved and this one changed nothing: it is pulled, after a snapshot', async () => {
  const fake = globalThis.__fake = await signedInDevice();
  await withFake(async () => {
    await Sync.sync();
    const theirs = structuredClone(fake.row(EMAIL).data);
    theirs.sessions.push({ id: 'phone-s', status: 'done', firstSetAt: Date.now(), blocks: [] }); theirs.settings.bodyweight = 180; theirs.savedAt = Date.now() + 5;
    fake.putRow(EMAIL, theirs);
    const r = await Sync.sync();
    eq([r.kind, r.device], ['pulled', 'Other phone']);
    ok(Store.state.sessions.some(x => x.id === 'phone-s') && Store.state.settings.bodyweight === 180);
    eq(Cloud.record().baseRev, 2);
    ok((await V.list()).some(x => x.reason === 'before-sync'), 'what was here is kept');
    eq((await Sync.sync()).kind, 'none');
  });
});
atest('sync: both devices changed: merged, both kept as snapshots, and the account gets the merge', async () => {
  const fake = globalThis.__fake = await signedInDevice();
  await withFake(async () => {
    await Sync.sync();
    const theirs = structuredClone(fake.row(EMAIL).data);
    theirs.sessions.push({ id: 'phone-s', status: 'done', firstSetAt: Date.now(), blocks: [] }); theirs.savedAt = Date.now() + 5;
    fake.putRow(EMAIL, theirs);
    Store.state.sessions.push({ id: 'laptop-s', status: 'done', firstSetAt: Date.now(), blocks: [] }); Store.save();
    const r = await Sync.sync();
    eq(r.kind, 'merged');
    ok(['phone-s', 'laptop-s', 'as'].every(id => Store.state.sessions.some(x => x.id === id)), 'both devices\' workouts here');
    eq(fake.row(EMAIL).rev, 3);
    ok(['phone-s', 'laptop-s'].every(id => fake.row(EMAIL).data.sessions.some(x => x.id === id)), 'and in the account');
    const why = (await V.list()).map(x => x.reason);
    ok(why.includes('before-sync') && why.includes('cloud-copy'), `both sides kept: ${why}`);
  });
});
atest('sync: a deletion travels, and an erased device never wipes the account', async () => {
  const fake = globalThis.__fake = await signedInDevice(loggedData(6, 'a'));
  await withFake(async () => {
    await Sync.sync();
    // Deleted on this device, untouched on the other: gone from the account.
    Store.state.sets = Store.state.sets.filter(x => x.id !== 'a0' && x.id !== 'a1'); Store.save();
    await Sync.sync();
    eq(fake.row(EMAIL).data.sets.length, 4);
    // Deleted on the other device while this one edited something else: both apply.
    const theirs = structuredClone(fake.row(EMAIL).data);
    theirs.sets = theirs.sets.filter(x => x.id !== 'a2'); theirs.savedAt = Date.now() + 5;
    fake.putRow(EMAIL, theirs);
    Store.state.settings.bodyweight = 205; Store.save();
    eq((await Sync.sync()).kind, 'merged');
    eq([Store.state.sets.length, Store.state.settings.bodyweight], [3, 205]);
    // This device gets erased: it asks instead of pushing the empty data.
    Store.replaceState(seed());
    const before = fake.row(EMAIL).rev;
    const r = await Sync.sync();
    eq([r.kind, r.choice], ['ask', 'account']);
    eq(fake.row(EMAIL).rev, before, 'the account is untouched');
  });
});
atest('sync: a device that meets an account with data asks first; each answer does what it says', async () => {
  const fake = globalThis.__fake = await signedInDevice(seed());
  await withFake(async () => {
    const theirs = loggedData(8, 'phone'); theirs.settings.bodyweight = 190;
    fake.putRow(EMAIL, theirs);
    const mine = structuredClone(Store.state);
    const r = await Sync.sync();
    eq([r.kind, r.choice, r.remote.sets, r.remote.workouts], ['ask', 'account', 8, 1]);
    eq(Store.state.sets.length, 0, 'nothing changes until you choose');
    eq(fake.row(EMAIL).rev, 1);
    eq((await Sync.resolve('account')).kind, 'pulled');
    eq([Store.state.sets.length, Store.state.settings.bodyweight], [8, 190]);
    ok((await V.list()).some(x => x.reason === 'cloud-copy' || x.reason === 'before-sync'));
    // Same account, a second fresh device that has its own data: merge both.
    Cloud.update({ baseRev: null }); await V.delKey('cloudBase');
    Store.replaceState(loggedData(3, 'laptop'));
    const r2 = await Sync.sync();
    eq([r2.kind, r2.choice], ['ask', 'merge']);
    eq((await Sync.resolve('merge')).kind, 'merged');
    eq(Store.state.sets.length, 11, 'both devices\' sets');
    eq(fake.row(EMAIL).data.sets.length, 11);
    // Keep this device's: it goes over the account, whose copy stays here as a snapshot.
    Cloud.update({ baseRev: null }); await V.delKey('cloudBase');
    Store.replaceState(loggedData(2, 'tablet'));
    eq((await Sync.sync()).kind, 'ask');
    eq((await Sync.resolve('keep')).kind, 'pushed');
    eq([fake.row(EMAIL).data.sets.length, Store.state.sets.length], [2, 2]);
    ok((await V.list()).filter(x => x.reason === 'cloud-copy').length >= 2, 'the account\'s copies were kept');
  });
});
atest('sync: another device saving mid-push is merged and retried; offline and old-version cases fail safe', async () => {
  const fake = globalThis.__fake = await signedInDevice();
  await withFake(async () => {
    await Sync.sync();
    Store.state.settings.bodyweight = 201; Store.save();
    const theirs = structuredClone(fake.row(EMAIL).data); theirs.sessions.push({ id: 'racer', status: 'done', firstSetAt: 1, blocks: [] }); theirs.savedAt = Date.now() + 5;
    fake.beforePatch = () => fake.putRow(EMAIL, theirs);
    const r = await Sync.sync();
    eq(r.kind, 'merged');
    ok(Store.state.sessions.some(x => x.id === 'racer') && fake.row(EMAIL).data.sessions.some(x => x.id === 'racer') && fake.row(EMAIL).data.settings.bodyweight === 201, 'the race lost nothing');
    // Offline: an error that says so, and nothing touched.
    const keep = JSON.stringify(Store.state.sets);
    Store.state.settings.bodyweight = 202; Store.save();
    fake.offline = true;
    const off = await Sync.sync();
    ok(off.kind === 'error' && off.error.offline && JSON.stringify(Store.state.sets) === keep);
    fake.offline = false;
    eq((await Sync.sync()).kind, 'pushed', 'and it catches up when the network is back');
    // An account copy from a newer build is left alone.
    const future = structuredClone(fake.row(EMAIL).data); future.version = 99; future.savedAt = Date.now() + 10;
    fake.putRow(EMAIL, future);
    const nv = await Sync.sync();
    ok(nv.kind === 'error' && /newer version/.test(nv.error.message) && Store.state.version === 24);
  });
});
atest('sync: signed out does nothing; signing out forgets the account link but keeps your data', async () => {
  const fake = globalThis.__fake = await signedInDevice();
  await withFake(async () => {
    await Sync.sync();
    await Sync.signOut();
    ok(!Cloud.signedIn() && Cloud.record().baseRev == null && (await V.getKey('cloudBase')) == null);
    eq((await Sync.sync()).kind, 'skipped');
    eq(Store.state.sets.length, 4, 'your data stays');
    await Cloud.sendCode(EMAIL); await Cloud.verifyCode(EMAIL, '123456');
    eq((await Sync.sync()).kind, 'ask', 'signing back in asks, as on a new device');
  });
});

// ---------- render ----------
// ---------- pace (js/pace.js) ----------
import * as Pace from './pace.js';
const MINUTE = 6e4;
// A finished workout with known timing. `groups`: [[block, ...]], each block { ex, tier, scheme, n, warm? };
// a group of two or more is a superset (alternating sets). `gap`: minutes per set (with its rest), `change`: after a group.
const paceWorkout = (state, { daysAgo = 1, loc = 'loc-basement', groups, gap = 3, change = 4, burst = false }) => {
  const sid = L.uid(), blocks = [];
  let t = NOON(daysAgo);
  const start = t;
  for (const g of groups) {
    const bs = g.map(x => ({ id: L.uid(), tier: x.tier, exerciseId: x.ex, schemeId: x.scheme, swaps: [], ...(x.rest != null ? { restSec: x.rest } : {}) }));
    bs.slice(1).forEach(b => { b.pairOf = bs[0].id; });
    blocks.push(...bs);
    g.forEach((x, i) => { for (let w = 0; w < (x.warm || 0); w++) { state.sets.push({ id: L.uid(), sessionId: sid, blockId: bs[i].id, exerciseId: x.ex, tier: x.tier, reps: 3, done: true, warmup: true, loggedAt: t }); t += MINUTE; } });
    const most = Math.max(...g.map(x => x.n));
    for (let r = 0; r < most; r++) g.forEach((x, i) => {
      if (r >= x.n) return;
      state.sets.push({ id: L.uid(), sessionId: sid, blockId: bs[i].id, exerciseId: x.ex, tier: x.tier, reps: 3, done: true, loggedAt: t });
      t += burst ? 5e3 : gap * MINUTE;
    });
    t += change * MINUTE; // after the last set and its rest
  }
  state.sessions.push({ id: sid, status: 'done', source: 'suggested', locationId: loc, minutes: 45, checkinAt: start - 3600e3, firstSetAt: start, blocks });
  return sid;
};
const squat = { ex: 'ex-front-squat', tier: 'T1', scheme: 's-t1-5x3', n: 5 };
const curl = { ex: 'ex-db-curl', tier: 'T3', scheme: 's-t3-3x15', n: 3 };
const tri = { ex: 'ex-db-oh-tri', tier: 'T3', scheme: 's-t3-3x15', n: 3 };
const fresh = () => { const s = seed(); s.settings.onboarded = true; return s; };
const staticMinutes = (s, b, ctx) => { const off = structuredClone(s); off.settings.learnPace = false; return L.blockMinutes(off, b, ctx); };

test('pace: gaps under 20 s and over 15 min are dropped, and a workout with more than 40% dropped teaches nothing', () => {
  const sess = { id: 'x', blocks: [{ id: 'a', tier: 'T1', exerciseId: 'e' }] };
  const at = mins => mins.map((m, i) => ({ id: `s${i}`, blockId: 'a', done: true, loggedAt: NOON(1) + m * MINUTE }));
  const one = Pace.sessionPace(sess, at([0, 3, 6, 6.2, 9.2, 12.2]));       // one burst of 12 s in five gaps: 20%
  eq([one.skipped, one.kept, one.perSet.map(x => x.minutes)], [false, 4, [3, 3, 3, 3]]);
  const brk = Pace.sessionPace(sess, at([0, 3, 6, 26, 29, 32]));           // a 20-minute break
  eq([brk.skipped, brk.kept], [false, 4]);
  const burst = Pace.sessionPace(sess, at([0, 0.1, 0.2, 0.3, 3, 6]));       // 3 of 5 gaps are bursts: 60%
  eq([burst.skipped, burst.bursty], [true, true]);
  eq(Pace.sessionPace(sess, at([0, 0.1, 3, 6, 9, 12])).skipped, false, 'one of five (20%) is fine');
});

test('pace: per-set time needs 3 workouts with the exercise at the tier; until then the estimate is exactly today’s', () => {
  const s = fresh();
  const b = { id: 'b', tier: 'T1', exerciseId: 'ex-front-squat', schemeId: 's-t1-5x3', swaps: [] };
  const before = L.blockMinutes(s, b);
  eq(before, 11 + 5 + 2, 'scheme + warm-up + changeover');
  paceWorkout(s, { daysAgo: 3, groups: [[squat]] });
  paceWorkout(s, { daysAgo: 2, groups: [[squat]] });
  eq(L.blockMinutes(s, b), before, 'two workouts: still the guess');
  ok(!L.pacedBlocks(s, [b], 'loc-basement'));
  paceWorkout(s, { daysAgo: 1, groups: [[squat]] });
  eq(L.paceFor(s).perSet.get('ex-front-squat|T1|solo'), { minutes: 3, sessions: 3 });
  eq(L.blockMinutes(s, b), 5 * 3 + 5 + 2, 'five sets at 3 minutes, plus the usual warm-up and changeover');
  ok(L.pacedBlocks(s, [b], 'loc-basement'));
  eq(L.schemeTime(s, 'T1', 'ex-front-squat', L.byId(s.schemes, 's-t1-4x3')), 12, 'other schemes scale by their sets');
  eq(L.blockMinutes(s, { ...b, exerciseId: 'ex-back-squat' }), staticMinutes(s, { ...b, exerciseId: 'ex-back-squat' }), 'another exercise keeps the guess');
  s.settings.learnPace = false;
  eq(L.blockMinutes(s, b), before, 'Use my pace off: exactly today’s numbers');
  s.settings.learnPace = true;
  s.settings.paceSince = Date.now();
  eq(L.blockMinutes(s, b), before, 'Reset: earlier workouts stop counting');
});

test('pace: only the last 8 weeks count, and burst-logged workouts change no estimate', () => {
  const s = fresh();
  const b = { id: 'b', tier: 'T1', exerciseId: 'ex-front-squat', schemeId: 's-t1-5x3', swaps: [] };
  for (const d of [60, 61, 62]) paceWorkout(s, { daysAgo: d, groups: [[squat]] });
  eq(L.blockMinutes(s, b), 18, 'nine weeks ago');
  for (const d of [1, 2, 3, 4]) paceWorkout(s, { daysAgo: d, groups: [[squat]], burst: true });
  eq(L.blockMinutes(s, b), 18, 'bursts');
  ok(L.paceFor(s).bursty, 'the next workout shows the logging hint');
});

test('pace: changeover per location needs 5 samples, less the next exercise’s warm-up', () => {
  const s = fresh();
  const b = { id: 'b', tier: 'T3', exerciseId: 'ex-db-curl', schemeId: 's-t3-3x15', swaps: [] };
  const groups = [[squat], [{ ...curl, n: 3 }], [{ ...tri, n: 3 }]]; // two changeovers each: squat→curl, curl→tri
  paceWorkout(s, { daysAgo: 1, groups, change: 4 });
  paceWorkout(s, { daysAgo: 2, groups, change: 4 });
  eq(L.paceFor(s).all.get('loc-basement').samples, 4);
  eq(L.changeoverAt(s, 'loc-basement'), 2, 'four samples: still the setting');
  paceWorkout(s, { daysAgo: 3, groups, change: 4 });
  eq(L.changeoverAt(s, 'loc-basement'), 4, 'T3 has no warm-up, so the gap is the changeover');
  eq(L.changeoverAt(s, 'loc-office'), 2, 'other locations keep the setting');
  eq(L.blockMinutes(s, b, { loc: 'loc-basement' }), 3 * 3 + 4, 'three curl sets at 3 minutes, and the learned changeover');
  eq(L.blockMinutes(s, b, { loc: 'loc-office' }), 3 * 3 + 2);
  // With logged warm-up sets, warm-up is learned too and comes off the changeover.
  const w = fresh();
  for (const d of [1, 2, 3]) paceWorkout(w, { daysAgo: d, groups: [[curl], [{ ...squat, warm: 3 }]], change: 7 });
  eq(L.paceFor(w).warm.get('ex-front-squat|T1'), 3);
  eq(L.paceFor(w).all.get('loc-basement').minutes, 7, 'a 13-minute gap between working sets, less the last curl set’s 3 and 3 of logged warm-up');
});

test('pace: a superset is timed as one group and split evenly between its blocks', () => {
  const s = fresh();
  for (const d of [1, 2, 3]) paceWorkout(s, { daysAgo: d, groups: [[curl, tri]], gap: 1.5 });
  // Six sets 1.5 minutes apart: 9 minutes for the group, 4.5 for each block, 1.5 a set.
  eq(L.paceFor(s).perSet.get('ex-db-curl|T3|pair').minutes, 1.5);
  ok(!L.paceFor(s).perSet.has('ex-db-curl|T3|solo'));
  const a = { id: 'a', tier: 'T3', exerciseId: 'ex-db-curl', schemeId: 's-t3-3x15', swaps: [] };
  const p = { id: 'p', tier: 'T3', exerciseId: 'ex-db-oh-tri', schemeId: 's-t3-3x15', swaps: [], pairOf: 'a' };
  eq(L.blockMinutes(s, a, { blocks: [a, p], loc: 'loc-office' }), 4.5 + 2);
  eq(L.blockMinutes(s, p, { blocks: [a, p], loc: 'loc-office' }), 4.5 + 1, 'the partner’s changeover is shared');
  eq(L.blockMinutes(s, a, { loc: 'loc-office' }), 6 + 2, 'done alone: no solo time learned, so the guess');
});

test('pace: rest changed today moves that block’s estimate by the difference', () => {
  const s = fresh();
  const b = { id: 'b', tier: 'T1', exerciseId: 'ex-front-squat', schemeId: 's-t1-5x3', swaps: [] };
  eq(L.blockMinutes(s, { ...b, restSec: 210 }) - L.blockMinutes(s, b), 5, 'a minute more rest on each of five sets');
});

test('pace: suggestions fill the time with your pace and never run over', () => {
  const s = fresh();
  // A slow lifter: 5 minutes a set on the squat.
  for (const d of [2, 4, 6]) paceWorkout(s, { daysAgo: d, groups: [[squat]], gap: 5 });
  for (const m of [30, 45, 60, 90]) {
    const c = ci({ minutes: m, fatigue: 2 });
    const r = L.buildSuggestion(s, c);
    ok(L.blocksMinutes(s, r.blocks, c.locationId) <= m + 1e-9, `${m} min: ${L.blocksMinutes(s, r.blocks, c.locationId)}`);
  }
});

// ---------- weekly review (js/review.js) ----------
import * as R from './review.js';
// The weighted-dip goal as in a real backup: it names Weighted dip, which needs a dip station and a belt in one place.
const reviewState = () => { const s = seed(); s.settings.onboarded = true; L.byId(s.slots, 'sl-t2-dip').exerciseId = 'ex-wdip'; return s; };
const famEx = (s, fam) => L.familyMembers(s, fam).find(e => !e.archived && e.metric !== 'load_reps')?.id ?? L.familyMembers(s, fam)[0].id;
// One finished workout at `t`: items [exerciseId, tier, sets, reps], optional `why` rows and blocks.
const logWorkout = (s, t, items, extra = {}) => {
  const sid = L.uid();
  items.forEach(([exerciseId, tier, n, reps], j) => { for (let i = 0; i < n; i++) s.sets.push({ id: L.uid(), sessionId: sid, blockId: `${sid}-${j}`, exerciseId, tier, reps, load: null, done: true, loggedAt: t + (j * 10 + i) * 6e4 }); });
  s.sessions.push({ id: sid, day: L.dayKey(t), status: 'done', source: 'suggested', locationId: 'loc-basement', minutes: 45, checkinAt: t - 6e5, firstSetAt: t, blocks: items.map(([exerciseId, tier], j) => ({ id: `${sid}-${j}`, tier, exerciseId, schemeId: 's-t3-3x15', swaps: [] })), ...extra });
  return sid;
};
const weekAgo = (s, n) => L.weekBounds(s, Date.now() - n * 7 * DAY).start;
const dayIn = (start, d) => start + d * DAY + 12 * 3600e3;

test('review: a week with 3 workouts, totals and goals match creditWeek', () => {
  const s = reviewState();
  const w = weekAgo(s, 1), arms = famEx(s, 'fam-arms'), back = famEx(s, 'fam-upperback');
  logWorkout(s, dayIn(w, 0), [[arms, 'T3', 3, 15], [back, 'T3', 3, 15]]);
  logWorkout(s, dayIn(w, 2), [[arms, 'T3', 3, 15]]);
  logWorkout(s, dayIn(w, 4), [[back, 'T3', 2, 5]]); // short of the dose
  const r = R.weekReview(s, w);
  const c = L.creditWeek(s, w + 3600e3);
  ok(r.finished);
  eq([r.totals.workouts, r.totals.sets, r.totals.byTier.T3], [3, 11, 11]);
  eq(r.totals.minutes, 12 + 2 + 1, 'first set to last per workout');
  for (const g of r.goals) eq(g.filled, c.slots.get(g.slotId).filled, g.label);
  eq(r.totals.filled, [...c.slots.values()].reduce((n, x) => n + x.filled, 0));
  eq(r.totals.quota, s.slots.reduce((n, sl) => n + sl.quota, 0));
  const ga = r.goals.find(g => g.slotId === 'sl-t3-arms'), gb = r.goals.find(g => g.slotId === 'sl-t3-upperback');
  eq([ga.met, ga.reason, gb.filled, gb.reason], [true, null, 1, 'short']);
  eq(r.totals.goalsMet, r.goals.filter(g => g.met).length);
  ok(/3 workouts/.test(R.reviewText(s, r)) && /T3 Arms \(pump\): 2\/2 ✓/.test(R.reviewText(s, r)), R.reviewText(s, r));
});

test('review: why a goal slipped, first match wins', () => {
  const s = reviewState();
  const w = weekAgo(s, 1), arms = famEx(s, 'fam-arms');
  const why = (slotId, note) => ({ slotId, label: '?', score: 1, why: [], picked: false, note });
  logWorkout(s, dayIn(w, 0), [[arms, 'T3', 3, 15]], { why: [
    why('sl-t2-clean', 'power work waits for a fresh day'), why('sl-t2-clean', 'no scheme fits remaining time'),
    why('sl-t2-incline', 'no scheme fits remaining time'), why('sl-t2-incline', 'T2 cap reached'),
    why('sl-t1-squat', 'score too low vs. top pick'), why('sl-t2-jumps', 'jumps are off today (turn on Add jumps)')] });
  logWorkout(s, dayIn(w, 1), [[arms, 'T3', 1, 5]]);
  s.sessions.at(-1).blocks.push({ id: 'x', tier: 'T3', slotId: 'sl-t3-core', exerciseId: famEx(s, 'fam-core'), schemeId: 's-t3-3x15', swaps: [{ type: 'exercise', from: 'a', to: 'b', at: dayIn(w, 1) }] });
  const r = R.weekReview(s, w);
  const reason = id => r.goals.find(g => g.slotId === id).reason;
  eq(reason('sl-t2-dip'), 'gear', 'weighted dip: no location has a dip station and a belt');
  eq(reason('sl-t3-core'), 'swapped');
  eq(reason('sl-t2-clean'), 'fresh', 'before never fit the time');
  eq(reason('sl-t2-incline'), 'time', 'before other goals came first');
  eq(reason('sl-t1-squat'), 'others');
  eq(reason('sl-t2-jumps'), 'jumps');
  L.byId(s.slots, 'sl-tq-clean').quota = 3;
  eq(R.weekReview(s, w).goals.find(g => g.slotId === 'sl-tq-clean').reason, 'workouts', 'quota 3, two workout days');
});

test('review: ease off after 2 missed weeks (across a changed week start), pause at 1, and the weighted-dip goal gets a fix', () => {
  const s = reviewState();
  s.settings.weekStartDay = 3; // Wednesday
  const w = weekAgo(s, 1), back = famEx(s, 'fam-upperback'), arms = famEx(s, 'fam-arms');
  logWorkout(s, dayIn(weekAgo(s, 3), 0), [[arms, 'T3', 3, 15], [back, 'T3', 3, 15]]); // first use: upper back once
  logWorkout(s, dayIn(weekAgo(s, 3), 1), [[arms, 'T3', 3, 15], [back, 'T3', 3, 15]]); // ...and twice: met that week
  logWorkout(s, dayIn(weekAgo(s, 2), 0), [[arms, 'T3', 3, 15]]);
  logWorkout(s, dayIn(w, 0), [[arms, 'T3', 3, 15]]);
  logWorkout(s, dayIn(w, 1), [[arms, 'T3', 3, 15]]);
  const r = R.weekReview(s, w);
  const gb = r.goals.find(g => g.slotId === 'sl-t3-upperback');
  eq(gb.missed, 2, 'missed last week and the one before, met the week before that');
  const p = id => r.proposals.find(x => x.id === id);
  eq(p('ease:sl-t3-upperback').change, { quota: 1 });
  eq(p('ease:sl-t1-squat').change, { quota: 0 }, 'at 1: pause');
  ok(!p('ease:sl-t3-arms'), 'met goals are not eased');
  const dip = p('gear:sl-t2-dip');
  ok(dip && dip.kind === 'gear' && /Weighted dip: no location has the gear/.test(dip.text), JSON.stringify(dip));
  eq(dip.change, { exerciseId: 'ex-wring-dip' }, 'the office has rings and a belt');
  // A week in progress proposes no ease-off yet.
  const now = R.weekReview(s, L.weekBounds(s).start);
  ok(!now.finished && !now.proposals.some(x => x.kind === 'ease'));
});

test('review: step up when met by mid-week twice and there is room; trim T3 quotas when over budget', () => {
  const s = reviewState();
  s.slots = s.slots.filter(sl => sl.id === 'sl-t3-arms');
  s.settings.week = { workouts: 3, minutes: 60 };
  const arms = famEx(s, 'fam-arms');
  for (const n of [1, 2]) { logWorkout(s, dayIn(weekAgo(s, n), 0), [[arms, 'T3', 3, 15]]); logWorkout(s, dayIn(weekAgo(s, n), 2), [[arms, 'T3', 3, 15]]); }
  const r = R.weekReview(s, weekAgo(s, 1));
  eq(r.proposals.map(p => [p.id, p.change]), [['step:sl-t3-arms', { quota: 3 }]]);
  // Late in the week only: no step up.
  const late = reviewState(); late.slots = late.slots.filter(sl => sl.id === 'sl-t3-arms'); late.settings.week = { workouts: 3, minutes: 60 };
  for (const n of [1, 2]) { logWorkout(late, dayIn(weekAgo(late, n), 4), [[arms, 'T3', 3, 15]]); logWorkout(late, dayIn(weekAgo(late, n), 5), [[arms, 'T3', 3, 15]]); }
  eq(R.weekReview(late, weekAgo(late, 1)).proposals, []);
  // Over budget: T3 quotas come down, largest first.
  const o = reviewState();
  o.settings.week = { workouts: 2, minutes: 30 };
  o.slots.find(sl => sl.id === 'sl-t3-core').quota = 4;
  logWorkout(o, dayIn(weekAgo(o, 1), 0), [[arms, 'T3', 3, 15]]);
  const trim = R.weekReview(o, weekAgo(o, 1)).proposals.find(p => p.kind === 'budget');
  ok(trim && trim.change.trims.every(t => t.quota < L.byId(o.slots, t.slotId).quota) && trim.change.trims.some(t => t.slotId === 'sl-t3-core'), JSON.stringify(trim));
  ok(/Core 4→/.test(trim.text), 'the largest comes down');
  R.applyProposal(o, trim);
  for (const t of trim.change.trims) eq(L.byId(o.slots, t.slotId).quota, t.quota);
});

test('review: a lift at the same load 3 sessions running is flagged, and nothing applies it', () => {
  const s = reviewState();
  for (const n of [3, 2, 1]) s.sets.push(...[0, 1, 2].map(i => ({ id: L.uid(), sessionId: `fs${n}`, blockId: `fs${n}`, exerciseId: 'ex-front-squat', tier: 'T1', schemeId: 's-t1-5x3', load: 185, reps: 3, done: true, loggedAt: dayIn(weekAgo(s, n), 1) + i * 6e4 })));
  const r = R.weekReview(s, weekAgo(s, 1));
  const l = r.lifts.find(x => x.exerciseId === 'ex-front-squat');
  eq([l.trend, l.load], ['stalled', 185]);
  const flag = r.proposals.find(p => p.kind === 'stalled');
  ok(flag && flag.change === null && !R.applyProposal(s, flag));
});

test('review: a proposal skipped twice is not offered again; records keep 26 weeks; migration adds reviews', () => {
  const s = reviewState();
  const arms = famEx(s, 'fam-arms');
  logWorkout(s, dayIn(weekAgo(s, 4), 0), [[arms, 'T3', 3, 15]]);
  const id = 'gear:sl-t2-dip';
  for (const n of [3, 2]) {
    const r = R.weekReview(s, weekAgo(s, n));
    ok(r.proposals.some(p => p.id === id), `offered in week -${n}`);
    R.recordReview(s, r).proposals.find(p => p.id === id).status = 'skipped';
  }
  ok(!R.weekReview(s, weekAgo(s, 1)).proposals.some(p => p.id === id), 'skipped twice');
  for (let i = 0; i < 30; i++) R.recordReview(s, { weekStart: i * 7 * DAY, totals: {}, proposals: [] });
  eq(s.reviews.length, R.KEEP_WEEKS);
  ok(s.reviews[0].weekStart >= s.reviews[1].weekStart, 'newest first');
  const old = seed(); delete old.reviews; old.version = 21;
  eq(migrate(old).reviews, []);
});

test('review: the Last week card is due on a new week until reviewed or dismissed', () => {
  const s = reviewState();
  eq(R.lastWeekDue(s), null, 'nothing yet');
  logWorkout(s, dayIn(weekAgo(s, 1), 0), [[famEx(s, 'fam-arms'), 'T3', 3, 15]]);
  const w = R.lastWeekDue(s);
  eq(w, weekAgo(s, 1));
  R.recordReview(s, R.weekReview(s, w), 'open');
  eq(R.lastWeekDue(s), w, 'opened but not finished: still due');
  R.recordReview(s, R.weekReview(s, w), 'dismissed');
  eq(R.lastWeekDue(s), null);
});

test('review: accepting changes the goal; the gear fix can also move the tier or remove it', () => {
  const s = reviewState();
  const sl = L.byId(s.slots, 'sl-t2-dip');
  ok(R.applyProposal(s, { slotId: sl.id, change: { exerciseId: 'ex-wring-dip' } }));
  eq(sl.exerciseId, 'ex-wring-dip');
  R.applyProposal(s, { slotId: sl.id, change: { tier: 'T3', exerciseId: null } });
  eq([sl.tier, 'exerciseId' in sl], ['T3', false]);
  R.applyProposal(s, { slotId: sl.id, change: { quota: 0 } });
  eq(sl.quota, 0);
  ok(!L.scoreSlots(s, ci()).some(c => c.slot.id === sl.id), 'a paused goal is not suggested');
  R.applyProposal(s, { slotId: sl.id, change: { remove: true } });
  ok(!L.byId(s.slots, sl.id));
});

test('a workout length typed in: pace ignores its set times, the review counts the typed minutes', () => {
  const s = fresh();
  for (const d of [1, 2, 3]) paceWorkout(s, { daysAgo: d, groups: [[squat]] });
  ok(L.paceFor(s).perSet.has('ex-front-squat|T1|solo'));
  for (const x of s.sessions) x.durationMin = 50;
  ok(!L.paceFor(s).perSet.has('ex-front-squat|T1|solo') && !L.paceFor(s).bursty, 'typed lengths teach nothing and ask nothing');
  const w = L.weekBounds(s, s.sessions[0].firstSetAt).start;
  const inWeek = s.sessions.filter(x => x.firstSetAt >= w && x.firstSetAt < w + 7 * DAY).length;
  eq(R.weekReview(s, w).totals.minutes, 50 * inWeek);
});

test('recovery: the day after a lower-body day, lower strength goals wait and upper ones come first', () => {
  const s = seed(); s.settings.onboarded = true;
  s.settings.weekStartDay = new Date().getDay(); // a full week left
  s.locations.push({ id: 'loc-all', name: 'All', equipment: [...s.equipment] });
  const c = ci({ locationId: 'loc-all', fatigue: 2 });
  const score = (st, id, cc = c) => L.scoreSlots(st, cc).find(x => x.slot.id === id);
  const before = { squat: score(s, 'sl-t1-squat').score, vpull: score(s, 'sl-t1-vpull').score, hams: score(s, 'sl-t2-hams').score, incline: score(s, 'sl-t2-incline').score };
  // Yesterday: heavy single-leg squats and moderate hip thrusts.
  done(s, 'ex-front-squat', 'T1', 3, 5, 1, 160, 'y1');
  const ht = s.exercises.find(e => /hip thrust/i.test(e.name));
  done(s, ht.id, 'T2', 10, 3, 1, 205, 'y2');
  // (the sessions are this week, so make sure the squat goal still has its quota open)
  s.slots.find(sl => sl.id === 'sl-t1-squat').quota = 2;
  eq([...L.recentLoadedRegions(s)], [['lower', 'heavy']]);
  const sq = score(s, 'sl-t1-squat'), vp = score(s, 'sl-t1-vpull'), hm = score(s, 'sl-t2-hams'), inc = score(s, 'sl-t2-incline');
  ok(sq.why.some(w => /heavy lower work since yesterday ×0.35/.test(w)), sq.why.join(' | '));
  ok(hm.why.some(w => /×0.5/.test(w)) && hm.score < before.hams, hm.why.join(' | '));
  ok(vp.score > before.vpull && inc.score > before.incline, 'upper goals a little higher');
  ok(vp.score > sq.score, `T1 pull-up ${vp.score} before T1 squat ${sq.score}`);
  ok(inc.score > hm.score, 'T2 incline before T2 deficit RDL');
  // Explosive work keeps its own rule (it becomes technique), and moderate-only work is a smaller step.
  const m = seed(); m.settings.weekStartDay = s.settings.weekStartDay; m.locations.push(s.locations.at(-1));
  done(m, ht.id, 'T2', 10, 3, 1, 205, 'y2');
  eq([...L.recentLoadedRegions(m)], [['lower', 'moderate']]);
  ok(score(m, 'sl-t1-squat').why.some(w => /moderate lower work since yesterday ×0.6/.test(w)));
  // The switch turns it off, and the last day of the week ignores it.
  s.settings.recovery.t1AfterT1 = false;
  ok(!score(s, 'sl-t1-squat').why.some(w => /since yesterday/.test(w)));
  s.settings.recovery.t1AfterT1 = true;
  s.settings.weekStartDay = (new Date().getDay() + 1) % 7;
  ok(!score(s, 'sl-t1-squat').why.some(w => /since yesterday/.test(w)), 'last day: now or never');
});

test('several locations: their gear together, each exercise done where its gear is, supersets kept in one place', () => {
  const s = seed(); s.settings.onboarded = true;
  const both = { ...ci({ fatigue: 2 }), locationId: 'loc-basement', locationIds: ['loc-basement', 'loc-office'] };
  const place = L.placeOf(s, both);
  eq([place.id, place.name, place.parts.length], ['loc-basement', 'Basement + Office', 2]);
  eq(L.placeOf(s, { locationId: 'loc-office' }).name, 'Office', 'one location: itself');
  const wpull = L.byId(s.exercises, 'ex-wpullup'), squat = L.byId(s.exercises, 'ex-front-squat');
  ok(L.isAvailable(wpull, place) && L.isAvailable(squat, place));
  eq([L.elsewhere(wpull, place)?.name, L.elsewhere(squat, place)], ['Office', null]);
  // Gear split across places doesn't add up: barbell (basement) and rings (office) aren't in one spot.
  ok(!L.isAvailable({ equipment: ['barbell', 'rings'] }, place));
  // The lower day yesterday: with the office in reach, the upper T1 goal comes first.
  s.settings.weekStartDay = new Date().getDay();
  done(s, 'ex-front-squat', 'T1', 3, 5, 1, 160, 'y1');
  s.slots.find(sl => sl.id === 'sl-t1-squat').quota = 2;
  const basementOnly = L.buildSuggestion(s, ci({ fatigue: 2 })).blocks.find(b => b.tier === 'T1');
  const r = L.buildSuggestion(s, both);
  const t1 = r.blocks.find(b => b.tier === 'T1');
  ok(t1 && L.byId(s.exercises, t1.exerciseId).familyId === 'fam-vpull', `T1 ${t1 && L.byId(s.exercises, t1.exerciseId).name}`);
  ok(!basementOnly || L.byId(s.exercises, basementOnly.exerciseId).familyId !== 'fam-vpull', 'the basement alone has no pull-up bar');
  // Every superset can be done in one of the two places.
  for (const b of r.blocks.filter(x => x.pairOf)) {
    const a = L.byId(s.exercises, b.exerciseId), lead = L.byId(s.exercises, L.byId(r.blocks, b.pairOf).exerciseId);
    ok(place.parts.some(p => L.isAvailable(a, p) && L.isAvailable(lead, p)), `${lead.name} + ${a.name}`);
  }
});

test('skip a category today: no goal, library pick, superset idea or jump from it', () => {
  const s = seed(); s.settings.onboarded = true;
  for (const fam of ['fam-squat', 'fam-hams', 'fam-arms', 'fam-jumps']) {
    const c = ci({ minutes: 90, fatigue: 1, jumps: true, skip: [fam], locationIds: ['loc-basement', 'loc-office'] });
    ok(!L.scoreSlots(s, c).some(x => x.slot.familyId === fam), `${fam}: goal`);
    for (const r of [L.buildSuggestion(s, c), L.buildFocus(s, c, { region: 'lower', explosive: true }), L.buildMix(s, c, { T1: 1, T2: 2, T3: 6 })]) {
      ok(!r.blocks.some(b => L.byId(s.exercises, b.exerciseId).familyId === fam), `${fam}: ${r.blocks.map(b => L.byId(s.exercises, b.exerciseId).name).join(', ')}`);
    }
    const idea = L.suggestPair(s, c, L.byId(s.exercises, 'ex-front-squat'));
    ok(!idea || idea.exercise.familyId !== fam, `${fam}: superset idea`);
  }
});

// ---------- conditioning (the COND tier) ----------
test('conditioning: the upgrade adds the bike, its EMOMs and a goal once; schemes count calories', () => {
  const old = seed(); old.version = 22;
  old.tiers = { ...old.tiers }; delete old.tiers.COND;
  old.families = old.families.filter(f => f.id !== 'fam-cond'); old.exercises = old.exercises.filter(e => e.id !== 'ex-assault-bike');
  old.schemes = old.schemes.filter(sc => !sc.tiers.includes('COND')); old.slots = old.slots.filter(sl => sl.tier !== 'COND');
  for (const l of old.locations) l.equipment = l.equipment.filter(q => q !== 'assault-bike');
  const m = migrate(old);
  eq(m.version, 24);
  ok(m.tiers.COND.repMin === 90 && m.families.some(f => f.id === 'fam-cond') && L.byId(m.exercises, 'ex-assault-bike').repUnit === 'cal');
  eq(m.schemes.filter(sc => sc.tiers.includes('COND')).length, 6);
  eq(m.slots.filter(sl => sl.tier === 'COND').map(sl => sl.quota), [1]);
  ok(m.locations.find(l => l.id === 'loc-basement').equipment.includes('assault-bike') && !m.locations.find(l => l.id === 'loc-office').equipment.includes('assault-bike'));
  m.version = 22; const again = migrate(m);
  eq([again.slots.filter(sl => sl.tier === 'COND').length, again.schemes.filter(sc => sc.tiers.includes('COND')).length], [1, 6], 'twice adds nothing more');
  const ladder = L.byId(m.schemes, 's-c-ladder10');
  eq([L.schemeReps(ladder), L.schemeReps(L.byId(m.schemes, 's-c-emom10x12'))], [95, 120]);
});

test('conditioning: only when you turn it on; then one EMOM, done last, in the time; not where there is no bike', () => {
  const s = seed(); s.settings.onboarded = true;
  for (const m of [30, 45, 60, 90]) {
    const off = L.buildSuggestion(s, ci({ minutes: m }));
    ok(!off.blocks.some(b => b.tier === 'COND'), `${m} off`);
    ok(off.scored.some(c => c.slot.tier === 'COND' && /conditioning is off/.test(c.note)), 'the note says why');
    const r = L.buildSuggestion(s, ci({ minutes: m, cond: true }));
    const c = r.blocks.filter(b => b.tier === 'COND');
    eq(c.length, 1, `${m} on`);
    eq(r.blocks.at(-1).tier, 'COND', 'done last');
    ok(L.blocksMinutes(s, r.blocks, 'loc-basement') <= m + 1e-9, `${m}: ${L.blocksMinutes(s, r.blocks, 'loc-basement')}`);
    ok(L.byId(s.schemes, c[0].schemeId).emom > 0);
  }
  const office = L.buildSuggestion(s, ci({ locationId: 'loc-office', minutes: 45, cond: true }));
  ok(!office.blocks.some(b => b.tier === 'COND'), 'no bike at the office');
  // The goal met already this week: turned on, it's still added (from the library).
  const met = seed();
  for (let i = 0; i < 10; i++) met.sets.push({ id: `c${i}`, sessionId: 'c', blockId: 'cb', exerciseId: 'ex-assault-bike', tier: 'COND', reps: 12, done: true, loggedAt: L.weekBounds(met).start + 3600e3 + i * 6e4 });
  ok(L.creditWeek(met).slots.get('sl-cond-bike').filled === 1, '10 × 12 cal counts toward the goal');
  ok(L.buildSuggestion(met, ci({ minutes: 45, cond: true })).blocks.some(b => b.tier === 'COND'));
  // Focused workouts and the mix take it too.
  ok(L.buildFocus(s, ci({ minutes: 60, cond: true }), { region: 'upper' }).blocks.some(b => b.tier === 'COND'));
  ok(L.buildMix(s, ci({ minutes: 60, cond: true }), { T1: 1, T2: 1, T3: 2 }).blocks.some(b => b.tier === 'COND'));
});

test('conditioning: fewer calories on a tired or easy day, more on a fresh or sweat day', () => {
  const s = seed();
  const bike = L.byId(s.exercises, 'ex-assault-bike');
  const pick = c => L.schemeReps(L.pickScheme(s, 'COND', bike, 25, c, s.tiers.COND));
  ok(pick(ci({ fatigue: 5 })) < pick(ci({ fatigue: 1 })), `${pick(ci({ fatigue: 5 }))} vs ${pick(ci({ fatigue: 1 }))}`);
  ok(pick(ci({ fatigue: 2, intent: 'easy' })) < pick(ci({ fatigue: 2, intent: 'sweat' })));
  ok(L.pickScheme(s, 'COND', bike, 10, ci(), s.tiers.COND).minutes <= 10, 'fits the time');
});

test('conditioning is never a superset idea, however much you use the bike', () => {
  const s = seed();
  // Lots of bike lately, and you love it.
  for (let i = 0; i < 30; i++) s.sets.push({ id: `bk${i}`, sessionId: `bk${i % 5}`, blockId: 'bk', exerciseId: 'ex-assault-bike', tier: 'COND', reps: 15, done: true, loggedAt: Date.now() - (i % 5 + 1) * DAY });
  L.byId(s.exercises, 'ex-assault-bike').pref = 'fav';
  const c = ci({ minutes: 60, cond: true });
  for (const m of s.exercises.filter(e => !e.archived)) ok(L.suggestPair(s, c, m)?.exercise.id !== 'ex-assault-bike', m.name);
  for (const minutes of [30, 45, 60, 90]) {
    const r = L.buildSuggestion(s, ci({ minutes, cond: true }));
    const b = r.blocks.find(x => x.exerciseId === 'ex-assault-bike');
    ok(b && b.tier === 'COND' && !b.pairOf && !r.blocks.some(x => x.pairOf === b.id), `${minutes}`);
  }
});

test('v24: bike sets added by hand at T3 move to conditioning and count toward its goal', () => {
  const s = seed(); s.version = 23;
  const at = L.weekBounds(s).start + 3600e3;
  s.sessions.push({ id: 'am', status: 'done', source: 'custom', locationId: 'loc-basement', firstSetAt: at, checkinAt: at, blocks: [{ id: 'bb', tier: 'T3', slotId: null, exerciseId: 'ex-assault-bike', schemeId: 's-t3-3x15', swaps: [] }] });
  for (let i = 0; i < 10; i++) s.sets.push({ id: `am${i}`, sessionId: 'am', blockId: 'bb', exerciseId: 'ex-assault-bike', tier: 'T3', reps: 12, done: true, loggedAt: at + i * 6e4 });
  ok(L.creditWeek(s).slots.get('sl-cond-bike').filled === 0, 'before: not counted');
  const m = migrate(s);
  ok(m.sets.filter(x => x.sessionId === 'am').every(x => x.tier === 'COND') && m.sessions.find(x => x.id === 'am').blocks[0].tier === 'COND');
  eq(m.sessions.find(x => x.id === 'am').blocks[0].slotId, 'sl-cond-bike');
  eq(L.creditWeek(m).slots.get('sl-cond-bike').filled, 1, 'after: 120 cal counts');
  ok(L.isConditioning(m, L.byId(m.exercises, 'ex-assault-bike')) && !L.isConditioning(m, L.byId(m.exercises, 'ex-db-curl')));
});

test('conditioning counts at 90 calories or 8 rounds: an EMOM 10 at 8 cal counts, a 5-round superset alone does not', () => {
  const s = seed();
  const at = L.weekBounds(s).start + 3600e3;
  const log = (n, cal, day) => { for (let i = 0; i < n; i++) s.sets.push({ id: L.uid(), sessionId: `d${day}`, blockId: `d${day}`, exerciseId: 'ex-assault-bike', tier: 'COND', reps: cal, done: true, loggedAt: at + day * DAY + i * 6e4 }); };
  log(5, 8, 0); // a T1 superset: 40 cal, 5 rounds
  eq(L.creditWeek(s).slots.get('sl-cond-bike').filled, 0);
  log(10, 8, 1); // EMOM 10 · 8 cal: 80 cal, 10 rounds
  eq(L.creditWeek(s).slots.get('sl-cond-bike').filled, 1);
  const old = seed(); old.version = 23; delete old.tiers.COND.setMin;
  eq(migrate(old).tiers.COND.setMin, 8);
});

// ---------- personal records ----------
test('PRs: heaviest load, most reps at a load or more, best estimated max; holds and reps-only work; never the first time', () => {
  const s = seed();
  let t = Date.now() - 30 * DAY;
  const log = (exerciseId, load, reps, extra = {}) => { const x = { id: L.uid(), sessionId: 'p', blockId: 'p', exerciseId, tier: 'T2', load, reps, done: true, loggedAt: (t += 6e4), ...extra }; s.sets.push(x); return x; };
  const first = log('ex-back-squat', 225, 6);
  eq(L.setPR(s, first), null, 'first time');
  log('ex-back-squat', 235, 3);
  const eight = log('ex-back-squat', 225, 8);
  eq(L.setPR(s, eight), { kind: 'reps', text: 'Rep PR: 8 at 225 lb (best was 6)' });
  eq(L.setPR(s, log('ex-back-squat', 225, 8)), null, 'tying it is not a record');
  eq(L.setPR(s, log('ex-back-squat', 245, 1)).kind, 'weight');
  eq(L.setPR(s, s.sets.at(-1)).text, 'Weight PR: 245 lb (best was 235 lb)');
  eq(L.setPR(s, log('ex-back-squat', 230, 7)).text, 'Rep PR: 7 at 230 lb (best was 3)', 'at 230 or more, only 235 × 3 and 245 × 1 came before');
  eq(L.setPR(s, log('ex-back-squat', 200, 12)).kind, 'reps', 'most reps at 200 or more');
  ok(!L.setPR(s, log('ex-back-squat', 135, 5, { warmup: true })), 'warm-ups never');
  // Reps-only and holds.
  log('ex-ring-dip', null, 10);
  eq(L.setPR(s, log('ex-ring-dip', null, 12)).text, 'Rep PR: 12 in a set (best was 10)');
  log('ex-sorensen', null, null, { time: 60 });
  eq(L.setPR(s, log('ex-sorensen', null, null, { time: 75 })).text, 'Hold PR: 75s (best was 60s)');
  // Looking back in History: only what came before counts.
  eq(L.setPR(s, eight).kind, 'reps', 'later sets don\'t take a record away');
});

test('leaning upper: lower-body T1/T2 goals wait, unless the week runs out first', () => {
  const s = seed(); s.settings.onboarded = true;
  // Your goals: T1 Z press, T2 front squat, T2 cleans; upper-body pump work.
  s.slots = [
    { id: 'z', familyId: 'fam-ohp', exerciseId: 'gs-z-press', tier: 'T1', quota: 1, priority: 3 },
    { id: 'fs', familyId: 'fam-squat', exerciseId: 'ex-front-squat', tier: 'T2', quota: 1, priority: 2 },
    { id: 'cl', familyId: 'fam-clean', tier: 'T2', quota: 3, priority: 2 },
    { id: 'ub', familyId: 'fam-upperback', tier: 'T3', quota: 2, priority: 1 },
    { id: 'ar', familyId: 'fam-arms', tier: 'T3', quota: 2, priority: 1 },
  ];
  s.settings.weekStartDay = (new Date().getDay() + 3) % 7; // three days left
  const c = ci({ minutes: 30, fatigue: 5, lean: 'upper' }); // wrecked
  const names = r => r.blocks.map(b => L.byId(s.exercises, b.exerciseId).name);
  const r = L.buildSuggestion(s, c);
  ok(!r.blocks.some(b => b.exerciseId === 'ex-front-squat'), names(r).join(', '));
  ok(r.blocks.some(b => b.exerciseId === 'gs-z-press'), 'Z press stays');
  ok(r.scored.some(x => x.slot.id === 'fs' && /leaning upper: lower-body strength work waits \(3 days left\)/.test(x.note)));
  ok(r.blocks.every(b => b.tier === 'T1' || b.tier === 'T3' || b.tier === 'TECH'), `the rest is T3 (or technique): ${names(r).join(', ')}`);
  // Either way: it can come in.
  ok(!L.buildSuggestion(s, { ...c, lean: 'either' }).scored.some(x => /leaning/.test(x.note || '')));
  // The last day of the week: now or not this week, so it isn't held back.
  s.settings.weekStartDay = (new Date().getDay() + 1) % 7;
  ok(!L.buildSuggestion(s, c).scored.some(x => x.slot.id === 'fs' && /leaning/.test(x.note || '')), 'last day');
});

test('Regenerate takes open goals of a tier in turn: power clean, then snatch', () => {
  const s = seed(); s.settings.onboarded = true;
  const sn = s.families.find(f => /snatch/i.test(f.name)).id;
  s.slots = [
    { id: 'z', familyId: 'fam-ohp', exerciseId: 'gs-z-press', tier: 'T1', quota: 1, priority: 3 },
    { id: 'cl', familyId: 'fam-clean', tier: 'T2', quota: 3, priority: 2 },
    { id: 'sn', familyId: sn, tier: 'T2', quota: 1, priority: 2 },
  ];
  s.settings.weekStartDay = (new Date().getDay() + 3) % 7;
  const fam = v => L.buildSuggestion(s, ci({ minutes: 30, fatigue: 3, lean: 'upper', variant: v })).blocks.filter(b => b.tier === 'T2').map(b => L.byId(s.exercises, b.exerciseId).familyId);
  eq(fam(0), ['fam-clean']);
  eq(fam(1), [sn]);
  eq(fam(2), ['fam-clean']);
});

await queue;
const fails = results.filter(r => r[0] === 'FAIL').length;
document.getElementById('summary').textContent = `${results.length - fails} passed, ${fails} failed`;
document.title = fails ? 'FAIL' : 'PASS';
document.getElementById('out').innerHTML = results.map(([k, n]) => `<div class="${k}">${k}  ${n.replace(/</g, '&lt;')}</div>`).join('');
