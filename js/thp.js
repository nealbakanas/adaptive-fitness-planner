// The THP-style jump plan (docs/vertical-jump-thp-review.md): four saved plans you start from the Plans tab, and a daily
// isometrics routine. Nothing here changes suggestions: the plans are ordinary saved plans, and the one exercise it adds
// (max approach jumps) is `planOnly`, so automatic picks never choose it.

export const THP_GROUP = 'THP-style jump plan';
export const THP_ABOUT = 'After Isaiah Rivera and John Evans (THP Strength). High days Mon/Wed with heavy cleans and squats, '
  + 'each set paired with 2–4 jumps; easy general days Tue/Thu (bike goes here); one fresh jump day at the end of the week. '
  + 'Isometric holds every day. Load 3 weeks, then deload a week. Stop a session at 3/10 pain.';

// Strength exercise the plans need that the library doesn't have.
export const THP_EXERCISES = [
  { id: 'ex-approach-jump', name: 'Max approach jump', familyId: 'fam-jumps', rank: 7, metric: 'reps', equipment: [], anytime: false,
    region: 'lower', explosive: true, bodyweight: false, youtube: '', start: null, cues: 'Full approach, max intent. Log your best touch in the note.',
    startMax: null, testedMax: null, maxReps: 5, restSec: 90, role: 'power', planOnly: true },
];

// Isometric holds (mobility exercises: their own sessions, outside the weekly goals).
const iso = (id, name, parts, cues, notes) => ({
  id, name, parts, sets: 3, reps: null, repsMax: null, hold: 45, holdMax: null, perSide: false, tempo: '', restSec: 60,
  track: { reps: false, hold: true, load: true, extra: '' }, cues, video: '', notes, archived: false,
});
export const THP_MOBILITY = [
  iso('mob-spanish-squat-hold', 'Spanish squat hold', ['Quads & knees'],
    'Band behind the knees, sit back to about 60–90° of knee bend, shins vertical. About 70% effort: a slight burn, no shaking, no pain.',
    'For the patellar tendon. THP does these daily, before sessions.'),
  iso('mob-calf-iso-hold', 'Calf raise hold', ['Calves & ankles'],
    'Hold a calf raise at mid-range (not fully stretched). About 70% effort, add load as it gets easy.',
    'For the Achilles. Daily.'),
];
export const THP_ROUTINE = { id: 'mobr-thp-isos', name: 'THP daily isos', items: ['mob-spanish-squat-hold', 'mob-calf-iso-hold'] };

const it = (exerciseId, tier, schemeId) => ({ exerciseId, tier, schemeId });
export const THP_PLANS = [
  { id: 'plan-thp-high-a', name: 'THP · High day A (Mon)', group: THP_GROUP,
    note: 'Isos and a full warm-up first. Clean from blocks if you can. Between clean sets: 2–3 broad jumps. Squat: pause doubles at 70–85%, then work up to one single at 88–95% (strength block).',
    items: [it('ex-power-clean', 'T1', 's-t1-6x2'), it('ex-broad-jump', 'JUMP', 's-j-4x3'), it('ex-back-squat', 'T1', 's-t1-5x3'), it('ex-hip-thrust', 'T2', 's-t2-4x6')] },
  { id: 'plan-thp-high-b', name: 'THP · High day B (Wed)', group: THP_GROUP,
    note: 'Isos and a full warm-up first. Jump squats light and fast. Between single-leg squat sets: 4 jump lunges. Calves heavy and slow (3 s down, pause at the bottom).',
    items: [it('ex-jump-squat', 'JUMP', 's-j-4x3'), it('gs-barbell-single-leg-squat', 'T1', 's-t1-5x3'), it('ex-jump-lunge', 'JUMP', 's-j-4x5'),
      it('gs-romanian-deadlift', 'T2', 's-t2-4x6'), it('ex-calf-raise', 'T3', 's-t3-4x8')] },
  { id: 'plan-thp-general', name: 'THP · General day (Tue/Thu)', group: THP_GROUP,
    note: 'Easy day: slow, controlled reps, nothing to failure. Conditioning belongs here, not on high days. Add upper body as you like.',
    items: [it('ex-bss', 'T3', 's-t3-3x15'), it('ex-nordic', 'T3', 's-t3-6x5'), it('ex-calf-raise', 'T3', 's-t3-3x15'), it('ex-assault-bike', 'COND', 's-c-emom10x12')] },
  { id: 'plan-thp-jump', name: 'THP · Jump day (Fri/Sat)', group: THP_GROUP,
    note: 'Fresh, after an easy day. Isos, jump flexibility (10 hinges, squats, lunges, leg swings), then 20–30 min of build-up jumps, raising effort by at most 10–20% per jump while pain-free. Then max-effort jumps for 5 min, adding 5 min a week up to about 20. Stop at 3/10 pain. Log your best touch.',
    items: [it('ex-approach-jump', 'JUMP', 's-j-4x5')] },
];

// Adds what's missing (never twice, never over your own edits). Returns whether anything was added.
export function addThpPlan(s) {
  let added = false;
  for (const e of THP_EXERCISES) {
    if (!s.exercises.some(x => x.id === e.id) && s.families.some(f => f.id === e.familyId)) { s.exercises.push({ ...e, equipment: [...e.equipment] }); added = true; }
  }
  s.mobility ??= { exercises: [], routines: [], sessions: [] };
  for (const m of THP_MOBILITY) if (!s.mobility.exercises.some(x => x.id === m.id)) { s.mobility.exercises.push(structuredClone(m)); added = true; }
  if (!s.mobility.routines.some(r => r.id === THP_ROUTINE.id)) { s.mobility.routines.push({ ...THP_ROUTINE, items: [...THP_ROUTINE.items] }); added = true; }
  s.plans ??= [];
  for (const p of THP_PLANS) {
    if (s.plans.some(x => x.id === p.id)) continue;
    // Only exercises and schemes this data has (a library you've trimmed keeps working).
    const items = p.items.filter(i => s.exercises.some(e => e.id === i.exerciseId) && s.schemes.some(sc => sc.id === i.schemeId)).map(i => ({ ...i }));
    if (items.length) { s.plans.push({ ...p, items }); added = true; }
  }
  return added;
}
