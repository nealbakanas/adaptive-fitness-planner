// Seed data: real lifts from the PRD plus placeholder T3 work. Everything is editable in-app.

import { mobilitySeed } from './mobility.js';

export const EQUIPMENT = [
  'barbell', 'rack', 'bench', 'dumbbells', 'kettlebell',
  'dip-belt', 'pullup-bar', 'rings', 'dip-station', 'bands', 'ab-wheel', 'box',
  'hyper-pro', 'leg-developer', // Freak Athlete Hyper Pro and its leg extension / leg curl attachment
];

// Movements that need the Hyper Pro itself (a back extension, GHR or leg curl can't be done without it).
export const HYPER_PRO_ONLY = ['ex-back-ext', 'ex-back-ext-90', 'ex-reverse-hyper', 'ex-ghr', 'ex-ghd-situp', 'ex-sorensen',
  'ex-belt-squat', 'ex-leg-ext', 'ex-seated-legcurl', 'ex-lying-legcurl'];

// Gear that doesn't need a gym session: an exercise using only these can be done in a spare few minutes.
export const ANYTIME_GEAR = ['pullup-bar', 'rings', 'bands', 'ab-wheel'];
export const defaultAnytime = (equipment, bodyweight = false) => !bodyweight && equipment.every(eq => ANYTIME_GEAR.includes(eq));

// Region matters for explosive work: heavy work in a region makes explosive work there technique, not power.
const FAMILY_REGION = { 'fam-squat': 'lower', 'fam-vpull': 'upper', 'fam-dip': 'upper', 'fam-clean': 'full', 'fam-incline': 'upper',
  'fam-upperback': 'upper', 'fam-arms': 'upper', 'fam-core': 'full', 'fam-jumps': 'lower',
  'fam-hams': 'lower', 'fam-hinge': 'lower', 'fam-quads': 'lower', 'fam-calves': 'lower' };
const EXPLOSIVE_FAMILIES = ['fam-clean', 'fam-jumps'];

function ex(id, name, familyId, rank, metric, equipment, opts = {}) {
  return {
    id, name, familyId, rank, metric, equipment,
    anytime: defaultAnytime(equipment, !!opts.bodyweight),
    region: FAMILY_REGION[familyId] ?? 'full', explosive: EXPLOSIVE_FAMILIES.includes(familyId),
    bodyweight: false, youtube: '', start: null, cues: '', startMax: null, maxReps: null, restSec: null,
    ...opts,
  };
}

export function seed() {
  const families = [
    { id: 'fam-squat', name: 'Squat pattern', defaultExerciseId: 'ex-back-squat' },
    { id: 'fam-vpull', name: 'Vertical pull', defaultExerciseId: 'ex-wpullup' },
    { id: 'fam-dip', name: 'Dip', defaultExerciseId: 'ex-wdip' },
    { id: 'fam-clean', name: 'Clean variations', defaultExerciseId: 'ex-power-clean' },
    { id: 'fam-incline', name: 'Incline press', defaultExerciseId: 'ex-incline-bench' },
    { id: 'fam-upperback', name: 'Upper back (pump)', defaultExerciseId: 'ex-ring-facepull' },
    { id: 'fam-arms', name: 'Arms (pump)', defaultExerciseId: 'ex-db-curl' },
    { id: 'fam-core', name: 'Core', defaultExerciseId: 'ex-hanging-knee' },
    { id: 'fam-jumps', name: 'Jumps', defaultExerciseId: 'ex-broad-jump' },
    { id: 'fam-hams', name: 'Hamstrings', defaultExerciseId: 'ex-nordic' },
    { id: 'fam-hinge', name: 'Hinge', defaultExerciseId: 'ex-back-ext' },
    { id: 'fam-quads', name: 'Quads', defaultExerciseId: 'ex-leg-ext' },
    { id: 'fam-calves', name: 'Calves', defaultExerciseId: 'ex-calf-raise' },
  ];

  // Rank runs harder (1) to easier within each family.
  const exercises = [
    ex('ex-back-squat', 'Back squat', 'fam-squat', 1, 'load_reps', ['barbell', 'rack']),
    ex('ex-front-squat', 'Front squat', 'fam-squat', 2, 'load_reps', ['barbell', 'rack']),
    ex('ex-bss', 'Bulgarian split squat', 'fam-squat', 3, 'load_reps', ['dumbbells', 'bench']),
    ex('ex-goblet', 'Goblet squat', 'fam-squat', 4, 'load_reps', ['kettlebell']),
    ex('ex-pistol', 'Pistol squat', 'fam-squat', 5, 'reps', []),
    ex('ex-air-squat', 'Air squat', 'fam-squat', 6, 'reps', []),

    ex('ex-wpullup', 'Weighted pull-up', 'fam-vpull', 1, 'load_reps', ['pullup-bar', 'dip-belt'], { bodyweight: true }),
    ex('ex-wchinup', 'Weighted chin-up', 'fam-vpull', 2, 'load_reps', ['pullup-bar', 'dip-belt'], { bodyweight: true }),
    ex('ex-pullup', 'Pull-up', 'fam-vpull', 3, 'reps', ['pullup-bar']),
    ex('ex-chinup', 'Chin-up', 'fam-vpull', 4, 'reps', ['pullup-bar']),
    ex('ex-ring-row', 'Ring row', 'fam-vpull', 5, 'reps', ['rings']),

    ex('ex-wdip', 'Weighted dip', 'fam-dip', 1, 'load_reps', ['dip-station', 'dip-belt'], { bodyweight: true }),
    ex('ex-wring-dip', 'Weighted ring dip', 'fam-dip', 1.5, 'load_reps', ['rings', 'dip-belt'], { bodyweight: true }),
    ex('ex-ring-dip', 'Ring dip', 'fam-dip', 2, 'reps', ['rings']),
    ex('ex-bar-dip', 'Bar dip', 'fam-dip', 3, 'reps', ['dip-station']),
    ex('ex-pushup', 'Push-up', 'fam-dip', 4, 'reps', []),

    ex('ex-power-clean', 'Power clean', 'fam-clean', 1, 'load_reps', ['barbell'], { maxReps: 5 }),
    ex('ex-hang-clean', 'Hang clean', 'fam-clean', 2, 'load_reps', ['barbell'], { maxReps: 5 }),
    ex('ex-hang-power-clean', 'Hang power clean', 'fam-clean', 3, 'load_reps', ['barbell'], { maxReps: 5 }),
    ex('ex-clean-pull', 'Clean pull', 'fam-clean', 4, 'load_reps', ['barbell'], { maxReps: 6 }),
    ex('ex-db-hang-clean', 'DB hang power clean', 'fam-clean', 5, 'load_reps', ['dumbbells'], { maxReps: 5 }),

    ex('ex-incline-bench', 'Incline bench press', 'fam-incline', 1, 'load_reps', ['barbell', 'bench', 'rack']),
    ex('ex-incline-db', 'Incline DB press', 'fam-incline', 2, 'load_reps', ['dumbbells', 'bench']),
    ex('ex-ring-pushup', 'Ring push-up', 'fam-incline', 3, 'reps', ['rings']),
    ex('ex-fe-pushup', 'Feet-elevated push-up', 'fam-incline', 4, 'reps', []),

    ex('ex-ring-facepull', 'Ring face pull', 'fam-upperback', 1, 'reps', ['rings']),
    ex('ex-db-reardelt', 'DB rear-delt fly', 'fam-upperback', 2, 'load_reps', ['dumbbells']),
    ex('ex-band-pullapart', 'Band pull-apart', 'fam-upperback', 3, 'reps', ['bands']),

    ex('ex-db-curl', 'DB curl', 'fam-arms', 1, 'load_reps', ['dumbbells']),
    ex('ex-db-oh-tri', 'DB overhead triceps extension', 'fam-arms', 2, 'load_reps', ['dumbbells']),
    ex('ex-ring-curl', 'Ring curl', 'fam-arms', 3, 'reps', ['rings']),
    ex('ex-ring-tri', 'Ring triceps extension', 'fam-arms', 4, 'reps', ['rings']),

    ex('ex-hanging-leg', 'Hanging leg raise', 'fam-core', 1, 'reps', ['pullup-bar']),
    ex('ex-ab-wheel', 'Ab wheel rollout', 'fam-core', 2, 'reps', ['ab-wheel']),
    ex('ex-ring-rollout', 'Ring rollout', 'fam-core', 2, 'reps', ['rings']),
    ex('ex-hanging-knee', 'Hanging knee raise', 'fam-core', 3, 'reps', ['pullup-bar']),
    ex('ex-dead-bug', 'Dead bug', 'fam-core', 4, 'reps', []),

    ex('ex-depth-jump', 'Depth jump', 'fam-jumps', 1, 'reps', ['box'], { maxReps: 5 }),
    ex('ex-box-jump', 'Box jump', 'fam-jumps', 2, 'reps', ['box'], { maxReps: 5 }),
    ex('ex-broad-jump', 'Broad jump', 'fam-jumps', 3, 'reps', [], { maxReps: 5 }),
    ex('ex-jump-squat', 'Jump squat', 'fam-jumps', 4, 'reps', [], { maxReps: 8 }),
    ex('ex-skater-jump', 'Skater jump', 'fam-jumps', 5, 'reps', [], { maxReps: 8 }),
    ex('ex-jump-lunge', 'Jump lunge', 'fam-jumps', 6, 'reps', [], { maxReps: 10 }),

    // Freak Athlete Hyper Pro (with the GHD pad) and the Leg Developer attachment: accessory (T3) work.
    ex('ex-nordic', 'Nordic curl', 'fam-hams', 1, 'reps', ['hyper-pro']),
    ex('ex-ghr', 'Glute-ham raise', 'fam-hams', 2, 'reps', ['hyper-pro']),
    ex('ex-seated-legcurl', 'Seated leg curl', 'fam-hams', 3, 'load_reps', ['hyper-pro', 'leg-developer']),
    ex('ex-lying-legcurl', 'Lying leg curl', 'fam-hams', 4, 'load_reps', ['hyper-pro', 'leg-developer']),
    ex('ex-back-ext-90', '90° back extension', 'fam-hinge', 1, 'load_reps', ['hyper-pro']),
    ex('ex-back-ext', 'Back extension', 'fam-hinge', 2, 'load_reps', ['hyper-pro']),
    ex('ex-reverse-hyper', 'Reverse hyper', 'fam-hinge', 3, 'load_reps', ['hyper-pro']),
    ex('ex-hip-thrust', 'Hip thrust', 'fam-hinge', 4, 'load_reps', ['hyper-pro']),
    ex('ex-sorensen', 'Sorensen hold', 'fam-hinge', 5, 'time', ['hyper-pro']),
    ex('ex-belt-squat', 'Belt squat', 'fam-quads', 1, 'load_reps', ['hyper-pro']),
    ex('ex-leg-ext', 'Leg extension', 'fam-quads', 2, 'load_reps', ['hyper-pro', 'leg-developer']),
    ex('ex-reverse-nordic', 'Reverse Nordic', 'fam-quads', 3, 'reps', ['hyper-pro']),
    ex('ex-calf-raise', 'Calf raise', 'fam-calves', 1, 'load_reps', ['hyper-pro']),
    ex('ex-ghd-situp', 'GHD sit-up', 'fam-core', 5, 'reps', ['hyper-pro']),
    ex('ex-trap3', 'Trap 3 raise', 'fam-upperback', 4, 'load_reps', ['hyper-pro']),
  ];

  const sc = (id, sets, reps, restSec, minutes, tiers) =>
    ({ id, name: `${sets}×${reps}`, sets, reps, restSec, minutes, tiers });

  const schemes = [
    sc('s-t1-3x5', 3, 5, 180, 9, ['T2']),
    sc('s-t1-5x3', 5, 3, 150, 11, ['T1']),
    sc('s-t1-10x2', 10, 2, 60, 12, ['T1']),
    sc('s-t1-6x2', 6, 2, 120, 9, ['T1']),
    sc('s-t1-8x2', 8, 2, 90, 12, ['T1']),
    sc('s-t1-6x3', 6, 3, 120, 13, ['T1']),
    sc('s-t1-5x5', 5, 5, 180, 15, ['T2']),
    sc('s-t1-10x1', 10, 1, 90, 12, ['T1']),
    sc('s-t1-4x3', 4, 3, 150, 10, ['T1']),
    sc('s-t1-8x3', 8, 3, 90, 14, ['T1']),
    sc('s-t2-3x8', 3, 8, 90, 8, ['T2']),
    sc('s-t2-4x6', 4, 6, 90, 10, ['T2']),
    sc('s-t2-6x4', 6, 4, 60, 10, ['T2']),
    sc('s-t2-3x10', 3, 10, 90, 10, ['T2']),
    sc('s-t3-2x25', 2, 25, 60, 5, ['T3']),
    sc('s-t3-3x15', 3, 15, 45, 6, ['T3']),
    sc('s-t3-4x12', 4, 12, 45, 7, ['T3']),
    sc('s-t3-5x10', 5, 10, 30, 7, ['T3']),
    sc('s-t2-4x3', 4, 3, 90, 7, ['T2']),
    sc('s-t2-5x3', 5, 3, 90, 8, ['T2']),
    sc('s-tq-4x2', 4, 2, 60, 6, ['TECH']),
    sc('s-tq-5x2', 5, 2, 60, 7, ['TECH']),
    sc('s-tq-4x3', 4, 3, 60, 7, ['TECH']),
    sc('s-tq-6x2', 6, 2, 60, 8, ['TECH']),
  ];

  const slots = [
    { id: 'sl-t1-squat', familyId: 'fam-squat', tier: 'T1', quota: 1, priority: 3 },
    { id: 'sl-t1-vpull', familyId: 'fam-vpull', tier: 'T1', quota: 1, priority: 3 },
    { id: 'sl-t2-clean', familyId: 'fam-clean', tier: 'T2', quota: 1, priority: 2 },
    { id: 'sl-t2-incline', familyId: 'fam-incline', tier: 'T2', quota: 1, priority: 2 },
    { id: 'sl-t2-dip', familyId: 'fam-dip', tier: 'T2', quota: 1, priority: 2 },
    { id: 'sl-t3-upperback', familyId: 'fam-upperback', tier: 'T3', quota: 2, priority: 1 },
    { id: 'sl-t3-arms', familyId: 'fam-arms', tier: 'T3', quota: 2, priority: 1 },
    { id: 'sl-t3-core', familyId: 'fam-core', tier: 'T3', quota: 2, priority: 1 },
    // Power: jumps count by contacts (reps), so this goal needs fewer reps than a lifting T2.
    { id: 'sl-t2-jumps', familyId: 'fam-jumps', tier: 'T2', quota: 2, priority: 2, repMin: 12, repMax: 20 },
    // Technique: the same explosive lifts practiced when tired or after heavy work. Credits only this goal.
    { id: 'sl-tq-clean', familyId: 'fam-clean', tier: 'TECH', quota: 2, priority: 1 },
  ];

  return {
    version: 9,
    settings: {
      weekStartDay: 1, // Monday
      bodyweight: null,
      unit: 'lb',
      increment: 5,
      kettlebells: [30, 40, 45, 53], // loads for kettlebell exercises snap to these
      recovery: { t1AfterT1: true },
      lastExportAt: null,
      timer: { autoStart: true, sound: true, vibrate: true, warn10: true, keepAwake: true, notify: false },
    },
    locations: [
      { id: 'loc-office', name: 'Office', equipment: ['pullup-bar', 'rings', 'dip-belt', 'kettlebell', 'ab-wheel'] },
      { id: 'loc-basement', name: 'Basement', equipment: [...EQUIPMENT] },
    ],
    tiers: {
      // GZCL: T1 85-100% in sets of 1-3 for 10-15 reps, T2 65-85% in sets of 5-8 for 20-30 reps, T3 10+ reps a set for 30+ total.
      T1: { repMin: 10, repMax: 15, intMin: 0.85, intMax: 1.0 },
      T2: { repMin: 20, repMax: 30, intMin: 0.65, intMax: 0.85 },
      T3: { repMin: 30, repMax: 60, setMin: 3, intMin: null, intMax: null },
      // Technique: quality reps at a light-to-moderate load. The load range is a target, any load counts.
      TECH: { repMin: 8, repMax: 16, intMin: 0.5, intMax: 0.7 },
    },
    equipment: [...EQUIPMENT], // grows as you add gear in the app
    families, exercises, schemes, slots,
    mobility: mobilitySeed(), // separate from strength: { exercises, routines, sessions }
    plans: [],
    sessions: [],
    sets: [],
    timer: null, // running rest timer: { endsAt, total, blockId, setId, next, warned, alerted }
    imports: {}, // history brought in from other apps, e.g. fitnotes: { at, cutoff, map: { fitnotesExerciseId: exerciseId } }
  };
}
