import { state, save, replaceState, resetState, loadProblem, lastSaveError, resolveLoadProblem, onSaveFail, keepCopy, readCopy, hasCopy, dropCopy,
  recover, getRecoveryCopy, useRecoveryCopy, dismissRecoveryCopy, snapshotNow, requestPersist, flushVault, slimHistory } from './store.js';
import * as Vault from './vault.js';
import * as Cloud from './cloud.js';
import * as Taste from './taste.js';
import { MIN_CHANGEOVERS } from './pace.js';
import * as R from './review.js';
import * as I from './interval.js';
import * as THP from './thp.js';
import * as B from './block.js';
import * as Mo from './morning.js';
import * as PG from './progress.js';
import * as CH from './charts.js';
import * as HR from './hr.js';
import * as Sync from './sync.js';
import * as L from './logic.js';
import * as FN from './fitnotes.js';
import * as G from './goals.js';
import * as M from './mobility.js';
import * as P from './programs.js';
import * as O from './onboard.js';

const appEl = document.getElementById('app');
const navEl = document.getElementById('nav');
const sheetEl = document.getElementById('sheet');

const TABS = [['today', 'Today'], ['week', 'Week'], ['timer', 'Timer'], ['library', 'Library'], ['plans', 'Plans'], ['more', 'Settings']];
const INTENTS = [['auto', 'You pick'], ['heavy', 'Heavy'], ['sweat', 'Sweat'], ['easy', 'Easy']];
const LEANS = [['either', 'Either'], ['upper', 'Upper body'], ['lower', 'Lower body']];
const TIMES = [10, 15, 20, 30, 45, 60, 90];
const REASONS = ['Equipment busy', 'Pain / niggle', 'Preference', 'Variety', 'Time'];
const METRICS = [['load_reps', 'Load × reps'], ['reps', 'Reps only'], ['time', 'Time'], ['distance', 'Distance'], ['none', 'None']];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ui = { tab: 'today', ci: defaultCheckin(), sheet: null, plan: null, whyOpen: false, libQuery: '', focus: null, setPage: null, history: null, mix: { T1: 0, T2: 1, T3: 6 }, mixOpen: false };

// ---------- helpers ----------

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const exOf = id => L.byId(state.exercises, id);
const famOf = id => L.byId(state.families, id);
const schOf = id => L.byId(state.schemes, id);
const slotLabel = sl => `${sl.tier} ${exOf(sl.exerciseId)?.name ?? famOf(sl.familyId)?.name ?? '?'}`;
const unit = () => state.settings.unit;
const round = x => Math.round(x);
const opts = (list, sel) => list.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(t)}</option>`).join('');

function defaultCheckin() {
  const last = state.sessions.filter(s => s.source !== 'imported').sort((a, b) => b.checkinAt - a.checkinAt)[0];
  return {
    locationId: last?.locationId ?? state.locations[0]?.id,
    locationIds: (last?.locationIds ?? [last?.locationId ?? state.locations[0]?.id]).filter(id => L.byId(state.locations, id)),
    minutes: last?.minutes ?? 45,
    fatigue: Mo.entryFor(state)?.energy ? 6 - Mo.entryFor(state).energy : 2, sleep: null, intent: 'auto', lean: 'either', split: false, jumps: false, cond: false, condPair: false,
  };
}

function toast(msg, undo = null) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  if (undo) {
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = 'Undo';
    b.onclick = () => { t.remove(); undo(); };
    t.append(' ', b);
  }
  document.body.appendChild(t);
  setTimeout(() => t.remove(), undo ? 5000 : 2200);
}

function currentSession() {
  const today = L.dayKey();
  return state.sessions.filter(s => s.day === today && s.status === 'open').sort((a, b) => b.checkinAt - a.checkinAt)[0];
}

function removeSession(s) {
  state.sets = state.sets.filter(x => x.sessionId !== s.id);
  state.sessions = state.sessions.filter(x => x.id !== s.id);
}

// Close anything left open from a previous day; drop sessions where nothing was logged. A workout you're still doing when
// midnight passes (its last set, check-in or reopening was within LIVE_HOURS) carries on today instead, the way Continue
// does: it stays under its own date in History, and what you log now counts for today. Returns whether anything changed.
const LIVE_HOURS = 4;
const lastActivity = s => state.sets.reduce((m, x) => (x.sessionId === s.id && x.done && x.loggedAt > m ? x.loggedAt : m), Math.max(s.checkinAt ?? 0, s.reopenedAt ?? 0, s.pausedAt ?? 0));
function closeStale() {
  const today = L.dayKey(), now = Date.now();
  let changed = false;
  for (const s of [...state.sessions]) {
    if ((s.status !== 'open' && s.status !== 'paused') || s.day === today) continue;
    if (now - lastActivity(s) < LIVE_HOURS * 3600e3) s.day = today;
    else endSession(s);
    changed = true;
  }
  for (const m of [...state.mobility.sessions]) if (m.status === 'open' && m.day !== today) { endMobility(m); changed = true; }
  return changed;
}
// The day changed while the app was open (it can sit open past midnight): look again at what's still going.
let daySeen = L.dayKey();
function rollDay() {
  const d = L.dayKey();
  if (d === daySeen) return false;
  daySeen = d;
  if (closeStale()) save();
  return true;
}

function endSession(s) {
  const mobDone = (s.mobility || []).some(it => it.sets.some(x => x.done));
  if (state.sets.some(x => x.sessionId === s.id && x.done) || mobDone) {
    s.status = 'done';
    state.sets = state.sets.filter(x => x.sessionId !== s.id || x.done);
    if (s.mobility) s.mobility = trimMobility(s.mobility);
  } else {
    removeSession(s);
  }
}

// A block's working sets. Warm-ups are kept apart: they never count, carry their load forward or start a rest.
const blockSets = b => state.sets.filter(s => s.blockId === b.id && !s.warmup);
const warmSets = b => state.sets.filter(s => s.blockId === b.id && s.warmup);
const canWarm = (b, ex) => (b.tier === 'T1' || b.tier === 'T2') && ex?.metric === 'load_reps';

// Suggested ramp to the first working load, shown as placeholders only: 40/60/80/90% for 5/3/2/1.
const WARM_RAMP = [[0.4, 5], [0.6, 3], [0.8, 2], [0.9, 1]];
function warmHint(b, ex, i) {
  const [pct, reps] = WARM_RAMP[Math.min(i, WARM_RAMP.length - 1)];
  const top = Number(blockSets(b)[0]?.load);
  return { load: top > 0 ? L.snapLoad(state, ex, top * pct) : null, reps };
}

// One logged set as text: "185×5", "BW+45×3", "40s", "100m", "12 reps".
const setAmount = (ex, s) => ex?.metric === 'load_reps' ? `${ex.bodyweight ? 'BW+' : ''}${s.load ?? 0}×${s.reps}`
  : ex?.metric === 'time' ? `${s.time ?? '?'}s` : ex?.metric === 'distance' ? `${s.distance ?? '?'}m` : `${s.reps ?? ''} ${ex?.repUnit ?? 'reps'}`;

// Most recent time logged for a timed exercise, so the next hold starts from it.
function lastTime(exerciseId) {
  let best = null;
  for (const s of state.sets) if (s.done && !s.warmup && s.exerciseId === exerciseId && s.time > 0 && (!best || s.loggedAt > best.loggedAt)) best = s;
  return best ? Number(best.time) : null;
}

// ---------- mobility (its own exercises and sessions; no tiers, goals or maxes) ----------

const mobEx = id => L.byId(state.mobility.exercises, id);
// A logged item's exercise: a program item carries its own (with that week's dose), else the mobility library's.
const itemEx = it => it.def ?? mobEx(it.exerciseId);
const progLabel = m => m.program ? `${P.programDef(m.program.id)?.name ?? 'Program'} · week ${m.program.week}, day ${m.program.day}` : null;
const statusRow = (name, value, hint = '') => `<div class="frow"><span class="grow"><span class="name">${name}</span>${hint ? `<span class="meta">${hint}</span>` : ''}</span><b>${value}</b></div>`;
const fmtDateTime = t => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtMinutesAgo = t => { const m = Math.max(0, Math.round((Date.now() - t) / 6e4)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const fmtAgo = t => { const d = Math.floor((L.startOfDay() - L.startOfDay(t)) / 864e5); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };

function currentMobility() {
  const today = L.dayKey();
  return state.mobility.sessions.filter(m => m.day === today && m.status === 'open').sort((a, b) => b.startedAt - a.startedAt)[0];
}

// Mobility items open right now: in the mobility session or the workout.
function findMobItem(id) {
  for (const list of [currentMobility()?.items, currentSession()?.mobility]) {
    const item = list?.find(x => x.id === id);
    if (item) return { item, list };
  }
  return {};
}

// Keep what was logged; drop unlogged rows and exercises with nothing logged.
function trimMobility(items) {
  for (const it of items) it.sets = it.sets.filter(s => s.done);
  return items.filter(it => it.sets.length);
}

function endMobility(m) {
  m.items = trimMobility(m.items);
  if (m.items.length) {
    m.status = 'done'; m.endedAt = Date.now();
    // A program day with anything logged moves the program on, unless you've moved it yourself since.
    const p = m.program && P.progress(state, m.program.id);
    if (p && p.week === m.program.week && p.day === m.program.day) P.advance(state, m.program.id);
  }
  else state.mobility.sessions = state.mobility.sessions.filter(x => x !== m);
}

function startMobility(items, extra = {}) {
  const m = { id: L.uid(), day: L.dayKey(), startedAt: Date.now(), status: 'open', items, ...extra };
  state.mobility.sessions.push(m);
  ui.showWorkout = false;
  return m;
}

function nextMobLabel(list, item) {
  for (const it of [item, ...list.filter(x => x !== item)]) {
    const i = it.sets.findIndex(s => !s.done);
    if (i >= 0) return `${itemEx(it)?.name ?? ''} · set ${i + 1}`;
  }
  return null;
}

// Supersets and giant sets: a group is a leader block plus the blocks whose pairOf points at it.
// Led by a main lift, the others are done in its rest. Led by a T3, it's a circuit: one set of each, then rest.
function groupOf(s, b) {
  const leader = (b.pairOf && s.blocks.find(x => x.id === b.pairOf)) || b;
  const members = [leader, ...s.blocks.filter(x => x.pairOf === leader.id)];
  return members.length > 1 ? members : [b];
}
const inPair = (s, b) => groupOf(s, b).length > 1;

// Rough time a set takes, so "real rest" is the gap between sets minus the work.
const workSec = st => st.time > 0 ? Number(st.time) : Math.max(5, (Number(st.reps) || 1) * 3);

function restSummary(sets) {
  const m = sets.filter(x => x.done && x.restSec != null);
  if (!m.length) return null;
  const avg = Math.round(m.reduce((t, x) => t + x.restSec, 0) / m.length);
  const plan = Math.round(m.reduce((t, x) => t + (x.restPlan || 0), 0) / m.length);
  return { avg, plan, n: m.length, text: `rest ${clock(avg)} avg (plan ${clock(plan)})` };
}

function newSet(session, block, ex, sc, load) {
  return {
    id: L.uid(), sessionId: session.id, blockId: block.id, exerciseId: ex.id, tier: block.tier, schemeId: sc.id,
    load: ex.metric === 'load_reps' ? load : null,
    reps: ['load_reps', 'reps'].includes(ex.metric) ? sc.reps : null,
    time: ex.metric === 'time' ? lastTime(ex.id) : null, distance: null, done: false,
  };
}

// Regenerate a block's undone sets after an exercise or scheme change; logged sets stay.
function genSets(session, block) {
  const ex = exOf(block.exerciseId), sc = schOf(block.schemeId);
  const warm = canWarm(block, ex);
  state.sets = state.sets.filter(s => !(s.blockId === block.id && !s.done && (!s.warmup || !warm)));
  for (const w of warmSets(block)) if (!w.done) w.exerciseId = ex.id; // unlogged warm-ups follow a swap
  const done = blockSets(block).length;
  const load = L.targetLoad(state, ex, block.tier, sc, session.checkinAt);
  for (let i = done; i < sc.sets; i++) {
    const st = newSet(session, block, ex, sc, load);
    if (sc.ramp && st.reps != null) st.reps = sc.reps + i * sc.ramp; // a ladder: more each round
    state.sets.push(st);
  }
  // AMRAP last set: on by default for a lift you did it on last time at this tier.
  if (block.amrap === undefined && canAmrap(block, ex)) block.amrap = L.lastOutcome(state, ex.id, block.tier, session.checkinAt)?.amrap != null;
  markAmrap(block);
}

// AMRAP (as many reps as possible) on the last working set: for loaded T1/T2 lifts, where it drives progression.
const canAmrap = (b, ex) => (b.tier === 'T1' || b.tier === 'T2') && ex?.metric === 'load_reps';
// Puts the AMRAP flag on the block's last working set (logged sets keep theirs), or clears it when AMRAP is off.
function markAmrap(b) {
  const sets = blockSets(b);
  const on = b.amrap && canAmrap(b, exOf(b.exerciseId));
  for (const st of sets) if (!st.done) delete st.amrap;
  const last = sets.at(-1);
  if (on && last && !last.done && !sets.some(x => x.done && x.amrap)) last.amrap = true;
}

function slotIdFor(exerciseId, tier) {
  const ex = exOf(exerciseId);
  return ex ? L.slotFor(state, ex, tier)?.id ?? null : null;
}

// Best scheme for an exercise added or re-tiered by hand: fits the time left if possible, never over its rep cap.
function schemeForBlock(s, ex, tier, exceptBlock) {
  const budget = L.takesTime(tier) ? sessionBudget(s, exceptBlock) - L.overhead(state, tier, ex.id, s.locationId) : Infinity; // jumps are warm-up time
  const dose = L.slotDose(state, L.slotFor(state, ex, tier), tier);
  return L.pickScheme(state, tier, ex, Math.max(budget, 0), s, dose)
    || L.pickScheme(state, tier, ex, Infinity, s, dose)
    || L.schemeOptions(state, tier)[0];
}

function newExercise({ name, familyId = null, familyName, metric = 'load_reps', bodyweight = false, equipment = [], rank = null, anytime = false, region = 'full', explosive = false }) {
  // No category given: the exercise starts its own, so it can still be swapped and ranked later.
  const fname = (familyName || name).trim();
  let fam = famOf(familyId) ?? state.families.find(f => f.name.toLowerCase() === fname.toLowerCase());
  if (!fam) {
    fam = { id: L.uid(), name: fname, defaultExerciseId: null };
    state.families.push(fam);
  }
  const e = {
    id: L.uid(), name, familyId: fam.id, rank: rank ?? (L.familyMembers(state, fam.id).at(-1)?.rank ?? 0) + 1,
    metric, bodyweight, equipment, anytime, region, explosive, youtube: '', start: null, cues: '', startMax: null, maxReps: null, restSec: null,
    role: L.guessRole(name, metric, explosive),
  };
  state.exercises.push(e);
  normalizeRanks(fam.id);
  if (!fam.defaultExerciseId) fam.defaultExerciseId = e.id;
  return e;
}

// Warn when an exercise can't show up anywhere, so new gear gets added to a location.
function availabilityNote(e) {
  if (state.locations.some(l => L.isAvailable(e, l))) return null;
  const missing = e.equipment.filter(eq => !state.locations.some(l => l.equipment.includes(eq)));
  return `${e.name} won't be suggested until a location has ${missing.join(', ') || 'its equipment'}. Add it in Settings → Locations.`;
}

function setBlockTier(s, b, tier, reason = null) {
  const ex = exOf(b.exerciseId);
  b.swaps.push({ type: 'tier', from: b.tier, to: tier, reason, at: Date.now() });
  b.tier = tier;
  b.slotId = slotIdFor(ex.id, tier);
  if (tier === 'T3') L.pairT3s(state, s.blocks, L.placeOf(state, s));
  b.schemeId = schemeForBlock(s, ex, tier, b).id;
  if (s.source === 'suggested') s.source = 'swapped';
  genSets(s, b);
}

// Only said when it changes something: a fresh day needs no line.
const readyText = r => r.tired ? 'Tired: explosive work as technique'
  : r.heavy.length ? `Heavy ${r.heavy.join('/')} work yesterday: explosive ${r.heavy.join('/')} work as technique`
  : r.low ? 'Low energy: power work stays, in short sets' : '';

// Conditioning supersets: the bike (or whatever conditioning is here), or null when there's none or it's skipped today.
function condPairExercise(s) {
  const fam = L.conditioningFamily(state);
  if ((s.skip || []).includes(fam)) return null;
  return L.pickExercise(state, fam, L.placeOf(state, s), 'COND');
}
// Calories per rest: more in a T1's longer rest.
const condPairCal = main => (main.tier === 'T1' ? 8 : 6);
// A round after each of the lift's sets; kept as a scheme so it can be edited (Settings → Schemes) and reused.
function condPairScheme(main) {
  const sets = schOf(main.schemeId)?.sets ?? 5, cal = condPairCal(main);
  const id = `s-c-pair-${sets}x${cal}`;
  let sc = schOf(id);
  if (!sc) {
    sc = { id, name: `${sets} × ${cal} cal in the rest`, sets, reps: cal, restSec: 0, minutes: Math.max(2, Math.round(sets * cal / 15)), tiers: ['COND'], pairOnly: true };
    state.schemes.push(sc);
  }
  return sc;
}

function addBlock(s, ex, tier) {
  const b = { id: L.uid(), tier, slotId: slotIdFor(ex.id, tier), exerciseId: ex.id, schemeId: null, swaps: [{ type: 'add', to: ex.id, at: Date.now() }] };
  b.schemeId = schemeForBlock(s, ex, tier, b).id;
  s.blocks.push(b);
  if (s.source === 'suggested') s.source = 'swapped';
  if (tier === 'T3') {
    L.pairT3s(state, s.blocks, L.placeOf(state, s));
    if (b.pairOf) b.schemeId = schemeForBlock(s, ex, tier, b).id; // a partner only costs half its time
  }
  genSets(s, b);
  return b;
}

// Clears what you haven't started from the open session: blocks with nothing logged go, with their sets. A block you've
// started stays whole (its remaining sets too). Returns the blocks kept.
function keepStarted(s) {
  const keep = s.blocks.filter(b => state.sets.some(x => x.blockId === b.id && x.done));
  state.sets = state.sets.filter(x => x.sessionId !== s.id || keep.some(b => b.id === x.blockId));
  s.blocks = keep;
  for (const b of keep) if (b.pairOf && !keep.some(x => x.id === b.pairOf)) delete b.pairOf;
  return keep;
}

// "Why this session" rows from buildSuggestion's scores.
// Accepting or skipping review proposals. The goals as they were before the first change are kept for Undo.
function reviewDecide(ids, status) {
  const rv = ui.review;
  const rec = R.recordReview(state, rv.data, 'reviewed');
  let changed = false;
  for (const id of ids) {
    const p = rv.data.proposals.find(x => x.id === id), r = rec.proposals.find(x => x.id === id);
    if (!p || !r || r.status !== 'open') continue;
    if (status === 'accepted' && p.change) {
      if (!ui.reviewUndo) { ui.reviewUndo = { slots: structuredClone(state.slots), accepted: [] }; }
      R.applyProposal(state, p);
      ui.reviewUndo.accepted.push(`${rec.id}/${id}`);
      changed = true;
    }
    r.status = status;
  }
  if (changed) keepCopy('before-review', ui.reviewUndo);
  save(); render();
  if (changed) toast(ids.length > 1 ? 'Goals changed' : 'Goal changed');
}

// (Only what's shown and what the weekly review reads: the scores and their working aren't kept.)
const whyRows = res => res.scored.map(c => ({ slotId: c.slot.id, label: slotLabel(c.slot), picked: !!c.picked, ...(c.note ? { note: c.note } : {}), ...(c.hold ? { hold: c.hold } : {}) }));

function createSession(blocks, source, extra = {}) {
  const s = {
    id: L.uid(), day: L.dayKey(), checkinAt: Date.now(), firstSetAt: null, status: 'open',
    ...ui.ci, source, blocks, ...extra,
  };
  state.sessions.push(s);
  L.pairT3s(state, blocks, L.placeOf(state, s));
  for (const b of blocks) genSets(s, b);
  save();
  return s;
}

function planBlocks(plan) {
  return plan.items.filter(it => exOf(it.exerciseId) && schOf(it.schemeId)).map(it => ({
    id: L.uid(), tier: it.tier, slotId: slotIdFor(it.exerciseId, it.tier),
    exerciseId: it.exerciseId, schemeId: it.schemeId, swaps: [],
  }));
}

function sessionBudget(s, exceptBlock) {
  return Math.round(s.minutes - s.blocks.filter(b => b !== exceptBlock)
    .reduce((m, b) => m + L.blockMinutes(state, b, { blocks: s.blocks, loc: s.locationId ?? null }), 0));
}

// Only real web links: a javascript: link in an imported or restored library would run code when tapped.
function videoUrl(ex) {
  if (!/^https?:\/\//i.test(ex.youtube || '')) return null;
  if (!ex.start) return ex.youtube;
  return ex.youtube + (ex.youtube.includes('?') ? '&' : '?') + 't=' + ex.start;
}

const parseMSS = v => {
  v = String(v || '').trim();
  if (!v) return null;
  if (v.includes(':')) { const [m, s] = v.split(':').map(Number); return m * 60 + (s || 0); }
  return Number(v) || null;
};
const fmtMSS = s => s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
const clock = secs => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

// ---------- rest timer ----------
// The timer is stored as an end timestamp, so it survives reloads and background throttling.

const timerEl = document.getElementById('timer');
const timerCfg = () => state.settings.timer;
let audioCtx = null;
let wakeLock = null;

// Rest precedence: this session's block setting > exercise override > scheme default.
function effectiveRest(b) {
  return b.restSec ?? exOf(b.exerciseId)?.restSec ?? schOf(b.schemeId)?.restSec ?? 90;
}

// iOS only allows audio after a user gesture, so this runs inside tap handlers.
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio support */ }
}

function beep(count = 1, freq = 880) {
  if (!audioCtx || !timerCfg().sound) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < count; i++) {
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.3);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + i * 0.3 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.3 + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + i * 0.3);
    osc.stop(t0 + i * 0.3 + 0.22);
  }
}

async function setWakeLock(on) {
  try {
    if (on && !wakeLock && timerCfg().keepAwake && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* denied or unsupported */ }
}

// Label for whatever set comes next in the session.
function nextSetLabel(s) {
  for (const b of s.blocks) {
    const sets = blockSets(b);
    const i = sets.findIndex(x => !x.done);
    if (i >= 0) return `${exOf(sets[i].exerciseId)?.name ?? ''} · set ${i + 1}`;
  }
  return null;
}

const doneIn = b => blockSets(b).filter(st => st.done).length;
const setLabel = b => { const i = blockSets(b).findIndex(st => !st.done); return i >= 0 ? `${exOf(b.exerciseId)?.name ?? ''} · set ${i + 1}` : null; };

// Next in the group after a set of b: whoever is furthest behind, the next one round from b on a tie.
function nextInGroup(s, b) {
  const g = groupOf(s, b);
  const at = g.indexOf(b);
  const order = [...g.slice(at + 1), ...g.slice(0, at + 1)].filter(setLabel);
  return order.sort((x, y) => doneIn(x) - doneIn(y))[0] ?? null;
}

function nextLabelAfter(s, b) {
  const n = nextInGroup(s, b);
  return (n && setLabel(n)) ?? nextSetLabel(s);
}

// An EMOM block (scheme.emom: seconds per round) rests until the next round starts on its clock, which starts with
// ▶ Start EMOM, or else at the first round you log. A rest set for today (⏱) still wins.
function emomRest(b) {
  const every = schOf(b.schemeId)?.emom;
  if (!every || b.restSec != null) return null;
  const now = Date.now();
  b.emomStart ??= now;
  const n = Math.floor((now - b.emomStart) / (every * 1000)) + 1;
  return Math.max(1, Math.round((b.emomStart + n * every * 1000 - now) / 1000));
}

function startTimer(s, b, setId = null) {
  const secs = emomRest(b) ?? effectiveRest(b);
  if (!secs) return;
  state.timer = { endsAt: Date.now() + secs * 1000, total: secs, blockId: b.id, setId, next: nextLabelAfter(s, b), warned: false, alerted: false };
  setWakeLock(true);
}

function startMobTimer(list, item, set) {
  const secs = itemEx(item)?.restSec || 0;
  if (!secs) return;
  state.timer = { endsAt: Date.now() + secs * 1000, total: secs, blockId: null, setId: set.id, next: nextMobLabel(list, item), warned: false, alerted: false };
  setWakeLock(true);
}

function stopTimer() {
  state.timer = null;
  renderTimer();
}

// ---------- hold timer ----------
// For timed sets (holds, planks) and mobility holds: a get-ready countdown, then the hold, each side in turn
// for per-side moves. When it runs out the set is logged with that time, which starts the rest as usual.
// Shares the timer bar with rest, so starting one replaces the other.

const goBtn = (attrs, on) => on
  ? '<button class="go on" data-act="workCancel" aria-label="Stop the timer">■</button>'
  : `<button class="go" ${attrs} aria-label="Start a timer for this set">▶</button>`;

function startWork(target, name, secs, perSide = false) {
  secs = Math.max(1, Math.round(secs));
  const prep = Math.max(0, timerCfg().prep ?? 5);
  const phases = [
    ...(prep ? [{ label: 'Get ready', secs: prep }] : []),
    ...(perSide ? [{ label: 'Left side', secs, hold: true }, { label: 'Switch sides', secs: Math.max(prep, 3) }, { label: 'Right side', secs, hold: true }]
      : [{ label: 'Go', secs, hold: true }]),
  ];
  const now = Date.now();
  state.timer = { kind: 'work', target, name, phases, startedAt: now, endsAt: now + phases.reduce((t, p) => t + p.secs, 0) * 1000 };
  unlockAudio();
  setWakeLock(true);
}

// Where a hold timer is: the phase, seconds left in it and seconds into it. Null once it has run out.
function workPhase(t, now = Date.now()) {
  let at = t.startedAt;
  for (let i = 0; i < t.phases.length; i++) {
    const p = t.phases[i], end = at + p.secs * 1000;
    if (now < end) return { i, p, rem: Math.ceil((end - now) / 1000), into: Math.floor((now - at) / 1000), frac: (now - at) / (p.secs * 1000) };
    at = end;
  }
  return null;
}

// Seconds held so far: into the current hold, else the last finished one (a per-side hold logs one side's time).
function workHeld(t) {
  const ph = workPhase(t);
  if (!ph) return t.phases.filter(p => p.hold).at(-1).secs;
  if (ph.p.hold) return ph.into;
  return t.phases.slice(0, ph.i).filter(p => p.hold).at(-1)?.secs ?? 0;
}

// Puts the held time on the set and logs it, unless it was logged by hand in the meantime.
function finishWork(t, held) {
  state.timer = null;
  if (t.target.set) {
    const st = L.byId(state.sets, t.target.set);
    if (st && !st.done && held > 0) { st.time = held; return actions.check({ id: st.id }); }
  } else {
    const st = findMobItem(t.target.item).item?.sets.find(x => x.id === t.target.mset);
    if (st && !st.done && held > 0) { st.hold = held; return actions.mcheck({ i: t.target.item, s: st.id }); }
  }
  save(); render();
}

function tickWork(t) {
  const ph = workPhase(t);
  if (!ph) {
    beep(3, 880);
    if (timerCfg().vibrate) navigator.vibrate?.([250, 120, 250, 120, 250]);
    return finishWork(t, workHeld(t));
  }
  // A high beep as each hold starts, and 3-2-1 before every change.
  if (t.phase !== ph.i) {
    t.phase = ph.i;
    if (ph.p.hold) { beep(1, 990); if (timerCfg().vibrate) navigator.vibrate?.(200); }
  }
  if (ph.rem <= 3 && t.beeped !== `${ph.i}:${ph.rem}`) { t.beeped = `${ph.i}:${ph.rem}`; beep(1, 660); }
  renderTimer();
}

// Hand the timer to the service worker so it can notify while the page is hidden.
let syncedEndsAt;
function syncTimerToWorker(force = false) {
  const endsAt = state.timer?.endsAt ?? null;
  if (!force && endsAt === syncedEndsAt) return;
  syncedEndsAt = endsAt;
  if (!navigator.serviceWorker) return;
  // Background notifications are for rest only: a hold is done with the app open.
  const wanted = timerCfg().notify && window.Notification?.permission === 'granted' && state.timer?.kind !== 'work';
  navigator.serviceWorker.ready.then(reg => reg.active?.postMessage({
    type: 'rest', id: String(endsAt), endsAt: wanted ? endsAt : null, next: state.timer?.next ?? null,
  }));
}

async function enableNotifications(el) {
  if (!window.Notification || !navigator.serviceWorker) {
    el.checked = timerCfg().notify = false;
    save();
    return toast('Notifications aren’t supported in this browser');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    el.checked = timerCfg().notify = false;
    save();
    return toast('Notifications were blocked');
  }
  syncTimerToWorker(true);
}

function tickTimer() {
  syncTimerToWorker();
  const t = state.timer;
  if (!t) return;
  if (t.kind === 'work') return tickWork(t);
  const rem = t.endsAt - Date.now();
  if (!t.warned && timerCfg().warn10 && rem <= 10000 && rem > 0 && t.total > 20) {
    t.warned = true;
    beep(1, 660);
    save();
  }
  if (!t.alerted && rem <= 0) {
    t.alerted = true;
    beep(3, 880);
    if (timerCfg().vibrate) navigator.vibrate?.([250, 120, 250, 120, 250]);
    save();
  }
  renderTimer();
}

function renderTimer() {
  const t = state.timer;
  document.body.classList.toggle('has-timer', !!t);
  if (!t) { timerEl.hidden = true; timerEl.innerHTML = ''; return; }
  if (t.kind === 'work') return renderWork(t);
  const rem = Math.round((t.endsAt - Date.now()) / 1000);
  const over = rem <= 0;
  const pct = over ? 100 : Math.min(100, 100 * (1 - rem / t.total));
  timerEl.hidden = false;
  timerEl.className = over ? 'over' : '';
  timerEl.innerHTML = `<div class="fill" style="width:${esc(pct)}%"></div>
    <div class="tbody"><div class="tmain"><span class="tclock">${over ? '+' + clock(-rem) : clock(rem)}</span>
      <span class="tlabel">${HR.fresh() ? `<span class="hrinline">♥ ${esc(HR.live.bpm)}</span> ` : ''}${over ? 'Go' : 'Rest'}${t.next ? ` · next: ${esc(t.next)}` : ''}</span></div>
      <div class="tbtns">${over ? '' : `<button data-act="timerAdj" data-d="-15">−15</button><button data-act="timerAdj" data-d="15">+15</button>`}
      <button data-act="timerStop">${over ? 'Done' : 'Skip'}</button></div></div>`;
}

function renderWork(t) {
  const ph = workPhase(t);
  if (!ph) return;
  timerEl.hidden = false;
  timerEl.className = ph.p.hold ? 'work' : 'prep';
  const held = workHeld(t);
  timerEl.innerHTML = `<div class="fill" style="width:${esc(Math.min(100, ph.frac * 100))}%"></div>
    <div class="tbody"><div class="tmain"><span class="tclock">${clock(ph.rem)}</span>
      <span class="tlabel">${esc(ph.p.label)} · ${esc(t.name)}</span></div>
      <div class="tbtns"><button data-act="workAdd">+15</button>
      ${held ? `<button data-act="workLog">Log ${clock(held)}</button>` : ''}
      <button data-act="workCancel" aria-label="Cancel the timer">✕</button></div></div>`;
}

setInterval(tickTimer, 250);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return syncTimerToWorker(true);
  if (state.timer || currentSession()) setWakeLock(true); // the browser drops the lock when hidden
  tickTimer();
});

// ---------- views ----------

function render() {
  rollDay();
  if (ui.onboard) {
    navEl.hidden = true;
    appEl.innerHTML = globalBanners() + viewOnboard(ui.onboard);
    renderSheet();
    return;
  }
  navEl.hidden = false;
  navEl.innerHTML = TABS.map(([k, t]) => `<button data-act="nav" data-tab="${esc(k)}" class="${esc(ui.tab === k ? 'on' : '')} ${esc(k === 'timer' && state.intervalRun ? 'live' : '')}" ${k === 'timer' && state.intervalRun ? 'aria-label="Timer, running"' : ''}>${t}</button>`).join('');
  const views = { today: viewToday, week: viewWeek, timer: viewTimer, library: viewLibrary, plans: viewPlans, more: viewSettings };
  appEl.innerHTML = globalBanners() + views[ui.tab]();
  renderSheet();
  renderTimer();
  if (ui.focus) {
    const el = appEl.querySelector(ui.focus);
    if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); }
    ui.focus = null;
  }
}

// Problems with saving show on every tab: they mean your latest changes aren't safe yet.
function globalBanners() {
  let h = '';
  const copy = getRecoveryCopy();
  if (loadProblem) {
    h += `<div class="banner bad">${esc(loadProblem.message)}${loadProblem.raw ? ' <button class="link" data-act="copyRaw">Copy the saved data</button>' : ''}
      ${copy ? `<button class="link" data-act="recoveryUse">Use the backup copy from ${esc(fmtDateTime(copy.at))}</button>` : ''}
      <button class="link" data-act="startFresh">Start fresh</button></div>`;
  } else if (copy) {
    h += `<div class="banner">A newer copy of your data was found on this device (saved ${esc(fmtDateTime(copy.at))}, ${copy.summary.workouts} workouts, ${copy.summary.sets} sets).
      <button class="link" data-act="recoveryUse">Use it</button> <button class="link" data-act="recoveryIgnore">Ignore</button></div>`;
  }
  if (ui.updateReady) {
    h += `<div class="banner">A newer version of the app is ready. <button class="link" data-act="reloadApp">Reload</button></div>`;
  }
  if (ui.cloud?.ask && !(ui.sheet?.type === 'cloudAsk')) {
    h += `<div class="banner">Your account has a saved backup. <button class="link" data-act="cloudAsk">Choose what to do</button></div>`;
  }
  if (ui.cloud?.authLost && !Cloud.signedIn()) {
    h += `<div class="banner bad">Your account sign-in expired. <button class="link" data-act="cloudAuthPage">Sign in again</button></div>`;
  }
  if (ui.recovered) {
    h += `<div class="banner">Recovered your data from this device's backup copy (saved ${esc(fmtDateTime(ui.recovered.at))}: ${ui.recovered.summary.workouts} workouts, ${ui.recovered.summary.sets} sets).
      <button class="link" data-act="recoveredOk">OK</button></div>`;
  }
  if (ui.setupUndo) h += `<div class="banner">Setup saved: new goals, locations and maxes. <button class="link" data-act="setupUndo">Undo</button></div>`;
  if (lastSaveError) {
    h += `<div class="banner bad">Your latest changes aren't saved: ${esc(lastSaveError)}. <button class="link" data-act="copyBackup">Copy a backup</button></div>`;
  }
  return h;
}

function banners() {
  let h = '';
  if (!state.settings.bodyweight) {
    h += `<div class="banner">Set your bodyweight in Settings so weighted pull-ups and dips get loads. <button class="link" data-act="nav" data-tab="more">Settings</button></div>`;
  }
  // Nudge after 3 finished workouts, or 7 days with one, since the last backup off this device (see Vault.backupNudge).
  if (Vault.backupNudge(state)) {
    const n = state.sessions.filter(x => x.status === 'done' && x.firstSetAt && x.firstSetAt > (state.settings.lastExportAt ?? 0)).length;
    h += `<div class="banner">${state.settings.lastExportAt ? `${n} workout${n === 1 ? '' : 's'} since your last backup.` : `Your ${n} workout${n === 1 ? '' : 's'} only exist on this device.`}
      <button class="link" data-act="saveBackup">Save backup</button> <button class="link" data-act="backupSnooze">Not now</button></div>`;
  }
  return h;
}

function viewToday() {
  if (B.settle(state)) save(); // a block past its end finishes now; its report waits below
  if (ui.tomorrow) return viewTomorrow(ui.tomorrow);
  const s = currentSession(), m = currentMobility();
  if (m && !(s && ui.showWorkout)) return banners() + viewMobSession(m, !!s);
  const back = m ? `<div class="banner">Mobility still open · <button class="link" data-act="showMobility">Switch to it</button></div>` : '';
  return banners() + back + (s ? viewSession(s) : viewCheckin());
}

function seg(key, items, cur) {
  return `<div class="seg">${items.map(([v, t]) =>
    `<button data-act="ci" data-k="${esc(key)}" data-v="${esc(v)}" class="${esc(String(cur) === String(v) ? 'on' : '')}">${t}</button>`).join('')}</div>`;
}

// Upper/lower workouts from the whole library, for when the weekly goals are done.
// With a lean, that half's two come first and stand out; the other half stays one tap away.
const focusName = (r, x) => `${r === 'upper' ? 'Upper' : 'Lower'} body${x ? ' + explosive' : ''}`;
const focusButtons = lean => `<div class="focusgrid">${[...L.FOCUS_REGIONS].sort((a, b) => (b === lean) - (a === lean)).flatMap(r => [false, true].map(x =>
  `<button data-act="focus" data-r="${esc(r)}" ${x ? 'data-x="1"' : ''} class="${esc(r === lean ? 'lean' : '')}">${focusName(r, x)}</button>`)).join('')}</div>`;

// Started programs: today's session and where you are. Programs not started are offered under Plans.
function programCards() {
  const started = P.PROGRAMS.filter(d => P.progress(state, d.id));
  if (!started.length) {
    return `<div class="field"><label>Programs</label><div class="list">${P.PROGRAMS.map(d =>
      `<button class="row" data-act="progOpen" data-id="${esc(d.id)}"><span>${esc(d.name)}</span><span class="meta">${P.weeksOf(d)} weeks ›</span></button>`).join('')}</div></div>`;
  }
  return started.map(d => {
    const p = P.progress(state, d.id);
    if (p.finished) {
      return `<div class="card prog"><b>${esc(d.name)}: done</b>
        <div class="brow"><button class="small" data-act="progOpen" data-id="${esc(d.id)}">Your progress</button></div></div>`;
    }
    const today = P.doneToday(state, d.id, L.dayKey());
    const last = P.lastSessionAt(state, d.id);
    const gap = last ? Math.floor((L.startOfDay() - L.startOfDay(last)) / 864e5) : null;
    const hint = today ? 'Done today ✓' : gap >= 7 ? `${gap} days off: maybe repeat week ${Math.max(1, p.week - 1)}` : '';
    const dose = P.dayPlan(d, p.week).map(e => `${e.name} ${M.doseText(e)}`).join(' · ');
    return `<div class="card prog"><div><b>${esc(d.name)}</b> · week ${p.week}/${P.weeksOf(d)}, day ${p.day}/${d.days}</div>
      <div class="meta">${esc(dose)}</div>${hint ? `<div class="meta ${today ? 'good' : ''}">${esc(hint)}</div>` : ''}
      <div class="brow"><button class="${today ? '' : 'primary'}" data-act="progSession" data-id="${esc(d.id)}">${today ? 'Start another' : 'Start'}</button>
        <button data-act="progOpen" data-id="${esc(d.id)}">Program ›</button></div></div>`;
  }).join('');
}

// ---------- the Timer tab: interval timers (js/interval.js) ----------

// The timer being set up: the last one you ran, else the first preset, with the bike (or a conditioning exercise) in it.
function ivDraft() {
  if (ui.iv) return ui.iv;
  const base = state.intervals?.last ?? state.intervals?.presets?.[0] ?? I.DEFAULT_PRESETS[0];
  const cfg = I.clean(base);
  if (!cfg.exercises.length || !cfg.exercises.every(exOf)) {
    const bike = exOf('ex-assault-bike') ?? state.exercises.find(e => !e.archived && L.isConditioning(state, e)) ?? state.exercises.find(e => !e.archived);
    cfg.exercises = bike ? [bike.id] : [];
  }
  ui.iv = { ...cfg, presetId: base.id ?? null };
  return ui.iv;
}

// Exercises for a set: conditioning first, then everything by name.
function ivExerciseOptions(sel) {
  const live = state.exercises.filter(e => !e.archived || e.id === sel);
  const cond = live.filter(e => L.isConditioning(state, e)).sort((a, b) => a.name.localeCompare(b.name));
  const rest = live.filter(e => !L.isConditioning(state, e)).sort((a, b) => a.name.localeCompare(b.name));
  const o = list => list.map(e => `<option value="${esc(e.id)}" ${e.id === sel ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
  return `<optgroup label="Conditioning">${o(cond)}</optgroup><optgroup label="Everything else">${o(rest)}</optgroup>`;
}

// ---------- heart rate (js/hr.js) ----------
// While the strap is on, every reading goes on what you're doing: the open workout, else a running interval timer
// (it moves to the workout the timer logs). Saved every half minute, not every beat.
const hrTarget = () => currentSession() ?? state.intervalRun ?? null;
let hrSaveAt = 0;
HR.onChange(live => {
  const target = live.status === 'live' && live.bpm ? hrTarget() : null;
  if (target) {
    target.hr = HR.addSample(target.hr, Date.now(), live.bpm);
    if (Date.now() - hrSaveAt > 30e3) { hrSaveAt = Date.now(); save(); }
  }
  for (const el of document.querySelectorAll('.hrpill')) { el.className = `hrpill ${live.status}`; el.innerHTML = hrPillInner(); }
  const big = document.getElementById('iv-hr');
  if (big) big.innerHTML = hrBigInner();
});
const hrPillInner = () => {
  const s = HR.live.status;
  if (s === 'live') return HR.fresh() ? `♥ <b>${esc(HR.live.bpm)}</b>` : '♥ …';
  return s === 'connecting' ? '♥ Connecting…' : s === 'lost' ? '♥ Reconnecting…' : '♥ Heart rate';
};
// The live heart rate, or a button to connect the strap (nothing where the browser can't reach Bluetooth).
const hrPill = () => (HR.supported() ? `<button class="hrpill ${esc(HR.live.status)}" data-act="hrTap" aria-label="Heart rate strap">${hrPillInner()}</button>` : '');
// The interval timer's big readout: the bpm, and the workout's average and peak so far.
function hrBigInner() {
  if (!HR.fresh()) return '';
  const sm = HR.summary(hrTarget()?.hr);
  return `<span class="hrbig">♥ ${esc(HR.live.bpm)}</span>${sm ? `<span class="meta">avg ${esc(sm.avg)} · peak ${esc(sm.max)}</span>` : ''}`;
}
// "♥ 138 avg · 171 peak" for a workout that has a recording, else ''.
const hrText = rec => { const sm = HR.summary(rec); return sm ? `♥ ${sm.avg} avg · ${sm.max} peak` : ''; };

function viewTimer() {
  if (state.intervalRun) return viewIntervalRun(state.intervalRun);
  if (ui.ivLog) return viewIntervalLog(ui.ivLog);
  const d = ivDraft();
  const presets = state.intervals?.presets ?? [];
  const field = (k, label, val, hint = '') => `<div class="field"><label for="iv-${esc(k)}">${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</label>
    <input id="iv-${esc(k)}" class="num" inputmode="${esc(k === 'rounds' || k === 'sets' ? 'numeric' : 'text')}" data-iv="${esc(k)}" value="${esc(val)}"></div>`;
  const sets = Array.from({ length: d.sets }, (_, i) => `<div class="field"><label for="iv-ex-${esc(i)}">${d.sets > 1 ? `Set ${i + 1}` : 'Exercise'}</label>
    <select id="iv-ex-${esc(i)}" data-ivex="${esc(i)}">${ivExerciseOptions(I.exerciseFor(d, i + 1))}</select></div>`).join('');
  return `<header class="top"><h1>Timer</h1><div class="hbtns">${hrPill()}</div></header>
    <div class="chips">${presets.map(p => `<button class="chip ${esc(d.presetId === p.id ? 'on' : '')}" data-act="ivPreset" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>
    <div class="card">
      <div class="field"><label for="iv-name">Name</label><input id="iv-name" data-iv="name" value="${esc(d.name)}"></div>
      <div class="row2 fields">${field('work', 'Work', clock(d.work))}${field('rest', 'Rest', clock(d.rest), '0 = EMOM')}</div>
      <div class="row2 fields">${field('rounds', 'Rounds', d.rounds)}${field('sets', 'Sets', d.sets)}</div>
      <div class="row2 fields">${field('setRest', 'Rest between sets', clock(d.setRest))}${field('prep', 'Get ready', clock(d.prep))}</div>
      ${sets}
      <p class="meta">${esc(I.describe(d))}</p>
      <div class="brow"><button class="primary big" data-act="ivStart">Start</button></div>
      <div class="brow"><button class="small" data-act="ivSave">${d.presetId && presets.some(p => p.id === d.presetId && !p.id.startsWith('iv-')) ? 'Save changes' : 'Save as a timer'}</button>
        ${d.presetId && !d.presetId.startsWith('iv-') ? '<button class="small quiet" data-act="ivDel">Delete</button>' : ''}</div>
    </div>`;
}

function viewIntervalRun(run) {
  const list = I.phases(run.cfg), ms = I.elapsed(run), at = I.phaseAt(list, ms);
  return `<header class="top"><h1>${esc(run.cfg.name)}</h1><div class="hbtns">${hrPill()}</div></header>
    <div class="ivrun ${esc(at?.phase.kind ?? 'done')}" id="iv-run">${ivRunInner(run, list, at)}</div>
    <div class="ivhr" id="iv-hr">${hrBigInner()}</div>
    <div class="brow ivbtns">${run.pausedAt ? '<button class="primary big" data-act="ivResume">Resume</button>' : '<button class="big" data-act="ivPause">Pause</button>'}
      <button class="big" data-act="ivSkip">Skip</button><button class="big danger" data-act="ivStop">Stop</button></div>`;
}

const IV_LABEL = { prep: 'Get ready', work: 'Work', rest: 'Rest', setRest: 'Rest between sets' };
function ivRunInner(run, list, at) {
  if (!at) return '<div class="ivclock">Done</div>';
  const c = run.cfg, p = at.phase;
  const ex = exOf(p.exerciseId)?.name ?? '';
  const next = at.next ? `Next: ${IV_LABEL[at.next.kind]}${at.next.kind === 'work' ? ` · ${esc(exOf(at.next.exerciseId)?.name ?? '')}` : ''}` : 'Last one';
  return `<div class="ivfill" style="width:${esc(Math.min(100, at.frac * 100))}%"></div>
    <div class="ivphase">${IV_LABEL[p.kind]}${run.pausedAt ? ' · paused' : ''}</div>
    <div class="ivclock">${clock(at.rem)}</div>
    <div class="ivsub">${p.kind === 'prep' ? esc(ex) : `${esc(ex)} · round ${p.round} of ${c.rounds}${c.sets > 1 ? ` · set ${p.set} of ${c.sets}` : ''}`}</div>
    <div class="ivnext">${next}</div>`;
}

// After a run: what you did, ready to log. Totals are per set (calories for the bike, else reps); blank still logs the rounds.
function viewIntervalLog(lg) {
  const done = I.roundsDone(I.phases(lg.cfg), lg.ms);
  if (!done.length) return `<header class="top"><h1>Timer</h1></header><div class="card"><p>No rounds finished.</p>
    <div class="brow"><button class="primary" data-act="ivDiscard">OK</button></div></div>`;
  const open = currentSession();
  return `<header class="top"><h1>Log it</h1></header>
    <div class="card"><p class="meta">${esc(lg.cfg.name)} · ${clock(Math.round(lg.ms / 1000))} · ${open ? 'into your open workout' : 'as its own workout'}</p>
    ${done.map(d => {
      const ex = exOf(d.exerciseId);
      const unitWord = ex?.repUnit ?? (ex?.metric === 'time' ? null : 'reps');
      return `<div class="field"><label for="iv-total-${esc(d.set)}">${lg.cfg.sets > 1 ? `Set ${d.set}: ` : ''}${esc(ex?.name ?? '?')} · ${d.rounds.length} round${d.rounds.length === 1 ? '' : 's'}</label>
        ${unitWord ? `<input id="iv-total-${esc(d.set)}" class="num" inputmode="numeric" data-ivtotal="${esc(d.set)}" value="${esc(lg.totals?.[d.set] ?? '')}" placeholder="total ${esc(unitWord)}">` : `<span class="meta">${lg.cfg.work}s a round</span>`}</div>`;
    }).join('')}
    <div class="brow"><button class="primary big" data-act="ivLog">Log ${done.reduce((n, d) => n + d.rounds.length, 0)} rounds</button><button class="quiet" data-act="ivDiscard">Discard</button></div></div>`;
}

// A scheme for a block of timer rounds (kept, so the block has one; never suggested: manualOnly).
function intervalScheme(cfg, tier, reps) {
  const id = `s-i-${cfg.rounds}x${cfg.work}-${cfg.rest}-${tier}`;
  let sc = schOf(id);
  if (!sc) {
    sc = { id, name: cfg.rest ? `${cfg.rounds} × ${cfg.work}s on / ${cfg.rest}s off` : `EMOM ${cfg.rounds} (every ${clock(cfg.work)})`, sets: cfg.rounds, reps: reps || 1, restSec: cfg.rest,
      minutes: Math.max(1, Math.round(cfg.rounds * (cfg.work + cfg.rest) / 60)), tiers: [tier], manualOnly: true, ...(cfg.rest ? {} : { emom: cfg.work }) };
    state.schemes.push(sc);
  }
  return sc;
}

// Logs a run: a block per set, a set per round finished (at the time it ended), the set's total spread over its rounds.
// Into the open workout if there is one, else a workout of its own.
function logIntervals(lg) {
  const cfg = I.clean(lg.cfg), done = I.roundsDone(I.phases(cfg), lg.ms);
  if (!done.length) return 0;
  const open = currentSession();
  const s = open ?? { id: L.uid(), day: L.dayKey(lg.startedAt), checkinAt: lg.startedAt, firstSetAt: null, status: 'done', source: 'interval',
    locationId: ui.ci.locationId, locationIds: ui.ci.locationIds, minutes: Math.max(1, Math.round(I.totalSecs(cfg) / 60)), durationMin: Math.max(1, Math.round(lg.ms / 60000)), blocks: [] };
  let n = 0;
  for (const d of done) {
    const ex = exOf(d.exerciseId);
    if (!ex) continue;
    const tier = tierFor(ex, 'T3');
    const reps = I.spread(lg.totals?.[d.set], d.rounds.length);
    const sc = intervalScheme(cfg, tier, reps[0]);
    const b = { id: L.uid(), tier, slotId: slotIdFor(ex.id, tier), exerciseId: ex.id, schemeId: sc.id, swaps: [], interval: cfg.name };
    s.blocks.push(b);
    d.rounds.forEach((r, i) => {
      state.sets.push({ id: L.uid(), sessionId: s.id, blockId: b.id, exerciseId: ex.id, tier, schemeId: sc.id, load: null,
        reps: ['reps', 'load_reps'].includes(ex.metric) ? reps[i] : null, time: ex.metric === 'time' ? cfg.work : null, distance: null,
        done: true, loggedAt: lg.startedAt + r.endMs, ...(state.settings.bodyweight ? { bw: state.settings.bodyweight } : {}) });
      n++;
    });
  }
  const first = Math.min(...state.sets.filter(x => x.sessionId === s.id && x.done && x.loggedAt).map(x => x.loggedAt));
  if (!s.firstSetAt || first < s.firstSetAt) s.firstSetAt = first;
  if (!open && lg.hr) s.hr = lg.hr; // with a workout open, the readings were already going on it
  if (!open) state.sessions.push(s);
  return n;
}

// The run, every quarter second: beeps at each change and in the last three seconds, and the clock on screen.
let ivLast = null;
function tickInterval() {
  const run = state.intervalRun;
  if (!run || run.pausedAt) return;
  const list = I.phases(run.cfg), ms = I.elapsed(run), at = I.phaseAt(list, ms);
  if (!at) {
    beep(3, 880);
    if (timerCfg().vibrate) navigator.vibrate?.([250, 120, 250, 120, 250]);
    ui.ivLog = { cfg: run.cfg, startedAt: run.startedAt, ms: I.totalSecs(run.cfg) * 1000, totals: {}, hr: run.hr ?? null };
    state.intervalRun = null; ivLast = null;
    setWakeLock(false);
    save(); render();
    return;
  }
  if (ivLast !== at.i) {
    if (ivLast != null) {
      if (at.phase.kind === 'work') { beep(1, 990); if (timerCfg().vibrate) navigator.vibrate?.(250); }
      else { beep(2, 520); if (timerCfg().vibrate) navigator.vibrate?.([120, 80, 120]); }
    }
    ivLast = at.i;
  }
  if (at.rem <= 3 && run.beeped !== `${at.i}:${at.rem}`) { run.beeped = `${at.i}:${at.rem}`; beep(1, 660); }
  const el = document.getElementById('iv-run');
  if (el && ui.tab === 'timer') { el.className = `ivrun ${at.phase.kind}`; el.innerHTML = ivRunInner(run, list, at); }
}
setInterval(tickInterval, 250);

function viewProgram(id) {
  const d = P.programDef(id), p = P.progress(state, id);
  const done = P.daysDoneByWeek(state, id);
  const vert = Object.fromEntries((state.programs?.[id]?.verticals || []).map(v => [v.week, v.value]));
  const vu = unit() === 'kg' ? 'cm' : 'in';
  const names = d.exercises.map(e => e.short ?? e.name);
  const rows = d.chart.map((wk, i) => {
    const w = i + 1, cur = p && !p.finished && p.week === w;
    return `<tr class="${cur ? 'cur' : ''} ${esc((done[w] || 0) >= d.days ? 'full' : '')}"><th>${w}</th>${wk.map(([sets, reps]) => `<td>${sets}×${reps}</td>`).join('')}
      <td>${done[w] ? `${done[w]}/${d.days}` : ''}</td>
      <td><input class="vert" inputmode="decimal" data-vert="${esc(id)}|${esc(w)}" value="${esc(vert[w] ?? '')}" aria-label="Vertical, week ${esc(w)}"></td></tr>`;
  }).join('');
  let h = `<header class="top sub"><button class="back" data-act="progClose">‹ Plans</button></header><h1 class="pagetitle">${esc(d.name)}</h1>
    <p class="meta pad">${P.weeksOf(d)} weeks · ${d.days} days a week · separate from your goals</p>`;
  if (!p) {
    h += `<button class="primary big" data-act="progStart" data-id="${esc(id)}">Start at week 1</button>`;
  } else if (p.finished) {
    h += `<div class="card"><b>All ${P.weeksOf(d)} weeks done.</b> <button class="link" data-act="progStart" data-id="${esc(id)}">Start over</button></div>`;
  } else {
    h += `<div class="card"><div><b>Week ${p.week}, day ${p.day} of ${d.days}</b></div>
      <div class="brow"><button class="primary" data-act="progSession" data-id="${esc(id)}">Start</button>
        ${p.day > 1 || p.week > 1 ? `<button data-act="progWeek" data-id="${esc(id)}" data-w="${esc(p.week)}">Restart week ${p.week}</button>` : ''}
        <select data-progweek="${esc(id)}" aria-label="Go to week">${opts(d.chart.map((_, i) => [i + 1, `Go to week ${i + 1}`]), p.week)}</select>
        <button class="quiet" data-act="progStop" data-id="${esc(id)}">Stop</button></div></div>`;
  }
  h += `<div class="label">Chart <span class="hint">sets × reps · vertical in ${vu}</span></div>
    <div class="card flush tablewrap"><table class="progchart"><thead><tr><th>Wk</th>${names.map(n => `<th>${esc(n)}</th>`).join('')}<th>Days</th><th>Vert</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="label">The exercises</div><div class="card">${d.exercises.map(e => `<p><b>${esc(e.name)}</b>${e.perSide ? ' · each leg' : ''}<br><span class="meta">${esc(e.cues)}</span>
      ${M.videoSearch(e.video) ? ` <a class="small" href="${esc(M.videoSearch(e.video))}" target="_blank" rel="noopener">▶ Video</a>` : ''}</p>`).join('')}</div>`;
  return h;
}

// Today's "skip" chips: the categories your weekly goals use. Skipped ones are left out of every suggestion today.
function skipField(ci) {
  const fams = [...new Set(state.slots.filter(sl => sl.quota > 0).map(sl => sl.familyId))].map(famOf).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!fams.length) return '';
  const on = ci.skip || [];
  return `<details class="skip" ${on.length || ui.skipOpen ? 'open' : ''} data-skip><summary>Skip today${on.length ? `: ${esc(on.map(id => famOf(id)?.name).filter(Boolean).join(', '))}` : ''}</summary>
    <div class="chips">${fams.map(f => `<button class="chip ${esc(on.includes(f.id) ? 'on' : '')}" data-act="ciSkip" data-v="${esc(f.id)}">${esc(f.name)}</button>`).join('')}</div></details>`;
}

// Morning check still to do today (its energy then stands in for the check-in's).
const morningOpen = () => !!ui.morning || (!Mo.entryFor(state) && ui.morningSkip !== L.dayKey());
const ciChip = (attr, on, label) => `<label class="chip ${on ? 'on' : ''}"><input type="checkbox" ${attr} ${on ? 'checked' : ''}>${label}</label>`;

function viewCheckin() {
  const ci = ui.ci;
  if (ci.skip?.length && ci.skipDay !== L.dayKey()) { ci.skip = []; delete ci.skipDay; } // a skip is for the day
  const doneToday = state.sessions.filter(s => s.day === L.dayKey() && s.status === 'done');
  const paused = state.sessions.filter(s => s.day === L.dayKey() && s.status === 'paused');
  let h = `<header class="top"><h1>Check in</h1><button class="small" data-act="tomorrowOpen">Plan tomorrow ›</button></header>`;
  h += blockReportCard() + plannedCard() + morningCard() + programDayCard();
  for (const p of paused) {
    const left = state.sets.filter(x => x.sessionId === p.id && !x.done && !x.warmup).length;
    const at = new Date(p.pausedAt ?? p.checkinAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    h += `<div class="card resume"><div><b>Paused at ${at}</b><div class="meta">${left} set${left === 1 ? '' : 's'} left</div></div>
      <button class="primary" data-act="resume" data-id="${esc(p.id)}">Resume</button></div>`;
  }
  if (doneToday.length) {
    const sets = state.sets.filter(x => x.done && !x.warmup && doneToday.some(s => s.id === x.sessionId)).length;
    const last = [...doneToday].sort((a, b) => (b.endedAt ?? b.checkinAt) - (a.endedAt ?? a.checkinAt))[0];
    h += `<div class="card muted">Done today · ${sets} sets <button class="link" data-act="sessionContinue" data-id="${esc(last.id)}">Continue</button></div>`;
  }
  const where = ci.locationIds?.length ? ci.locationIds : [ci.locationId];
  if (state.locations.length > 1) {
    h += `<div class="field"><label>Where</label><div class="seg">${state.locations.map(l =>
      `<button data-act="ciLoc" data-v="${esc(l.id)}" class="${esc(where.includes(l.id) ? 'on' : '')}">${esc(l.name)}</button>`).join('')}</div></div>`;
  }
  h += `<div class="field"><label>Minutes</label>${seg('minutes', TIMES.map(t => [t, t]), ci.minutes)}</div>
    ${morningOpen() ? '' : `<div class="field"><label>Energy <span class="hint">1 wrecked · 5 fresh</span></label>${seg('energy', [1, 2, 3, 4, 5].map(n => [n, n]), 6 - ci.fatigue)}</div>`}
    <div class="field"><label>Sleep <span class="hint">optional</span></label>${seg('sleep', [1, 2, 3, 4, 5].map(n => [n, n]), ci.sleep)}</div>
    <div class="field"><label>Intent</label>${seg('intent', INTENTS, ci.intent)}</div>
    <div class="field"><label>Lean</label>${seg('lean', LEANS, ci.lean ?? 'either')}</div>
    <div class="chips extras">${ciChip('data-ci-jumps', ci.jumps, '+ Jumps')}${ciChip('data-ci-cond', ci.cond, '+ Conditioning')}${ciChip('data-ci-condpair', ci.condPair, '+ Bike supersets')}${ciChip('data-ci-split', ci.split, 'Split across the day')}</div>
    ${skipField(ci)}
    <button class="primary big" data-act="suggest">Suggest a session</button>
    <details class="mixer" ${ui.mixOpen ? 'open' : ''} data-mix><summary>Choose the mix</summary>
      ${['T1', 'T2', 'T3'].map(t => `<div class="row mixrow"><span>${t}</span><div class="stepper small"><button data-act="mixStep" data-t="${esc(t)}" data-d="-1" aria-label="Fewer ${esc(t)}">−</button><span>${ui.mix[t]}</span><button data-act="mixStep" data-t="${esc(t)}" data-d="1" aria-label="More ${esc(t)}">+</button></div></div>`).join('')}
      <button class="primary" data-act="mixBuild">Build this mix</button></details>
    <div class="field"><label>Focused workout</label>${focusButtons(L.leanOf(ci))}</div>`;
  const own = state.plans.filter(p => !p.group);
  if (own.length) {
    h += `<div class="field"><label>Saved plans</label><div class="list">${own.map(p =>
      `<button class="row" data-act="startPlan" data-id="${esc(p.id)}"><span>${esc(p.name)}</span></button>`).join('')}</div></div>`;
  }
  return h;
}

// ---------- plan tomorrow ----------
// What the suggestion would be tomorrow morning: the same rules, run as of 7am tomorrow (that week's goals, today's training
// as yesterday for recovery), with the check-in you choose here. Saved, it waits on tomorrow's check-in to start as is.

const tomorrowAt = () => L.startOfDay() + 864e5 + 7 * 3600e3;
const dayLong = t => new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

function tomorrowBuild(d) {
  const t = tomorrowAt();
  const ci = { ...d.ci, variant: d.variant || 0 };
  return { t, ci, res: L.buildSuggestion(state, ci, t), program: B.today(state, t) };
}

function viewTomorrow(d) {
  const { t, ci, res, program } = tomorrowBuild(d);
  const where = ci.locationIds?.length ? ci.locationIds : [ci.locationId];
  const credit = L.creditWeek(state, t);
  const rows = res.blocks.map(b => {
    const ex = exOf(b.exerciseId), sc = schOf(b.schemeId);
    const load = ex && sc ? L.targetLoad(state, ex, b.tier, sc, t) : null;
    const partner = b.pairOf ? '↔ ' : '';
    return `<div class="slotrow"><span class="tier ${esc(b.tier)}">${esc(b.tier)}</span><span class="grow"><span class="name">${partner}${esc(ex?.name ?? '?')}</span>
      <span class="meta">${esc(sc?.name ?? '')}${load != null ? ` · ${ex.bodyweight ? 'BW+' : ''}${load} ${unit()}` : ''}</span></span></div>`;
  }).join('');
  const left = [...credit.slots.values()].filter(r => L.counted(state, r.slot) && r.filled < r.slot.quota).length;
  return `<header class="top sub"><button class="back" data-act="tomorrowClose">‹ Check in</button></header>
    <h1 class="pagetitle">${esc(dayLong(t))}</h1>
    <p class="meta pad">${left} goal${left === 1 ? '' : 's'} open that week · energy ${6 - ci.fatigue} assumed</p>
    ${program?.due ? `<div class="card program"><div class="meta">${esc(program.block.group)} · Week ${program.week}/${program.block.weeks}</div><b>${esc(shortPlan(program.due.planId))}</b> is due that day</div>` : ''}
    ${state.locations.length > 1 ? `<div class="field"><label>Where</label><div class="seg">${state.locations.map(l =>
      `<button data-act="tomorrowSet" data-k="loc" data-v="${esc(l.id)}" class="${esc(where.includes(l.id) ? 'on' : '')}">${esc(l.name)}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label>Minutes</label><div class="seg">${TIMES.map(m => `<button data-act="tomorrowSet" data-k="minutes" data-v="${esc(m)}" class="${esc(ci.minutes === m ? 'on' : '')}">${m}</button>`).join('')}</div></div>
    <div class="field"><label>Lean</label><div class="seg">${LEANS.map(([v, n]) => `<button data-act="tomorrowSet" data-k="lean" data-v="${esc(v)}" class="${esc((ci.lean ?? 'either') === v ? 'on' : '')}">${n}</button>`).join('')}</div></div>
    <div class="card flush">${rows || '<p class="muted pad">Nothing from your goals fits.</p>'}</div>
    <p class="meta pad">About ${res.minutesUsed} min${res.ready && readyText(res.ready) ? ` · ${esc(readyText(res.ready))}` : ''}</p>
    <div class="actions"><button data-act="tomorrowRegen">Regenerate</button><button class="primary" data-act="tomorrowSave">Save for ${esc(new Date(t).toLocaleDateString(undefined, { weekday: 'long' }))}</button></div>`;
}

// Check-in: the workout you planned the night before, ready to start.
function plannedCard() {
  const p = state.planned;
  if (!p || p.day !== L.dayKey()) return '';
  const names = p.blocks.map(b => exOf(b.exerciseId)?.name).filter(Boolean);
  return `<div class="card program due"><div class="meta">Planned last night · ${p.ci.minutes} min</div>
    <p>${esc(names.join(' · '))}</p>
    <div class="brow"><button class="primary" data-act="plannedStart">Start it</button><button class="small" data-act="plannedDrop">Discard</button></div></div>`;
}

// ---------- morning check ----------

const jumpWord = ex => (/broad|long jump|bound|standing long|triple/i.test(ex?.name ?? '') ? 'Distance' : 'Height');
// The morning energy row also answers for the check-in's energy (data-k), which is hidden while this card is open.
const numSeg = (k, vals, cur, extra = '') => `<div class="seg tight">${vals.map(n => `<button data-act="mornSet" data-m="${esc(k)}" ${k === 'energy' ? 'data-k="energy"' : ''} ${extra} data-v="${esc(n)}" class="${esc(cur === n ? 'on' : '')}">${n}</button>`).join('')}</div>`;

// Energy and pain each morning (js/morning.js). Logged: one line, and what it changes today.
function morningCard() {
  const e = Mo.entryFor(state), parts = Mo.morningOf(state).parts;
  const sore = Mo.jumpPain(state);
  if (e && !ui.morning) {
    const holds = Mo.reliefHolds(state);
    return `<div class="card muted morning"><span>Morning · ${esc(Mo.entryText(e)) || 'logged'}</span> <button class="link" data-act="mornEdit">Edit</button>
      ${sore.length ? `<p>No jumps today${holds.length ? ` · <button class="link" data-act="mornIsos">Isometric holds</button>` : ''}</p>` : ''}</div>`;
  }
  if (!morningOpen()) return '';
  const d = ui.morning ?? (ui.morning = { energy: null, pain: {} });
  const ideas = [...new Set([...parts, ...Mo.PART_IDEAS])];
  return `<div class="card morning"><h3>Morning check</h3>
    <div class="field"><label>Energy <span class="hint">1 wrecked · 5 fresh</span></label>${numSeg('energy', [1, 2, 3, 4, 5], d.energy)}</div>
    ${parts.map(p => `<div class="field"><label>${esc(p)} <span class="hint">pain</span></label>${numSeg('pain', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], d.pain[p] ?? null, `data-p="${esc(p)}"`)}</div>`).join('')}
    <details class="parts" ${parts.length ? '' : 'open'}><summary>Tracked parts</summary>
      <div class="chips">${ideas.map(p => `<button class="chip ${esc(parts.includes(p) ? 'on' : '')}" data-act="mornPart" data-p="${esc(p)}">${esc(p)}</button>`).join('')}</div>
      <div class="row2"><input id="morn-part" placeholder="Another part"><button class="small" data-act="mornPartAdd">Add</button></div></details>
    <div class="brow"><button class="primary small" data-act="mornSave">Save</button>${e ? '<button class="small" data-act="mornCancel">Cancel</button>' : '<button class="small" data-act="mornSkip">Not today</button>'}</div></div>`;
}

// The holds that stand in for jumps on a sore morning, added to the workout's mobility (once).
function addReliefHolds(s, parts) {
  const ids = Mo.reliefHolds(state).filter(id => !(s.mobility || []).some(it => it.exerciseId === id));
  s.mobility = [...(s.mobility || []), ...ids.map(mobEx).filter(Boolean).map(e => M.newItem(state, e))];
  s.painSwap = parts;
}

// ---------- program blocks ----------

const planName = id => L.byId(state.plans, id)?.name ?? '?';
const shortPlan = id => planName(id).replace(/^.*?·\s*/, '').replace(/\s*\([^)]*\)\s*$/, '');

// Check-in: the program session due today (or one you're behind on), or what's next on a day off.
const planItemsText = p => p.items.map(it => `${exOf(it.exerciseId)?.name ?? '?'} ${schOf(it.schemeId)?.name ?? ''}`.trim()).join(' · ');
function programDayCard() {
  const t = B.today(state);
  if (!t) {
    const b = state.block;
    if (b?.pausedAt) return `<div class="card muted">${esc(b.group)} paused · <button class="link" data-act="blockResume">Resume</button></div>`;
    if (b && Date.now() < b.startedAt) return `<div class="card muted">${esc(b.group)} starts ${esc(shortDate(b.startedAt))}</div>`;
    return '';
  }
  const head = `${esc(t.block.group)} · Week ${t.week}/${t.block.weeks}${t.deload ? ' · deload' : ''}`;
  if (t.due) {
    const p = L.byId(state.plans, t.due.planId);
    const low = 6 - ui.ci.fatigue <= 2;
    return `<div class="card program due"><div class="meta">${head}${t.due.behind ? ` · from ${B.WEEKDAY_NAMES[t.due.weekday]}` : ''}</div><h3>${esc(shortPlan(p.id))}</h3>
      <p class="meta">${esc(planItemsText(p))}</p>
      ${low ? '<p class="meta">Low energy: deload it, or leave it for tomorrow.</p>' : ''}
      <div class="brow"><button class="primary" data-act="blockStart">Start${t.deload ? ' (deload)' : ''}</button>${t.deload ? '' : '<button class="small" data-act="blockStart" data-deload="1">Deload</button>'}</div></div>`;
  }
  const next = t.next ? `Next: ${esc(shortPlan(t.next.planId))} ${B.WEEKDAY_NAMES[t.next.weekday]} · <button class="link" data-act="blockStart">Start now</button>` : 'Week done';
  return `<div class="card muted program"><div class="meta">${head} · ${t.done}/${t.scheduled}${t.doneToday ? ' · done today' : ''}</div><p>${next}</p></div>`;
}

// Week tab: the block at a glance, each scheduled day ticked or open.
function weekBlockCard() {
  const t = B.today(state);
  if (!t) return '';
  const done = t.sessions.map(s => s.planId);
  const left = [...done];
  const days = B.sequence(state, t.block).map(x => {
    const i = left.indexOf(x.planId);
    const ok = i >= 0;
    if (ok) left.splice(i, 1);
    return `<span class="chip ${ok ? 'on' : ''}">${B.WEEKDAY_NAMES[x.weekday]} ${esc(shortPlan(x.planId))}${ok ? ' ✓' : ''}</span>`;
  }).join('');
  return `<div class="card program"><h3>${esc(t.block.group)}</h3><div class="meta">Week ${t.week}/${t.block.weeks}${t.deload ? ' · deload' : ''} · ${t.done}/${t.scheduled} sessions</div>
    <div class="chips">${days}</div></div>`;
}

// Plans tab, under a plan group: run it as a block, or the running block's controls.
function groupBlockRow(g) {
  const b = state.block;
  if (b?.group === g) {
    const wk = Math.max(1, Math.min(b.weeks, B.weekNo(state, b)));
    const when = Date.now() < b.startedAt ? `starts ${shortDate(b.startedAt)}` : b.pausedAt ? 'paused' : `week ${wk} of ${b.weeks}`;
    return `<div class="card program"><b>Running as a block · ${esc(when)}</b>
      <div class="brow">${b.pausedAt ? '<button class="small" data-act="blockResume">Resume</button>' : '<button class="small" data-act="blockPause">Pause</button>'}<button class="small danger" data-act="blockEnd">End block</button></div></div>`;
  }
  if (b) return '';
  return `<div class="brow pad"><button class="small primary" data-act="blockSetup" data-g="${esc(g)}">Run as a block</button></div>`;
}

function viewBlockSetup(d) {
  const plans = state.plans.filter(p => p.group === d.group);
  const days = [...Array(7).keys()].map(i => (state.settings.weekStartDay + i) % 7);
  const at = wd => d.schedule.find(x => x.weekday === wd)?.planId ?? '';
  const draftBlock = { owns: d.owns };
  const paused = state.slots.filter(sl => sl.quota > 0 && B.ownsSlot(state, draftBlock, sl));
  return `<header class="top sub"><button class="back" data-act="blockSetupClose">‹ Plans</button></header>
    <h1 class="pagetitle">Run ${esc(d.group)}</h1>
    <h3>Schedule</h3><div class="card flush">${days.map(wd => `<div class="frow"><span class="grow"><span class="name">${WEEKDAYS[wd]}</span></span>
      <select data-bsched="${esc(wd)}">${opts([['', 'Your own day'], ...plans.map(p => [p.id, shortPlan(p.id)])], at(wd))}</select></div>`).join('')}</div>
    <h3>What the program owns</h3><div class="card">
      <div class="field"><label>Body half <span class="hint">its T1/T2</span></label><div class="seg">${[['', 'Neither'], ['lower', 'Lower body'], ['upper', 'Upper body']].map(([v, t]) =>
        `<button data-act="bOwnHalf" data-v="${esc(v)}" class="${esc((d.owns.half ?? '') === v ? 'on' : '')}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>Whole tiers</label><div class="chips">${['JUMP', 'COND'].map(t => `<button class="chip ${esc(d.owns.tiers.includes(t) ? 'on' : '')}" data-act="bOwnTier" data-v="${esc(t)}">${t === 'JUMP' ? 'Jumps' : 'Conditioning'}</button>`).join('')}</div></div></div>
    <h3>Length</h3><div class="card">
      <div class="frow"><span class="grow"><span class="name">Weeks</span></span><div class="stepper small"><button data-act="bWeeks" data-d="-1" aria-label="Fewer weeks">−</button><span>${d.weeks}</span><button data-act="bWeeks" data-d="1" aria-label="More weeks">+</button></div></div>
      <label class="toggle"><input type="checkbox" data-bdeload ${d.deloadEvery ? 'checked' : ''}> Deload every 4th week <span class="hint">40% fewer sets</span></label>
      <div class="field"><label>Start</label><div class="seg">${[['next', 'Next week'], ['today', 'Today']].map(([v, t]) => `<button data-act="bStart" data-v="${esc(v)}" class="${esc(d.start === v ? 'on' : '')}">${t}</button>`).join('')}</div></div></div>
    ${paused.length ? `<div class="card muted">Pauses ${esc(paused.map(slotLabel).join(', '))}</div>` : ''}
    <div class="actions"><button data-act="blockSetupClose">Cancel</button><button class="primary" data-act="blockGo">Start the block</button></div>`;
}

// The end-of-block report, on Today until you choose what's next.
function blockReportCard() {
  const b = B.unseenReport(state);
  if (!b) return '';
  const r = b.report;
  const name = id => exOf(id)?.name ?? '?';
  const u = unit(), ju = B.jumpUnit(state);
  const num = (v, un = '', dp = 0) => (v == null ? '—' : `${dp ? v.toFixed(dp) : round(v)}${un}`);
  const row = (label, f, un = '', dp = 0) => `<div class="kv"><span>${esc(label)}</span><b>${r.before ? `${num(f(r.before), un, dp)} → ` : ''}${num(f(r.block), un, dp)}</b></div>`;
  return `<div class="card report"><h3>${esc(b.group)}: done${r.early ? ' (ended early)' : ''}</h3>
    <p class="meta">${r.weeks} week${r.weeks === 1 ? '' : 's'} · ${r.before ? `against the ${r.before.weeks} weeks before it` : 'fewer than 2 usable weeks before it, so the block alone'}</p>
    ${row('Sessions per week', x => x.sessionsPerWeek, '', 1)}
    <div class="kv"><span>As written</span><b>${r.asWritten} of ${r.sessions}${r.edited ? ' (plans edited)' : ''}</b></div>
    ${Object.keys(r.block.e1rm).map(id => row(`${name(id)} e1RM`, x => x.e1rm[id], ` ${u}`)).join('')}
    ${Object.keys(r.block.jumps).map(id => row(`${name(id)} best`, x => x.jumps[id], ` ${ju}`)).join('')}
    ${row('Sets/week in its slice', x => x.ownedSetsPerWeek, '', 1)}
    ${row('Your other goals hit', x => (x.goalsHit == null ? null : 100 * x.goalsHit), '%')}
    ${row('Pain flags', x => x.painFlags)}
    ${row('Morning energy', x => x.energy, '', 1)}
    <p><b>${esc(r.verdict)}</b></p>
    <div class="brow"><button class="primary small" data-act="blockAgain" data-id="${esc(b.id)}">Run it again</button><button class="small" data-act="blockSeen" data-id="${esc(b.id)}">Back to my goals</button><button class="small" data-act="blockCopy" data-id="${esc(b.id)}">Copy report</button></div></div>`;
}

// Starts today's program session: the plan as written (40% fewer sets on a deload), jumps swapped for holds on a sore
// morning, then T3s from your goals in the time left.
function startBlockSession(deload) {
  const t = B.today(state);
  const step = t?.due ?? t?.next;
  if (!step) return;
  const p = L.byId(state.plans, step.planId);
  const cur = currentSession();
  if (cur) { cur.status = 'paused'; cur.pausedAt = Date.now(); toast('Paused your open workout. Resume it from Today later.'); }
  const sore = Mo.jumpPain(state);
  let blocks = planBlocks(p);
  if (sore.length) blocks = blocks.filter(b => b.tier !== 'JUMP');
  const deloading = t.deload || !!deload;
  const s = createSession(blocks, 'custom', {
    planId: p.id, ...(p.note ? { planNote: p.note } : {}), blockRun: t.block.id, planItems: p.items.map(i => ({ ...i })),
    programLabel: `${t.block.group} · Week ${t.week} of ${t.block.weeks} · ${shortPlan(p.id)}`, ...(deloading ? { deload: true } : {}),
  });
  if (deloading) {
    for (const b of s.blocks) {
      const sets = blockSets(b), keep = B.deloadSets(sets.length);
      const drop = new Set(sets.slice(keep).map(x => x.id));
      state.sets = state.sets.filter(x => !drop.has(x.id));
    }
  }
  if (sore.length) addReliefHolds(s, sore.map(x => x.part));
  // T3s from your goals (and superset ideas, shown on each lift) in whatever time the plan leaves.
  const left = sessionBudget(s);
  if (left >= 8) {
    const res = L.buildMix(state, { ...s, minutes: left }, { T1: 0, T2: 0, T3: 4 }, Date.now(), { excludeFamilies: s.blocks.map(b => exOf(b.exerciseId)?.familyId) });
    const extra = res.blocks.filter(b => b.tier === 'T3');
    s.blocks.push(...extra);
    L.pairT3s(state, s.blocks, L.placeOf(state, s));
    for (const b of extra) genSets(s, b);
  }
  save();
  ui.tab = 'today';
  render(); window.scrollTo(0, 0);
}

function laterBanner(s) {
  const later = laterSets(s);
  if (!later.length) return '';
  const names = [...new Set(later.map(x => exOf(x.exerciseId)?.name).filter(Boolean))].join(', ');
  return `<div class="banner">${later.length} set${later.length === 1 ? '' : 's'} added in History (${esc(names)}). Done already?
    <div class="brow"><button class="small" data-act="laterPlanned">Not yet</button><button class="small" data-act="laterDone">Yes, done</button></div></div>`;
}

function viewSession(s) {
  const loc = L.placeOf(state, s);
  const credit = L.creditWeek(state);
  const est = s.minutes - sessionBudget(s);
  const rest = restSummary(state.sets.filter(x => x.sessionId === s.id));
  const burst = L.paceFor(state)?.bursty && !state.sets.some(x => x.sessionId === s.id && x.done);
  const bits = [loc?.name, s.source === 'focus' ? focusName(s.focusRegion, s.focusExplosive) : null, `${s.minutes} min`,
    s.intent && s.intent !== 'auto' ? INTENTS.find(i => i[0] === s.intent)?.[1] : null, L.leanOf(s) ? `${L.leanOf(s)} lean` : null, `est ${est}`, rest?.text].filter(Boolean);
  const ready = s.ready ? readyText(s.ready) : '';
  let h = `<header class="top"><div><h1>Today</h1><div class="sub">${esc(bits.join(' · '))}</div>
    ${s.skip?.length ? `<div class="sub">Skipping ${esc(s.skip.map(id => famOf(id)?.name).filter(Boolean).join(', '))}</div>` : ''}
    ${ready ? `<div class="sub ready">${esc(ready)}</div>` : ''}${burst ? '<div class="sub">Tick each set as you finish it to learn your pace.</div>' : ''}</div>
    <div class="hbtns">${hrPill()}<button class="small" data-act="moreTime">+ Time</button></div></header>`;
  h += laterBanner(s);
  if (s.blockRun) h += `<div class="banner program">${esc(s.programLabel ?? 'Program')}${s.deload ? ' · deload' : ''}</div>`;
  if (s.painSwap?.length) h += `<div class="card muted">No jumps today (${esc(s.painSwap.join(', '))}): isometric holds instead.</div>`;
  if (s.planNote) h += `<details class="plannote"><summary>Plan notes</summary><p>${esc(s.planNote)}</p></details>`;
  if (!s.blocks.length) h += `<div class="card muted">Nothing from your goals fits here. Add an exercise or use a plan.</div>`;
  // Goals nearly done: they fill little of the time and the rest came from the library. Offer a focused workout instead.
  const goalMin = s.goalMinutes ?? s.minutes - sessionBudget(s);
  if (s.source === 'suggested' && s.minutes - goalMin >= Math.max(15, s.minutes * 0.4) && !state.sets.some(x => x.sessionId === s.id && x.done)) {
    h += `<div class="card focusoffer"><b>${goalMin > 0 ? `Goals fill ${goalMin} of ${s.minutes} min` : 'No goals left here'}</b><p class="meta">Or a focused workout:</p>${focusButtons(L.leanOf(s))}</div>`;
  }
  // Each superset partner renders right after the block it's paired with.
  const ordered = [];
  for (const b of s.blocks) {
    if (b.pairOf && s.blocks.some(x => x.id === b.pairOf)) continue;
    ordered.push(b, ...s.blocks.filter(x => x.pairOf === b.id));
  }
  const ideas = pairIdeas(s, ordered, credit);
  h += ordered.map(b => viewBlock(s, b, credit, ideas.get(b.id))).join('');
  if (s.mobility?.length) h += `<div class="sectionhead"><h3>Mobility</h3></div>${s.mobility.map(viewMobItem).join('')}`;
  h += `<div class="addrow"><button class="addblock" data-act="addEx">+ Exercise</button><button class="addblock" data-act="mobPick" data-mode="workout">+ Mobility</button></div>`;
  if (s.focusNotes?.length) {
    h += `<details class="why" ${ui.whyOpen ? 'open' : ''} data-why><summary>How this was built</summary><ul>${s.focusNotes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>`;
  }
  if (s.why?.length) {
    // Picked goals get a tick; the rest say what held them back.
    h += `<details class="why" ${ui.whyOpen ? 'open' : ''} data-why><summary>Why this session</summary><ul>${s.why.map(w =>
      `<li class="${w.picked ? 'picked' : ''}"><b>${esc(w.label)}</b>${w.picked ? ' ✓' : w.note ? ` <span class="meta">${esc(w.note)}</span>` : ''}</li>`).join('')}</ul></details>`;
  }
  h += `<div class="actions">
    <button data-act="usePlan">Use a plan</button>
    ${['suggested', 'swapped', 'focus'].includes(s.source) ? '<button data-act="regen">Regenerate</button>' : ''}
    <button data-act="recheck">Check in again</button>
    <button data-act="pause">Pause</button>
    <button class="primary" data-act="finish">Finish</button></div>`;
  return h;
}

// One superset idea per main block that has sets left and no partner yet, each from a different family.
// With Conditioning supersets on at check-in, the first T1 and the first T2 get the bike instead.
function pairIdeas(s, ordered, credit) {
  const out = new Map();
  const used = s.blocks.map(b => exOf(b.exerciseId)?.familyId);
  const bike = s.condPair ? condPairExercise(s) : null;
  const firstOf = tier => ordered.find(b => b.tier === tier);
  for (const b of ordered) {
    if (!['T1', 'T2', 'TECH'].includes(b.tier) || b.noPair || inPair(s, b) || !blockSets(b).some(x => !x.done)) continue;
    if (bike && (b === firstOf('T1') || b === firstOf('T2'))) {
      out.set(b.id, { exercise: bike, tier: 'COND', why: `conditioning superset: ${condPairCal(b)} cal on the bike in each rest` });
      continue;
    }
    const ex = exOf(b.exerciseId);
    const idea = ex && L.suggestPair(state, s, ex, { excludeFamilies: used, credit });
    if (!idea) continue;
    out.set(b.id, idea);
    used.push(idea.exercise.familyId);
  }
  return out;
}

function viewBlock(s, b, credit, idea = null) {
  const ex = exOf(b.exerciseId), sc = schOf(b.schemeId);
  if (!ex || !sc) return `<div class="card muted">Missing exercise or scheme.</div>`;
  const cfg = state.tiers[b.tier];
  const max = ex.metric === 'load_reps' ? L.estimatedMax(state, ex.id) : null;
  const pct = L.targetPct(cfg, sc.reps);
  const sets = blockSets(b);

  // Progression: how this load follows from last time (see L.progression).
  const prog = L.progression(state, ex, b.tier, sc, s.checkinAt);
  let info = [];
  const there = L.elsewhere(ex, L.placeOf(state, s)); // several locations: say where this one is done
  if (there) info.push(`at ${esc(there.name)}`);
  // With progression the load is last time's (+ the increment), so show what share of your e1RM that really is.
  const progPct = prog && max ? (prog.load + (ex.bodyweight ? state.settings.bodyweight || 0 : 0)) / max : null;
  if (max) info.push(`e1RM ${round(max)}${ex.bodyweight ? ' total' : ''}${ex.metric === 'load_reps' && (progPct || pct) ? ` · ${round((progPct || pct) * 100)}%` : ''}`);
  else if (ex.metric === 'load_reps' && b.tier !== 'T3') info.push(`<button class="link" data-act="maxSet" data-id="${esc(ex.id)}">Set 1RM</button>`);
  const progLine = !prog ? '' : prog.up
    ? `<div class="dose prog up">↑ ${ex.bodyweight ? 'BW+' : ''}${prog.load} ${unit()} · every rep at ${prog.last.load} last time${prog.last.amrap != null ? `, ${prog.last.amrap} on the AMRAP` : ''}</div>`
    : `<div class="dose prog">${prog.down ? '↓' : '='} ${ex.bodyweight ? 'BW+' : ''}${prog.load} ${unit()}${prog.down ? '' : ' again'} · ${prog.last.short} rep${prog.last.short === 1 ? '' : 's'} short last time</div>`;
  const emom = sc.emom && b.restSec == null;
  const restBtn = emom
    ? `<button class="restchip" data-act="restEdit" data-b="${esc(b.id)}">⏱ every ${clock(sc.emom)}</button>${blockSets(b).some(x => x.done) || b.emomStart ? '' : ` <button class="restchip go-emom" data-act="emomStart" data-b="${esc(b.id)}">▶ Start EMOM</button>`}`
    : `<button class="restchip" data-act="restEdit" data-b="${esc(b.id)}">⏱ rest ${clock(effectiveRest(b))}${b.restSec != null ? ' (set today)' : ex.restSec != null ? ' (exercise)' : ''}</button>`;

  let dose = '';
  const slot = b.slotId && L.byId(state.slots, b.slotId);
  if (slot) {
    const r = credit.slots.get(slot.id);
    const agg = r?.days.get(L.dayKey()) || { reps: 0, sets: 0 };
    const need = L.slotDose(state, slot, b.tier).repMin;
    const orSets = L.TIER[b.tier]?.orSets;
    const prog = orSets ? `${agg.reps}/${need} ${L.repUnit(b.tier)} or ${agg.sets}/${cfg.setMin || orSets} ${L.setUnit(b.tier)}` : `${agg.reps}/${need} ${L.repUnit(b.tier)}`;
    const goal = esc(exOf(slot.exerciseId)?.name ?? famOf(slot.familyId)?.name ?? '');
    // "Count it": this exercise fills its goal today whatever the sets or reps (shown while it isn't already done, or once ticked).
    const box = b.countGoal || !r?.todayMet ? `<label class="countit"><input type="checkbox" data-countgoal="${esc(b.id)}" ${b.countGoal ? 'checked' : ''}> Count it</label>` : '';
    dose = `<div class="dose ${esc(r?.todayMet ? 'met' : '')}"><span>${r?.todayMet ? `✓ ${goal} goal done` : `${goal} · ${prog}`}</span>${box}</div>`;
  }
  if ((b.tier === 'T1' || b.tier === 'T2') && ex.metric !== 'load_reps' && !ex.explosive) {
    dose += `<div class="dose warn">Reps only: won't count toward a ${b.tier} goal</div>`;
  }

  const rest = restSummary(sets);
  if (rest) info.push(rest.text);

  if (ex.explosive && (b.tier === 'T1' || b.tier === 'T2')) {
    const rd = L.powerReadiness(state, s, ex, Date.now(), b.id);
    if (!rd.fresh) dose += `<div class="dose warn">Not fresh: ${esc(rd.reasons.join('; '))} · <button class="link" data-act="toTech" data-b="${esc(b.id)}">As technique</button></div>`;
  }

  const warmRows = warmSets(b).map((st, i) => {
    const hint = warmHint(b, ex, i);
    return `<div class="set warm ${st.done ? 'done' : ''}"><span class="n" title="Warm-up">W</span>
      <input class="num" inputmode="decimal" data-set="${esc(st.id)}" data-f="load" value="${esc(st.load)}" placeholder="${esc(hint.load ?? '—')}"><span class="u">${ex.bodyweight ? '+' : ''}${unit()}</span>
      <span class="x">×</span><input class="num" inputmode="numeric" data-set="${esc(st.id)}" data-f="reps" value="${esc(st.reps)}" placeholder="${esc(hint.reps)}">
      <button class="check" data-act="check" data-id="${esc(st.id)}" aria-label="Log warm-up set">${st.done ? '✓' : ''}</button></div>`;
  }).join('');

  const rows = sets.map((st, i) => {
    const sx = exOf(st.exerciseId) || ex;
    const other = st.exerciseId !== ex.id ? `<span class="meta">${esc(sx.name)}</span>` : '';
    let inputs = '';
    if (sx.metric === 'load_reps') {
      inputs = `<input class="num" inputmode="decimal" data-set="${esc(st.id)}" data-f="load" value="${esc(st.load)}" placeholder="—"><span class="u">${sx.bodyweight ? '+' : ''}${unit()}</span>
        <span class="x">×</span><input class="num" inputmode="numeric" data-set="${esc(st.id)}" data-f="reps" value="${esc(st.reps)}">`;
    } else if (sx.metric === 'reps') {
      inputs = `<input class="num" inputmode="numeric" data-set="${esc(st.id)}" data-f="reps" value="${esc(st.reps)}"><span class="u">${esc(sx.repUnit ?? 'reps')}</span>`;
    } else if (sx.metric === 'time') {
      inputs = `<input class="num" inputmode="numeric" data-set="${esc(st.id)}" data-f="time" value="${esc(st.time)}"><span class="u">sec</span>${st.done ? '' : goBtn(`data-act="workStart" data-id="${esc(st.id)}"`, state.timer?.target?.set === st.id)}`;
    } else if (sx.metric === 'distance') {
      inputs = `<input class="num" inputmode="decimal" data-set="${esc(st.id)}" data-f="distance" value="${esc(st.distance)}"><span class="u">m</span>`;
    }
    // Jumps: an optional height or distance, when you measure. The best is a record, like a 1RM.
    if (b.tier === 'JUMP' || L.isJump(sx)) inputs += `<input class="num jumpin" inputmode="decimal" data-set="${esc(st.id)}" data-f="jump" value="${esc(st.jump)}" placeholder="—" aria-label="${esc(jumpWord(sx))} (optional)"><span class="u">${B.jumpUnit(state)} ${jumpWord(sx) === 'Distance' ? '→' : '↑'}</span>`;
    return `<div class="set ${st.done ? 'done' : ''} ${st.amrap ? 'amrap' : ''}"><span class="n">${i + 1}</span>${inputs}${st.amrap ? '<span class="amraptag">AMRAP</span>' : ''}${st.done && st.pr ? `<span class="prtag" title="${esc(st.prText ?? 'Personal record')}" aria-label="${esc(st.prText ?? 'Personal record')}">🏆</span>` : ''}${other}
      <button class="check" data-act="check" data-id="${esc(st.id)}" aria-label="Log set">${st.done ? '✓' : ''}</button></div>`;
  }).join('');

  const vid = videoUrl(ex);
  const more = !!ui.bmore?.has(b.id);
  const group = groupOf(s, b);
  const main = b.pairOf && group[0] !== b ? group[0] : null;
  const others = group.filter(x => x !== b).map(x => esc(exOf(x.exerciseId)?.name)).join(' and ');
  const what = `${group.length > 2 ? 'Giant set' : 'Superset'} with ${others}`;
  const pairHead = main ? `<div class="sslabel">↔ ${what}
    <button class="link" data-act="pairUnlink" data-b="${esc(b.id)}">Unlink</button></div>` : '';
  const ideaRow = idea ? `<div class="pairidea"><span>↔ <b>${esc(idea.exercise.name)}</b>${idea.tier === 'COND' ? ` <span class="meta">${condPairCal(b)} cal each rest</span>` : ''}</span>
    <span class="brow"><button class="small" data-act="pairAdd" data-b="${esc(b.id)}" data-ex="${esc(idea.exercise.id)}">+ Add</button>
    <button class="small quiet" data-act="pairOpen" data-b="${esc(b.id)}">Other</button>
    <button class="small quiet" data-act="pairNo" data-b="${esc(b.id)}" aria-label="No thanks">✕</button></span></div>` : '';
  return `<section class="block ${main ? 'paired' : ''} ${esc(s.blocks.some(x => x.pairOf === b.id) ? 'haspair' : '')}">
    ${pairHead}
    <div class="bhead"><button class="tier ${esc(b.tier)}" data-act="tierEdit" data-b="${esc(b.id)}" aria-label="Change tier">${esc(b.tier)} ▾</button>
      <button class="chip" data-act="swapEx" data-b="${esc(b.id)}">${esc(ex.name)} ▾</button>
      <button class="chip" data-act="swapScheme" data-b="${esc(b.id)}">${esc(sc.name)} · ${b.pairOf ? '+' : ''}${round(L.setsMinutes(state, b, s.blocks))}m ▾</button>
      <button class="icon bremove" data-act="removeBlock" data-b="${esc(b.id)}" aria-label="Remove ${esc(ex.name)}" title="Remove exercise">✕</button></div>
    <div class="meta">${info.join(' · ')} ${restBtn}</div>
    ${progLine}${dose}
    <div class="sets">${warmRows}${rows}</div>
    <div class="brow">
      <button class="small" data-act="addSet" data-b="${esc(b.id)}">+ set</button>
      <button class="small" data-act="removeSet" data-b="${esc(b.id)}">− set</button>
      ${inPair(s, b) ? '' : `<button class="small" data-act="pairOpen" data-b="${esc(b.id)}">↔ Superset</button>`}
      <button class="small quiet ${more ? 'on' : ''}" data-act="bMore" data-b="${esc(b.id)}" aria-expanded="${esc(more)}" aria-label="More for ${esc(ex.name)}">⋯</button>
    </div>
    <div class="brow bmorerow" ${more ? '' : 'hidden'}>
      ${canWarm(b, ex) ? `<button class="small" data-act="addWarm" data-b="${esc(b.id)}">+ warm-up</button>` : ''}
      ${canAmrap(b, ex) ? `<button class="small ${b.amrap ? 'on' : ''}" data-act="amrapToggle" data-b="${esc(b.id)}" aria-pressed="${esc(!!b.amrap)}">AMRAP last</button>` : ''}
      <button class="small" data-act="timerStart" data-b="${esc(b.id)}">⏱ Rest now</button>
      <button class="small" data-act="exHist" data-id="${esc(ex.id)}">History</button>
      ${vid ? `<a class="small" href="${esc(vid)}" target="_blank" rel="noopener">▶ Video</a>` : ''}
      ${ex.cues ? `<p class="meta cuesline">${esc(ex.cues)}</p>` : ''}
    </div>
    ${ideaRow}
  </section>`;
}

function viewMobItem(item) {
  const ex = itemEx(item);
  if (!ex) return '';
  const t = ex.track, last = M.lastFor(state, ex.id, item.id);
  const input = (st, f, mode, ph = '—') => `<input class="num${esc(f === 'extra' ? ' wide' : '')}" inputmode="${esc(mode)}" data-mset="${esc(item.id)}|${esc(st.id)}" data-f="${esc(f)}" value="${esc(st[f])}" placeholder="${esc(ph)}">`;
  const rows = item.sets.map((st, i) => {
    let h = '';
    if (t.load) h += `${input(st, 'load', 'decimal')}<span class="u">${unit()}</span>`;
    if (t.reps) h += `${input(st, 'reps', 'numeric')}<span class="u">reps</span>`;
    // A timer only for moves dosed as a hold (couch stretch), not reps with a pause at the top (cobra).
    if (t.hold) h += `${input(st, 'hold', 'numeric')}<span class="u">s</span>${st.done || !ex.hold ? '' : goBtn(`data-act="mworkStart" data-i="${esc(item.id)}" data-s="${esc(st.id)}"`, state.timer?.target?.mset === st.id)}`;
    if (t.extra) h += input(st, 'extra', 'text', t.extra);
    return `<div class="set ${st.done ? 'done' : ''}"><span class="n">${i + 1}</span>${h}
      <button class="check" data-act="mcheck" data-i="${esc(item.id)}" data-s="${esc(st.id)}" aria-label="Log set">${st.done ? '✓' : ''}</button></div>`;
  }).join('');
  const vid = M.videoSearch(ex.video);
  const day = x => new Date(x).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<section class="block mob">
    <div class="bhead"><span class="tier MOB">${item.def ? 'JUMP' : 'MOB'}</span><span class="mobname">${esc(ex.name)}</span>
      <button class="icon bremove" data-act="mRemove" data-i="${esc(item.id)}" aria-label="Remove ${esc(ex.name)}" title="Remove exercise">✕</button></div>
    <div class="meta">${esc([M.doseText(ex), `rest ${clock(ex.restSec || 0)}`].join(' · '))}</div>
    ${last ? `<div class="dose">Last (${day(last.at)}): ${esc(M.itemText(ex, last.item, unit()))}${last.item.note ? ` · “${esc(last.item.note)}”` : ''}</div>` : ''}
    <div class="sets">${rows}</div>
    <input class="mobnote" data-mnote="${esc(item.id)}" value="${esc(item.note)}" placeholder="Notes">
    <div class="brow">
      <button class="small" data-act="mAddSet" data-i="${esc(item.id)}">+ set</button>
      <button class="small" data-act="mRemoveSet" data-i="${esc(item.id)}">− set</button>
      ${vid ? `<a class="small" href="${esc(vid)}" target="_blank" rel="noopener">▶ Video</a>` : ''}
    </div>
    ${ex.cues || ex.notes ? `<details class="cues"><summary>Cues${ex.notes ? ' and history' : ''}</summary>${ex.cues ? `<p>${esc(ex.cues)}</p>` : ''}${ex.notes ? `<p class="meta">${esc(ex.notes)}</p>` : ''}</details>` : ''}
  </section>`;
}

function viewMobSession(m, workoutOpen) {
  const total = m.items.reduce((n, it) => n + it.sets.length, 0);
  const done = m.items.reduce((n, it) => n + it.sets.filter(s => s.done).length, 0);
  const title = progLabel(m) ?? L.byId(state.mobility.routines, m.routineId)?.name ?? (m.parts?.length ? m.parts.join(', ') : 'Your picks');
  let h = `<header class="top"><div><h1>${m.program ? 'Jump program' : 'Mobility'}</h1><div class="sub">${esc(title)} · ${done}/${total} sets</div></div></header>`;
  if (workoutOpen) h += `<div class="banner">Workout still open · <button class="link" data-act="showWorkout">Switch to it</button></div>`;
  h += m.items.map(viewMobItem).join('') || '<div class="card muted">Nothing here yet.</div>';
  return h + `<button class="addblock" data-act="mobPick" data-mode="session">+ Add mobility</button>
    <div class="actions"><button data-act="mobDiscard">Discard</button><button class="primary" data-act="mobFinish">Finish</button></div>`;
}

const libModeSeg = () => `<div class="seg libmode"><button class="${esc(ui.libMode !== 'mobility' ? 'on' : '')}" data-act="libMode" data-v="strength">Strength</button>
  <button class="${esc(ui.libMode === 'mobility' ? 'on' : '')}" data-act="libMode" data-v="mobility">Mobility</button></div>`;

function viewMobLibrary() {
  const q = ui.libQuery.trim().toLowerCase(), pf = ui.mobPart;
  const last = M.lastDoneAt(state);
  const list = state.mobility.exercises.filter(e => (ui.showArchived || !e.archived) && (!q || e.name.toLowerCase().includes(q)) && (!pf || e.parts.includes(pf)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return `<header class="top"><h1>Library</h1><button class="primary" data-act="mobExNew">+ Mobility</button></header>${libModeSeg()}
    <input class="search" id="libq" placeholder="Search mobility" value="${esc(ui.libQuery)}" data-libq>
    <div class="chips">${M.BODY_PARTS.map(p => `<button class="chip ${esc(pf === p ? 'on' : '')}" data-act="mobPartFilter" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <div class="card">${list.map(e => `<div class="exrow"><button class="name" data-act="mobExEdit" data-id="${esc(e.id)}">${esc(e.name)}<span class="meta">${esc([M.doseText(e),
      last.has(e.id) ? fmtAgo(last.get(e.id)) : '', e.archived ? 'archived' : ''].filter(Boolean).join(' · '))}</span></button></div>`).join('') || '<p class="muted">No matches.</p>'}</div>`;
}

function viewMobRoutine(r) {
  return `<header class="top"><h1>${r.id ? 'Edit routine' : 'New mobility routine'}</h1></header>
    <div class="field"><label>Name</label><input id="mr-name" data-mrname value="${esc(r.name)}" placeholder="e.g. Hips before volleyball"></div>
    <div class="card">${r.items.map((id, i) => {
      const e = mobEx(id);
      return `<div class="exrow"><span class="name">${esc(e?.name ?? '?')}<span class="meta">${e ? esc(M.doseText(e)) : ''}</span></span>
        <button class="icon" data-act="mobRoutineMove" data-i="${esc(i)}" data-dir="-1" aria-label="Move up">↑</button>
        <button class="icon" data-act="mobRoutineMove" data-i="${esc(i)}" data-dir="1" aria-label="Move down">↓</button>
        <button class="icon" data-act="mobRoutineDel" data-i="${esc(i)}" aria-label="Remove">✕</button></div>`;
    }).join('') || '<p class="muted">No exercises yet.</p>'}</div>
    <button data-act="mobPick" data-mode="routine">+ Add exercises</button>
    <div class="actions">${r.id ? '<button class="danger" data-act="mobRoutineDelete">Delete</button>' : ''}
      <button data-act="mobRoutineCancel">Cancel</button><button class="primary" data-act="mobRoutineSave">Save routine</button></div>`;
}

// ---------- onboarding ----------
// A short setup that turns a few choices into weekly goals (js/onboard.js). New installs see it first; Settings → Set up again.
const OB_TITLES = { welcome: 'Welcome', you: 'About you', where: 'Where you train', week: 'Your week', heavy: 'Heavy lifts (T1)',
  support: 'Support work (T2)', pump: 'Accessories (T3)', maxes: '1-rep maxes', review: 'Your weekly goals' };

const obStepper = (kind, id, n) => `<div class="stepper small"><button data-act="obQuota" data-k="${esc(kind)}" data-id="${esc(id)}" data-d="-1" aria-label="Fewer">−</button><span>${n}</span><button data-act="obQuota" data-k="${esc(kind)}" data-id="${esc(id)}" data-d="1" aria-label="More">+</button></div>`;
const obChip = (kind, id, label, on) => `<button class="chip ${on ? 'on' : ''}" data-act="obToggle" data-k="${esc(kind)}" data-id="${esc(id)}">${esc(label)}</button>`;
// The picks of one kind with times a week for each.
const obPicked = (kind, picks, nameOf) => kind === 'pump' && L.t3AsAreas(state) ? '' : Object.keys(picks).length
  ? `<div class="card flush">${Object.entries(picks).map(([id, n]) => `<div class="frow"><span class="grow"><span class="name">${esc(nameOf(id))}</span><span class="meta">times a week</span></span>${obStepper(kind, id, n)}</div>`).join('')}</div>`
  : '';

function viewOnboard(d) {
  const step = O.STEPS[d.step];
  const n = O.STEPS.length - 1;
  const exName = id => exOf(id)?.name ?? '?';
  const famName = id => famOf(id)?.name ?? '?';
  let body = '';
  if (step === 'welcome') {
    body = `<p>A few questions to set up your weekly goals. About two minutes.</p>
      <button class="primary big" data-act="obNext">Start</button>
      <div class="actions"><button data-act="obImport">Import from FitNotes</button><button data-act="obSkip">${state.settings.onboarded ? 'Cancel' : 'Skip'}</button></div>`;
  } else if (step === 'you') {
    body = `<div class="menu">
        ${frow('Units', `<div class="seg">${['lb', 'kg'].map(u => `<button class="${esc(d.unit === u ? 'on' : '')}" data-act="obSet" data-k="unit" data-v="${esc(u)}">${u}</button>`).join('')}</div>`)}
        ${frow(`Bodyweight (${d.unit})`, `<input class="num" inputmode="decimal" data-ob="bodyweight" value="${esc(d.bodyweight ?? '')}">`)}
      </div>`;
  } else if (step === 'where') {
    body = `<p class="meta">Name each place and tap its gear.</p>` +
      d.locations.map((l, i) => `<div class="card">
        <input class="titleinput" data-ob="loc.${esc(i)}.name" value="${esc(l.name)}" aria-label="Location name">
        <div class="chips">${state.equipment.map(eq => `<button class="chip ${esc(l.equipment.includes(eq) ? 'on' : '')}" data-act="obEq" data-i="${esc(i)}" data-eq="${esc(eq)}">${esc(eq)}</button>`).join('')}</div>
        ${d.locations.length > 1 ? `<button class="link" data-act="obLocDel" data-i="${esc(i)}">Remove this location</button>` : ''}</div>`).join('') +
      `<button class="addblock" data-act="obLocAdd">+ Add location</button>`;
  } else if (step === 'week') {
    body = `<div class="menu">
        ${frow('Workouts a week', `<input class="num" inputmode="numeric" data-ob="week.workouts" value="${esc(d.week.workouts)}">`)}
        ${frow('Minutes each', `<input class="num" inputmode="numeric" data-ob="week.minutes" value="${esc(d.week.minutes)}">`)}
      </div>`;
  } else if (step === 'heavy' || step === 'support') {
    const kind = step === 'heavy' ? 't1' : 't2';
    const other = step === 'heavy' ? d.t2 : d.t1;
    const groups = O.strengthChoices(state, d);
    body = (step === 'heavy'
      ? `<p class="meta">Pick 2–3 to take heavy · ${Object.keys(O.picks(state, d, 't1')).length} picked</p>`
      : `<p class="meta">Moderate lifts, sets of 5–8</p>`) +
      groups.map(([label, list]) => `<div class="label">${label}</div><div class="chips">${list.filter(e => !(e.id in other)).map(e => obChip(kind, e.id, e.name, e.id in d[kind])).join('')}</div>`).join('') +
      `<button class="addblock" data-act="quickAdd" data-from="ob">+ Add an exercise</button>` +
      (step === 'support' ? `<div class="label">Power work (jumps, Olympic lifts)</div><div class="chips">${O.powerChoices(state, d).map(f => obChip('power', f.id, f.name, f.id in d.power)).join('')}</div>` : '') +
      obPicked(kind, O.picks(state, d, kind), exName) + (step === 'support' ? obPicked('power', O.picks(state, d, 'power'), famName) : '');
  } else if (step === 'pump') {
    body = `<p class="meta">Accessory areas; the exercises rotate</p>
      <div class="chips">${O.pumpChoices(state, d).map(f => obChip('pump', f.id, f.name, f.id in d.pump)).join('')}</div>` + obPicked('pump', O.picks(state, d, 'pump'), famName);
  } else if (step === 'maxes') {
    const ids = [...Object.keys(O.picks(state, d, 't1')), ...Object.keys(O.picks(state, d, 't2'))];
    body = ids.length
      ? `<p class="meta">Optional, in ${d.unit}. Blank: learned from your sets.</p>
        <div class="menu">${ids.map(id => frow(`${esc(exName(id))}${exOf(id)?.bodyweight ? ' <span class="hint">added load</span>' : ''}`,
          `<input class="num" inputmode="decimal" data-ob="max.${esc(id)}" value="${esc(d.maxes[id] ?? '')}" placeholder="1RM">`)).join('')}</div>`
      : `<p class="muted">No lifts picked.</p>`;
  } else if (step === 'review') {
    const slots = O.buildSlots(state, d);
    const b = O.draftBudget(state, d);
    const label = sl => sl.exerciseId ? exName(sl.exerciseId) : famName(sl.familyId);
    body = `<div class="card flush">${slots.map(sl => `<div class="slotrow"><span class="tier ${esc(sl.tier)}">${esc(sl.tier)}</span><span class="grow"><span class="name">${esc(label(sl))}</span></span><b>${sl.quota}/wk</b></div>`).join('') || '<p class="muted pad">No goals picked.</p>'}</div>
      <div class="card"><p>${b.room >= 0
        ? `<b>${round(b.used)}</b> of your <b>${round(b.total)}</b> minutes a week. Room for ${b.addT2} more T2 or ${b.addT3} more T3.`
        : `<b>${round(b.used)}</b> minutes, <b>${round(-b.room)}</b> over your ${round(b.total)}. Lower a few, accessories first.`}</p></div>
      <button class="primary big" data-act="obFinish">Save these goals</button>
      <p class="meta">Replaces your goals and locations; you can undo.</p>`;
  }
  const nav = step === 'welcome' || step === 'review' ? (step === 'review' ? `<div class="actions"><button data-act="obBack">Back</button></div>` : '')
    : `<div class="actions"><button data-act="obBack">Back</button><button class="primary" data-act="obNext">Next</button></div>`;
  return `<header class="top"><div><h1>${OB_TITLES[step]}</h1>${d.step ? `<div class="sub">Step ${d.step} of ${n}</div>` : ''}</div></header>${body}${nav}`;
}

// Goal time against training time, folded away: the summary line says whether it fits.
function weekBudgetCard() {
  const b = G.weekBudget(state);
  const src = k => b.fromHistory[k] ? 'last 4 weeks' : state.settings.week?.[k] ? '' : 'a guess';
  const range = ([lo, hi]) => lo === hi ? `${lo}` : `${lo}–${hi}`;
  const areas = L.t3AsAreas(state);
  const rows = L.TIERS.filter(t => L.TIER[t].core || b.count[t]).map(t => `<div class="frow"><span class="tier ${esc(t)}">${t}</span><span class="grow"><span class="name">${L.TIER[t].label}</span>
      <span class="meta">${t === 'T3' && areas ? 'areas · fill spare time' : `${L.takesTime(t) ? `~${round(b.cost[t])} min each` : 'in the warm-up'}${b.guide[t] ? ` · guide ${range(b.guide[t])}` : ''}`}</span></span>
      <b>${t === 'T3' && areas ? `${b.areas} area${b.areas === 1 ? '' : 's'}` : `${b.count[t]}/wk`}</b></div>`).join('');
  const verdict = b.room >= 0 ? (areas ? `${round(b.room)} min a week left for T3 areas and extras.` : `Room for ${b.addT2} more T2 or ${b.addT3} more T3 a week.`)
    : `${round(-b.room)} min over: lower a quota or two${areas ? '' : ', accessories first'}.`;
  const hint = k => (src(k) ? `<span class="meta">${src(k)}</span>` : '');
  return `<details class="card budget"><summary><b>Week budget</b> <span class="meta">${round(b.used)} of ${round(b.total)} min</span></summary>
    <div class="frow"><span class="grow"><span class="name">Workouts a week</span>${hint('workouts')}</span>${numIn('settings.week.workouts', state.settings.week?.workouts ?? '', `placeholder="${esc(b.workouts)}" data-rerender`)}</div>
    <div class="frow"><span class="grow"><span class="name">Minutes each</span>${hint('minutes')}</span>${numIn('settings.week.minutes', state.settings.week?.minutes ?? '', `placeholder="${esc(b.minutes)}" data-rerender`)}</div>
    ${rows}
    <p class="meta">${verdict}</p></details>`;
}

function viewWeek() {
  if (ui.history) return viewHistory(ui.history);
  if (ui.goalSuggest) return viewGoalSuggest(ui.goalSuggest);
  if (ui.review) return viewReview(ui.review);
  const c = L.creditWeek(state);
  const fmt = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dayName = k => new Date(k + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' });
  const left = L.daysLeftInWeek(state);
  let h = `<header class="top"><div><h1>This week</h1><div class="sub">${fmt(c.start)} – ${fmt(c.end - 864e5)} · ${left} day${left === 1 ? '' : 's'} left</div></div>
    <button class="small" data-act="histOpen">History</button></header>`;
  if (ui.goalsUndo) h += `<div class="banner">Goals updated. <button class="link" data-act="gsUndo">Undo</button></div>`;
  if (ui.reviewUndo) h += `<div class="banner">Goals changed. <button class="link" data-act="reviewUndo">Undo</button></div>`;
  h += lastWeekCard();
  h += weekBlockCard();
  const owned = B.ownedSlotIds(state);
  const allSlots = [...c.slots.values()].sort((a, b) => a.slot.tier.localeCompare(b.slot.tier) || (b.slot.priority - a.slot.priority));
  const slots = allSlots.filter(r => !owned.has(r.slot.id));
  const ownedRows = allSlots.filter(r => owned.has(r.slot.id));
  const goalRow = r => {
    const area = L.isArea(state, r.slot);
    const pips = area ? (r.exposures ? `<span class="meta">${r.exposures}×</span>` : '')
      : Array.from({ length: r.slot.quota }, (_, i) => `<span class="pip ${esc(i < r.filled ? 'on' : '')}"></span>`).join('');
    const unitOf = [L.repUnit(r.slot.tier), L.setUnit(r.slot.tier)];
    const days = [...r.days].map(([k, a]) => `${dayName(k)} ${a.reps ? `${a.reps} ${unitOf[0]}` : `${a.sets} ${unitOf[1]}`}${a.met ? ' ✓' : ''}`).join(' · ');
    const ex = exOf(r.slot.exerciseId);
    const name = ex?.name ?? famOf(r.slot.familyId)?.name;
    const sub = [r.slot.quota ? '' : 'paused', days].filter(Boolean).join(' · ');
    return `<button class="slotrow" data-act="goalEdit" data-id="${esc(r.slot.id)}"><span class="tier ${esc(r.slot.tier)}">${esc(r.slot.tier)}</span>
      <span class="grow"><span class="name">${esc(name)}</span>${sub ? `<span class="meta">${esc(sub)}</span>` : ''}</span>
      <span class="pips">${pips}</span></button>`;
  };
  h += `<div class="sectionhead"><h3>Weekly goals</h3><div class="brow"><button class="small" data-act="gsOpen">Suggest</button><button class="small" data-act="goalNew">+ Goal</button></div></div>
    <div class="card flush">${slots.map(goalRow).join('') || '<p class="muted pad">No weekly goals yet.</p>'}</div>`;
  if (ownedRows.length) {
    h += `<details class="owned"><summary>${ownedRows.length} paused for ${esc(state.block?.group ?? 'the program')}</summary><div class="card flush">${ownedRows.map(goalRow).join('')}</div></details>`;
  }
  h += `<div class="brow pad"><button class="small" data-act="reviewOpen" data-w="${esc(c.start)}">Review this week</button></div>`;
  h += weekBudgetCard();

  const sets = state.sets.filter(s => s.done && !s.warmup && s.loggedAt >= c.start && s.loggedAt < c.end).sort((a, b) => a.loggedAt - b.loggedAt);
  if (sets.length) {
    // What each set counts toward, to fix by hand: folded away.
    const byDay = new Map();
    for (const s of sets) { const k = L.dayKey(s.loggedAt); byDay.set(k, [...(byDay.get(k) || []), s]); }
    const blocksById = L.blockIndex(state);
    h += `<details class="card setsweek"><summary><b>Sets this week</b> <span class="meta">${sets.length}</span></summary>`;
    for (const [k, list] of byDay) {
      h += `<div class="dayhead">${dayName(k)}</div>${list.map(s => {
        const ex = exOf(s.exerciseId);
        const auto = L.autoSlotFor(state, s, blocksById);
        const autoLbl = auto ? slotLabel(L.byId(state.slots, auto)) : 'none';
        const val = s.countsManual ? (s.countsToward ?? 'none') : 'auto';
        return `<div class="setlog"><div class="grow"><span class="tier ${esc(s.tier)}">${esc(s.tier)}</span> ${esc(ex?.name ?? '?')} <span class="meta">${esc(setAmount(ex, s))}</span></div>
          <select data-counts="${esc(s.id)}" aria-label="Counts toward">${opts([['auto', `Auto: ${autoLbl}`], ...state.slots.map(sl => [sl.id, slotLabel(sl)]), ['none', 'Nothing']], val)}</select></div>`;
      }).join('')}`;
    }
    h += `</details>`;
  }
  const mw = M.weekSummary(state, c.start, c.end);
  if (mw.sessions) h += `<div class="card"><b>Mobility</b> <span class="meta">${mw.sessions} session${mw.sessions === 1 ? '' : 's'}${mw.parts.length ? ` · ${esc(mw.parts.join(', '))}` : ''}</span></div>`;
  for (const d of P.PROGRAMS) {
    const p = P.progress(state, d.id);
    if (!p) continue;
    const n = P.programSessions(state, d.id).filter(m => m.startedAt >= c.start && m.startedAt < c.end).length;
    h += `<button class="card row" data-act="progOpen" data-id="${esc(d.id)}"><span><b>${esc(d.name)}</b>
      <span class="meta">${n}/${d.days} days · ${p.finished ? 'finished' : `next: week ${p.week}, day ${p.day}`}</span></span><span>›</span></button>`;
  }
  return h;
}

// ---------- history ----------

const HISTORY_PAGE = 20;

// Every workout and mobility session with something logged, newest first. Each lists its exercises in the
// order they were first logged; a search keeps only sessions (and exercises) whose name matches.
function historyEntries(q) {
  const match = name => !q || (name || '').toLowerCase().includes(q);
  const bySession = new Map();
  for (const st of state.sets) {
    if (!st.done) continue;
    if (!bySession.has(st.sessionId)) bySession.set(st.sessionId, []);
    bySession.get(st.sessionId).push(st);
  }
  const mobLines = items => (items || []).filter(it => it.sets.some(x => x.done) && match(itemEx(it)?.name));
  const out = [];
  for (const s of state.sessions) {
    const sets = (bySession.get(s.id) || []).sort((a, b) => a.loggedAt - b.loggedAt);
    const groups = new Map();
    for (const st of sets) {
      const ex = exOf(st.exerciseId);
      if (!match(ex?.name)) continue;
      const k = `${st.exerciseId}|${st.tier}`;
      if (!groups.has(k)) groups.set(k, { ex, tier: st.tier, sets: [] });
      groups.get(k).sets.push(st);
    }
    const mob = mobLines(s.mobility);
    if (!groups.size && !mob.length) continue;
    const times = [...sets.map(x => x.loggedAt), ...(s.mobility || []).flatMap(it => it.sets.filter(x => x.done).map(x => x.at))].filter(Boolean);
    out.push({ s, at: times.length ? Math.min(...times) : s.checkinAt, end: times.length ? Math.max(...times) : s.checkinAt, sets: sets.filter(x => !x.warmup).length, groups: [...groups.values()], mob });
  }
  for (const m of state.mobility.sessions) {
    const mob = mobLines(m.items);
    if (!mob.length) continue;
    const times = m.items.flatMap(it => it.sets.filter(x => x.done).map(x => x.at)).filter(Boolean);
    out.push({ m, at: times.length ? Math.min(...times) : m.startedAt, end: times.length ? Math.max(...times) : m.startedAt, groups: [], mob });
  }
  return out.sort((a, b) => b.at - a.at);
}

// "185×5 (×3), 190×3": repeats of the same set are counted, not listed.
function setsText(ex, sets) {
  const runs = [];
  for (const st of sets) {
    const a = setAmount(ex, st);
    if (runs.at(-1)?.a === a) runs.at(-1).n++;
    else runs.push({ a, n: 1 });
  }
  return runs.map(r => r.n > 1 ? `${r.a} (×${r.n})` : r.a).join(', ');
}

function histSets(g) {
  const warm = g.sets.filter(x => x.warmup), work = g.sets.filter(x => !x.warmup);
  const w = warm.map(x => x.load != null || x.reps != null ? `${x.load ?? '—'}×${x.reps ?? '—'}` : '✓').join(', ');
  return [w && `warm-up ${w}`, work.length && setsText(g.ex, work)].filter(Boolean).join(' · ');
}

// ---------- editing a past workout ----------

// A past workout's exercises as { key, ex, tier, sets }: the sets logged for one exercise at one tier, in the order logged.
function histGroups(s) {
  const groups = new Map();
  for (const st of state.sets.filter(x => x.sessionId === s.id && x.done).sort((a, b) => a.loggedAt - b.loggedAt)) {
    const key = `${st.exerciseId}|${st.tier}`;
    if (!groups.has(key)) groups.set(key, { key, ex: exOf(st.exerciseId), tier: st.tier, sets: [] });
    groups.get(key).sets.push(st);
  }
  return [...groups.values()];
}

// After an edit: a block with no sets left goes, the rest follow their sets, and a superset link to a gone block is dropped.
function tidyBlocks(s) {
  const blocks = (s.blocks || []).filter(b => state.sets.some(x => x.blockId === b.id));
  for (const b of blocks) {
    const first = state.sets.find(x => x.blockId === b.id);
    b.exerciseId = first.exerciseId; b.tier = first.tier;
    if (b.pairOf && !blocks.some(x => x.id === b.pairOf)) delete b.pairOf;
  }
  s.blocks = blocks;
}

// What undo needs to put a workout back exactly: the session and its sets.
const sessionSnap = s => ({ at: state.sessions.indexOf(s), session: structuredClone(s), sets: state.sets.filter(x => x.sessionId === s.id).map(x => ({ ...x })) });
function restoreSnap(snap) {
  const id = snap.session.id;
  state.sessions = state.sessions.filter(x => x.id !== id);
  state.sessions.splice(Math.min(snap.at, state.sessions.length), 0, snap.session);
  state.sets = [...state.sets.filter(x => x.sessionId !== id), ...snap.sets];
  save(); render();
}

// A finished set for an exercise added to (or extended in) a past workout, prefilled from `from` or your last time.
function histNewSet(s, block, ex, at, from = null) {
  const loaded = ex?.metric === 'load_reps';
  return {
    id: L.uid(), sessionId: s.id, blockId: block.id, exerciseId: ex.id, tier: block.tier, schemeId: null,
    load: loaded ? (from?.load ?? L.lastLoad(state, ex.id)) : null,
    reps: ['load_reps', 'reps'].includes(ex.metric) ? from?.reps ?? null : null,
    time: ex.metric === 'time' ? from?.time ?? lastTime(ex.id) : null, distance: ex.metric === 'distance' ? from?.distance ?? null : null,
    done: true, loggedAt: at, addedLater: true, ...(state.settings.bodyweight ? { bw: state.settings.bodyweight } : {}),
  };
}

// Sets added in the History editor (logged as done after the fact; before addedLater, those were the ones with no scheme).
// Continuing a workout asks about them: done, or what you're about to do.
const laterSets = s => s.source === 'imported' ? [] : state.sets.filter(x => x.sessionId === s.id && x.done && !x.warmup && (x.addedLater || x.schemeId == null));

// A scheme for a block of sets logged in History: one with that many sets of those reps, else the usual pick.
function schemeForSets(s, b, sets) {
  const reps = Number(sets[0]?.reps) || null;
  return L.schemeOptions(state, b.tier).find(sc => sc.sets === sets.length && (reps == null || sc.reps === reps))
    ?? schemeForBlock(s, exOf(b.exerciseId), b.tier, b);
}

// `done`: they were done (they stay logged, in the workout's block for that exercise); else they're the plan for now
// (unticked, or dropped when the workout already has that exercise waiting).
function resolveLater(s, done) {
  const byBlock = new Map();
  for (const x of laterSets(s)) byBlock.set(x.blockId, [...(byBlock.get(x.blockId) || []), x]);
  for (const [blockId, sets] of byBlock) {
    let b = s.blocks.find(x => x.id === blockId);
    if (!b) { b = { id: blockId, tier: sets[0].tier, slotId: slotIdFor(sets[0].exerciseId, sets[0].tier), exerciseId: sets[0].exerciseId, schemeId: null, swaps: [] }; s.blocks.push(b); }
    const twin = s.blocks.find(x => x !== b && x.exerciseId === b.exerciseId && x.tier === b.tier && schOf(x.schemeId));
    const target = schOf(b.schemeId) ? b : twin ?? b;
    if (!done && target !== b) { state.sets = state.sets.filter(x => !sets.includes(x)); continue; } // the workout has it waiting already
    if (!schOf(target.schemeId)) target.schemeId = schemeForSets(s, target, sets).id;
    for (const x of sets) {
      x.blockId = target.id; x.schemeId = target.schemeId; delete x.addedLater;
      if (!done) { x.done = false; delete x.loggedAt; }
    }
    if (done) genSets(s, target); // the rest of its scheme, if any is left
  }
  s.blocks = s.blocks.filter(b => state.sets.some(x => x.blockId === b.id));
  for (const b of s.blocks) if (b.pairOf && !s.blocks.some(x => x.id === b.pairOf)) delete b.pairOf;
  const first = state.sets.filter(x => x.sessionId === s.id && x.done && x.loggedAt).map(x => x.loggedAt);
  s.firstSetAt = first.length ? Math.min(...first) : null;
}

// Picking an exercise in the sheet: change a group to it, or add it as a new group with one set.
// The tier for an exercise you add by hand: conditioning is always conditioning (so it counts toward that goal), the rest
// is the tier you picked in the sheet.
const tierFor = (ex, asked) => (L.isConditioning(state, ex) ? 'COND' : asked);

// Records the set's personal record on it (L.setPR), or clears it. Returns whether it is one.
function markPR(st) {
  const pr = st.done ? L.setPR(state, st) : null;
  if (pr) { st.pr = pr.kind; st.prText = pr.text; } else { delete st.pr; delete st.prText; }
  return !!pr;
}

function histPick(exerciseId) {
  const sh = ui.sheet, s = L.byId(state.sessions, sh.sessionId), ex = exOf(exerciseId);
  if (!s || !ex) return;
  const snap = sessionSnap(s);
  if (sh.mode === 'histSwap') {
    for (const st of histGroups(s).find(g => g.key === sh.group)?.sets ?? []) st.exerciseId = exerciseId;
    tidyBlocks(s);
  } else {
    const last = state.sets.filter(x => x.sessionId === s.id && x.done).reduce((m, x) => Math.max(m, x.loggedAt), s.firstSetAt ?? s.checkinAt ?? Date.now());
    const tier = tierFor(ex, sh.tier);
    const block = { id: L.uid(), tier, slotId: slotIdFor(ex.id, tier), exerciseId: ex.id, schemeId: null, swaps: [{ type: 'add', to: ex.id, at: Date.now() }] };
    (s.blocks ??= []).push(block);
    state.sets.push(histNewSet(s, block, ex, last + 1000));
  }
  ui.sheet = null; renderSheet();
  save(); render();
  toast(sh.mode === 'histSwap' ? `Changed to ${ex.name}` : `Added ${ex.name} as ${tierFor(ex, sh.tier)}`, () => restoreSnap(snap));
}

// Moves a workout to another day, keeping its time of day: its sets, check-in and any mobility in it move together.
function moveWorkout(dateStr) {
  const s = L.byId(state.sessions, ui.history?.edit), m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(dateStr);
  if (!s || !m) return;
  const old = new Date(s.firstSetAt ?? s.checkinAt);
  const to = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), old.getHours(), old.getMinutes(), old.getSeconds());
  if (to.getTime() > Date.now()) { toast('That day hasn\'t happened yet'); return render(); }
  const delta = to.getTime() - old.getTime();
  if (!delta) return;
  for (const st of state.sets) if (st.sessionId === s.id) st.loggedAt += delta;
  s.checkinAt += delta;
  if (s.firstSetAt) s.firstSetAt += delta;
  for (const it of s.mobility || []) for (const x of it.sets || []) if (x.at) x.at += delta;
  s.day = L.dayKey(s.checkinAt);
  save(); render();
}

// First logged set to last, in minutes, or null.
function loggedMinutes(s) {
  const ts = state.sets.filter(x => x.sessionId === s.id && x.done && x.loggedAt).map(x => x.loggedAt);
  return ts.length ? Math.round((Math.max(...ts) - Math.min(...ts)) / 60e3) : null;
}

function viewHistoryEdit(hs) {
  const s = L.byId(state.sessions, hs.edit);
  if (!s) { delete hs.edit; return viewHistory(hs); }
  const when = s.firstSetAt ?? s.checkinAt;
  const setRow = (g, st, i) => {
    const sx = exOf(st.exerciseId) || g.ex;
    let inputs = '';
    if (sx?.metric === 'load_reps') inputs = `<input class="num" inputmode="decimal" data-set="${esc(st.id)}" data-f="load" value="${esc(st.load)}" placeholder="—"><span class="u">${sx.bodyweight ? '+' : ''}${unit()}</span>
      <span class="x">×</span><input class="num" inputmode="numeric" data-set="${esc(st.id)}" data-f="reps" value="${esc(st.reps)}">`;
    else if (sx?.metric === 'time') inputs = `<input class="num" inputmode="numeric" data-set="${esc(st.id)}" data-f="time" value="${esc(st.time)}"><span class="u">sec</span>`;
    else if (sx?.metric === 'distance') inputs = `<input class="num" inputmode="decimal" data-set="${esc(st.id)}" data-f="distance" value="${esc(st.distance)}"><span class="u">m</span>`;
    else inputs = `<input class="num" inputmode="numeric" data-set="${esc(st.id)}" data-f="reps" value="${esc(st.reps)}"><span class="u">${esc(sx?.repUnit ?? 'reps')}</span>`;
    return `<div class="set ${st.warmup ? 'warm' : ''}"><span class="n" ${st.warmup ? 'title="Warm-up"' : ''}>${st.warmup ? 'W' : i + 1}</span>${inputs}
      <button class="icon setdel" data-act="histDelSet" data-id="${esc(st.id)}" aria-label="Delete this set">✕</button></div>`;
  };
  const groups = histGroups(s).map(g => {
    let n = 0;
    // Count it, as in a live workout: the exercise's block fills its goal that day whatever the sets or reps.
    const blk = s.blocks.find(x => x.id === g.sets[0]?.blockId && x.slotId && L.byId(state.slots, x.slotId));
    const count = blk ? `<label class="countit"><input type="checkbox" data-countgoal="${esc(blk.id)}" data-hist="${esc(s.id)}" ${blk.countGoal ? 'checked' : ''}> Count it toward ${esc(slotLabel(L.byId(state.slots, blk.slotId)))}</label>` : '';
    return `<section class="card histedit">
      <div class="bhead"><select class="tierpick ${esc(g.tier)}" data-hgtier="${esc(g.key)}" aria-label="Tier">${L.TIERS.map(t => `<option value="${esc(t)}" ${t === g.tier ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <button class="chip" data-act="histSwap" data-g="${esc(g.key)}">${esc(g.ex?.name ?? '?')} ▾</button>
        <button class="icon bremove" data-act="histDelGroup" data-g="${esc(g.key)}" aria-label="Remove ${esc(g.ex?.name ?? 'exercise')} from this workout" title="Remove exercise">✕</button></div>
      <div class="sets">${g.sets.map(st => setRow(g, st, st.warmup ? 0 : n++)).join('')}</div>
      <div class="brow"><button class="small" data-act="histAddSet" data-g="${esc(g.key)}">+ set</button>${count}</div></section>`;
  }).join('');
  return `<header class="top sub"><button class="back" data-act="histEditDone">‹ History</button></header><h1 class="pagetitle">Edit workout</h1>
    <div class="card"><div class="field"><label for="hist-date">Date</label><input id="hist-date" type="date" data-hdate max="${esc(L.dayKey())}" value="${esc(L.dayKey(when))}"></div>
      <div class="field"><label for="hist-loc">Where</label><select id="hist-loc" data-hloc>${[['', '—'], ...state.locations.map(l => [l.id, l.name])].map(([v, t]) => `<option value="${esc(v)}" ${v === (s.locationId ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="field"><label for="hist-dur">How long (min) <span class="hint">optional</span></label><input id="hist-dur" class="num" inputmode="numeric" data-hdur value="${esc(s.durationMin ?? '')}" placeholder="${esc(loggedMinutes(s) ?? '')}">
</div></div>
    ${groups || '<p class="muted">No exercises left in this workout.</p>'}
    <button class="addblock" data-act="histAddEx">+ Add exercise</button>
    <div class="actions"><button class="danger" data-act="histDeleteWorkout">Delete workout</button><button class="primary" data-act="histEditDone">Done</button></div>`;
}

const histTabs = mode => `<div class="seg histmode"><button class="${esc(mode !== 'progress' ? 'on' : '')}" data-act="histMode" data-v="workouts">Workouts</button><button class="${esc(mode === 'progress' ? 'on' : '')}" data-act="histMode" data-v="progress">Progress</button></div>`;

function viewHistory(hs) {
  if (hs.edit) return viewHistoryEdit(hs);
  if (hs.mode === 'progress') return viewProgress();
  const q = hs.q.trim().toLowerCase();
  const all = historyEntries(q);
  const shown = all.slice(0, hs.limit);
  const thisYear = new Date().getFullYear();
  const dateText = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(new Date(t).getFullYear() !== thisYear ? { year: 'numeric' } : {}) });
  const card = e => {
    const { s, m } = e;
    const bits = [];
    if (s) {
      if (s.source === 'imported') bits.push('from FitNotes');
      else {
        bits.push(L.placeOf(state, s)?.name);
        const mins = s.durationMin ?? Math.round((e.end - e.at) / 60e3);
        if (mins > 0) bits.push(`${mins} min`);
      }
      if (e.sets) bits.push(`${e.sets} set${e.sets === 1 ? '' : 's'}`);
      if (s.hr) bits.push(hrText(s.hr));
      if (s.status === 'open' || s.status === 'paused') bits.push(s.status === 'open' ? 'in progress' : 'paused');
    } else {
      bits.push(progLabel(m) ?? L.byId(state.mobility.routines, m.routineId)?.name ?? (m.parts?.length ? m.parts.join(', ') : 'Mobility'));
      if (m.status === 'open') bits.push('in progress');
    }
    const lines = e.groups.map(g => `<div class="histex"><span class="tier ${esc(g.tier)}">${esc(g.tier)}</span><span class="grow"><span class="name">${esc(g.ex?.name ?? '?')}</span>
      <span class="meta">${esc(histSets(g))}${g.sets.some(x => x.pr) ? ` · <span class="prtag" title="${esc(g.sets.filter(x => x.pr).map(x => x.prText).join('; '))}">🏆</span> ${esc(g.sets.filter(x => x.pr).map(x => x.prText).at(-1) ?? 'PR')}` : ''}</span></span></div>`).join('')
      + e.mob.map(it => {
        const ex = itemEx(it);
        return `<div class="histex"><span class="tier MOB">${it.def ? 'JUMP' : 'MOB'}</span><span class="grow"><span class="name">${esc(ex?.name ?? '?')}</span>
          <span class="meta">${esc(ex ? M.itemText(ex, it, unit()) : '')}${it.note ? ` · “${esc(it.note)}”` : ''}</span></span></div>`;
      }).join('');
    const editable = s && s.status !== 'open' && s.status !== 'paused';
    return `<div class="card hist"><div class="histhead"><b>${esc(dateText(e.at))}</b><span class="meta">${esc(bits.filter(Boolean).join(' · '))}</span>
      ${editable ? `<span class="brow">${s.status === 'done' && s.source !== 'imported' ? `<button class="small" data-act="sessionContinue" data-id="${esc(s.id)}">Continue</button>` : ''}<button class="small" data-act="histEdit" data-id="${esc(s.id)}">Edit</button></span>` : ''}</div>${lines}</div>`;
  };
  return `<header class="top sub"><button class="back" data-act="histClose">‹ This week</button></header><h1 class="pagetitle">History</h1>
    ${histTabs(hs.mode)}
    <input class="search" id="histq" placeholder="Search an exercise" value="${esc(hs.q)}" data-histq>
    ${q ? `<p class="meta pad">${all.length} session${all.length === 1 ? '' : 's'} with “${esc(hs.q.trim())}”.</p>` : ''}
    ${shown.map(card).join('') || `<p class="muted">${q ? 'No sessions match.' : 'Nothing logged yet. Finished workouts and mobility sessions show up here.'}</p>`}
    ${all.length > shown.length ? `<button class="addblock" data-act="histMore">Show ${Math.min(HISTORY_PAGE, all.length - shown.length)} more (${all.length - shown.length} older)</button>` : ''}`;
}

// ---------- progress (History → Progress) ----------

// Hover and tap readouts: each chart's hit points, by chart id (filled as the page renders).
const chartHits = new Map();
const fmtShortDay = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const weekLabel = t => `Week of ${new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
const signedNum = (v, dp = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}`;

// One chart in a card: title, a one-line takeaway, the chart, and the same numbers as a table.
function chartCard(id, title, takeaway, chart, table, extra = '') {
  chartHits.set(id, chart.hits);
  const body = chart.svg
    ? `<div class="chartwrap">${chart.svg}<div class="charttip" hidden></div></div>
       <details class="charttable"><summary>Show as table</summary><table><thead><tr>${table.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
       <tbody>${table.rows.slice().reverse().map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`
    : '<p class="muted">Nothing logged in this range.</p>';
  return `<div class="card chartcard"><h3>${esc(title)}</h3>${extra}${takeaway ? `<p class="meta">${takeaway}</p>` : ''}${body}</div>`;
}

const legend = keys => `<div class="legend">${keys.map(([k, name]) => `<span><i style="background:${esc(CH.COLORS[k])}"></i>${esc(name)}</span>`).join('')}</div>`;

function viewProgress() {
  const pg = ui.prog ??= { range: '12w', lift: null };
  const { from, to, days } = PG.rangeBounds(state, pg.range);
  const prev = { from: from - (to - from), to: from };
  const u = unit();
  chartHits.clear();
  let h = `<header class="top sub"><button class="back" data-act="histClose">‹ This week</button></header><h1 class="pagetitle">History</h1>
    ${histTabs('progress')}
    <div class="seg ranges">${PG.RANGES.map(([k, t]) => `<button class="${esc(pg.range === k ? 'on' : '')}" data-act="progRange" data-v="${esc(k)}">${t}</button>`).join('')}</div>`;

  // Tiles: per-week averages in this range, against the same length of time before it.
  const now = PG.summary(state, from, to), was = pg.range === 'all' ? null : PG.summary(state, prev.from, prev.to);
  const tile = (label, v, w, fmt, dp = 0) => `<div class="tile"><div class="tlabel">${label}</div><div class="tvalue">${v == null ? '—' : fmt(v)}</div>
    ${was && v != null && w > 0 ? `<div class="tdelta">${signedNum(100 * (v - w) / w)}% vs prior ${pg.range === '1y' ? 'year' : `${Math.round(days / 7)} wk`}</div>` : ''}</div>`;
  h += `<div class="tiles">
    ${tile('Workouts / week', now.workouts, was?.workouts, v => v.toFixed(1))}
    ${tile(`Volume / week (${u})`, now.volume, was?.volume, CH.fmtNum)}
    ${tile('Reps / week', now.reps, was?.reps, CH.fmtNum)}
    ${tile('Average energy', now.energy, was?.energy, v => `${v.toFixed(1)} / 5`)}</div>`;

  // Estimated 1RM for one lift.
  const lifts = PG.liftOptions(state);
  if (lifts.length) {
    if (!lifts.some(x => x.id === pg.lift)) {
      const goalLift = state.slots.filter(sl => sl.tier === 'T1').map(sl => sl.exerciseId ?? famOf(sl.familyId)?.defaultExerciseId).find(id => lifts.some(x => x.id === id));
      pg.lift = goalLift ?? lifts[0].id;
    }
    const ser = PG.e1rmSeries(state, pg.lift, from, to);
    const ch = PG.liftChange(ser);
    const name = exOf(pg.lift)?.name ?? '?';
    const chart = CH.lineChart('e1rm', `${name} estimated 1-rep max`, ser.map(p => ({ t: p.t, v: p.v, tip: { value: `${Math.round(p.v)} ${u}`, title: fmtShortDay(p.t), sub: `best set ${p.load} × ${p.reps}` } })), { unit: '' });
    const take = ch ? `<b>${signedNum(ch.delta)} ${u}</b> · ${Math.round(ch.first)} → ${Math.round(ch.last)}${ch.best > ch.last ? ` · best ${Math.round(ch.best)}` : ''}` : '';
    h += chartCard('e1rm', 'Estimated 1-rep max', take, chart,
      { head: ['Day', `e1RM (${u})`, 'Best set'], rows: ser.map(p => [fmtShortDay(p.t), Math.round(p.v), `${p.load} × ${p.reps}`]) },
      `<select class="liftpick" data-proglift aria-label="Lift">${opts(lifts.map(x => [x.id, x.name]), pg.lift)}</select>`);
  }

  // Volume and reps per workout.
  const ws = PG.workouts(state, from, to);
  const avg = k => ws.length ? ws.reduce((x, w) => x + w[k], 0) / ws.length : 0;
  const half = k => { const n = Math.floor(ws.length / 2); if (n < 2) return ''; const a = ws.slice(0, n), b = ws.slice(-n); const m = xs => xs.reduce((x, w) => x + w[k], 0) / xs.length; const d = m(a) ? 100 * (m(b) - m(a)) / m(a) : 0; return ` · last ${n} vs first ${n}: ${signedNum(d)}%`; };
  h += chartCard('volume', 'Volume per workout', ws.length ? `Avg <b>${CH.fmtNum(avg('volume'))} ${u}</b>${half('volume')}` : '',
    CH.columnChart('volume', 'Volume per workout', ws.map(w => ({ t: w.t, parts: [{ key: 'series', v: w.volume }], tip: { value: `${CH.fmtNum(w.volume)} ${u}`, title: fmtShortDay(w.t), sub: `${w.sets} sets` } }))),
    { head: ['Workout', `Volume (${u})`, 'Sets'], rows: ws.map(w => [fmtShortDay(w.t), Math.round(w.volume).toLocaleString('en-US'), w.sets]) });
  h += chartCard('reps', 'Reps per workout', ws.length ? `Avg <b>${Math.round(avg('reps'))}</b>${half('reps')}` : '',
    CH.columnChart('reps', 'Reps per workout', ws.map(w => ({ t: w.t, parts: [{ key: 'series', v: w.reps }], tip: { value: `${w.reps} reps`, title: fmtShortDay(w.t), sub: `${w.sets} sets` } }))),
    { head: ['Workout', 'Reps', 'Sets'], rows: ws.map(w => [fmtShortDay(w.t), w.reps, w.sets]) });

  // Energy by day.
  const en = PG.energySeries(state, from, to);
  const low = en.filter(e => e.v <= 2).length;
  h += chartCard('energy', 'Energy by day', en.length ? `Avg <b>${(en.reduce((x, e) => x + e.v, 0) / en.length).toFixed(1)}</b> · ${low} low day${low === 1 ? '' : 's'}` : '',
    CH.lineChart('energy', 'Energy by day', en.map(e => ({ t: e.t, v: e.v, tip: { value: `${e.v} / 5`, title: fmtShortDay(e.t), sub: e.source === 'morning' ? 'morning check' : 'check-in' } })), { domain: [1, 5], fmt: v => String(v) }),
    { head: ['Day', 'Energy', 'From'], rows: en.map(e => [fmtShortDay(e.t), e.v, e.source]) });

  // Heart rate per workout (a strap was on): average and peak.
  const hrs = state.sessions.filter(s => s.hr && (s.firstSetAt ?? s.checkinAt) >= from && (s.firstSetAt ?? s.checkinAt) < to)
    .map(s => ({ t: s.firstSetAt ?? s.checkinAt, ...HR.summary(s.hr) })).filter(x => x.avg).sort((a, b) => a.t - b.t);
  if (hrs.length) {
    h += chartCard('hr', 'Heart rate per workout', `Avg <b>${Math.round(hrs.reduce((x, w) => x + w.avg, 0) / hrs.length)} bpm</b> · highest peak ${Math.max(...hrs.map(w => w.max))}`,
      CH.lineChart('hr', 'Average heart rate per workout', hrs.map(w => ({ t: w.t, v: w.avg, tip: { value: `${w.avg} bpm avg`, title: fmtShortDay(w.t), sub: `peak ${w.max} · ${w.minutes} min recorded` } }))),
      { head: ['Workout', 'Avg', 'Peak', 'Minutes'], rows: hrs.map(w => [fmtShortDay(w.t), w.avg, w.max, w.minutes]) });
  }

  // Week by week: sets by tier, and how much of your goals you hit.
  const wk = PG.weekly(state, from, to);
  const keys = [['T1', 'T1 heavy'], ['T2', 'T2 moderate'], ['T3', 'T3 accessory'], ['Other', 'Other']];
  const tot = w => w.sets.T1 + w.sets.T2 + w.sets.T3 + w.sets.Other;
  const share = k => { const all = wk.reduce((x, w) => x + tot(w), 0); return all ? Math.round(100 * wk.reduce((x, w) => x + w.sets[k], 0) / all) : 0; };
  h += chartCard('tiers', 'Sets per week by tier', wk.some(w => tot(w)) ? `T1 ${share('T1')}% · T2 ${share('T2')}% · T3 ${share('T3')}%` : '',
    CH.columnChart('tiers', 'Working sets per week by tier', wk.some(w => tot(w)) ? wk.map(w => ({ t: w.start, parts: keys.map(([k]) => ({ key: k, v: w.sets[k] })), tip: { value: `${tot(w)} sets`, title: weekLabel(w.start), sub: keys.map(([k]) => `${k} ${w.sets[k]}`).join(' · ') } })) : []),
    { head: ['Week', 'T1', 'T2', 'T3', 'Other'], rows: wk.map(w => [weekLabel(w.start), w.sets.T1, w.sets.T2, w.sets.T3, w.sets.Other]) }, legend(keys));
  const hit = wk.filter(w => w.quota > 0);
  const avgHit = hit.length ? Math.round(100 * hit.reduce((x, w) => x + w.filled / w.quota, 0) / hit.length) : null;
  h += chartCard('goals', 'Weekly goals hit', avgHit != null ? `Avg <b>${avgHit}%</b> a week` : '',
    CH.columnChart('goals', 'Share of weekly goal sessions hit', hit.map(w => ({ t: w.start, parts: [{ key: 'series', v: Math.round(100 * w.filled / w.quota) }], tip: { value: `${Math.round(100 * w.filled / w.quota)}%`, title: weekLabel(w.start), sub: `${w.filled} of ${w.quota} goal sessions` } })), { max: 100, fmt: v => `${v}%` }),
    { head: ['Week', 'Hit', 'Goal sessions'], rows: hit.map(w => [weekLabel(w.start), `${Math.round(100 * w.filled / w.quota)}%`, `${w.filled} of ${w.quota}`]) });
  return h;
}

// Crosshair, highlight and readout for whichever point is nearest the pointer.
function chartPoint(e) {
  const svg = e.target.closest?.('svg.chartsvg');
  for (const tip of document.querySelectorAll('.charttip:not([hidden])')) if (!svg || tip.parentElement !== svg.parentElement) hideChartTip(tip.parentElement);
  if (!svg) return;
  const hits = chartHits.get(svg.dataset.chart);
  if (!hits?.length) return;
  const r = svg.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * CH.W;
  const hit = CH.nearest(hits, x);
  const xh = svg.querySelector('.xhair'), dot = svg.querySelector('.hdot'), band = svg.querySelector('.hband');
  if (xh) { xh.setAttribute('x1', hit.x); xh.setAttribute('x2', hit.x); xh.setAttribute('visibility', 'visible'); }
  if (dot) { dot.setAttribute('cx', hit.x); dot.setAttribute('cy', hit.y); dot.setAttribute('visibility', 'visible'); }
  if (band) { band.setAttribute('x', hit.x - hit.w / 2); band.setAttribute('width', hit.w); band.setAttribute('visibility', 'visible'); }
  const tip = svg.parentElement.querySelector('.charttip');
  tip.replaceChildren();
  const v = document.createElement('b'); v.textContent = hit.tip.value;
  const t = document.createElement('span'); t.textContent = hit.tip.title;
  tip.append(v, t);
  if (hit.tip.sub) { const s2 = document.createElement('span'); s2.className = 'meta'; s2.textContent = hit.tip.sub; tip.append(s2); }
  tip.hidden = false;
  const px = (hit.x / CH.W) * r.width;
  tip.style.left = `${Math.max(0, Math.min(r.width - tip.offsetWidth, px - tip.offsetWidth / 2))}px`;
}
function hideChartTip(wrap) {
  wrap.querySelector('.charttip').hidden = true;
  for (const sel of ['.xhair', '.hdot', '.hband']) wrap.querySelector(sel)?.setAttribute('visibility', 'hidden');
}
document.addEventListener('pointermove', chartPoint);
document.addEventListener('pointerdown', chartPoint);

function viewLibrary() {
  if (ui.libMode === 'mobility') return viewMobLibrary();
  const q = ui.libQuery.trim().toLowerCase();
  const archivedCount = state.exercises.filter(e => e.archived).length;
  let h = `<header class="top"><h1>Library</h1><div class="hbtns inline"><button class="small" data-act="catNew">+ Category</button><button class="primary" data-act="quickAdd">+ Exercise</button></div></header>${libModeSeg()}
    <input class="search" id="libq" placeholder="Search exercises or categories" value="${esc(ui.libQuery)}" data-libq>
    ${partChips(state.exercises.filter(e => ui.showArchived || !e.archived), ui.libPart, 'libPart')}
    ${archivedCount ? `<button class="small quiet libarch" data-act="libArchived">${ui.showArchived ? 'Hide' : 'Show'} archived (${archivedCount})</button>` : ''}`;
  const fams = [...state.families].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of fams) {
    const famMatch = f.name.toLowerCase().includes(q);
    const all = L.familyMembers(state, f.id);
    const members = all.filter(e => (ui.showArchived || !e.archived) && (!q || famMatch || e.name.toLowerCase().includes(q))
      && (!ui.libPart || L.bodyPart(state, e) === ui.libPart));
    if (!members.length && (q || ui.libPart || all.length)) continue; // nothing to show; truly empty families stay so you can add to them
    h += `<div class="card"><h3 class="cathead">${esc(f.name)}<button class="icon" data-act="catEdit" data-id="${esc(f.id)}" aria-label="Edit ${esc(f.name)}">✎</button></h3>${members.map(e => {
      const max = e.metric === 'load_reps' ? L.estimatedMax(state, e.id) : null;
      const meta = [max ? `e1RM ${round(max)}` : '', e.equipment.join(', '), e.archived ? 'archived' : ''].filter(Boolean).join(' · ');
      return `<div class="exrow"><button class="name" data-act="libEdit" data-id="${esc(e.id)}">${f.defaultExerciseId === e.id ? '★ ' : ''}${esc(e.name)}${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</button>
        <button class="icon" data-act="libMove" data-id="${esc(e.id)}" data-dir="-1" aria-label="Move up">↑</button>
        <button class="icon" data-act="libMove" data-id="${esc(e.id)}" data-dir="1" aria-label="Move down">↓</button></div>`;
    }).join('') || '<p class="muted">Empty category.</p>'}
    <button class="small" data-act="quickAdd" data-fam="${esc(f.id)}">+ Add</button></div>`;
  }
  return h;
}

function exerciseOptions(sel) {
  return [...state.families].sort((a, b) => a.name.localeCompare(b.name)).map(f =>
    `<optgroup label="${esc(f.name)}">${L.familyMembers(state, f.id).filter(e => !e.archived || e.id === sel).map(e =>
      `<option value="${esc(e.id)}" ${e.id === sel ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</optgroup>`).join('');
}

function viewPlans() {
  if (ui.blockSetup) return viewBlockSetup(ui.blockSetup);
  if (ui.program) return viewProgram(ui.program);
  if (ui.mobRoutine) return viewMobRoutine(ui.mobRoutine);
  const p = ui.plan;
  if (p) {
    return `<header class="top"><h1>${p.id ? 'Edit plan' : 'New plan'}</h1></header>
      <div class="field"><label>Name</label><input data-pbind="name" value="${esc(p.name)}" placeholder="e.g. Office pump 20"></div>
      ${p.items.map((it, i) => `<div class="card planitem">
        <select data-pbind="items.${esc(i)}.exerciseId">${exerciseOptions(it.exerciseId)}</select>
        <div class="row2">
          <select data-pbind="items.${esc(i)}.tier">${opts(L.TIERS.map(t => [t, t]), it.tier)}</select>
          <select data-pbind="items.${esc(i)}.schemeId">${opts(L.schemeOptions(state, it.tier).map(s => [s.id, `${s.name} · ${s.minutes}m`]), it.schemeId)}</select>
          <button class="icon" data-act="planDelItem" data-i="${esc(i)}" aria-label="Remove">✕</button></div></div>`).join('')}
      <button data-act="planAddItem">+ Add exercise</button>
      <div class="actions">${p.id ? '<button class="danger" data-act="planDelete">Delete</button>' : ''}
        <button data-act="planCancel">Cancel</button><button class="primary" data-act="planSave">Save plan</button></div>`;
  }
  let h = `<header class="top"><h1>Plans</h1><button class="primary" data-act="planNew">+ New plan</button></header>`;
  h += programCards();
  // Mobility routines: tap to start one, ✎ to edit it.
  const lastRoutine = id => { const t = Math.max(0, ...state.mobility.sessions.filter(x => x.routineId === id && x.status === 'done').map(x => x.startedAt)); return t ? fmtAgo(t) : ''; };
  h += `<div class="sectionhead"><h3>Mobility</h3><button class="small" data-act="mobRoutineNew">+ Routine</button></div>
    <div class="card flush">${state.mobility.routines.map(r => `<div class="exrow"><button class="name" data-act="mobStart" data-id="${esc(r.id)}">${esc(r.name)}<span class="meta">${[`${r.items.length} exercises`, lastRoutine(r.id)].filter(Boolean).join(' · ')}</span></button>
      <button class="icon" data-act="mobRoutineEdit" data-id="${esc(r.id)}" aria-label="Edit ${esc(r.name)}">✎</button></div>`).join('')}
      <button class="row add" data-act="mobPick" data-mode="new">Pick body parts ›</button></div>`;
  const own = state.plans.filter(p => !p.group);
  const planItems = p => esc(p.items.map(it => `${it.tier} ${exOf(it.exerciseId)?.name ?? '?'} ${schOf(it.schemeId)?.name ?? ''}`).join(' · '));
  if (own.length) {
    h += `<div class="sectionhead"><h3>Saved plans</h3></div>` + own.map(p => `<button class="card row" data-act="planEdit" data-id="${esc(p.id)}"><span><b>${esc(p.name)}</b>
      <span class="meta">${planItems(p)}</span></span><span>›</span></button>`).join('');
  }
  // Plan groups (the THP-style jump plan): a heading, what it's about (folded), and each day with Start and Edit.
  for (const g of [...new Set(state.plans.filter(p => p.group).map(p => p.group))]) {
    const about = g === THP.THP_GROUP ? THP.THP_ABOUT : '';
    h += `<div class="sectionhead"><h3>${esc(g)}</h3></div>${about ? `<details class="plannote"><summary>About</summary><p>${esc(about)}</p></details>` : ''}${groupBlockRow(g)}`;
    h += state.plans.filter(p => p.group === g).map(p => `<div class="card plangroup"><b>${esc(p.name)}</b>
      <div class="meta">${planItems(p)}</div>${p.note ? `<details class="plannote"><summary>Notes</summary><p>${esc(p.note)}</p></details>` : ''}
      <div class="brow"><button class="small primary" data-act="startPlan" data-id="${esc(p.id)}">Start</button><button class="small" data-act="planEdit" data-id="${esc(p.id)}">Edit</button></div></div>`).join('');
  }
  return h;
}

const SETTINGS_PAGES = [
  ['you', 'You and training'],
  ['timer', 'Rest timer'],
  ['locations', 'Locations and equipment'],
  ['maxes', '1-rep maxes'],
  ['tiers', 'Tier doses'],
  ['schemes', 'Schemes'],
  ['data', 'Backup and data'],
  ['fitnotes', 'Import from FitNotes'],
];

function viewSettings() {
  const page = ui.setPage;
  if (!page) return viewSettingsMenu();
  const title = SETTINGS_PAGES.find(p => p[0] === page)[1];
  const body = { you: settingsYou, maxes: settingsMaxes, timer: settingsTimer, locations: settingsLocations, tiers: settingsTiers, schemes: settingsSchemes, data: settingsData, fitnotes: settingsFitnotes }[page]();
  return `<header class="top sub"><button class="back" data-act="setPage" data-p="">‹ Settings</button></header><h1 class="pagetitle">${title}</h1>${body}`;
}

function viewSettingsMenu() {
  const st = state.settings, tc = st.timer;
  const t1 = state.tiers.T1;
  const summary = {
    you: `${st.bodyweight ? `${st.bodyweight} ${unit()}` : 'Bodyweight not set'}`,
    timer: [tc.autoStart ? 'Automatic' : 'Manual', tc.sound ? 'beeps' : 'silent'].join(' · '),
    locations: state.locations.map(l => l.name).join(', '),
    tiers: `T1 ${t1.repMin}–${t1.repMax} reps at ${round(t1.intMin * 100)}%+`,
    schemes: `${state.schemes.length} schemes`,
    maxes: (() => { const n = state.exercises.filter(e => e.testedMax?.load > 0).length; return n ? `${n} entered` : 'None entered'; })(),
    data: `Last backup ${st.lastExportAt ? new Date(st.lastExportAt).toLocaleDateString() : 'never'}`,
  };
  return `<header class="top"><h1>Settings</h1></header>
    <div class="menu">
      ${SETTINGS_PAGES.slice(0, 3).map(([k, t]) => menuRow(k, t, summary[k])).join('')}
      <button class="menurow" data-act="goWeek"><span class="grow"><span class="name">Weekly goals</span>
        <span class="meta">${state.slots.length} · on the Week tab</span></span><span class="chev">›</span></button>
    </div>
    <div class="label">Programming</div>
    <div class="menu">${SETTINGS_PAGES.slice(3, 6).map(([k, t]) => menuRow(k, t, summary[k])).join('')}</div>
    <div class="menu">${menuRow('data', 'Backup and data', summary.data)}
      <button class="menurow" data-act="setupAgain"><span class="grow"><span class="name">Set up again</span>
        <span class="meta">replaces your goals</span></span><span class="chev">›</span></button></div>
    <div class="label">App</div>
    <div class="menu"><button class="menurow" data-act="refreshApp"><span class="grow"><span class="name">Get the latest version</span>
      <span class="meta">${ui.swVersion ? `you have ${esc(String(ui.swVersion).replace(/^afp-/, ''))} · ` : ''}your data stays</span></span></button></div>`;
}

const menuRow = (k, t, sub) => `<button class="menurow" data-act="setPage" data-p="${esc(k)}"><span class="grow"><span class="name">${esc(t)}</span>
  <span class="meta">${esc(sub)}</span></span><span class="chev">›</span></button>`;

// One labelled setting per row: label (and hint) on the left, control on the right.
const frow = (label, control, hint = '') => `<label class="frow"><span class="grow"><span class="name">${label}</span>${hint ? `<span class="meta">${hint}</span>` : ''}</span>${control}</label>`;
const numIn = (path, val, extra = '') => `<input class="num" inputmode="decimal" data-bind="${esc(path)}" data-type="num" value="${esc(val)}" ${extra}>`;
const pctIn = (path, val) => `<input class="num" inputmode="numeric" data-bind="${esc(path)}" data-type="pct" value="${esc(val == null ? '' : round(val * 100))}">`;
const switchIn = (path, on) => `<input type="checkbox" class="switch" data-bind="${esc(path)}" data-type="bool" ${on ? 'checked' : ''}>`;

function settingsYou() {
  const st = state.settings;
  return `<div class="menu">
      ${frow(`Bodyweight (${unit()})`, numIn('settings.bodyweight', st.bodyweight))}
      ${frow('Units', `<select data-bind="settings.unit" data-rerender>${opts([['lb', 'lb'], ['kg', 'kg']], st.unit)}</select>`)}
      ${frow(`Round loads to (${unit()})`, numIn('settings.increment', st.increment))}
      ${frow(`Kettlebells (${unit()})`, `<input class="list" inputmode="decimal" data-kb value="${esc((st.kettlebells || []).join(', '))}" placeholder="30, 40, 53">`)}
      ${frow('Changeover (min)', numIn('settings.changeover', st.changeover ?? 2), 'setup time per exercise')}
      ${frow('Week starts on', `<select data-bind="settings.weekStartDay" data-type="num">${opts(WEEKDAYS.map((d, i) => [i, d]), st.weekStartDay)}</select>`)}
    </div>
    <div class="label">Suggestions</div>
    <div class="menu">${frow('Power work on low-energy days', switchIn('settings.recovery.powerWhenTired', st.recovery?.powerWhenTired !== false), 'off: technique work instead')}
      ${frow('Rest what you trained yesterday', switchIn('settings.recovery.t1AfterT1', st.recovery?.t1AfterT1), 'alternate upper and lower days')}
      ${frow('T3 as areas', `<input type="checkbox" class="switch" data-bind="settings.t3Areas" data-type="bool" data-rerender ${st.t3Areas ? 'checked' : ''}>`, 'no weekly counts: picked to suit the day')}
      ${frow('Learn from my swaps', switchIn('settings.learnTaste', st.learnTaste !== false))}
      <button class="menurow" data-act="tasteForget"><span class="grow"><span class="name">Forget what it learned</span>
        ${st.tasteSince ? `<span class="meta">since ${esc(new Date(st.tasteSince).toLocaleDateString())}</span>` : ''}</span></button></div>
    <div class="label">Pace</div>
    <div class="menu">${frow('Use my pace', switchIn('settings.learnPace', st.learnPace !== false), 'time estimates from your sets')}
      ${paceRows()}
      <button class="menurow" data-act="paceReset"><span class="grow"><span class="name">Reset my pace</span>
        ${st.paceSince ? `<span class="meta">learning since ${esc(new Date(st.paceSince).toLocaleDateString())}</span>` : ''}</span></button></div>`;
}

// What the estimates learned: changeover per location, and how many per-set times.
function paceRows() {
  if (state.settings.learnPace === false) return '';
  const p = L.paceFor(state);
  const rows = state.locations.map(l => {
    const c = p.all.get(l.id);
    const text = !c ? 'not learned yet' : p.change.has(l.id)
      ? `${(Math.round(c.minutes * 2) / 2).toFixed(1)} min changeover`
      : `learning (${c.samples}/${MIN_CHANGEOVERS})`;
    return `<div class="frow"><span class="grow"><span class="name">${esc(l.name)}</span><span class="meta">${esc(text)}</span></span></div>`;
  });
  const n = p.perSet.size;
  rows.push(`<div class="frow"><span class="grow"><span class="name">Per-set times</span><span class="meta">${n ? `${n} exercise${n === 1 ? '' : 's'}` : 'not learned yet'}</span></span></div>`);
  return rows.join('');
}

function settingsTimer() {
  const tc = state.settings.timer;
  const sw = (key, label, hint) => frow(label, switchIn(`settings.timer.${key}`, tc[key]), hint);
  return `<div class="menu">
      ${sw('autoStart', 'Start when I log a set')}
      ${sw('sound', 'Beep when rest is over')}
      ${sw('warn10', 'Beep at 10 seconds left')}
      ${sw('vibrate', 'Vibrate when rest is over', 'Android only')}
      ${sw('keepAwake', 'Keep the screen on')}
      ${sw('notify', 'Notify in the background', 'best on Android')}
      ${frow('Get-ready countdown (s)', numIn('settings.timer.prep', tc.prep ?? 5), 'before hold timers')}
    </div>
    <div class="actions"><button data-act="timerTest">Test sound</button>
      ${tc.notify ? '<button data-act="notifyTest">Test notification</button>' : ''}</div>`;
}

function settingsLocations() {
  return state.locations.map((l, i) => `<div class="card">
      <input class="titleinput" data-bind="locations.${esc(i)}.name" value="${esc(l.name)}" aria-label="Location name">
      <div class="chips">${state.equipment.map(eq => `<label class="chip ${esc(l.equipment.includes(eq) ? 'on' : '')}"><input type="checkbox" data-loceq="${esc(l.id)}|${esc(eq)}" ${l.equipment.includes(eq) ? 'checked' : ''}>${esc(eq)}</label>`).join('')}
        <input class="chipinput" data-eqnew="loc:${esc(l.id)}" placeholder="+ New" aria-label="Add equipment" enterkeyhint="done"></div>
    </div>`).join('') + `<button class="addblock" data-act="locAdd">+ Add location</button>`;
}

// Your T1 goals' lifts, then T2 goals' lifts, then other main lifts and power exercises you've done in the last 12 weeks.
function settingsMaxes() {
  const goalLift = sl => sl.exerciseId ?? famOf(sl.familyId)?.defaultExerciseId;
  const loaded = e => e && e.metric === 'load_reps' && !e.archived;
  const groups = [['Your T1 lifts', 'T1'], ['Your T2 lifts', 'T2']].map(([label, tier]) =>
    [label, [...new Set(state.slots.filter(sl => sl.tier === tier).map(goalLift))].map(exOf).filter(loaded)]);
  const listed = new Set(groups.flatMap(([, list]) => list.map(e => e.id)));
  const since = Date.now() - 84 * 864e5;
  const recent = [...new Set(state.sets.filter(s => s.done && s.loggedAt >= since).map(s => s.exerciseId))].map(exOf)
    .filter(e => loaded(e) && !listed.has(e.id) && ['main', 'power'].includes(e.role ?? L.guessRole(e.name, e.metric, e.explosive)));
  groups.push(['Other lifts you do', recent.sort((a, b) => a.name.localeCompare(b.name))]);
  const row = e => `<label class="frow"><span class="grow"><span class="name">${esc(e.name)}${e.bodyweight ? ' <span class="hint">added load</span>' : ''}</span>
      <span class="meta">${esc(maxLine(e) || 'No max yet')}</span></span>
      <input class="num" inputmode="decimal" data-max="${esc(e.id)}" value="${esc(e.testedMax?.load ?? '')}" placeholder="1RM"></label>`;
  return `<p class="meta pad">Tested 1RMs (${unit()}). Blank uses your sets.</p>` +
    groups.filter(([, list]) => list.length).map(([label, list]) => `<div class="label">${label}</div><div class="menu">${list.map(row).join('')}</div>`).join('');
}

// A tier's own settings, from what the tier is (L.TIER): an or-sets minimum, a target load range, or an intensity floor.
function tierRows(t, c) {
  const k = L.TIER[t];
  if (k.orSets) return frow(`Or minimum ${L.setUnit(t)}`, numIn(`tiers.${t}.setMin`, c.setMin ?? k.orSets), k.orSetsHint);
  if (k.targetLoad) return frow('Target load from (%)', pctIn(`tiers.${t}.intMin`, c.intMin)) + frow('Target load up to (%)', pctIn(`tiers.${t}.intMax`, c.intMax));
  if (k.strength) return frow('Intensity from (%)', pctIn(`tiers.${t}.intMin`, c.intMin)) + frow('Intensity up to (%)', pctIn(`tiers.${t}.intMax`, c.intMax));
  return '';
}

function settingsTiers() {
  return `<p class="meta pad">A session counts toward a goal once it reaches the minimum.</p>` +
    L.TIERS.map(t => {
      const c = state.tiers[t];
      return `<div class="label"><span class="tier ${esc(t)}">${t}</span> ${esc(L.TIER[t].label)}</div><div class="menu">
        ${frow(`Minimum ${L.repUnit(t)}`, numIn(`tiers.${t}.repMin`, c.repMin))}
        ${frow(`Maximum ${L.repUnit(t)}`, numIn(`tiers.${t}.repMax`, c.repMax))}
        ${tierRows(t, c)}
      </div>`;
    }).join('');
}

function settingsSchemes() {
  return L.TIERS.map(t => {
      const list = state.schemes.filter(sc => sc.tiers.includes(t));
      return `<div class="label"><span class="tier ${esc(t)}">${t}</span></div><div class="menu">${list.map(sc =>
        `<button class="menurow" data-act="schemeEdit" data-id="${esc(sc.id)}"><span class="grow"><span class="name">${esc(sc.name)}</span>
          <span class="meta">${L.schemeReps(sc)} ${L.repUnit(sc.tiers[0])} · ${sc.minutes} min · ${sc.emom ? `every ${clock(sc.emom)}` : `rest ${clock(sc.restSec)}`}</span></span><span class="chev">›</span></button>`).join('')
        || '<p class="muted pad">None yet.</p>'}</div>`;
    }).join('') + `<button class="addblock" data-act="schemeNew">+ Add scheme</button>`;
}

// How a snapshot came about, for the saved-copies list.
const SNAP_LABEL = { daily: 'daily', 'before-import': 'before an import', 'before-setup': 'before setup', 'before-paste': 'before restoring a backup',
  'before-restore': 'before restoring a saved copy', 'before-erase': 'before erasing everything', recovered: 'found at startup' };

// Loads what Backup and data shows about the copy on this device (it lives in IndexedDB, so it arrives a moment later).
async function loadVault() {
  const usable = await Vault.usable();
  ui.vault = { usable, savedAt: usable ? (await Vault.get())?.at ?? null : null, rows: usable ? await Vault.list() : [] };
  if (ui.setPage === 'data') render();
}
function openDataPage() {
  loadVault();
  requestPersist().then(() => { if (ui.setPage === 'data') render(); });
}

// ---------- the account (js/cloud.js, js/sync.js) ----------

function cloudSection() {
  if (!Cloud.configured()) return '';
  const c = ui.cloud ?? {}, busy = c.busy || Sync.isBusy();
  let body;
  if (Cloud.signedIn()) {
    const last = Cloud.record().lastSyncAt;
    body = `${statusRow('Signed in as', esc(Cloud.email() ?? ''))}
      ${statusRow('Synced', busy ? 'Syncing…' : last ? fmtMinutesAgo(last) : 'Not yet')}
      ${c.error ? `<p class="meta pad bad">${esc(c.error)}</p>` : c.offline ? '<p class="meta pad">You\'re offline. It syncs when the network is back.</p>' : ''}
      ${c.ask ? '<button class="menurow" data-act="cloudAsk"><span class="grow"><span class="name">Choose what to do with your account\'s backup</span></span><span class="chev">›</span></button>' : ''}
      <button class="menurow" data-act="cloudSync" ${busy ? 'disabled' : ''}><span class="grow"><span class="name">Sync now</span></span></button>
      <button class="menurow" data-act="cloudSignOut"><span class="grow"><span class="name">Sign out</span><span class="meta">data stays here</span></span></button>`;
  } else if (c.sentTo) {
    body = `<p class="meta pad">Link and code sent to ${esc(c.sentTo)}</p>
      <div class="field pad"><label for="cloud-code">Code</label><input id="cloud-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456"></div>
      ${c.error ? `<p class="meta pad bad">${esc(c.error)}</p>` : ''}
      <button class="menurow" data-act="cloudVerify" ${c.busy ? 'disabled' : ''}><span class="grow"><span class="name">Sign in with the code</span></span></button>
      <button class="menurow" data-act="cloudChange"><span class="grow"><span class="name">Use a different email</span></span></button>`;
  } else if (c.mode === 'link') {
    body = `      <div class="field pad"><label for="cloud-email">Email</label><input id="cloud-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(c.email ?? '')}"></div>
      ${c.error ? `<p class="meta pad bad">${esc(c.error)}</p>` : ''}
      <button class="menurow" data-act="cloudSend" ${c.busy ? 'disabled' : ''}><span class="grow"><span class="name">Email me a sign-in link</span></span></button>
      <button class="menurow" data-act="cloudMode" data-m="password"><span class="grow"><span class="name">Use a password instead</span></span></button>`;
  } else {
    body = `<p class="meta pad">Keeps a copy in your account for a new phone or a cleared browser.</p>
      <div class="field pad"><label for="cloud-email">Email</label><input id="cloud-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(c.email ?? '')}"></div>
      <div class="field pad"><label for="cloud-password">Password</label><input id="cloud-password" type="password" autocomplete="current-password" placeholder="6 or more characters"></div>
      ${c.error ? `<p class="meta pad bad">${esc(c.error)}</p>` : ''}
      <button class="menurow" data-act="cloudPassword" data-m="in" ${c.busy ? 'disabled' : ''}><span class="grow"><span class="name">Sign in</span></span></button>
      <button class="menurow" data-act="cloudPassword" data-m="up" ${c.busy ? 'disabled' : ''}><span class="grow"><span class="name">Create account</span><span class="meta">first time</span></span></button>
      <button class="menurow" data-act="cloudMode" data-m="link"><span class="grow"><span class="name">Email me a sign-in link</span></span></button>`;
  }
  return `<div class="label">Back up to your account</div><div class="menu">${body}</div>`;
}

// What a finished sync means for the screen. Automatic syncs call this too; it only redraws when something changed.
function handleSync(r) {
  const c = ui.cloud ??= {};
  const was = JSON.stringify([c.error, c.offline, !!c.ask]);
  c.busy = false;
  if (r.kind === 'error') {
    c.offline = !!r.error.offline;
    c.error = r.error.offline ? null : r.error.message;
    if (r.error.auth) c.authLost = true;
  } else if (r.kind !== 'skipped') {
    c.error = null; c.offline = false; c.authLost = false;
  }
  if (r.kind === 'ask') {
    const first = !c.ask;
    c.ask = r;
    if (first && !ui.sheet) openSheet({ type: 'cloudAsk' });
  } else if (r.kind !== 'skipped' && r.kind !== 'error') c.ask = null;
  if (r.kind === 'pulled' || r.kind === 'merged') {
    ui.ci = defaultCheckin();
    toast(r.kind === 'merged' ? 'Merged with your other device' : 'Updated from your other device');
    render();
  } else if (ui.setPage === 'data' || was !== JSON.stringify([c.error, c.offline, !!c.ask])) render();
}

function sheetCloudAsk() {
  const a = ui.cloud?.ask;
  if (!a) return '<p class="muted">Nothing to choose.</p>';
  const choice = (id, name, hint) => `<button class="row ${esc(a.choice === id ? 'on' : '')}" data-act="cloudChoose" data-c="${esc(id)}"><span>${name}</span><span class="meta">${hint}</span></button>`;
  return `<h3>Your account has a backup</h3>
    <p class="meta">Account: ${a.remote.workouts} workouts, ${a.remote.sets} sets (${esc(fmtDateTime(Date.parse(a.remote.saved_at)))}${a.remote.device ? `, ${esc(a.remote.device)}` : ''}).
      This device: ${a.local.workouts} workouts, ${a.local.sets} sets. What's replaced stays under Saved copies.</p>
    <div class="list">
      ${choice('account', 'Use the account\'s copy', 'replaces this device')}
      ${choice('merge', 'Merge both', 'keeps both')}
      ${choice('keep', 'Keep this device\'s', 'replaces the account\'s')}
    </div>`;
}

function settingsData() {
  const st = state.settings, v = ui.vault;
  const persisted = st.storagePersisted === true ? 'Yes' : st.storagePersisted === 'unsupported' ? 'Not available here' : st.storagePersisted === false ? 'No' : '…';
  const copyLine = !v ? '…' : !v.usable ? 'Not available in this browser' : v.savedAt ? `Saved ${fmtMinutesAgo(v.savedAt)}` : 'Not saved yet';
  const status = statusRow;
  const rows = (v?.rows ?? []).map(r => `<button class="menurow" data-act="vaultRestore" data-at="${esc(r.at)}"><span class="grow"><span class="name">${esc(fmtDateTime(r.at))}</span>
    <span class="meta">${esc(SNAP_LABEL[r.reason] ?? r.reason)} · ${r.workouts ?? '?'} workouts, ${r.sets ?? '?'} sets</span></span><span class="chev">›</span></button>`).join('');
  return `<div class="label">Status</div>
    <div class="menu">
      ${status('Protected from automatic clearing', persisted, st.storagePersisted === false ? 'add the app to your home screen' : '')}
      ${status('Copy on this device', copyLine)}
      ${status('Last backup off this device', st.lastExportAt ? `${esc(new Date(st.lastExportAt).toLocaleDateString())} · ${fmtAgo(st.lastExportAt)}` : 'Never')}
    </div>
    ${cloudSection()}
    <div class="label">Back up</div>
    <div class="menu">
      <button class="menurow" data-act="saveBackup"><span class="grow"><span class="name">Save backup to…</span><span class="meta">Files, iCloud, Drive or email</span></span></button>
      <button class="menurow" data-act="copyBackup"><span class="grow"><span class="name">Copy backup</span></span></button>
    </div>
    <div class="label">Saved copies on this device</div>
    <div class="menu">${rows || `<p class="muted pad">${v ? 'None yet' : '…'}</p>`}</div>
    <div class="label">Import</div>
    <div class="menu">
      <button class="menurow" data-act="setPage" data-p="fitnotes"><span class="grow"><span class="name">Import from FitNotes</span>
        ${st.imports?.fitnotes?.at ? `<span class="meta">last ${new Date(st.imports.fitnotes.at).toLocaleDateString()}</span>` : ''}</span><span class="chev">›</span></button>
      ${hasCopy('before-import') ? '<button class="menurow" data-act="fnUndo"><span class="grow"><span class="name">Undo last import</span></span></button>' : ''}
    </div>
    <div class="label">Restore</div>
    <div class="menu">
      <button class="menurow" data-act="pasteImport"><span class="grow"><span class="name">Paste a backup</span></span></button>
      <label class="menurow"><span class="grow"><span class="name">Choose a backup file</span></span><input type="file" accept="application/json,.json" data-import hidden></label>
    </div>
    <div class="menu"><button class="menurow danger" data-act="reset"><span class="grow"><span class="name">Erase all data</span></span></button></div>`;
}

// ---------- FitNotes import ----------

const fmtDay = d => new Date(`${d}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const MODE_LABEL = Object.fromEntries(FN.MODES);
const REGION_LABEL = { lower: 'lower body', upper: 'upper body', full: 'whole body' };

function settingsFitnotes() {
  const f = ui.fn ??= { stage: 'pick' };
  if (loadProblem) return `<p class="meta pad">Sort out the message at the top first: saving is paused.</p>`;
  if (f.stage === 'reading') return `<div class="card"><p>Reading your backup…</p><p class="meta">The first time, this downloads a SQLite reader (about 0.7 MB).</p></div>`;
  if (f.stage === 'review') return fnReview(f);
  if (f.stage === 'done') return fnDone(f);
  return fnPick(f);
}

function fnPick(f) {
  const bw = f.bodyweight ?? state.settings.bodyweight ?? '';
  return `${f.error ? `<div class="banner bad">${esc(f.error)}</div>` : ''}
    <p class="meta pad">Read on this phone, never uploaded. You check it before anything is saved.</p>
    <div class="menu">
      ${frow(`Bodyweight (${unit()})`, `<input id="fn-bw" class="num" inputmode="decimal" value="${esc(bw)}">`)}
      ${frow('How far back', `<select id="fn-years">${opts([[1, 'Last year'], [2, 'Last 2 years'], [4, 'Last 4 years']], f.years ?? 2)}</select>`)}
    </div>
    <label class="btn primary big fnpick">Choose the FitNotes backup<input type="file" data-fnfile hidden></label>
    <p class="meta pad">The .fitnotes file from a FitNotes backup${state.imports?.fitnotes?.at ? '; sets already imported are skipped' : ''}.</p>`;
}

function fnLine(r) {
  const t = r.target !== 'new' && exOf(r.target);
  const base = t
    ? `→ ${t.name}${FN.willAdopt(state, r) ? ` (switches to ${MODE_LABEL[r.mode].toLowerCase()})` : ''}${r.again ? ' · as last time' : ''}`
    : `New · ${r.family} · ${MODE_LABEL[r.mode]} · ${REGION_LABEL[r.region]}${r.explosive ? ' · explosive' : ''}${r.archive ? ' · archived' : ''}`;
  return base;
}

function fnRow(r, f) {
  const open = f.open.has(r.fnId);
  const count = r.active ? `${r.recent} in the last year` : `last ${fmtDay(r.last)}`;
  return `<div class="fnrow ${open ? 'open' : ''}">
    <button class="menurow" data-act="fnToggle" data-id="${esc(r.fnId)}"><span class="grow"><span class="name">${esc(r.fnName)}</span>
      <span class="meta">${esc(fnLine(r))}</span><span class="meta">${esc(count)}</span></span><span class="chev">${open ? '−' : '+'}</span></button>
    ${open ? fnEditor(r) : ''}</div>`;
}

function fnEditor(r) {
  const id = r.fnId;
  const choices = [['new', 'A new exercise'], ...state.exercises.filter(e => !e.archived || e.id === r.target)
    .map(e => [e.id, `${e.name} (${famOf(e.familyId)?.name ?? ''})`]).sort((a, b) => a[1].localeCompare(b[1]))];
  let h = `<div class="fnedit"><div class="field"><label>Bring in as</label><select data-fn="${esc(id)}" data-k="target">${opts(choices, r.target)}</select></div>`;
  if (r.target === 'new') {
    h += `<div class="field"><label>Name</label><input data-fn="${esc(id)}" data-k="name" value="${esc(r.name)}"></div>
      <div class="field"><label>Category</label><input data-fn="${esc(id)}" data-k="family" list="fn-fams" value="${esc(r.family)}"></div>
      <div class="field"><label>How it was logged</label><select data-fn="${esc(id)}" data-k="mode">${opts(FN.MODES, r.mode)}</select></div>
      <div class="field"><label>Body region</label><select data-fn="${esc(id)}" data-k="region">${opts(Object.entries(REGION_LABEL), r.region)}</select></div>
      <label class="toggle"><input type="checkbox" data-fn="${esc(id)}" data-k="explosive" ${r.explosive ? 'checked' : ''}> Explosive</label>
      <label class="toggle"><input type="checkbox" data-fn="${esc(id)}" data-k="archive" ${r.archive ? 'checked' : ''}> Archive it <span class="hint">history only</span></label>
      <div class="field"><label>Equipment</label><div class="chips">${[...new Set([...state.equipment, ...r.equipment])].map(eq =>
        `<label class="chip ${esc(r.equipment.includes(eq) ? 'on' : '')}"><input type="checkbox" data-fn="${esc(id)}" data-k="eq" value="${esc(eq)}" ${r.equipment.includes(eq) ? 'checked' : ''}>${esc(eq)}</label>`).join('')}</div></div>`;
  } else if (FN.willAdopt(state, r)) {
    h += `<p class="meta">${esc(exOf(r.target).name)} will switch to ${esc(MODE_LABEL[r.mode].toLowerCase())} to match your history.</p>`;
  }
  return h + '</div>';
}

function fnReview(f) {
  const rows = f.plan.rows;
  const active = rows.filter(r => r.active), older = rows.filter(r => !r.active);
  const fams = [...new Set([...state.families.map(x => x.name), ...rows.map(r => r.family)])].sort();
  return `${f.error ? `<div class="banner bad">${esc(f.error)}</div>` : ''}
    <p class="meta pad">${rows.length} exercises, ${f.plan.sets} sets since ${fmtDay(f.plan.cutoff)}. Check the ${active.length} you use most${older.length ? `; ${older.length} older ones come in archived` : ''}.</p>
    <datalist id="fn-fams">${fams.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="menu">${active.map(r => fnRow(r, f)).join('') || '<p class="muted pad">None in the last year.</p>'}</div>
    ${older.length ? `<button class="addblock" data-act="fnOlder">${f.showOlder ? 'Hide' : 'Show'} the ${older.length} older exercises</button>
      ${f.showOlder ? `<div class="menu">${older.map(r => fnRow(r, f)).join('')}</div>` : ''}` : ''}
    <button class="primary big" data-act="fnImport">Import ${f.plan.sets} sets</button>
    <div class="actions"><button data-act="fnCancel">Cancel</button></div>`;
}

function fnDone(f) {
  const s = f.summary;
  return `<div class="card"><h3>Imported</h3>
      <div class="kv"><span>Sets</span><b>${s.sets}</b></div>
      <div class="kv"><span>Workout days</span><b>${s.sessions}</b></div>
      <div class="kv"><span>New exercises</span><b>${s.created}${s.archived ? ` (${s.archived} archived)` : ''}</b></div>
      <div class="kv"><span>Matched to ones you had</span><b>${s.matched}</b></div>
      ${s.skipped ? `<div class="kv"><span>Already imported before</span><b>${s.skipped} sets</b></div>` : ''}
      ${s.adopted.length ? `<p class="meta">Switched to match your history: ${esc(s.adopted.join(', '))}.</p>` : ''}
      ${s.defaults.length ? `<p class="meta">Each category's usual choice is now what you do most: ${esc(s.defaults.join(' · '))}. Change it in Library.</p>` : ''}
    </div>
    <div class="card"><h3>Estimated maxes from your history</h3>
      ${s.maxes.map(m => `<div class="kv"><span>${esc(m.name)}<span class="meta">last ${fmtDay(m.last)}${m.stale ? ' · rough, over 12 weeks ago' : ''}</span></span>
        <b>${m.added != null ? `BW+${round(m.added)}` : round(m.max)} ${unit()}</b></div>`).join('') || '<p class="muted">Not enough loaded sets yet.</p>'}
    </div>
    <button class="primary big" data-act="gsOpen">Suggest weekly goals</button>
    <div class="actions"><button data-act="fnLibrary">Open Library</button><button data-act="fnFinish">Done</button></div>
    <p class="meta pad">Undo: Settings → Backup and data</p>`;
}

// ---------- suggested goals ----------

const PRIORITY_LABEL = { 1: 'low', 2: 'medium', 3: 'high' };

// ---------- weekly review (js/review.js) ----------

const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// On a new week: last week in one line, until you review or dismiss it.
function lastWeekCard() {
  const w = R.lastWeekDue(state);
  if (w == null) return '';
  const r = R.weekReview(state, w);
  const t = r.totals;
  return `<div class="card review-due"><h3>Last week</h3>
    <p>${t.filled}/${t.quota} goal sessions · ${t.workouts} workout${t.workouts === 1 ? '' : 's'}${r.topReason ? ` · ${esc(R.REASONS[r.topReason].toLowerCase())}` : ''}</p>
    <div class="brow"><button class="primary small" data-act="reviewOpen" data-w="${esc(w)}">Review</button><button class="small" data-act="reviewDismiss" data-w="${esc(w)}">Dismiss</button></div></div>`;
}

function viewReview(rv) {
  const r = rv.data;
  const rec = R.reviewRecord(state, r.weekStart);
  const status = id => rec?.proposals.find(p => p.id === id)?.status ?? 'open';
  const t = r.totals;
  const tiers = L.TIERS.filter(x => t.byTier[x]).map(x => `${x} ${t.byTier[x]}`).join(' · ') || 'none';
  const ago = at => at == null ? 'never' : shortDate(at);
  let h = `<header class="top sub"><button class="back" data-act="reviewClose">‹ This week</button></header>
    <h1 class="pagetitle">Week of ${shortDate(r.weekStart)}${r.finished ? '' : ' (so far)'}</h1>`;
  if (ui.reviewUndo) h += `<div class="banner">Goals changed. <button class="link" data-act="reviewUndo">Undo</button></div>`;
  h += `<div class="card"><div class="kv"><span>Goal sessions</span><b>${t.filled} of ${t.quota}</b></div>
    <div class="kv"><span>Goals met</span><b>${t.goalsMet} of ${t.goals}</b></div>
    <div class="kv"><span>Workouts</span><b>${t.workouts} · ${t.minutes} min</b></div>
    <div class="kv"><span>Working sets</span><b>${t.sets} (${esc(tiers)})</b></div></div>`;
  h += `<h3>Goals</h3><div class="card flush">${r.goals.map(g => `<div class="slotrow"><span class="tier ${esc(g.tier)}">${esc(g.tier)}</span>
      <span class="grow"><span class="name">${esc(g.label.slice(g.tier.length + 1))}</span>
      <span class="meta">${g.met ? 'met' : esc(R.REASONS[g.reason])}${g.missed >= 2 ? ` · ${g.missed} weeks running` : ''}${g.lastDone != null ? ` · last ${esc(ago(g.lastDone))}` : ''}</span></span>
      <b class="${g.met ? 'good' : ''}">${g.filled}/${g.quota}</b></div>`).join('') || '<p class="muted pad">No weekly goals.</p>'}</div>`;
  if (r.areas?.length) {
    h += `<h3>T3 areas</h3><div class="card"><p class="meta">${esc(r.areas.map(a => `${a.label} ${a.days}×`).join(' · '))}</p></div>`;
  }
  if (r.block) {
    h += `<h3>Program</h3><div class="card"><p>${esc(r.block.text)}</p>${r.program.length ? `<p class="meta">${esc(r.program.map(g => `${g.label} ${g.filled}/${g.quota}`).join(' · '))}</p>` : ''}</div>`;
  }
  if (r.lifts.length) {
    const word = { up: 'up', held: 'held', down: 'down', stalled: 'stalled', new: 'first time' };
    h += `<h3>Lifts</h3><div class="card flush">${r.lifts.map(l => `<div class="slotrow"><span class="tier ${esc(l.tier)}">${esc(l.tier)}</span>
      <span class="grow"><span class="name">${esc(l.name)}</span><span class="meta">${l.load} ${unit()}${l.prev != null ? ` (was ${l.prev})` : ''}${l.complete ? '' : ' · reps missed'}</span></span>
      <b>${word[l.trend]}</b></div>`).join('')}</div>`;
  }
  const open = r.proposals.filter(p => status(p.id) === 'open');
  h += `<div class="sectionhead"><h3>Proposed changes</h3>${open.some(p => p.change) ? '<button class="small" data-act="reviewAcceptAll">Accept all</button>' : ''}</div>`;
  h += r.proposals.length ? `<div class="card flush">${r.proposals.map(p => {
    const st = status(p.id);
    const btns = st !== 'open' ? `<span class="meta">${st === 'accepted' ? 'accepted' : 'skipped'}</span>`
      : `${p.change ? `<button class="small primary" data-act="reviewAccept" data-id="${esc(p.id)}">Accept</button>` : ''}<button class="small" data-act="reviewSkip" data-id="${esc(p.id)}">${p.change ? 'Skip' : 'OK'}</button>`;
    return `<div class="slotrow proposal"><span class="grow"><span class="name">${esc(p.text)}</span></span><span class="brow">${btns}</span></div>`;
  }).join('')}</div>` : `<p class="muted pad">${r.finished ? 'Nothing to change.' : 'Proposals come when the week ends.'}</p>`;
  h += `<div class="brow pad"><button class="small" data-act="reviewCopy">Copy review</button></div>`;
  return h;
}

function viewGoalSuggest(g) {
  const head = `<header class="top sub"><button class="back" data-act="gsCancel">‹ This week</button></header><h1 class="pagetitle">Suggested goals</h1>`;
  if (!g.rows.length) {
    return `${head}<p class="meta pad">Not enough history yet (${g.workouts} workouts in ${g.weeks} weeks).</p>`;
  }
  const total = g.rows.filter(r => r.include && !(r.tier === 'T3' && L.t3AsAreas(state))).reduce((t, r) => t + r.quota, 0);
  return `${head}
    <p class="meta pad">From ${g.workouts} workouts in ${g.weeks} weeks. Tap one to change it.</p>
    <div class="card"><div class="kv ${esc(total > g.capacity ? 'over' : '')}"><span>Goal sessions a week</span><b>${total} of ~${g.capacity} that fit</b></div></div>
    <div class="menu">${g.rows.map(r => gsRow(r, g)).join('')}</div>
    <button class="primary big" data-act="gsApply" data-mode="replace">Replace my goals</button>
    <div class="actions"><button data-act="gsApply" data-mode="add">Add to my goals</button><button data-act="gsCancel">Cancel</button></div>`;
}

function gsRow(r, g) {
  const open = g.open.has(r.key);
  const name = famOf(r.familyId)?.name ?? '?';
  const bits = [r.tier === 'T3' && L.t3AsAreas(state) ? 'area' : `${r.quota}× a week`, `${PRIORITY_LABEL[r.priority]} priority`, r.repMin ? `${r.repMin}+ reps` : ''].filter(Boolean).join(' · ');
  return `<div class="fnrow ${open ? 'open' : ''} ${r.include ? '' : 'off'}">
    <div class="gsline"><input type="checkbox" class="gsinc" data-gs="${esc(r.key)}" data-k="include" ${r.include ? 'checked' : ''} aria-label="Include ${esc(name)}">
      <button class="menurow" data-act="gsToggle" data-key="${esc(r.key)}"><span class="tier ${esc(r.tier)}">${esc(r.tier)}</span>
        <span class="grow"><span class="name">${esc(name)}</span><span class="meta">${esc(bits)}</span><span class="meta">${esc(r.reason)}</span></span>
        <span class="chev">${open ? '−' : '+'}</span></button></div>
    ${open ? `<div class="fnedit">
      <div class="field"><label>Tier</label><div class="seg">${L.TIERS.map(t => `<button class="${esc(r.tier === t ? 'on' : '')}" data-act="gsSet" data-key="${esc(r.key)}" data-k="tier" data-v="${esc(t)}">${t}</button>`).join('')}</div>
</div>
      <div class="field"><label>Times per week</label><div class="stepper">
        <button data-act="gsStep" data-key="${esc(r.key)}" data-d="-1" aria-label="Fewer">−</button><span>${r.quota}</span><button data-act="gsStep" data-key="${esc(r.key)}" data-d="1" aria-label="More">+</button></div></div>
      <div class="field"><label>Priority</label><div class="seg">${PRIORITIES.map(([v, t]) => `<button class="${esc(r.priority === v ? 'on' : '')}" data-act="gsSet" data-key="${esc(r.key)}" data-k="priority" data-v="${esc(v)}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>Reps per session <span class="hint">optional</span></label>
        <input inputmode="numeric" data-gs="${esc(r.key)}" data-k="repMin" value="${esc(r.repMin ?? '')}" placeholder="${esc(L.slotDose(state, null, r.tier).repMin)}"></div>
    </div>` : ''}</div>`;
}

async function startFitnotes(file) {
  if (!file) return;
  const bodyweight = Number(document.querySelector('#fn-bw')?.value) || null;
  const years = Number(document.querySelector('#fn-years')?.value) || 2;
  if (!bodyweight) {
    ui.fn = { stage: 'pick', years, error: 'Enter your bodyweight first: weighted pull-ups and dips need it.' };
    return render();
  }
  ui.fn = { stage: 'reading', bodyweight, years };
  render();
  try {
    const data = await FN.readBackup(new Uint8Array(await file.arrayBuffer()));
    const cutoff = L.dayKey(Date.now() - years * 365.25 * 864e5);
    const plan = FN.planImport(state, data, { cutoff });
    if (!plan.rows.length) throw new Error(`That backup has no workouts since ${fmtDay(cutoff)}.`);
    ui.fn = { stage: 'review', data, plan, bodyweight, years, open: new Set(), showOlder: false };
  } catch (e) {
    ui.fn = { stage: 'pick', bodyweight, years, error: e.message };
  }
  render();
}

function fnSet(id, k, el) {
  const r = ui.fn.plan.rows.find(x => String(x.fnId) === id);
  if (k === 'eq') r.equipment = el.checked ? [...r.equipment, el.value] : r.equipment.filter(x => x !== el.value);
  else if (k === 'explosive' || k === 'archive') r[k] = el.checked;
  else r[k] = el.value;
  render();
}

// ---------- sheets ----------

function openSheet(s) { ui.sheet = s; renderSheet(); }
function closeSheet() { ui.sheet = null; renderSheet(); }

function renderSheet() {
  const s = ui.sheet;
  if (!s) { sheetEl.hidden = true; sheetEl.innerHTML = ''; return; }
  const body = { swapEx: sheetSwapEx, swapScheme: sheetSwapScheme, plans: sheetPlans, quickAdd: sheetQuickAdd, editEx: sheetEditEx, rest: sheetRest,
    confirm: sheetConfirm, backupText: sheetBackupText, reviewText: sheetReviewText, pasteImport: sheetPasteImport,
    addEx: sheetAddEx, category: sheetCategory, max: sheetMax, tier: sheetTier, goal: sheetGoal, scheme: sheetScheme, pair: sheetPair, finishAsk: sheetFinishAsk, moreTime: sheetMoreTime, mobPick: sheetMobPick, mobEx: sheetMobEx, exHist: sheetExHist, cloudAsk: sheetCloudAsk }[s.type](s);
  sheetEl.innerHTML = `<div class="panel"><button class="close" data-act="sheetClose" aria-label="Close">✕</button>${body}</div>`;
  sheetEl.hidden = false;
  if (ui.sheetFocus) {
    const el = sheetEl.querySelector(ui.sheetFocus);
    if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); }
    ui.sheetFocus = null;
  }
}

// One line per tier, for the pickers.
const TIER_DESC = {
  T1: 'Heavy · sets of 1–3 at 85%+',
  T2: 'Moderate · sets of 5–8 at 65–85%',
  T3: 'Accessory · 10+ reps a set',
  TECH: 'Technique · light explosive work',
  JUMP: 'Jumps · counted in contacts',
  COND: 'Conditioning · bike EMOMs, in calories',
};

// Body-part chips: one at a time, tap again to clear. Only parts with something in `list` show.
const partChips = (list, cur, act) => {
  const have = new Set(list.map(e => L.bodyPart(state, e)));
  return `<div class="chips partchips">${L.BODY_PARTS.filter(p => have.has(p)).map(p =>
    `<button class="chip ${esc(cur === p ? 'on' : '')}" data-act="${esc(act)}" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div>`;
};

// Exercises you've logged, newest first (each once), out of `list`.
function recentExercises(list, n = 8) {
  const ok = new Set(list.map(e => e.id)), out = [];
  for (const st of [...state.sets].filter(x => x.done && !x.warmup).sort((a, b) => (b.loggedAt ?? 0) - (a.loggedAt ?? 0))) {
    if (ok.has(st.exerciseId) && !out.includes(st.exerciseId)) out.push(st.exerciseId);
    if (out.length >= n) break;
  }
  return out.map(exOf);
}

// Pick any exercise, from any family: mode 'add' adds a block, mode 'swap' replaces one. Search looks everywhere;
// otherwise a body part narrows the list, and with neither you see what you've done lately.
function sheetAddEx(sh) {
  const past = sh.mode === 'histAdd' || sh.mode === 'histSwap'; // editing a past workout: any exercise, wherever it was done
  const s = past ? L.byId(state.sessions, sh.sessionId) : currentSession();
  const loc = past ? null : L.placeOf(state, s);
  const live = state.exercises.filter(e => !e.archived);
  const usable = past ? live : live.filter(e => L.isAvailable(e, loc));
  // Swapping starts on the body part you're swapping from.
  if (sh.part === undefined) {
    const from = sh.mode === 'swap' ? exOf(findBlock(sh.blockId).b?.exerciseId) : sh.mode === 'histSwap' ? histGroups(s).find(g => g.key === sh.group)?.ex : null;
    sh.part = from ? L.bodyPart(state, from) : null;
  }
  const q = (sh.q || '').trim().toLowerCase();
  const inPart = e => !sh.part || L.bodyPart(state, e) === sh.part;
  const matches = q ? live.filter(e => e.name.toLowerCase().includes(q) || famOf(e.familyId)?.name.toLowerCase().includes(q)) : live.filter(inPart);
  const here = past ? matches : matches.filter(e => L.isAvailable(e, loc));
  const away = past || (!q && !sh.part) ? 0 : matches.length - here.length;
  const tier = sh.mode === 'swap' ? findBlock(sh.blockId).b.tier : sh.tier;
  const title = sh.mode === 'add' || sh.mode === 'histAdd' ? 'Add an exercise' : sh.mode === 'histSwap' ? 'Change to another exercise' : sh.mode === 'pair' ? `Superset with ${esc(exOf(findBlock(sh.blockId).b.exerciseId)?.name)}` : 'Swap to any exercise';
  const row = e => `<button class="row" data-act="addExPick" data-id="${esc(e.id)}"><span>${esc(e.name)}</span>
      <span class="meta">${(tier === 'T1' || tier === 'T2') && e.metric !== 'load_reps' && !e.explosive ? 'reps only' : ''}</span></button>`;
  let rows;
  if (q || sh.part) {
    const groups = new Map();
    for (const e of here.sort((a, b) => a.rank - b.rank)) {
      const f = famOf(e.familyId)?.name ?? '';
      groups.set(f, [...(groups.get(f) || []), e]);
    }
    rows = [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([f, list]) => `<div class="label">${esc(f)}</div>${list.map(row).join('')}`).join('')
      || '<p class="muted">No matches here.</p>';
  } else {
    const recent = recentExercises(usable);
    rows = recent.length ? `<div class="label">Recent</div>${recent.map(row).join('')}` : '<p class="muted">Pick a body part or search.</p>';
  }
  const raw = (sh.q || '').trim();
  return `<h3>${title}</h3>
    ${sh.mode !== 'swap' && sh.mode !== 'histSwap' ? `<div class="seg tierseg">${L.TIERS.map(t => `<button class="${esc(sh.tier === t ? 'on' : '')}" data-act="addExTier" data-t="${esc(t)}">${t}</button>`).join('')}</div>` : ''}
    <input class="search" id="sheetq" data-sheetq value="${esc(sh.q || '')}" placeholder="Search, or type a new name" autocomplete="off">
    ${q ? '' : partChips(usable, sh.part, 'addExPart')}
    <div class="list">${rows}
      <button class="row add" data-act="addExCreate">+ ${raw ? `Create “${esc(raw)}”` : 'New exercise'}</button></div>
    ${away ? `<p class="meta">${away} more need gear that isn't at ${esc(loc?.name)}</p>` : ''}`;
}

function sheetTier(sh) {
  const { b } = findBlock(sh.blockId);
  const ex = exOf(b.exerciseId);
  return `<h3>Tier for ${esc(ex.name)}</h3>
    <div class="list">${L.TIERS.map(t => {
      const sl = L.slotFor(state, ex, t);
      return `<button class="row ${esc(b.tier === t ? 'on' : '')}" data-act="tierPick" data-t="${esc(t)}"><span><span class="tier ${esc(t)}">${t}</span> ${TIER_DESC[t]}</span>
        <span class="meta">${sl ? `goal: ${esc(exOf(sl.exerciseId)?.name ?? famOf(sl.familyId)?.name ?? '')}` : ''}</span></button>`;
    }).join('')}</div>`;
}

const PRIORITIES = [[1, 'Low'], [2, 'Medium'], [3, 'High']];

function sheetGoal(sh) {
  const g = sh.draft;
  const famOpts = [...state.families].filter(f => f.id === g.familyId || L.familyMembers(state, f.id).some(e => !e.archived))
    .sort((a, b) => a.name.localeCompare(b.name)).map(f => [f.id, f.name]);
  const members = L.familyMembers(state, g.familyId).filter(e => !e.archived || e.id === g.exerciseId);
  const usual = exOf(famOf(g.familyId)?.defaultExerciseId)?.name;
  return `<h3>${sh.isNew ? 'New weekly goal' : 'Edit weekly goal'}</h3>
    <div class="field"><label>Tier</label><div class="seg">${L.TIERS.map(t => `<button class="${esc(g.tier === t ? 'on' : '')}" data-act="goalSet" data-k="tier" data-v="${esc(t)}">${t}</button>`).join('')}</div>
      <p class="meta">${TIER_DESC[g.tier]}</p></div>
    <div class="field"><label>Category</label><select data-gdraft="familyId">${opts(famOpts, g.familyId)}</select></div>
    <div class="field"><label>Exercise</label><select data-gdraft="exerciseId">${opts([['', `Any${usual ? ` (usually ${usual})` : ''}`], ...members.map(e => [e.id, e.name])], g.exerciseId ?? '')}</select></div>
    ${goalMaxField(g)}
    ${g.tier === 'T3' && L.t3AsAreas(state)
      ? `<div class="field"><label>Area <span class="hint">no weekly count</span></label><div class="seg">${[[1, 'Active'], [0, 'Paused']].map(([v, t]) => `<button class="${esc((g.quota > 0 ? 1 : 0) === v ? 'on' : '')}" data-act="goalActive" data-v="${esc(v)}">${t}</button>`).join('')}</div></div>`
      : `<div class="field"><label>Times per week</label><div class="stepper">
      <button data-act="goalStep" data-d="-1" aria-label="Fewer">−</button><span>${g.quota || 'Paused'}</span><button data-act="goalStep" data-d="1" aria-label="More">+</button></div></div>`}
    <div class="field"><label>Reps per session <span class="hint">optional</span></label>
      <input id="g-reps" inputmode="numeric" value="${esc(g.repMin ?? '')}" placeholder="${esc(L.slotDose(state, null, g.tier).repMin)}"></div>
    <div class="field"><label>Priority</label><div class="seg">${PRIORITIES.map(([v, t]) => `<button class="${esc(g.priority === v ? 'on' : '')}" data-act="goalSet" data-k="priority" data-v="${esc(v)}">${t}</button>`).join('')}</div></div>
    <div class="actions">${sh.isNew ? '' : '<button class="danger" data-act="goalDelete">Delete</button>'}
      <button class="primary" data-act="goalSave">${sh.isNew ? 'Add goal' : 'Save'}</button></div>`;
}

// The goal's lift (its exercise, else the family's usual one) and its 1-rep max, which you can set right here.
function goalMaxField(g) {
  const lift = exOf(g.exerciseId) ?? exOf(famOf(g.familyId)?.defaultExerciseId);
  if (!lift || lift.metric !== 'load_reps' || !['T1', 'T2', 'TECH'].includes(g.tier)) return '';
  return `<div class="field"><label>1-rep max${g.exerciseId ? '' : ` · ${esc(lift.name)}`}${lift.bodyweight ? ' <span class="hint">added load</span>' : ''}</label>
    <div class="maxrow"><input class="num" inputmode="decimal" data-max="${esc(lift.id)}" value="${esc(lift.testedMax?.load ?? '')}" placeholder="1RM" aria-label="Tested 1-rep max, ${esc(lift.name)}">
      <span class="meta">${esc(L.maxSource(state, lift.id) === 'tested' && lift.testedMax?.at ? `tested ${shortDay(lift.testedMax.at)}` : maxLine(lift) || 'No max yet')}</span></div></div>`;
}

function sheetScheme(sh) {
  const d = sh.draft;
  const sc = sh.id && schOf(sh.id);
  const used = sc && (state.sets.some(s => s.schemeId === sc.id) || state.plans.some(p => p.items.some(it => it.schemeId === sc.id)));
  const est = Math.round((d.sets * (d.reps * 4 + (d.restSec || 0))) / 60);
  return `<h3>${sh.id ? 'Edit scheme' : 'New scheme'}</h3>
    <div class="row2 fields">
      <div class="field"><label>Sets</label><input id="sc-sets" class="num" inputmode="numeric" value="${esc(d.sets)}"></div>
      <div class="field"><label>Reps</label><input id="sc-reps" class="num" inputmode="numeric" value="${esc(d.reps)}"></div>
      <div class="field"><label>Rest</label><input id="sc-rest" class="num" value="${esc(clock(d.restSec || 0))}"></div>
      <div class="field"><label>Minutes</label><input id="sc-min" class="num" inputmode="numeric" value="${esc(d.minutes ?? '')}" placeholder="${esc(est)}"></div>
    </div>
    <p class="meta">${d.sets * d.reps} reps · ~${est} min</p>
    <div class="field"><label>Use for</label><div class="seg">${L.TIERS.map(t => `<button class="${esc(d.tiers.includes(t) ? 'on' : '')}" data-act="schemeTier" data-t="${esc(t)}">${t}</button>`).join('')}</div></div>
    <div class="actions">${sh.id ? (used ? '<p class="meta">In use, so it can’t be deleted</p>' : '<button class="danger" data-act="schemeDelete">Delete</button>') : ''}
      <button class="primary" data-act="schemeSave">Save</button></div>`;
}

function readSchemeInputs() {
  const d = ui.sheet.draft;
  const q = id => sheetEl.querySelector(id).value.trim();
  d.sets = Math.max(1, Number(q('#sc-sets')) || 1);
  d.reps = Math.max(1, Number(q('#sc-reps')) || 1);
  d.restSec = parseMSS(q('#sc-rest')) ?? 0;
  d.minutes = q('#sc-min') === '' ? null : Number(q('#sc-min'));
}

function findBlock(id) {
  const s = currentSession();
  return { s, b: s?.blocks.find(x => x.id === id) };
}

function reasonChips(cur) {
  return `<div class="chips">${REASONS.map(r => `<button class="chip ${esc(cur === r ? 'on' : '')}" data-act="reason" data-v="${esc(r)}">${r}</button>`).join('')}</div>`;
}

function sheetSwapEx(sh) {
  const { s, b } = findBlock(sh.blockId);
  const cur = exOf(b.exerciseId), fam = famOf(cur.familyId);
  const loc = L.placeOf(state, s);
  // What you usually swap this for comes first, marked; favorites carry a star.
  const usual = new Map(Taste.replacements(Taste.taste(state), cur.id, b.tier).map(r => [r.id, r.count]));
  const alts = L.alternatives(state, cur, loc).sort((x, y) => (usual.get(y.id) ?? 0) - (usual.get(x.id) ?? 0));
  return `<h3>Swap ${esc(cur.name)}</h3><div class="meta">${esc(fam?.name)} at ${esc(loc?.name)}</div>
    <div class="label">Why? <span class="hint">optional</span></div>${reasonChips(sh.reason)}
    <div class="list">${alts.map(a => `<button class="row" data-act="pickEx" data-id="${esc(a.id)}"><span>${a.pref === 'fav' ? '★ ' : ''}${esc(a.name)}</span>
      <span class="meta">${usual.has(a.id) ? 'your usual · ' : ''}${a.rank < cur.rank ? 'harder' : 'easier'}${a.metric !== 'load_reps' && !a.explosive && (b.tier === 'T1' || b.tier === 'T2') ? ' · won’t count' : ''}</span></button>`).join('')
      || '<p class="muted">Nothing else in this category here.</p>'}
    <button class="row add" data-act="qaVariation" data-id="${esc(cur.id)}" data-from="swap">+ New variation</button>
    <button class="row add" data-act="swapAny">All exercises ›</button>
    <button class="row add" data-act="tastePref" data-id="${esc(cur.id)}" data-v="never">${cur.pref === 'never' ? `Suggest ${esc(cur.name)} again` : `Never suggest ${esc(cur.name)}`}</button></div>`;
}

function sheetSwapScheme(sh) {
  const { s, b } = findBlock(sh.blockId);
  const ex = exOf(b.exerciseId);
  const budget = sessionBudget(s, b) - L.overhead(state, b.tier, b.exerciseId, s.locationId ?? null);
  const time = sc => round(L.setsMinutes(state, b, s.blocks, sc));
  return `<h3>Scheme for ${esc(ex.name)}</h3><div class="meta">${esc(b.tier)} · ${round(budget)} min left</div>
    <div class="label">Why? <span class="hint">optional</span></div>${reasonChips(sh.reason)}
    <div class="list">${L.schemeOptions(state, b.tier).map(sc => {
      const load = L.targetLoad(state, ex, b.tier, sc, s.checkinAt);
      const bits = [`${time(sc)} min`, `${L.schemeReps(sc)} ${L.repUnit(b.tier)}`, load != null ? `${ex.bodyweight ? 'BW+' : ''}${load} ${unit()}` : '',
        L.doseFit(state, b.tier, sc, L.slotDose(state, L.byId(state.slots, b.slotId), b.tier)) ? '✓ goal' : '', time(sc) > budget ? 'over time' : '',
        L.overRepCap(ex, sc) ? 'too many reps' : ''].filter(Boolean);
      const dim = time(sc) > budget || L.overRepCap(ex, sc);
      return `<button class="row ${esc(sc.id === b.schemeId ? 'on' : '')} ${dim ? 'dim' : ''}" data-act="pickScheme" data-id="${esc(sc.id)}">
        <span>${esc(sc.name)}</span><span class="meta">${esc(bits.join(' · '))}</span></button>`;
    }).join('')}</div>`;
}

function sheetPair(sh) {
  const { s, b } = findBlock(sh.blockId);
  const ex = exOf(b.exerciseId);
  const idea = L.suggestPair(state, s, ex, { excludeFamilies: s.blocks.map(x => exOf(x.exerciseId)?.familyId) });
  // Free blocks to pair with, or existing groups (by their leader) to join as a giant set.
  const others = s.blocks.filter(x => x !== b && !x.pairOf);
  const names = o => groupOf(s, o).map(x => esc(exOf(x.exerciseId)?.name)).join(' + ');
  return `<h3>Superset with ${esc(ex.name)}</h3>
    <div class="list">
      ${idea && b.tier !== 'T3' ? `<button class="row" data-act="pairAdd" data-b="${esc(b.id)}" data-ex="${esc(idea.exercise.id)}"><span>+ ${esc(idea.exercise.name)} <span class="tier T3">T3</span></span><span class="meta">suggested</span></button>` : ''}
      ${others.length ? `<div class="label">Already in this workout</div>${others.map(o => `<button class="row" data-act="pairLink" data-b="${esc(b.id)}" data-o="${esc(o.id)}">
        <span>${names(o)} <span class="tier ${esc(o.tier)}">${esc(o.tier)}</span></span><span class="meta">${inPair(s, o) ? 'giant set' : ''}</span></button>`).join('')}` : ''}
      <button class="row add" data-act="pairAny" data-b="${esc(b.id)}">All exercises ›</button></div>`;
}

const MOB_PICK_TITLE = { new: 'Mobility session', session: 'Add mobility', workout: 'Add mobility to this workout', routine: 'Add to routine' };

function sheetMobPick(sh) {
  const last = M.lastDoneAt(state);
  const shown = sh.parts.length || sh.mode === 'routine' ? M.rankForParts(state, sh.parts, sh.exclude) : [];
  return `<h3>${MOB_PICK_TITLE[sh.mode]}</h3>
    <p class="meta">Up to 3 body parts</p>
    <div class="chips">${M.BODY_PARTS.map(p => `<button class="chip ${esc(sh.parts.includes(p) ? 'on' : '')}" data-act="mobPart" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <div class="list">${shown.map(({ e }) => `<button class="row ${esc(sh.picked.includes(e.id) ? 'on' : '')}" data-act="mobTick" data-id="${esc(e.id)}">
      <span>${sh.picked.includes(e.id) ? '☑' : '☐'} ${esc(e.name)}</span>
      <span class="meta">${esc(`${M.doseText(e)}${last.has(e.id) ? ` · ${fmtAgo(last.get(e.id))}` : ''}`)}</span></button>`).join('')
      || (sh.parts.length ? '<p class="muted">Nothing for those yet.</p>' : '')}
      <button class="row add" data-act="mobExNew">+ New mobility exercise</button></div>
    <div class="actions"><button class="primary" data-act="mobAddPicked">${sh.mode === 'new' ? 'Start' : 'Add'}${sh.picked.length ? ` ${sh.picked.length}` : ''}</button></div>`;
}

function sheetMobEx(sh) {
  const d = sh.draft;
  const num = (id, v) => `<input id="${esc(id)}" class="num" inputmode="numeric" value="${esc(v ?? '')}">`;
  const box = (id, on, label) => `<label class="toggle"><input type="checkbox" id="${esc(id)}" ${on ? 'checked' : ''}> ${label}</label>`;
  const used = sh.id && M.loggedItems(state).some(x => x.item.exerciseId === sh.id);
  return `<h3>${sh.isNew ? 'New mobility exercise' : 'Edit mobility exercise'}</h3>
    <div class="field"><label>Name</label><input id="me-name" value="${esc(d.name)}" placeholder="e.g. 90/90 hip switch"></div>
    <div class="field"><label>Body parts</label><div class="chips">${M.BODY_PARTS.map(p => `<button class="chip ${esc(d.parts.includes(p) ? 'on' : '')}" data-act="mobExPart" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>
    <div class="row2 fields">
      <div class="field"><label>Sets</label>${num('me-sets', d.sets)}</div>
      <div class="field"><label>Reps</label>${num('me-reps', d.reps)}</div>
      <div class="field"><label>Up to</label>${num('me-repsmax', d.repsMax)}</div></div>
    <div class="row2 fields">
      <div class="field"><label>Hold (s)</label>${num('me-hold', d.hold)}</div>
      <div class="field"><label>Up to</label>${num('me-holdmax', d.holdMax)}</div>
      <div class="field"><label>Rest</label><input id="me-rest" class="num" value="${esc(clock(d.restSec || 0))}"></div></div>
    ${box('me-side', d.perSide, 'Each side')}
    <div class="field"><label>Tempo <span class="hint">optional</span></label><input id="me-tempo" value="${esc(d.tempo)}" placeholder="e.g. 4s down / 2s hold"></div>
    <div class="field"><label>Log each set with</label>${box('me-t-reps', d.track.reps, 'Reps')}${box('me-t-hold', d.track.hold, 'Hold time')}${box('me-t-load', d.track.load, 'Load')}
      <input id="me-t-extra" value="${esc(d.track.extra)}" placeholder="Other, e.g. Depth"></div>
    <div class="field"><label>Cues</label><textarea id="me-cues" rows="2">${esc(d.cues)}</textarea></div>
    <div class="field"><label>Video <span class="hint">link or search</span></label><input id="me-video" value="${esc(d.video)}" placeholder="e.g. kneesovertoesguy elephant walk"></div>
    <div class="field"><label>History notes</label><textarea id="me-notes" rows="2">${esc(d.notes)}</textarea></div>
    ${sh.isNew ? '' : box('me-arch', d.archived, 'Archived')}
    <div class="actions">${!sh.isNew && !used ? '<button class="danger" data-act="mobExDelete">Delete</button>' : ''}${used ? `<button data-act="histOpen" data-q="${esc(d.name)}">History</button>` : ''}<button class="primary" data-act="mobExSave">Save</button></div>`;
}

function readMobDraft() {
  const d = ui.sheet.draft, q = id => sheetEl.querySelector(id);
  if (!q('#me-name')) return d;
  const n = id => { const v = q(id).value.trim(); return v === '' ? null : Math.max(0, Number(v) || 0); };
  Object.assign(d, {
    name: q('#me-name').value.trim(), sets: n('#me-sets') || 1, reps: n('#me-reps'), repsMax: n('#me-repsmax'), hold: n('#me-hold'), holdMax: n('#me-holdmax'),
    restSec: parseMSS(q('#me-rest').value) ?? 0, perSide: q('#me-side').checked, tempo: q('#me-tempo').value.trim(),
    track: { reps: q('#me-t-reps').checked, hold: q('#me-t-hold').checked, load: q('#me-t-load').checked, extra: q('#me-t-extra').value.trim() },
    cues: q('#me-cues').value.trim(), video: q('#me-video').value.trim(), notes: q('#me-notes').value.trim(), archived: q('#me-arch')?.checked ?? !!d.archived,
  });
  return d;
}

// One exercise's history: the max the loads come from, what's next at each tier, and every session with it, newest
// first (sets, best e1RM, and whether every prescribed rep was hit).
function sheetExHist(sh) {
  const ex = exOf(sh.id);
  if (!ex) return '<p class="muted">Exercise not found.</p>';
  const day = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const bySession = new Map();
  for (const st of state.sets) {
    if (!st.done || st.exerciseId !== ex.id) continue;
    const k = `${st.sessionId}|${st.tier}`;
    if (!bySession.has(k)) bySession.set(k, { tier: st.tier, at: st.loggedAt, sets: [] });
    const g = bySession.get(k);
    g.sets.push(st);
    g.at = Math.min(g.at, st.loggedAt);
  }
  const groups = [...bySession.values()].sort((a, b) => b.at - a.at);
  const shown = groups.slice(0, sh.limit ?? 20);
  const line = g => {
    const work = g.sets.filter(x => !x.warmup).sort((a, b) => a.loggedAt - b.loggedAt);
    const sc = schOf(work[0]?.schemeId);
    const best = Math.max(0, ...work.map(x => L.setE1rm(state, x) || 0));
    const hit = sc && ['T1', 'T2'].includes(g.tier) && ex.metric === 'load_reps'
      ? (work.reduce((n, x) => n + (Number(x.reps) || 0), 0) >= L.schemeReps(sc) ? ' · ✓ every rep' : ' · short') : ''; // in total, as progression counts them
    return `<div class="histex"><span class="tier ${esc(g.tier)}">${esc(g.tier)}</span><span class="grow"><span class="name">${esc(day(g.at))}${sc ? ` · ${esc(sc.name)}` : ''}</span>
      <span class="meta">${esc(histSets({ ex, sets: g.sets }))}${best ? ` · e1RM ${round(best)}` : ''}${hit}</span></span></div>`;
  };
  // What the next session asks for at each tier you've done it at lately (same scheme as last time).
  const next = ['T1', 'T2'].map(t => {
    const last = L.lastOutcome(state, ex.id, t);
    if (!last) return '';
    const load = L.targetLoad(state, ex, t, last.scheme);
    return load == null ? '' : `<div class="frow"><span class="tier ${esc(t)}">${t}</span><span class="grow"><span class="name">Next ${esc(last.scheme.name)}: ${ex.bodyweight ? 'BW+' : ''}${load} ${unit()}</span>
      <span class="meta">${last.complete ? `every rep at ${last.load} last time, so up` : `${last.short} rep${last.short === 1 ? '' : 's'} short at ${last.load} last time, so the same`}</span></span></div>`;
  }).join('');
  return `<h3>${esc(ex.name)}</h3>
    ${maxLine(ex) ? `<div class="meta">${esc(maxLine(ex))}</div>` : ''}
    ${next ? `<div class="label">Next time</div><div class="menu">${next}</div>` : ''}
    ${groups.length ? exerciseCharts(ex, sh) : ''}
    <div class="label">${groups.length} session${groups.length === 1 ? '' : 's'}</div>
    ${shown.map(line).join('') || '<p class="muted">Nothing logged yet.</p>'}
    ${groups.length > shown.length ? `<button class="addblock" data-act="exHistMore">Show more (${groups.length - shown.length} older)</button>` : ''}
    <div class="actions"><button data-act="histOpen" data-q="${esc(ex.name)}">Full workouts</button></div>`;
}

// The exercise's own progress: estimated max, then what fits how it's logged (volume, reps, longest hold, best jump).
function exerciseCharts(ex, sh) {
  const range = sh.range ?? '12w';
  const { from, to } = PG.rangeBounds(state, range);
  const u = unit(), ju = B.jumpUnit(state);
  const ss = PG.exerciseSessions(state, ex.id, from, to);
  let h = `<div class="seg ranges">${PG.RANGES.map(([k, t]) => `<button class="${esc(range === k ? 'on' : '')}" data-act="exHistRange" data-v="${esc(k)}">${t}</button>`).join('')}</div>`;
  if (!ss.length) return `${h}<p class="muted">Nothing logged in this range.</p>`;
  const tipDay = (w, value, sub) => ({ value, title: fmtShortDay(w.t), sub });
  const table = (head, f) => ({ head: ['Day', ...head], rows: ss.map(w => [fmtShortDay(w.t), ...f(w)]) });
  if (ex.metric === 'load_reps') {
    const ser = PG.e1rmSeries(state, ex.id, from, to);
    const ch = PG.liftChange(ser);
    if (ser.length) {
      h += chartCard('ex-e1rm', 'Estimated 1-rep max', ch ? `<b>${signedNum(ch.delta)} ${u}</b> · ${round(ch.first)} → ${round(ch.last)}${ch.best > ch.last ? ` · best ${round(ch.best)}` : ''}` : '',
        CH.lineChart('ex-e1rm', `${ex.name} estimated 1-rep max`, ser.map(p => ({ t: p.t, v: p.v, tip: { value: `${round(p.v)} ${u}`, title: fmtShortDay(p.t), sub: `best set ${p.load} × ${p.reps}` } }))),
        { head: ['Day', `e1RM (${u})`, 'Best set'], rows: ser.map(p => [fmtShortDay(p.t), round(p.v), `${p.load} × ${p.reps}`]) });
    }
    h += chartCard('ex-volume', 'Volume per session', `Avg <b>${CH.fmtNum(ss.reduce((x, w) => x + w.volume, 0) / ss.length)} ${u}</b>`,
      CH.columnChart('ex-volume', `${ex.name} volume per session`, ss.map(w => ({ t: w.t, parts: [{ key: 'series', v: w.volume }], tip: tipDay(w, `${CH.fmtNum(w.volume)} ${u}`, `${w.sets} sets, ${w.reps} reps`) }))),
      table([`Volume (${u})`, 'Sets', 'Reps'], w => [round(w.volume).toLocaleString('en-US'), w.sets, w.reps]));
  } else if (ex.metric === 'time') {
    h += chartCard('ex-hold', 'Longest hold per session', '',
      CH.columnChart('ex-hold', `${ex.name} longest hold`, ss.map(w => ({ t: w.t, parts: [{ key: 'series', v: w.hold }], tip: tipDay(w, `${w.hold} s`, `${w.sets} sets`) })), { fmt: v => `${v}s` }),
      table(['Longest (s)', 'Sets'], w => [w.hold, w.sets]));
  }
  if (ex.metric === 'reps' || (ex.metric === 'load_reps' && !ss.some(w => w.volume))) {
    h += chartCard('ex-reps', 'Reps per session', `Avg <b>${round(ss.reduce((x, w) => x + w.reps, 0) / ss.length)}</b>`,
      CH.columnChart('ex-reps', `${ex.name} reps per session`, ss.map(w => ({ t: w.t, parts: [{ key: 'series', v: w.reps }], tip: tipDay(w, `${w.reps} reps`, `${w.sets} sets`) }))),
      table(['Reps', 'Sets'], w => [w.reps, w.sets]));
  }
  const jumps = ss.filter(w => w.jump > 0);
  if (jumps.length) {
    h += chartCard('ex-jump', 'Best jump', jumps.length > 1 ? `<b>${signedNum(jumps.at(-1).jump - jumps[0].jump, 1)} ${ju}</b> · best ${Math.max(...jumps.map(w => w.jump))}` : '',
      CH.lineChart('ex-jump', `${ex.name} best jump`, jumps.map(w => ({ t: w.t, v: w.jump, tip: tipDay(w, `${w.jump} ${ju}`, `${w.sets} sets`) }))),
      { head: ['Day', `Best (${ju})`], rows: jumps.map(w => [fmtShortDay(w.t), w.jump]) });
  }
  return h;
}

function sheetFinishAsk(sh) {
  return `<h3>${sh.left} set${sh.left === 1 ? '' : 's'} not logged yet</h3>
    <p class="meta">Finishing drops them. Pause keeps them for later today.</p>
    <div class="actions"><button data-act="finishNow">Finish now</button><button class="primary" data-act="pause">Pause</button></div>`;
}

function sheetMoreTime() {
  return `<h3>More time</h3>
    <div class="seg">${[10, 15, 20, 30, 45].map(m => `<button data-act="addTime" data-v="${esc(m)}">+${m} min</button>`).join('')}</div>`;
}

// In-app confirmation; native confirm() is unavailable in some hosts.
function askConfirm(title, body, yes, onYes) {
  openSheet({ type: 'confirm', title, body, yes, onYes });
}

function sheetConfirm(sh) {
  return `<h3>${esc(sh.title)}</h3><p class="meta">${esc(sh.body)}</p>
    <div class="actions"><button data-act="sheetClose">Cancel</button><button class="danger solid" data-act="confirmYes">${esc(sh.yes)}</button></div>`;
}

function sheetReviewText(sh) {
  return `<h3>Copy review</h3><p class="meta">Select and copy:</p>
    <textarea id="review-text" rows="12" readonly>${esc(sh.text)}</textarea>`;
}

function sheetBackupText(sh) {
  return `<h3>Copy your backup</h3><p class="meta">Select all, copy, and paste it into a note:</p>
    <textarea id="backup-json" rows="8" readonly>${esc(sh.json)}</textarea>`;
}

function sheetPasteImport() {
  return `<h3>Restore from a backup</h3>
    <textarea id="paste-json" rows="8" placeholder='{"version":1,...}'></textarea>
    <div class="actions"><button class="primary" data-act="pasteImportGo">Restore</button></div>`;
}

const REST_PRESETS = [30, 45, 60, 90, 120, 150, 180, 240, 300];

function sheetRest(sh) {
  const { b } = findBlock(sh.blockId);
  const ex = exOf(b.exerciseId), sc = schOf(b.schemeId);
  const cur = sh.value ?? effectiveRest(b);
  return `<h3>Rest for ${esc(ex.name)}</h3>
    <div class="meta">${esc(sc.name)} default ${clock(sc.restSec)}${ex.restSec != null ? ` · yours ${clock(ex.restSec)}` : ''}</div>
    <div class="restbig">${clock(cur)}</div>
    <div class="seg"><button data-act="restNudge" data-d="-15">−15s</button><button data-act="restNudge" data-d="15">+15s</button></div>
    <div class="chips">${REST_PRESETS.map(v => `<button class="chip ${esc(v === cur ? 'on' : '')}" data-act="restPreset" data-v="${esc(v)}">${clock(v)}</button>`).join('')}</div>
    <label class="toggle"><input type="checkbox" id="rest-save" ${sh.saveDefault ? 'checked' : ''}> Always for ${esc(ex.name)}</label>
    <div class="actions">
      ${b.restSec != null || ex.restSec != null ? '<button data-act="restClear">Scheme default</button>' : ''}
      <button class="primary" data-act="restApply">Use ${clock(cur)}</button></div>`;
}

function sheetPlans() {
  if (!state.plans.length) return `<h3>Plans</h3><p class="muted">No saved plans yet.</p><button data-act="goPlans">Build one</button>`;
  return `<h3>Use a plan</h3><div class="meta">Logged sets stay</div><div class="list">${state.plans.map(p =>
    `<button class="row" data-act="applyPlan" data-id="${esc(p.id)}"><span>${esc(p.name)}</span></button>`).join('')}</div>`;
}

const equipChip = (eq, on, name) => `<label class="chip ${on ? 'on' : ''}"><input type="checkbox" name="${esc(name)}" value="${esc(eq)}" ${on ? 'checked' : ''}>${esc(eq)}</label>`;

function equipChips(sel, name) {
  return `<div class="chips">${state.equipment.map(eq => equipChip(eq, sel.includes(eq), name)).join('')}
    <input class="chipinput" data-eqnew="${esc(name)}" placeholder="+ New" aria-label="Add equipment" enterkeyhint="done"></div>`;
}

const LOG_TYPES = [['load_reps', 'Weight × reps'], ['reps', 'Reps'], ['time', 'Time'], ['distance', 'Distance']];

// Starting values for the new-exercise form: copied from the base exercise for a variation.
function qaDefaults(sh, base) {
  const name = sh.name ?? '';
  const d = base
    ? { famId: base.familyId, metric: base.metric, bodyweight: base.bodyweight, equipment: [...base.equipment] }
    : { famId: famOf(sh.familyId)?.id ?? null, metric: 'load_reps', bodyweight: false, equipment: [] };
  if (/^weighted\b/i.test(name)) Object.assign(d, weightedDefaults(d));
  d.region = base?.region ?? L.guessRegion(name);
  d.explosive = base?.explosive ?? L.guessExplosive(name);
  return d;
}

// "Weighted …" means added load on top of bodyweight, usually on a dip belt.
function weightedDefaults(d) {
  const equipment = [...d.equipment];
  if (state.equipment.includes('dip-belt') && !equipment.includes('dip-belt')) equipment.push('dip-belt');
  return { metric: 'load_reps', bodyweight: true, equipment };
}

// The existing exercise whose name appears inside the typed name, longest first ("weighted ring dip" → Ring dip).
function similarExercise(typed) {
  const t = typed.trim().toLowerCase();
  if (t.length < 3) return null;
  const exact = state.exercises.find(e => e.name.toLowerCase() === t);
  if (exact) return { e: exact, exact: true };
  const hits = state.exercises.filter(e => e.name.length >= 4 && t.includes(e.name.toLowerCase()));
  hits.sort((a, b) => b.name.length - a.name.length);
  return hits[0] ? { e: hits[0], exact: false } : null;
}

function qaHint(typed, sh) {
  const m = similarExercise(typed);
  if (!m) return '';
  if (m.exact) return `You already have ${esc(m.e.name)}.`;
  if (sh.baseId === m.e.id) return '';
  return `Looks like a variation of ${esc(m.e.name)}. <button class="link" data-act="qaUseBase" data-id="${esc(m.e.id)}">Copy its details</button>`;
}

// A category (a family: exercises that swap for each other): its name, what's in it, exercises to move in from other
// categories, and new ones typed one per line.
function readCatInputs() {
  const d = ui.sheet?.draft;
  if (!d) return;
  const name = sheetEl.querySelector('#cat-name'), add = sheetEl.querySelector('#cat-new');
  if (name) d.name = name.value;
  if (add) d.newLines = add.value;
}

function sheetCategory(sh) {
  const d = sh.draft, fam = sh.id ? famOf(sh.id) : null;
  const members = fam ? L.familyMembers(state, fam.id) : [];
  const q = (sh.q || '').trim().toLowerCase();
  const others = state.exercises.filter(e => !e.archived && e.familyId !== sh.id);
  const shown = q ? others.filter(e => e.name.toLowerCase().includes(q) || famOf(e.familyId)?.name.toLowerCase().includes(q))
    : sh.part ? others.filter(e => L.bodyPart(state, e) === sh.part) : others.filter(e => d.moveIn.includes(e.id));
  const goals = fam ? state.slots.filter(sl => sl.familyId === fam.id).length : 0;
  return `<h3>${fam ? 'Edit category' : 'New category'}</h3>
    <div class="field"><label>Name</label><input id="cat-name" value="${esc(d.name)}" placeholder="e.g. Triceps" autocomplete="off"></div>
    ${members.length ? `<div class="label">In it</div><div class="chips">${members.map(e => `<span class="chip">${esc(e.name)}${e.archived ? ' (archived)' : ''}</span>`).join('')}</div>` : ''}
    <div class="label">Move exercises here</div>
    <input class="search" id="catq" data-catq value="${esc(sh.q || '')}" placeholder="Search" autocomplete="off">
    ${q ? '' : partChips(others, sh.part, 'catPart')}
    <div class="list">${shown.sort((a, b) => a.name.localeCompare(b.name)).map(e => `<button class="row ${esc(d.moveIn.includes(e.id) ? 'on' : '')}" data-act="catPick" data-id="${esc(e.id)}">
      <span>${d.moveIn.includes(e.id) ? '☑' : '☐'} ${esc(e.name)}</span><span class="meta">${esc(famOf(e.familyId)?.name ?? '')}</span></button>`).join('')
      || (q || sh.part ? '<p class="muted">No matches.</p>' : '')}</div>
    <div class="field"><label>New exercises <span class="hint">one per line</span></label><textarea id="cat-new" rows="3" placeholder="e.g. Cable pushdown">${esc(d.newLines)}</textarea></div>
    <div class="actions">${fam ? `<button class="danger" data-act="catDelete">Delete</button>` : ''}
      <button class="primary" data-act="catSave">${fam ? 'Save' : 'Create'}${d.moveIn.length ? ` · move ${d.moveIn.length}` : ''}</button></div>
    ${goals ? `<p class="meta">${goals} weekly goal${goals === 1 ? '' : 's'} use this category.</p>` : ''}`;
}

function sheetQuickAdd(sh) {
  const base = sh.baseId ? exOf(sh.baseId) : null;
  const d = qaDefaults(sh, base);
  const label = sh.from === 'swap' ? 'Add and use' : sh.from === 'ob' ? 'Add and pick' : sh.from === 'add' ? `Add to today as ${sh.tier}` : 'Add exercise';
  const radio = (name, value, text, on) => `<label><input type="radio" name="${esc(name)}" value="${esc(value)}" ${on ? 'checked' : ''}>${text}</label>`;
  return `<h3>${base ? `New variation of ${esc(base.name)}` : 'New exercise'}</h3>
    <div class="field"><label>Name</label><input id="qa-name" data-qaname autocomplete="off" value="${esc(sh.name ?? '')}"
      placeholder="${base ? `e.g. Weighted ${esc(base.name.toLowerCase())}` : 'e.g. Pause squat'}"></div>
    <div id="qa-hint" class="qahint">${qaHint(sh.name ?? '', sh)}</div>
    ${base ? `<div class="field"><label>Compared with ${esc(base.name)}</label><div class="seg radio">
      ${radio('qa-place', 'harder', 'Harder', true)}${radio('qa-place', 'easier', 'Easier', false)}</div></div>` : ''}
    <div class="field"><label>Category <span class="hint">swaps within it</span></label>
      <select id="qa-famsel" data-qafam>${opts([['', 'Choose…'], ...[...state.families].sort((a, b) => a.name.localeCompare(b.name)).map(f => [f.id, f.name]), ['__new', '+ New category']], d.famId ?? '')}</select>
      <input id="qa-fam" autocomplete="off" value="" placeholder="New category name" hidden></div>
    <div class="field"><label>How do you log it?</label><div class="seg radio">
      ${LOG_TYPES.map(([v, t]) => radio('qa-metric', v, t, d.metric === v)).join('')}</div></div>
    <label class="toggle"><input type="checkbox" id="qa-bw" ${d.bodyweight ? 'checked' : ''}> Added to bodyweight <span class="hint">e.g. weighted dips</span></label>
    <div class="field"><label>Equipment</label>${equipChips(d.equipment, 'qa-eq')}</div>
    <label class="toggle"><input type="checkbox" id="qa-any" ${base ? (base.anytime ? 'checked' : '') : ''}> No setup <span class="hint">fits a spare few minutes</span></label>
    <div class="field"><label>Body region</label><div class="seg radio">
      ${radio('qa-region', 'lower', 'Lower', d.region === 'lower')}${radio('qa-region', 'upper', 'Upper', d.region === 'upper')}${radio('qa-region', 'full', 'Whole body', d.region === 'full')}</div></div>
    <label class="toggle"><input type="checkbox" id="qa-expl" ${d.explosive ? 'checked' : ''}> Explosive <span class="hint">jumps, throws, Olympic lifts</span></label>
    <button class="primary big" data-act="qaSave">${label}</button>`;
}

// "e1RM 346 from your sets" / "1RM 350 you tested Oct 13" for an exercise, or ''.
const shortDay = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function maxLine(e) {
  const max = e.metric === 'load_reps' ? L.estimatedMax(state, e.id) : null;
  if (!max) return '';
  const tm = e.testedMax;
  const total = e.bodyweight ? ' incl. bodyweight' : '';
  return L.maxSource(state, e.id) === 'tested'
    ? `1RM ${round(max)}${total}${tm?.at ? ` · tested ${shortDay(tm.at)}` : ''}`
    : `e1RM ${round(max)}${total} · from your sets`;
}
// Saves a typed-in 1RM (blank clears it); a changed value is dated today.
function setTestedMax(e, raw) {
  const v = String(raw ?? '').trim();
  if (v === '' || !(Number(v) > 0)) { e.testedMax = null; e.startMax = null; return; }
  if (Number(v) !== Number(e.testedMax?.load)) e.testedMax = { load: Number(v), at: Date.now() };
  e.startMax = null;
}

function sheetMax(sh) {
  const e = exOf(sh.id);
  return `<h3>1-rep max: ${esc(e.name)}</h3>
    <div class="field"><label>Tested 1RM (${unit()}${e.bodyweight ? ', added load' : ''})</label>
      <input id="mx-load" inputmode="decimal" value="${esc(e.testedMax?.load ?? '')}" placeholder="e.g. 315"></div>
    <p class="meta">Counts for ${L.TESTED_MAX_WEEKS} weeks; stronger sets still raise it.</p>
    <div class="actions"><button class="primary" data-act="maxSave" data-id="${esc(e.id)}">Save</button></div>`;
}

function sheetEditEx(sh) {
  const e = exOf(sh.id);
  const fam = famOf(e.familyId);
  const famOpts = [...state.families].sort((a, b) => a.name.localeCompare(b.name)).map(f => [f.id, f.name]);
  const hasHistory = state.sets.some(s => s.done && s.exerciseId === e.id);
  const max = e.metric === 'load_reps' ? L.estimatedMax(state, e.id) : null;
  return `<h3>Edit exercise</h3>
    <div class="field"><label>Name</label><input id="ee-name" value="${esc(e.name)}"></div>
    <div class="field"><label>Category</label><select id="ee-fam">${opts(famOpts, e.familyId)}</select></div>
    <label class="toggle"><input type="checkbox" id="ee-default" ${fam?.defaultExerciseId === e.id ? 'checked' : ''}> Usual choice for this category</label>
    <div class="field"><label>How do you log it?</label><select id="ee-metric">${opts(METRICS, e.metric)}</select></div>
    <label class="toggle"><input type="checkbox" id="ee-bw" ${e.bodyweight ? 'checked' : ''}> Added to bodyweight <span class="hint">e.g. weighted dips</span></label>
    <div class="field"><label>1-rep max (${unit()}${e.bodyweight ? ', added load' : ''}) <span class="hint">${e.testedMax?.at ? `tested ${shortDay(e.testedMax.at)}` : 'optional'}</span></label>
      <input id="ee-max" inputmode="decimal" value="${esc(e.testedMax?.load ?? e.startMax ?? '')}" placeholder="Your tested max">
      <div class="meta">${max ? esc(maxLine(e)) : 'No max yet'}</div></div>
    <div class="field"><label>Max reps per set <span class="hint">optional</span></label>
      <input id="ee-maxreps" inputmode="numeric" value="${esc(e.maxReps)}" placeholder="e.g. 5"></div>
    <div class="field"><label>Rest (m:ss) <span class="hint">optional</span></label>
      <input id="ee-rest" value="${esc(e.restSec != null ? clock(e.restSec) : '')}" placeholder="e.g. 2:30"></div>
    <div class="field"><label>Equipment</label>${equipChips(e.equipment, 'ee-eq')}</div>
    <label class="toggle"><input type="checkbox" id="ee-any" ${e.anytime ? 'checked' : ''}> No setup <span class="hint">fits a spare few minutes</span></label>
    <div class="field"><label>Body region</label>
      <select id="ee-region">${opts([['lower', 'Lower body'], ['upper', 'Upper body'], ['full', 'Whole body']], e.region || 'full')}</select></div>
    <label class="toggle"><input type="checkbox" id="ee-expl" ${e.explosive ? 'checked' : ''}> Explosive <span class="hint">jumps, throws, Olympic lifts</span></label>
    <div class="field"><label>Role</label>
      <select id="ee-role">${opts([['main', 'Main lift (T1/T2 strength)'], ['power', 'Power (explosive T1/T2)'], ['accessory', 'Accessory (T3 only)'], ['technique', 'Technique drill']], e.role ?? L.guessRole(e.name, e.metric, e.explosive))}</select></div>
    <div class="field"><label>In suggestions</label>
      <select id="ee-pref">${opts([['', 'Normal'], ['fav', 'Favorite'], ['never', 'Never suggest']], e.pref ?? '')}</select></div>
    <label class="toggle"><input type="checkbox" id="ee-arch" ${e.archived ? 'checked' : ''}> Archived <span class="hint">history only</span></label>
    <div class="field"><label>YouTube URL</label><input id="ee-yt" value="${esc(e.youtube)}" placeholder="https://youtu.be/..."></div>
    <div class="field"><label>Start time (m:ss)</label><input id="ee-start" value="${esc(fmtMSS(e.start))}" placeholder="0:42"></div>
    <div class="field"><label>Cues</label><textarea id="ee-cues" rows="3">${esc(e.cues)}</textarea></div>
    <div class="actions">${hasHistory ? '' : `<button class="danger" data-act="exDelete" data-id="${esc(e.id)}">Delete</button>`}
      ${hasHistory ? `<button data-act="exHist" data-id="${esc(e.id)}">History</button>` : ''}
      <button data-act="qaVariation" data-id="${esc(e.id)}">Make a variation</button>
      <button class="primary" data-act="exSave" data-id="${esc(e.id)}">Save</button></div>`;
}

// ---------- actions ----------

function swapTo(exerciseId) {
  const { s, b } = findBlock(ui.sheet.blockId);
  b.swaps.push({ type: 'exercise', from: b.exerciseId, to: exerciseId, reason: ui.sheet.reason, at: Date.now() });
  b.exerciseId = exerciseId;
  b.slotId = slotIdFor(exerciseId, b.tier); // the goal the new exercise counts toward, not the old one's
  if (s.source === 'suggested') s.source = 'swapped';
  genSets(s, b);
  ui.sheet = null;
  save(); render();
}

function normalizeRanks(familyId) {
  L.familyMembers(state, familyId).forEach((e, i) => { e.rank = i + 1; });
}

// Moves an exercise to another category (to the end of it). Goals that name it go with it; the old category picks a new
// usual choice if it was this one.
function moveExercise(e, familyId) {
  if (!e || e.familyId === familyId) return;
  const old = famOf(e.familyId);
  e.rank = (L.familyMembers(state, familyId).at(-1)?.rank ?? 0) + 1;
  e.familyId = familyId;
  for (const sl of state.slots) if (sl.exerciseId === e.id) sl.familyId = familyId;
  if (old) {
    normalizeRanks(old.id);
    if (old.defaultExerciseId === e.id) old.defaultExerciseId = L.familyMembers(state, old.id).find(x => !x.archived)?.id ?? null;
  }
  const fam = famOf(familyId);
  if (fam && !fam.defaultExerciseId) fam.defaultExerciseId = e.id;
}

const actions = {
  nav: d => {
    ui.tab = d.tab;
    ui.plan = ui.tab === 'plans' ? ui.plan : null;
    ui.setPage = null;
    if (d.tab !== 'week') ui.goalsUndo = null;
    ui.history = null;
    ui.review = null;
    if (d.tab !== 'week') ui.reviewUndo = null;
    if (d.tab !== 'plans') ui.program = null;
    render(); window.scrollTo(0, 0);
  },

  histOpen: d => {
    ui.history = { q: d.q ?? '', limit: HISTORY_PAGE };
    ui.goalSuggest = null;
    ui.sheet = null; renderSheet();
    ui.tab = 'week';
    render(); window.scrollTo(0, 0);
  },
  exHist: d => openSheet({ type: 'exHist', id: d.id, limit: 20 }),
  exHistMore: () => { ui.sheet.limit += 20; renderSheet(); },
  histClose: () => { ui.history = null; render(); window.scrollTo(0, 0); },
  exHistRange: d => { ui.sheet.range = d.v; renderSheet(); },
  histMode: d => { ui.history.mode = d.v; render(); window.scrollTo(0, 0); },
  progRange: d => { ui.prog.range = d.v; render(); },
  histMore: () => { ui.history.limit += HISTORY_PAGE; render(); },

  gsOpen: () => {
    ui.goalSuggest = { ...G.suggestGoals(state), open: new Set() };
    ui.fn = null;
    ui.setPage = null;
    ui.tab = 'week';
    render(); window.scrollTo(0, 0);
  },
  gsToggle: d => {
    const open = ui.goalSuggest.open;
    open.has(d.key) ? open.delete(d.key) : open.add(d.key);
    render();
  },
  gsSet: d => {
    const r = ui.goalSuggest.rows.find(x => x.key === d.key);
    r[d.k] = d.k === 'priority' ? Number(d.v) : d.v;
    render();
  },
  gsStep: d => {
    const r = ui.goalSuggest.rows.find(x => x.key === d.key);
    r.quota = Math.min(7, Math.max(1, r.quota + Number(d.d)));
    render();
  },
  gsApply: d => {
    const g = ui.goalSuggest;
    if (!g.rows.some(r => r.include)) return toast('Tick at least one goal first');
    ui.goalsUndo = G.applyGoals(state, g.rows, d.mode);
    ui.goalSuggest = null;
    save(); render(); window.scrollTo(0, 0);
    toast(d.mode === 'replace' ? 'Goals replaced' : 'Goals added');
  },
  gsCancel: () => { ui.goalSuggest = null; render(); window.scrollTo(0, 0); },
  reviewOpen: d => {
    const data = R.weekReview(state, Number(d.w));
    ui.review = { data };
    ui.goalSuggest = null; ui.history = null;
    R.recordReview(state, data, data.finished ? 'reviewed' : 'open');
    save(); render(); window.scrollTo(0, 0);
  },
  reviewClose: () => { ui.review = null; render(); window.scrollTo(0, 0); },
  reviewDismiss: d => {
    R.recordReview(state, R.weekReview(state, Number(d.w)), 'dismissed');
    save(); render();
  },
  reviewAccept: d => reviewDecide([d.id], 'accepted'),
  reviewAcceptAll: () => {
    const rec = R.reviewRecord(state, ui.review.data.weekStart);
    reviewDecide(ui.review.data.proposals.filter(p => p.change && rec?.proposals.find(x => x.id === p.id)?.status === 'open').map(p => p.id), 'accepted');
  },
  reviewSkip: d => reviewDecide([d.id], 'skipped'),
  reviewUndo: () => {
    const before = ui.reviewUndo ?? readCopy('before-review');
    if (!before) return;
    state.slots = before.slots;
    for (const r of state.reviews) for (const p of r.proposals) if (before.accepted.includes(`${r.id}/${p.id}`)) p.status = 'open';
    dropCopy('before-review');
    ui.reviewUndo = null;
    save(); render(); toast('Your previous goals are back');
  },
  reviewCopy: () => {
    const text = R.reviewText(state, ui.review.data);
    const fallback = () => openSheet({ type: 'reviewText', text });
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast('Review copied'), fallback);
    else fallback();
  },
  gsUndo: () => {
    if (!ui.goalsUndo) return;
    state.slots = ui.goalsUndo;
    ui.goalsUndo = null;
    save(); render(); toast('Your previous goals are back');
  },

  ciSkip: d => {
    const on = new Set(ui.ci.skip || []);
    if (on.has(d.v)) on.delete(d.v); else on.add(d.v);
    ui.ci.skip = [...on]; ui.ci.skipDay = L.dayKey(); ui.skipOpen = true;
    render();
  },
  // Locations: tap to add or remove one; at least one stays. The first picked is the main one.
  ciLoc: d => {
    const ids = ui.ci.locationIds?.length ? [...ui.ci.locationIds] : [ui.ci.locationId];
    const i = ids.indexOf(d.v);
    if (i >= 0) { if (ids.length > 1) ids.splice(i, 1); } else ids.push(d.v);
    ui.ci.locationIds = ids;
    ui.ci.locationId = ids[0];
    render();
  },
  ci: d => {
    if (d.k === 'energy') { ui.ci.fatigue = 6 - Number(d.v); return render(); }
    const num = ['minutes', 'fatigue', 'sleep'].includes(d.k);
    const v = num ? Number(d.v) : d.v;
    ui.ci[d.k] = d.k === 'sleep' && ui.ci.sleep === v ? null : v;
    render();
  },

  suggest: () => {
    const res = L.buildSuggestion(state, ui.ci);
    const s = createSession(res.blocks, 'suggested', { why: whyRows(res), ready: res.ready, goalMinutes: res.goalMinutes, focusNotes: res.notes });
    if (res.pain) { addReliefHolds(s, res.pain); save(); }
    render(); window.scrollTo(0, 0);
  },

  // A focused workout replaces what's unlogged in the open session (logged work stays), or starts a new one.
  focus: d => {
    const region = d.r, explosive = !!d.x;
    let s = currentSession();
    if (s) keepStarted(s);
    const ci = s ? { ...s, minutes: sessionBudget(s) } : ui.ci;
    const res = L.buildFocus(state, ci, { region, explosive }, Date.now(), { excludeFamilies: (s?.blocks || []).map(b => exOf(b.exerciseId)?.familyId) });
    const extra = { focusRegion: region, focusExplosive: explosive, focusNotes: res.notes, ready: res.ready };
    if (s) {
      s.blocks.push(...res.blocks);
      L.pairT3s(state, s.blocks, L.placeOf(state, s));
      for (const b of res.blocks) genSets(s, b);
      Object.assign(s, extra, { source: 'focus' });
      delete s.why;
      delete s.goalMinutes;
      delete s.mix; // it's a focused workout now, so Regenerate rebuilds it as one
      save();
    } else {
      s = createSession(res.blocks, 'focus', extra);
    }
    render(); window.scrollTo(0, 0);
    if (!res.blocks.length) toast('Nothing fits here. Try another location or more time.');
  },

  mixStep: d => {
    const max = { T1: 3, T2: 6, T3: 14 }[d.t];
    ui.mix[d.t] = Math.max(0, Math.min(max, ui.mix[d.t] + Number(d.d)));
    ui.mixOpen = true;
    render();
  },
  mixBuild: () => {
    const mix = { ...ui.mix };
    const res = L.buildMix(state, ui.ci, mix);
    createSession(res.blocks, 'suggested', { mix, ready: res.ready, focusNotes: res.notes });
    ui.mixOpen = false;
    render(); window.scrollTo(0, 0);
    if (!res.blocks.length) toast('Nothing fits here. Try another location or more time.');
  },

  // Another take on the same check-in: blocks you haven't started are rebuilt with the picks rotated; started ones stay.
  regen: () => {
    const s = currentSession();
    if (!s || !['suggested', 'swapped', 'focus'].includes(s.source)) return;
    const started = new Set(s.blocks.filter(b => state.sets.some(x => x.blockId === b.id && x.done)).map(b => b.id));
    const before = s.blocks.filter(b => !started.has(b.id)).map(b => b.exerciseId).join();
    const keep = keepStarted(s);
    s.variant = (s.variant || 0) + 1;
    s.source = s.focusRegion ? 'focus' : 'suggested';
    const ci = { ...s, minutes: sessionBudget(s) };
    const excludeFamilies = keep.map(b => exOf(b.exerciseId)?.familyId);
    const res = s.mix ? L.buildMix(state, ci, s.mix, Date.now(), { excludeFamilies, sessionBlocks: keep })
      : s.focusRegion
      ? L.buildFocus(state, ci, { region: s.focusRegion, explosive: !!s.focusExplosive }, Date.now(), { excludeFamilies, sessionBlocks: keep })
      : L.buildSuggestion(state, ci, Date.now(), { excludeFamilies, sessionBlocks: keep });
    s.blocks.push(...res.blocks);
    L.pairT3s(state, s.blocks, L.placeOf(state, s));
    for (const b of res.blocks) genSets(s, b);
    s.focusNotes = res.notes;
    s.ready = res.ready;
    if (res.scored) {
      s.why = whyRows(res);
      s.goalMinutes = res.goalMinutes;
    }
    save(); render(); window.scrollTo(0, 0);
    // Your goals' lifts stay put, so a workout of only those can come back the same.
    toast(res.blocks.map(b => b.exerciseId).join() === before ? 'Same again: your goals fill this one' : 'New take on today');
  },

  startPlan: d => {
    const p = L.byId(state.plans, d.id);
    const cur = currentSession();
    if (cur) { cur.status = 'paused'; cur.pausedAt = Date.now(); toast('Paused your open workout. Resume it from Today later.'); }
    createSession(planBlocks(p), 'custom', { planId: p.id, ...(p.note ? { planNote: p.note } : {}) });
    ui.tab = 'today';
    render(); window.scrollTo(0, 0);
  },

  check: d => {
    const st = L.byId(state.sets, d.id);
    const s = L.byId(state.sessions, st.sessionId);
    if (!st.done && st.warmup) {
      // A warm-up just gets logged: nothing carried into the working sets, no rest, no max.
      st.done = true;
      st.loggedAt = Date.now();
      st.bw = state.settings.bodyweight;
      if (!s.firstSetAt) s.firstSetAt = st.loggedAt;
    } else if (!st.done) {
      const prev = blockSets({ id: st.blockId }).filter(x => x.done).sort((x, y) => y.loggedAt - x.loggedAt)[0];
      st.done = true;
      st.loggedAt = Date.now();
      st.bw = state.settings.bodyweight;
      st.refMax = L.estimatedMax(state, st.exerciseId, s.checkinAt);
      if (!s.firstSetAt) s.firstSetAt = st.loggedAt;
      // Carry the load (or a hold's time) forward into empty rows so the next set is one tap.
      for (const o of blockSets({ id: st.blockId })) {
        if (o.done || o.exerciseId !== st.exerciseId) continue;
        for (const f of ['load', 'time']) if ((o[f] == null || o[f] === '') && st[f] != null && st[f] !== '') o[f] = st[f];
      }
      unlockAudio();
      const b = s.blocks.find(x => x.id === st.blockId);
      // Real rest: time since this block's previous set, minus roughly how long the set took. Long gaps are breaks, not rest.
      const gap = prev && (st.loggedAt - prev.loggedAt) / 1000;
      if (b && gap && gap < 15 * 60) { st.restSec = Math.max(0, Math.round(gap - workSec(st))); st.restPlan = effectiveRest(b); }
      const more = state.sets.some(x => x.sessionId === s.id && !x.done && !x.warmup);
      const group = b ? groupOf(s, b) : [];
      const lead = group[0];
      const next = b && nextInGroup(s, b);
      if (!more) state.timer = null; // session's last set: nothing to rest for
      // Done in a main lift's rest: keep that countdown, just point it at what's next.
      else if (lead && lead !== b && lead.tier !== 'T3' && state.timer?.blockId === lead.id && state.timer.endsAt > Date.now()) state.timer.next = nextLabelAfter(s, b);
      // Mid-round in a T3 superset or giant set: straight on to the next exercise, rest comes after the round.
      else if (lead?.tier === 'T3' && group.length > 1 && next && next !== b && doneIn(next) < doneIn(b)) {
        state.timer = null;
        toast(`Next: ${setLabel(next)}`);
      } else if (timerCfg().autoStart && b) startTimer(s, b, st.id);
      if (markPR(st)) toast(`🏆 ${st.prText}`);
    } else {
      st.done = false;
      delete st.loggedAt;
      delete st.restSec;
      delete st.restPlan;
      markPR(st);
      if (state.timer?.setId === st.id) state.timer = null; // un-logging a set cancels its rest
    }
    save(); render();
  },

  addSet: d => {
    const { s, b } = findBlock(d.b);
    const last = blockSets(b).at(-1);
    const ex = exOf(b.exerciseId), sc = schOf(b.schemeId);
    const ns = newSet(s, b, ex, sc, last?.load ?? L.targetLoad(state, ex, b.tier, sc, s.checkinAt));
    if (last && last.exerciseId === ex.id) ns.reps = last.reps;
    if (last?.amrap) ns.reps = sc.reps; // the new last set is the AMRAP one; start it from the prescribed reps
    state.sets.push(ns);
    markAmrap(b);
    save(); render();
  },

  addWarm: d => {
    const { s, b } = findBlock(d.b);
    const ex = exOf(b.exerciseId);
    if (!canWarm(b, ex)) return;
    const w = { ...newSet(s, b, ex, schOf(b.schemeId), null), warmup: true, reps: null };
    // Before the working sets, after any earlier warm-ups.
    const at = state.sets.findIndex(x => x.blockId === b.id && !x.warmup);
    state.sets.splice(at < 0 ? state.sets.length : at, 0, w);
    save(); render();
  },
  removeSet: d => {
    const { b } = findBlock(d.b);
    const undone = blockSets(b).filter(x => !x.done);
    if (!undone.length) return toast('Only logged sets left');
    state.sets = state.sets.filter(x => x !== undone.at(-1));
    markAmrap(b);
    save(); render();
  },

  amrapToggle: d => {
    const { b } = findBlock(d.b);
    b.amrap = !b.amrap;
    markAmrap(b);
    save(); render();
    toast(b.amrap ? 'Last set is AMRAP: double the reps or more and next time goes up 10' : 'AMRAP off');
  },

  swapEx: d => openSheet({ type: 'swapEx', blockId: d.b, reason: null }),
  swapScheme: d => openSheet({ type: 'swapScheme', blockId: d.b, reason: null }),
  reason: d => { ui.sheet.reason = ui.sheet.reason === d.v ? null : d.v; renderSheet(); },
  pickEx: d => swapTo(d.id),
  // Favorite or Never suggest for an exercise (tapping the same one again clears it).
  tastePref: d => {
    const e = exOf(d.id);
    e.pref = e.pref === d.v ? null : d.v;
    save(); renderSheet(); render();
    toast(e.pref === 'never' ? `${e.name} won’t be suggested` : e.pref === 'fav' ? `${e.name} is a favorite` : `${e.name} is back to normal`);
  },
  paceReset: () => askConfirm('Reset your pace?', 'Time estimates go back to the usual guesses and learn again from your next workouts. Your history stays.', 'Reset', () => {
    state.settings.paceSince = Date.now();
    save(); render(); toast('Pace reset');
  }),
  tasteForget: () => askConfirm('Forget what it learned?', 'Suggestions stop using your earlier swaps and removals and start fresh from here. Your history, favorites and Never suggest stay.', 'Forget', () => {
    state.settings.tasteSince = Date.now();
    save(); render(); toast('Starting fresh');
  }),

  pickScheme: d => {
    const { s, b } = findBlock(ui.sheet.blockId);
    if (b.schemeId !== d.id) {
      b.swaps.push({ type: 'scheme', from: b.schemeId, to: d.id, reason: ui.sheet.reason, at: Date.now() });
      b.schemeId = d.id;
      if (s.source === 'suggested') s.source = 'swapped';
      genSets(s, b);
    }
    ui.sheet = null;
    save(); render();
  },

  usePlan: () => openSheet({ type: 'plans' }),
  goPlans: () => { ui.sheet = null; ui.tab = 'plans'; render(); },

  applyPlan: d => {
    const s = currentSession();
    const p = L.byId(state.plans, d.id);
    s.blocks = s.blocks.filter(b => state.sets.some(x => x.blockId === b.id && x.done));
    state.sets = state.sets.filter(x => x.sessionId !== s.id || x.done);
    const blocks = planBlocks(p);
    s.blocks.push(...blocks);
    for (const b of blocks) genSets(s, b);
    s.source = 'custom';
    s.planId = p.id;
    ui.sheet = null;
    save(); render();
  },

  finish: () => {
    const s = currentSession();
    const mobSets = (s.mobility || []).flatMap(it => it.sets);
    const left = state.sets.filter(x => x.sessionId === s.id && !x.done && !x.warmup).length + mobSets.filter(x => !x.done).length;
    const any = state.sets.some(x => x.sessionId === s.id && x.done) || mobSets.some(x => x.done);
    if (left && any) return openSheet({ type: 'finishAsk', left });
    actions.finishNow();
  },
  finishNow: () => {
    const s = currentSession();
    const rest = restSummary(state.sets.filter(x => x.sessionId === s.id));
    endSession(s);
    state.timer = null;
    ui.sheet = null; renderSheet();
    setWakeLock(false);
    save(); render(); toast(rest ? `Session saved · ${rest.text}` : 'Session saved');
  },
  pause: () => {
    const s = currentSession();
    s.status = 'paused';
    s.pausedAt = Date.now();
    state.timer = null;
    ui.sheet = null; renderSheet();
    setWakeLock(false);
    save(); render(); window.scrollTo(0, 0);
    toast('Paused. Resume it from Today when you have time.');
  },
  // A finished workout, open again: its unlogged sets come back, and anything open now is paused. One from an earlier day
  // carries on today (it stays under its own date in History; what you log now is today's).
  sessionContinue: d => {
    const s = L.byId(state.sessions, d.id);
    if (!s || s.status !== 'done') return;
    const go = () => {
      const cur = currentSession();
      if (cur && cur !== s) { cur.status = 'paused'; cur.pausedAt = Date.now(); }
      s.status = 'open';
      s.day = L.dayKey();
      s.reopenedAt = Date.now();
      delete s.pausedAt; delete s.endedAt;
      for (const b of s.blocks || []) if (exOf(b.exerciseId) && schOf(b.schemeId)) genSets(s, b);
      ui.history = null; ui.tab = 'today'; ui.sheet = null; renderSheet();
      save(); render(); window.scrollTo(0, 0);
      toast('Workout reopened. Finish it again when you\'re done.');
    };
    if (s.day === L.dayKey()) return go();
    askConfirm('Continue this workout today?', 'It opens again with its unlogged sets. It stays under its own date in History; the sets you log now count for today.', 'Continue', go);
  },
  // Plan tomorrow
  tomorrowOpen: () => {
    const { locationId, locationIds, minutes, fatigue, intent, lean, jumps, cond, condPair, split } = ui.ci;
    ui.tomorrow = { variant: 0, ci: { locationId, locationIds: [...(locationIds || [locationId])], minutes, fatigue: Mo.entryFor(state) ? fatigue : 2, sleep: null, intent, lean, jumps, cond, condPair, split, skip: [] } };
    render(); window.scrollTo(0, 0);
  },
  tomorrowClose: () => { ui.tomorrow = null; render(); window.scrollTo(0, 0); },
  tomorrowSet: d => {
    const c = ui.tomorrow.ci;
    if (d.k === 'minutes') c.minutes = Number(d.v);
    else if (d.k === 'lean') c.lean = d.v;
    else if (d.k === 'loc') { const ids = c.locationIds.includes(d.v) ? (c.locationIds.length > 1 ? c.locationIds.filter(x => x !== d.v) : c.locationIds) : [...c.locationIds, d.v]; c.locationIds = ids; c.locationId = ids[0]; }
    render();
  },
  tomorrowRegen: () => { ui.tomorrow.variant++; render(); },
  tomorrowSave: () => {
    const { t, ci, res } = tomorrowBuild(ui.tomorrow);
    state.planned = { day: L.dayKey(t), savedAt: Date.now(), ci: { ...ci, variant: 0 }, blocks: structuredClone(res.blocks), notes: res.notes, goalMinutes: res.goalMinutes };
    ui.tomorrow = null;
    save(); render(); window.scrollTo(0, 0);
    toast(`Saved for ${new Date(t).toLocaleDateString(undefined, { weekday: 'long' })}`);
  },
  plannedStart: () => {
    const p = state.planned;
    ui.ci = { ...ui.ci, ...p.ci, fatigue: ui.ci.fatigue }; // today's energy, the plan's place and time
    // Fresh ids, so the plan can't collide with anything; superset links follow.
    const ids = new Map(p.blocks.map(b => [b.id, L.uid()]));
    const blocks = p.blocks.filter(b => exOf(b.exerciseId) && schOf(b.schemeId)).map(b => ({ ...structuredClone(b), id: ids.get(b.id), ...(b.pairOf ? { pairOf: ids.get(b.pairOf) } : {}) }));
    createSession(blocks, 'suggested', { planned: true, focusNotes: p.notes, goalMinutes: p.goalMinutes });
    delete state.planned;
    save(); render(); window.scrollTo(0, 0);
  },
  plannedDrop: () => { delete state.planned; save(); render(); },

  // Morning check
  mornSet: d => {
    const m = ui.morning ?? (ui.morning = { energy: null, pain: {} });
    if (d.m === 'energy') { m.energy = m.energy === Number(d.v) ? null : Number(d.v); if (m.energy) ui.ci.fatigue = 6 - m.energy; }
    else m.pain[d.p] = m.pain[d.p] === Number(d.v) ? null : Number(d.v);
    render();
  },
  mornPart: d => {
    const parts = Mo.morningOf(state).parts;
    Mo.setParts(state, parts.includes(d.p) ? parts.filter(x => x !== d.p) : [...parts, d.p]);
    save(); render();
  },
  mornPartAdd: () => {
    const v = document.getElementById('morn-part')?.value.trim();
    if (!v) return toast('Type a body part first');
    Mo.setParts(state, [...Mo.morningOf(state).parts, v]);
    save(); render();
  },
  mornSave: () => {
    const m = ui.morning ?? { energy: null, pain: {} };
    if (m.energy == null && !Object.values(m.pain).some(v => v != null)) return toast('Tap your energy, or a score for a part');
    const e = Mo.record(state, m);
    if (e.energy != null) ui.ci.fatigue = 6 - e.energy;
    ui.morning = null;
    save(); render();
    const sore = Mo.jumpPain(state);
    toast(sore.length ? `${sore.map(x => x.part).join(', ')} over 3/10: no jumps today, isometrics instead` : 'Morning check saved');
  },
  mornEdit: () => { const e = Mo.entryFor(state); ui.morning = { energy: e?.energy ?? null, pain: { ...(e?.pain || {}) } }; render(); },
  mornCancel: () => { ui.morning = null; render(); },
  mornSkip: () => { ui.morning = null; ui.morningSkip = L.dayKey(); render(); },
  mornIsos: () => {
    if (currentMobility()) { ui.showWorkout = false; render(); return toast('A mobility session is already open'); }
    const items = Mo.reliefHolds(state).map(mobEx).filter(Boolean).map(e => M.newItem(state, e));
    if (!items.length) return toast('No holds for these parts in your mobility library');
    startMobility(items, { relief: true });
    ui.tab = 'today';
    save(); render(); window.scrollTo(0, 0);
  },

  // Program blocks
  blockSetup: d => { ui.blockSetup = B.draftFor(state, d.g); render(); window.scrollTo(0, 0); },
  blockSetupClose: () => { ui.blockSetup = null; render(); window.scrollTo(0, 0); },
  bOwnHalf: d => { ui.blockSetup.owns.half = d.v || null; render(); },
  bOwnTier: d => { const t = ui.blockSetup.owns.tiers; ui.blockSetup.owns.tiers = t.includes(d.v) ? t.filter(x => x !== d.v) : [...t, d.v]; render(); },
  bWeeks: d => { ui.blockSetup.weeks = Math.max(2, Math.min(16, ui.blockSetup.weeks + Number(d.d))); render(); },
  bStart: d => { ui.blockSetup.start = d.v; render(); },
  blockGo: () => {
    const d = ui.blockSetup;
    if (!d.schedule.length) return toast('Give at least one day a session');
    const b = B.startBlock(state, d);
    ui.blockSetup = null;
    save(); render(); window.scrollTo(0, 0);
    toast(Date.now() < b.startedAt ? `Starts ${shortDate(b.startedAt)}` : 'Block started');
  },
  blockStart: d => startBlockSession(!!d.deload),
  blockPause: () => { B.pauseBlock(state); save(); render(); toast('Paused: your goals run as usual until you resume'); },
  blockResume: () => { B.resumeBlock(state); save(); render(); toast('Resumed'); },
  blockEnd: () => askConfirm(`End ${state.block.group}?`, 'Its report covers the weeks done so far, and your goals run as usual again.', 'End block', () => {
    B.endBlock(state);
    ui.tab = 'today';
    save(); render(); window.scrollTo(0, 0);
  }),
  blockSeen: d => { const b = L.byId(state.blocks, d.id); if (b) b.reportSeen = true; save(); render(); },
  blockAgain: d => {
    const b = L.byId(state.blocks, d.id);
    if (!b) return;
    b.reportSeen = true;
    B.startBlock(state, { group: b.group, schedule: b.schedule, owns: b.owns, weeks: b.weeks, deloadEvery: b.deloadEvery, start: 'next' });
    save(); render(); toast(`Starts ${shortDate(state.block.startedAt)}`);
  },
  blockCopy: d => {
    const b = L.byId(state.blocks, d.id);
    if (!b) return;
    const text = B.reportText(state, b);
    const fallback = () => openSheet({ type: 'reviewText', text });
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast('Report copied'), fallback);
    else fallback();
  },

  bMore: d => { ui.bmore ??= new Set(); ui.bmore[ui.bmore.has(d.b) ? 'delete' : 'add'](d.b); render(); },
  laterDone: () => { const s = currentSession(); if (!s) return; resolveLater(s, true); save(); render(); toast('Kept as done'); },
  laterPlanned: () => { const s = currentSession(); if (!s) return; resolveLater(s, false); save(); render(); toast('Unticked'); },
  ivPreset: d => {
    const p = (state.intervals?.presets ?? []).find(x => x.id === d.id);
    if (!p) return;
    const keep = ivDraft().exercises; // a preset without exercises keeps the ones you picked
    ui.iv = { ...I.clean(p), presetId: p.id };
    if (!ui.iv.exercises.length) ui.iv.exercises = keep;
    render();
  },
  ivSave: () => {
    const d = ivDraft(), list = (state.intervals.presets ??= []);
    const mine = d.presetId && !d.presetId.startsWith('iv-') && list.find(p => p.id === d.presetId);
    const cfg = I.clean(d);
    if (mine) Object.assign(mine, cfg, { id: mine.id });
    else { const id = `ivu-${L.uid()}`; list.push({ ...cfg, id }); d.presetId = id; }
    save(); render(); toast(`Saved “${cfg.name}”`);
  },
  ivDel: () => askConfirm('Delete this timer?', 'Your logged rounds stay.', 'Delete', () => {
    state.intervals.presets = state.intervals.presets.filter(p => p.id !== ui.iv?.presetId);
    ui.iv = null; save(); render();
  }),
  ivStart: () => {
    const d = ivDraft(), cfg = I.clean(d);
    if (!cfg.exercises.length) return toast('Pick an exercise first');
    state.intervals.last = { ...cfg, id: d.presetId ?? undefined };
    state.intervalRun = { cfg, startedAt: Date.now(), pausedAt: null, pausedMs: 0 };
    ivLast = null;
    unlockAudio(); setWakeLock(true);
    save(); render(); window.scrollTo(0, 0);
  },
  ivPause: () => { const r = state.intervalRun; if (r && !r.pausedAt) { r.pausedAt = Date.now(); save(); render(); } },
  ivResume: () => { const r = state.intervalRun; if (r?.pausedAt) { r.pausedMs = (r.pausedMs || 0) + Date.now() - r.pausedAt; r.pausedAt = null; unlockAudio(); save(); render(); } },
  ivSkip: () => {
    const r = state.intervalRun; if (!r) return;
    const list = I.phases(r.cfg), ms = I.elapsed(r), at = I.phaseAt(list, ms);
    if (!at) return;
    r.startedAt -= I.phaseStart(list, at.i + 1) - ms; // jump to the start of the next phase
    save(); tickInterval(); render();
  },
  ivStop: () => {
    const r = state.intervalRun; if (!r) return;
    ui.ivLog = { cfg: r.cfg, startedAt: r.startedAt, ms: I.elapsed(r), totals: {}, hr: r.hr ?? null };
    state.intervalRun = null; ivLast = null;
    setWakeLock(false);
    save(); render();
  },
  ivLog: () => {
    const lg = ui.ivLog; if (!lg) return;
    for (const el of document.querySelectorAll('[data-ivtotal]')) lg.totals[el.dataset.ivtotal] = el.value;
    const n = logIntervals(lg);
    ui.ivLog = null;
    save(); render();
    toast(n ? `Logged ${n} round${n === 1 ? '' : 's'}` : 'Nothing to log');
  },
  ivDiscard: () => { ui.ivLog = null; render(); },
  // The heart-rate pill: connect the strap (Chrome's device list), or once it's on, offer to disconnect it.
  hrTap: async () => {
    if (HR.live.status === 'live' || HR.live.status === 'lost' || HR.live.status === 'connecting') {
      return askConfirm(`Disconnect ${HR.live.name ?? 'the strap'}?`, 'What it recorded stays on the workout.', 'Disconnect', () => { HR.disconnect(); render(); });
    }
    try {
      const name = await HR.connect();
      if (state.settings.hrStrap !== name) { state.settings.hrStrap = name; save(); }
      toast(`${name} connected`);
    } catch (e) { toast(e.message); }
    render();
  },
  resume: d => {
    const cur = currentSession();
    if (cur) { cur.status = 'paused'; cur.pausedAt = Date.now(); }
    const s = L.byId(state.sessions, d.id);
    s.status = 'open';
    delete s.pausedAt;
    save(); render(); window.scrollTo(0, 0);
    toast('Picked up where you left off. Tap + Time if you have more than planned.');
  },
  moreTime: () => openSheet({ type: 'moreTime' }),
  addTime: d => {
    const s = currentSession();
    const extra = Number(d.v);
    const excludeFamilies = s.blocks.map(b => exOf(b.exerciseId)?.familyId);
    const res = s.source === 'focus'
      ? L.buildFocus(state, { ...s, minutes: extra }, { region: s.focusRegion, accessoriesOnly: true }, Date.now(), { excludeFamilies, sessionBlocks: s.blocks })
      : L.buildSuggestion(state, { ...s, minutes: extra }, Date.now(), { excludeFamilies, sessionBlocks: s.blocks });
    s.minutes += extra;
    if (res.notes?.length) s.focusNotes = [...(s.focusNotes || []), ...res.notes];
    s.blocks.push(...res.blocks);
    L.pairT3s(state, s.blocks, L.placeOf(state, s));
    for (const b of res.blocks) genSets(s, b);
    ui.sheet = null;
    save(); render();
    toast(res.blocks.length ? `Added ${res.blocks.map(b => exOf(b.exerciseId)?.name).join(', ')}` : 'Nothing else fits. Add an exercise below.');
  },

  showWorkout: () => { ui.showWorkout = true; render(); window.scrollTo(0, 0); },
  showMobility: () => { ui.showWorkout = false; render(); window.scrollTo(0, 0); },

  mobStart: d => {
    if (currentMobility()) { ui.showWorkout = false; render(); return toast('A mobility session is already open'); }
    const r = L.byId(state.mobility.routines, d.id);
    startMobility(r.items.map(mobEx).filter(e => e && !e.archived).map(e => M.newItem(state, e)), { routineId: r.id });
    ui.tab = 'today';
    save(); render(); window.scrollTo(0, 0);
  },
  progOpen: d => { ui.program = d.id; ui.mobRoutine = null; ui.plan = null; ui.tab = 'plans'; render(); window.scrollTo(0, 0); },
  progClose: () => { ui.program = null; render(); window.scrollTo(0, 0); },
  progStart: d => {
    P.startProgram(state, d.id);
    save(); render(); toast(`${P.programDef(d.id).name}: week 1, day 1`);
  },
  progSession: d => {
    if (currentMobility()) { ui.showWorkout = false; ui.tab = 'today'; render(); return toast('Finish or discard the open mobility session first'); }
    const p = P.progress(state, d.id), def = P.programDef(d.id);
    if (!p || p.finished) return;
    const items = P.dayPlan(def, p.week).map(e => ({ ...M.newItem(state, e), def: e }));
    startMobility(items, { program: { id: d.id, week: p.week, day: p.day } });
    ui.program = null; ui.tab = 'today';
    save(); render(); window.scrollTo(0, 0);
  },
  progWeek: d => { P.setWeek(state, d.id, Number(d.w)); save(); render(); toast(`Week ${d.w}, day 1`); },
  progStop: d => askConfirm(`Stop ${P.programDef(d.id).name}?`, 'Your sessions and verticals stay. You can start again from week 1 later.', 'Stop program', () => {
    state.programs[d.id] = { stopped: true, verticals: state.programs[d.id]?.verticals ?? [] };
    save(); render();
  }),

  mobPick: d => {
    const ids = items => (items || []).map(i => i.exerciseId);
    const exclude = d.mode === 'session' ? ids(currentMobility()?.items) : d.mode === 'workout' ? ids(currentSession()?.mobility)
      : d.mode === 'routine' ? [...ui.mobRoutine.items] : [];
    openSheet({ type: 'mobPick', mode: d.mode, parts: [], picked: [], exclude });
  },
  mobPart: d => {
    const sh = ui.sheet;
    sh.parts = sh.parts.includes(d.v) ? sh.parts.filter(p => p !== d.v) : [...sh.parts, d.v].slice(-3);
    sh.picked = M.suggestForParts(state, sh.parts, sh.exclude);
    renderSheet();
  },
  mobTick: d => {
    const sh = ui.sheet;
    sh.picked = sh.picked.includes(d.id) ? sh.picked.filter(x => x !== d.id) : [...sh.picked, d.id];
    renderSheet();
  },
  mobAddPicked: () => {
    const sh = ui.sheet;
    const exs = sh.picked.map(mobEx).filter(Boolean);
    if (!exs.length) return toast('Tick at least one');
    if (sh.mode === 'routine') ui.mobRoutine.items.push(...exs.map(e => e.id));
    else {
      const items = exs.map(e => M.newItem(state, e));
      const open = currentMobility();
      if (sh.mode === 'workout') (currentSession().mobility ??= []).push(...items);
      else if (open) { open.items.push(...items); ui.showWorkout = false; }
      else startMobility(items, { parts: sh.parts });
      ui.tab = 'today';
    }
    ui.sheet = null; renderSheet();
    save(); render();
  },
  mcheck: d => {
    const { item, list } = findMobItem(d.i);
    const st = item?.sets.find(x => x.id === d.s);
    if (!st) return;
    if (!st.done) {
      st.done = true;
      st.at = Date.now();
      unlockAudio();
      const more = list.some(it => it.sets.some(x => !x.done));
      if (timerCfg().autoStart && more) startMobTimer(list, item, st);
      else if (!more && state.timer && !state.timer.blockId) state.timer = null;
    } else {
      st.done = false;
      delete st.at;
      if (state.timer?.setId === st.id) state.timer = null;
    }
    save(); render();
  },
  mAddSet: d => {
    const { item } = findMobItem(d.i);
    const last = item.sets.at(-1);
    item.sets.push({ ...last, id: L.uid(), done: false, at: undefined });
    save(); render();
  },
  mRemoveSet: d => {
    const { item } = findMobItem(d.i);
    const i = item.sets.map(s => s.done).lastIndexOf(false);
    if (i < 0) return toast('Only logged sets left');
    item.sets.splice(i, 1);
    save(); render();
  },
  mRemove: d => {
    const { item, list } = findMobItem(d.i);
    const at = list.indexOf(item), sets = [...item.sets];
    const undo = () => { item.sets = sets; if (!list.includes(item)) list.splice(at, 0, item); save(); render(); };
    if (item.sets.some(s => s.done)) { item.sets = item.sets.filter(s => s.done); toast('Logged sets kept; the rest removed', undo); }
    else { list.splice(at, 1); toast(`Removed ${itemEx(item)?.name ?? 'exercise'}`, undo); }
    save(); render();
  },
  mobFinish: () => {
    const m = currentMobility();
    const n = m.items.reduce((t, it) => t + it.sets.filter(s => s.done).length, 0);
    endMobility(m);
    if (state.timer && !state.timer.blockId) state.timer = null;
    setWakeLock(false);
    save(); render(); window.scrollTo(0, 0);
    toast(n ? `Mobility saved · ${n} sets` : 'Nothing logged, so nothing saved');
  },
  mobDiscard: () => askConfirm('Discard this mobility session?', 'Nothing from it is kept, including sets you logged.', 'Discard', () => {
    const m = currentMobility();
    state.mobility.sessions = state.mobility.sessions.filter(x => x !== m);
    if (state.timer && !state.timer.blockId) state.timer = null;
    save(); render();
  }),

  libMode: d => { ui.libMode = d.v; ui.libQuery = ''; render(); },
  mobPartFilter: d => { ui.mobPart = ui.mobPart === d.v ? null : d.v; render(); },
  mobExNew: () => openSheet({ type: 'mobEx', isNew: true, ret: ui.sheet?.type === 'mobPick' ? ui.sheet : null,
    draft: { name: '', parts: ui.sheet?.parts ? [...ui.sheet.parts] : ui.mobPart ? [ui.mobPart] : [], sets: 3, reps: 10, repsMax: null, hold: null, holdMax: null,
      perSide: false, tempo: '', restSec: 45, track: { reps: true, hold: false, load: false, extra: '' }, cues: '', video: '', notes: '', archived: false } }),
  mobExEdit: d => openSheet({ type: 'mobEx', id: d.id, draft: structuredClone(mobEx(d.id)) }),
  mobExPart: d => {
    const dr = readMobDraft();
    dr.parts = dr.parts.includes(d.v) ? dr.parts.filter(p => p !== d.v) : [...dr.parts, d.v];
    renderSheet();
  },
  mobExSave: () => {
    const sh = ui.sheet, d = readMobDraft();
    if (!d.name) return toast('Give it a name');
    if (!d.parts.length) return toast('Pick at least one body part');
    if (!d.track.reps && !d.track.hold && !d.track.load && !d.track.extra) d.track[d.hold ? 'hold' : 'reps'] = true;
    let id = sh.id;
    if (sh.isNew) { id = L.uid(); state.mobility.exercises.push({ ...d, id }); }
    else Object.assign(mobEx(sh.id), d, { id: sh.id });
    save();
    if (sh.ret) {
      const back = sh.ret;
      if (sh.isNew) back.picked = [...back.picked, id];
      if (!back.parts.length) back.parts = d.parts.slice(0, 3);
      openSheet(back);
    } else {
      ui.sheet = null; renderSheet();
    }
    render(); toast(sh.isNew ? `Added ${d.name}` : 'Saved');
  },
  mobExDelete: () => {
    const id = ui.sheet.id;
    askConfirm(`Delete “${mobEx(id).name}”?`, 'It is also taken out of your mobility routines.', 'Delete', () => {
      state.mobility.exercises = state.mobility.exercises.filter(e => e.id !== id);
      for (const r of state.mobility.routines) r.items = r.items.filter(x => x !== id);
      save(); render();
    });
  },

  mobRoutineNew: () => { ui.mobRoutine = { name: '', items: [] }; render(); },
  mobRoutineEdit: d => { ui.mobRoutine = structuredClone(L.byId(state.mobility.routines, d.id)); render(); },
  mobRoutineMove: d => {
    const a = ui.mobRoutine.items, i = Number(d.i), j = i + Number(d.dir);
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    render();
  },
  mobRoutineDel: d => { ui.mobRoutine.items.splice(Number(d.i), 1); render(); },
  mobRoutineCancel: () => { ui.mobRoutine = null; render(); },
  mobRoutineSave: () => {
    const r = ui.mobRoutine;
    r.name = (document.querySelector('#mr-name')?.value ?? r.name).trim();
    if (!r.name) return toast('Give the routine a name');
    if (r.id) Object.assign(L.byId(state.mobility.routines, r.id), r);
    else state.mobility.routines.push({ ...r, id: L.uid() });
    ui.mobRoutine = null;
    save(); render(); toast('Routine saved');
  },
  mobRoutineDelete: () => askConfirm(`Delete “${ui.mobRoutine.name}”?`, 'Sessions you did with it keep their logs.', 'Delete routine', () => {
    state.mobility.routines = state.mobility.routines.filter(r => r.id !== ui.mobRoutine.id);
    ui.mobRoutine = null;
    save(); render();
  }),

  pairAdd: d => {
    const { s, b } = findBlock(d.b);
    if (L.isConditioning(state, exOf(d.ex))) {
      // The bike in this lift's rest: a conditioning block paired with it, a round after each set.
      const ex = exOf(d.ex);
      const nb = { id: L.uid(), tier: 'COND', slotId: slotIdFor(ex.id, 'COND'), exerciseId: ex.id, schemeId: condPairScheme(b).id, swaps: [{ type: 'add', to: ex.id, at: Date.now() }], pairOf: b.id };
      s.blocks.push(nb);
      if (s.source === 'suggested') s.source = 'swapped';
      genSets(s, nb);
      save(); render();
      return toast(`Superset: ${ex.name} in ${exOf(b.exerciseId).name}'s rest`);
    }
    const nb = addBlock(s, exOf(d.ex), 'T3');
    nb.pairOf = b.id;
    nb.schemeId = schemeForBlock(s, exOf(d.ex), 'T3', nb).id; // now it only costs half its time
    genSets(s, nb);
    ui.sheet = null; renderSheet();
    save(); render();
    toast(`Superset: ${exOf(d.ex).name} in ${exOf(b.exerciseId).name}'s rest`);
  },
  pairOpen: d => openSheet({ type: 'pair', blockId: d.b }),
  pairAny: d => openSheet({ type: 'addEx', mode: 'pair', tier: 'T3', blockId: d.b, q: '' }),
  pairLink: d => {
    const { s } = findBlock(d.b);
    const { b } = findBlock(d.b);
    const o = s.blocks.find(x => x.id === d.o);
    if (inPair(s, o)) b.pairOf = o.id; // join its group: a giant set
    else o.pairOf = b.id;
    ui.sheet = null; renderSheet();
    save(); render();
  },
  pairUnlink: d => {
    const { b } = findBlock(d.b);
    delete b.pairOf;
    save(); render();
  },
  pairNo: d => {
    findBlock(d.b).b.noPair = true;
    save(); render();
  },

  recheck: () => {
    endSession(currentSession());
    state.timer = null;
    save(); render();
  },

  timerStart: d => {
    unlockAudio();
    const { s, b } = findBlock(d.b);
    startTimer(s, b);
    save(); renderTimer();
  },
  timerAdj: d => {
    const t = state.timer;
    const delta = Number(d.d) * 1000;
    t.endsAt = Math.max(Date.now() + 1000, t.endsAt + delta);
    t.total = Math.max(1, t.total + Number(d.d));
    if (t.endsAt - Date.now() > 10000) t.warned = false;
    save(); renderTimer();
  },
  timerStop: () => { stopTimer(); save(); },

  workStart: d => {
    const st = L.byId(state.sets, d.id);
    const ex = st && exOf(st.exerciseId);
    if (!ex) return;
    st.time = Number(st.time) || lastTime(ex.id) || 30;
    startWork({ set: st.id }, ex.name, st.time);
    save(); render();
  },
  mworkStart: d => {
    const { item } = findMobItem(d.i);
    const st = item?.sets.find(x => x.id === d.s);
    const ex = st && itemEx(item);
    if (!ex) return;
    st.hold = Number(st.hold) || ex.holdMax || ex.hold || 30;
    startWork({ mset: st.id, item: item.id }, ex.name, st.hold, ex.perSide);
    save(); render();
  },
  workAdd: () => {
    const t = state.timer, ph = t?.kind === 'work' && workPhase(t);
    if (!ph) return;
    ph.p.secs += 15;
    t.endsAt += 15000;
    save(); renderTimer();
  },
  workLog: () => {
    const t = state.timer;
    if (t?.kind === 'work') finishWork(t, workHeld(t));
  },
  workCancel: () => { state.timer = null; save(); render(); },
  timerTest: () => {
    unlockAudio();
    const was = timerCfg().sound;
    timerCfg().sound = true;
    beep(3, 880);
    timerCfg().sound = was;
    if (timerCfg().vibrate) navigator.vibrate?.([250, 120, 250]);
  },

  notifyTest: async () => {
    if (window.Notification?.permission !== 'granted') return toast('Notifications are not allowed');
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification('Rest over', { body: 'Test: this is what you’ll see', tag: 'rest', renotify: true, vibrate: [250, 120, 250], icon: 'icons/icon-192.png' });
  },

  restEdit: d => openSheet({ type: 'rest', blockId: d.b, value: null, saveDefault: false }),
  // The EMOM clock: round 1 starts now, and the timer counts down to round 2 (then each logged round to the next).
  emomStart: d => {
    const { s, b } = findBlock(d.b);
    unlockAudio();
    b.emomStart = Date.now();
    const every = schOf(b.schemeId).emom;
    state.timer = { endsAt: b.emomStart + every * 1000, total: every, blockId: b.id, setId: null, next: `${exOf(b.exerciseId)?.name ?? ''} · round 2`, warned: false, alerted: false };
    setWakeLock(true);
    save(); render();
  },
  restNudge: d => {
    const { b } = findBlock(ui.sheet.blockId);
    ui.sheet.saveDefault = sheetEl.querySelector('#rest-save').checked;
    ui.sheet.value = Math.max(0, (ui.sheet.value ?? effectiveRest(b)) + Number(d.d));
    renderSheet();
  },
  restPreset: d => {
    ui.sheet.saveDefault = sheetEl.querySelector('#rest-save').checked;
    ui.sheet.value = Number(d.v);
    renderSheet();
  },
  restApply: () => {
    const { b } = findBlock(ui.sheet.blockId);
    const v = ui.sheet.value ?? effectiveRest(b);
    if (sheetEl.querySelector('#rest-save').checked) {
      exOf(b.exerciseId).restSec = v;
      delete b.restSec; // the exercise default now covers it
    } else {
      b.restSec = v;
    }
    ui.sheet = null;
    save(); render();
  },
  restClear: () => {
    const { b } = findBlock(ui.sheet.blockId);
    delete b.restSec;
    exOf(b.exerciseId).restSec = null;
    ui.sheet = null;
    save(); render();
  },

  sheetClose: () => closeSheet(),

  quickAdd: d => openSheet({ type: 'quickAdd', familyId: d.fam || null, from: d.from || 'lib', blockId: ui.sheet?.blockId, reason: ui.sheet?.reason }),

  qaSave: () => {
    const sh = ui.sheet;
    const name = sheetEl.querySelector('#qa-name').value.trim();
    if (!name) return toast('Give the exercise a name');
    const famSel = sheetEl.querySelector('#qa-famsel').value;
    const familyId = famSel === '__new' || !famSel ? null : famSel; // none chosen: it starts a category of its own
    const familyName = famSel === '__new' ? sheetEl.querySelector('#qa-fam').value.trim() : '';
    const equipment = [...sheetEl.querySelectorAll('input[name="qa-eq"]:checked')].map(i => i.value);
    // A variation sits right next to its base exercise, on the side you picked.
    const base = sh.baseId && exOf(sh.baseId);
    const sameFam = base && base.familyId === familyId;
    const place = sheetEl.querySelector('input[name="qa-place"]:checked')?.value;
    const e = newExercise({
      name, familyId, familyName, equipment,
      metric: sheetEl.querySelector('input[name="qa-metric"]:checked')?.value ?? 'load_reps',
      bodyweight: sheetEl.querySelector('#qa-bw').checked,
      anytime: sheetEl.querySelector('#qa-any').checked,
      region: sheetEl.querySelector('input[name="qa-region"]:checked')?.value ?? 'full',
      explosive: sheetEl.querySelector('#qa-expl').checked,
      rank: sameFam ? base.rank + (place === 'easier' ? 0.5 : -0.5) : null,
    });
    if (sh.from === 'ob') return obAdded(e);
    const s = currentSession();
    // Gear you just added while training is gear you have here.
    if (s && sh.from !== 'lib') {
      const loc = L.placeOf(state, s);
      for (const eq of sh.newEq || []) if (equipment.includes(eq) && !loc.equipment.includes(eq)) loc.equipment.push(eq);
    }
    save();
    const here = s && L.isAvailable(e, L.placeOf(state, s));
    const note = availabilityNote(e);
    if (note) setTimeout(() => toast(note), 2300);
    if (sh.from === 'swap' && sh.blockId) {
      if (here) return swapTo(e.id);
      toast('Added, but its equipment isn’t here');
    } else if ((sh.from === 'add' || sh.from === 'pair') && s) {
      if (here) {
        const nb = addBlock(s, e, sh.tier);
        if (sh.from === 'pair') nb.pairOf = sh.blockId;
        toast(`Added ${e.name}`);
      }
      else toast('Added, but its equipment isn’t here');
    } else {
      toast(`Added ${e.name}`);
    }
    ui.sheet = null;
    save(); render();
  },

  qaVariation: d => {
    openSheet({ type: 'quickAdd', baseId: d.id, from: d.from || 'lib', blockId: ui.sheet?.blockId, reason: ui.sheet?.reason, tier: ui.sheet?.tier });
    ui.sheetFocus = '#qa-name';
    renderSheet();
  },
  qaUseBase: d => {
    const sh = ui.sheet;
    sh.name = sheetEl.querySelector('#qa-name').value;
    sh.baseId = d.id;
    sh.familyId = null;
    renderSheet();
  },

  addEx: () => openSheet({ type: 'addEx', mode: 'add', tier: 'T3', q: '' }),
  swapAny: () => openSheet({ type: 'addEx', mode: 'swap', blockId: ui.sheet.blockId, reason: ui.sheet.reason, q: '' }),
  addExTier: d => { ui.sheet.tier = d.t; renderSheet(); },
  addExPart: d => { ui.sheet.part = ui.sheet.part === d.v ? null : d.v; renderSheet(); },
  libPart: d => { ui.libPart = ui.libPart === d.v ? null : d.v; render(); },
  addExPick: d => {
    const sh = ui.sheet;
    if (sh.mode === 'histSwap' || sh.mode === 'histAdd') return histPick(d.id);
    if (sh.mode === 'swap') return swapTo(d.id);
    const s = currentSession();
    const tier = tierFor(exOf(d.id), sh.tier);
    const nb = addBlock(s, exOf(d.id), tier);
    if (sh.mode === 'pair') nb.pairOf = sh.blockId;
    ui.sheet = null;
    save(); render();
    toast(`Added ${exOf(d.id).name} as ${tier}`);
  },
  addExCreate: () => {
    const sh = ui.sheet;
    openSheet({ type: 'quickAdd', from: sh.mode, name: (sh.q || '').trim(), tier: sh.tier, blockId: sh.blockId, reason: sh.reason, familyId: null });
    ui.sheetFocus = '#qa-name';
    renderSheet();
  },

  tierEdit: d => openSheet({ type: 'tier', blockId: d.b }),
  tierPick: d => {
    const { s, b } = findBlock(ui.sheet.blockId);
    if (b.tier !== d.t) setBlockTier(s, b, d.t);
    ui.sheet = null;
    save(); render();
  },
  toTech: d => {
    const { s, b } = findBlock(d.b);
    setBlockTier(s, b, 'TECH', 'not fresh');
    save(); render();
    toast('Switched to technique');
  },

  removeBlock: d => {
    const { s, b } = findBlock(d.b);
    const logged = state.sets.some(x => x.blockId === b.id && x.done);
    // Undo puts back exactly what was there: the blocks (with their supersets), the sets and the source.
    const before = { blocks: structuredClone(s.blocks), sets: state.sets.filter(x => x.sessionId === s.id).map(x => ({ ...x })), source: s.source };
    state.sets = state.sets.filter(x => x.blockId !== b.id || x.done);
    const removedBefore = s.removed;
    if (!logged) {
      // A vote against it for what learns your taste (js/taste.js), unless you added it yourself.
      s.removed = [...(s.removed ?? []), { exerciseId: b.exerciseId, tier: b.tier, slotId: b.slotId ?? null, at: Date.now(), wasSuggested: !(b.swaps || []).some(w => w.type === 'add') }];
      s.blocks = s.blocks.filter(x => x !== b);
      const rest = s.blocks.filter(x => x.pairOf === b.id);
      if (rest.length) { delete rest[0].pairOf; for (const x of rest.slice(1)) x.pairOf = rest[0].id; }
    }
    if (s.source === 'suggested') s.source = 'swapped';
    toast(logged ? 'Logged sets kept; the rest removed' : `Removed ${exOf(b.exerciseId)?.name ?? 'exercise'}`, () => {
      s.blocks = before.blocks;
      s.source = before.source;
      if (removedBefore) s.removed = removedBefore; else delete s.removed;
      state.sets = [...state.sets.filter(x => x.sessionId !== s.id), ...before.sets];
      save(); render();
    });
    save(); render();
  },

  libEdit: d => openSheet({ type: 'editEx', id: d.id }),
  catNew: () => { openSheet({ type: 'category', id: null, q: '', part: null, draft: { name: '', moveIn: [], newLines: '' } }); ui.sheetFocus = '#cat-name'; renderSheet(); },
  catEdit: d => { const f = famOf(d.id); openSheet({ type: 'category', id: f.id, q: '', part: null, draft: { name: f.name, moveIn: [], newLines: '' } }); },
  catPart: d => { readCatInputs(); ui.sheet.part = ui.sheet.part === d.v ? null : d.v; renderSheet(); },
  catPick: d => { readCatInputs(); const m = ui.sheet.draft.moveIn; ui.sheet.draft.moveIn = m.includes(d.id) ? m.filter(x => x !== d.id) : [...m, d.id]; renderSheet(); },
  catSave: () => {
    readCatInputs();
    const sh = ui.sheet, d = sh.draft, name = d.name.trim();
    if (!name) return toast('Name the category');
    if (state.families.some(f => f.id !== sh.id && f.name.toLowerCase() === name.toLowerCase())) return toast(`There's already a ${name} category`);
    let fam = sh.id && famOf(sh.id);
    if (!fam) { fam = { id: L.uid(), name, defaultExerciseId: null }; state.families.push(fam); }
    fam.name = name;
    for (const id of d.moveIn) moveExercise(exOf(id), fam.id);
    const lines = [...new Set(d.newLines.split('\n').map(x => x.trim()).filter(Boolean))];
    const have = lines.filter(n => state.exercises.some(e => e.name.toLowerCase() === n.toLowerCase()));
    for (const n of lines.filter(x => !have.includes(x))) newExercise({ name: n, familyId: fam.id, region: L.guessRegion(n), explosive: L.guessExplosive(n) });
    if (!fam.defaultExerciseId) fam.defaultExerciseId = L.familyMembers(state, fam.id).find(e => !e.archived)?.id ?? null;
    ui.sheet = null;
    save(); render();
    toast(have.length ? `Saved ${name}. Already in your library: ${have.join(', ')}` : `Saved ${name}`);
  },
  catDelete: () => {
    const fam = famOf(ui.sheet.id);
    if (L.familyMembers(state, fam.id).length) return toast('Move its exercises to another category first');
    const goals = state.slots.filter(sl => sl.familyId === fam.id);
    askConfirm(`Delete ${fam.name}?`, goals.length ? `Its ${goals.length} weekly goal${goals.length === 1 ? '' : 's'} go too.` : 'It has no exercises.', 'Delete', () => {
      state.slots = state.slots.filter(sl => sl.familyId !== fam.id);
      state.families = state.families.filter(f => f !== fam);
      save(); render();
    });
  },

  libMove: d => {
    const e = exOf(d.id);
    normalizeRanks(e.familyId);
    const members = L.familyMembers(state, e.familyId);
    const i = members.indexOf(e), j = i + Number(d.dir);
    if (j < 0 || j >= members.length) return;
    [members[i].rank, members[j].rank] = [members[j].rank, members[i].rank];
    save(); render();
  },

  setupAgain: () => { ui.onboard = O.startDraft(state); ui.onboard.step = 1; render(); window.scrollTo(0, 0); },
  obNext: () => { readObInputs(); ui.onboard.step = Math.min(O.STEPS.length - 1, ui.onboard.step + 1); render(); window.scrollTo(0, 0); },
  obBack: () => { readObInputs(); ui.onboard.step = Math.max(0, ui.onboard.step - 1); render(); window.scrollTo(0, 0); },
  obSkip: () => { if (!state.settings.onboarded) { state.settings.onboarded = true; save(); } ui.onboard = null; render(); requestPersist(); },
  obImport: () => { state.settings.onboarded = true; save(); ui.onboard = null; ui.tab = 'more'; actions.setPage({ p: 'fitnotes' }); requestPersist(); },
  obSet: d => { readObInputs(); ui.onboard[d.k] = d.v; render(); },
  obToggle: d => {
    readObInputs();
    const picks = ui.onboard[d.k];
    if (d.id in picks) delete picks[d.id];
    else picks[d.id] = d.k === 'power' ? 2 : d.k === 'pump' ? 2 : 1;
    render();
  },
  obQuota: d => { readObInputs(); const picks = ui.onboard[d.k]; picks[d.id] = Math.min(7, Math.max(1, picks[d.id] + Number(d.d))); render(); },
  obEq: d => {
    readObInputs();
    const l = ui.onboard.locations[Number(d.i)];
    l.equipment = l.equipment.includes(d.eq) ? l.equipment.filter(x => x !== d.eq) : [...l.equipment, d.eq];
    render();
  },
  obLocAdd: () => { readObInputs(); ui.onboard.locations.push({ id: L.uid(), name: 'New location', equipment: [] }); render(); },
  obLocDel: d => { readObInputs(); ui.onboard.locations.splice(Number(d.i), 1); render(); },
  obFinish: () => {
    keepCopy('before-setup');
    snapshotNow('before-setup');
    O.applyDraft(state, ui.onboard);
    ui.onboard = null; ui.setupUndo = true; ui.tab = 'today';
    save(); render(); window.scrollTo(0, 0);
    requestPersist();
    toast('All set. Check in when you train.');
  },
  setupUndo: () => {
    const before = readCopy('before-setup');
    if (before) replaceState(before);
    dropCopy('before-setup');
    ui.setupUndo = false;
    render(); toast('Your previous setup is back');
  },
  maxSet: d => openSheet({ type: 'max', id: d.id }),
  maxSave: d => {
    setTestedMax(exOf(d.id), sheetEl.querySelector('#mx-load').value);
    ui.sheet = null;
    save(); render(); toast('1RM saved');
  },
  exSave: d => {
    const e = exOf(d.id);
    const q = sel => sheetEl.querySelector(sel);
    moveExercise(e, q('#ee-fam').value);
    e.name = q('#ee-name').value.trim() || e.name;
    e.metric = q('#ee-metric').value;
    e.bodyweight = q('#ee-bw').checked;
    setTestedMax(e, q('#ee-max').value);
    e.restSec = q('#ee-rest').value.trim() === '' ? null : parseMSS(q('#ee-rest').value);
    const mr = q('#ee-maxreps').value.trim();
    e.maxReps = mr === '' ? null : Number(mr);
    e.equipment = [...sheetEl.querySelectorAll('input[name="ee-eq"]:checked')].map(i => i.value);
    e.anytime = q('#ee-any').checked;
    e.region = q('#ee-region').value;
    e.explosive = q('#ee-expl').checked;
    e.role = q('#ee-role').value;
    e.pref = q('#ee-pref').value || null;
    e.archived = q('#ee-arch').checked;
    e.youtube = q('#ee-yt').value.trim();
    e.start = parseMSS(q('#ee-start').value);
    e.cues = q('#ee-cues').value.trim();
    const fam = famOf(e.familyId);
    if (q('#ee-default').checked) fam.defaultExerciseId = e.id;
    else if (fam.defaultExerciseId === e.id) fam.defaultExerciseId = null;
    ui.sheet = null;
    save(); render();
    const note = availabilityNote(e);
    if (note) toast(note);
  },

  exDelete: d => {
    const e = exOf(d.id);
    askConfirm(`Delete ${e.name}?`, 'It has no logged sets, so no history is lost.', 'Delete', () => {
    state.exercises = state.exercises.filter(x => x.id !== e.id);
    state.sets = state.sets.filter(x => x.exerciseId !== e.id); // only unlogged rows can reference it
    for (const p of state.plans) p.items = p.items.filter(it => it.exerciseId !== e.id);
    const fam = famOf(e.familyId);
    if (fam?.defaultExerciseId === e.id) fam.defaultExerciseId = L.familyMembers(state, fam.id)[0]?.id ?? null;
    for (const s of state.sessions) s.blocks = s.blocks.filter(b => b.exerciseId !== e.id);
    save(); render();
    });
  },

  planNew: () => { ui.plan = { name: '', items: [] }; actions.planAddItem(); },
  planEdit: d => { ui.plan = structuredClone(L.byId(state.plans, d.id)); render(); },
  planAddItem: () => {
    const last = ui.plan.items.at(-1);
    const tier = last?.tier ?? 'T2';
    ui.plan.items.push({ exerciseId: last?.exerciseId ?? state.exercises[0]?.id, tier, schemeId: L.schemeOptions(state, tier)[0]?.id });
    render();
  },
  planDelItem: d => { ui.plan.items.splice(Number(d.i), 1); render(); },
  planCancel: () => { ui.plan = null; render(); },
  planSave: () => {
    const p = ui.plan;
    if (!p.name.trim()) return toast('Give the plan a name');
    if (!p.items.length) return toast('Add at least one exercise');
    if (p.id) state.plans[state.plans.findIndex(x => x.id === p.id)] = { ...p, editedAt: Date.now() };
    else state.plans.push({ ...p, id: L.uid() });
    ui.plan = null;
    save(); render(); toast('Plan saved');
  },
  planDelete: () => askConfirm(`Delete “${ui.plan.name}”?`, 'Past sessions that used it keep their logs.', 'Delete plan', () => {
    state.plans = state.plans.filter(x => x.id !== ui.plan.id);
    ui.plan = null;
    save(); render();
  }),

  locAdd: () => { state.locations.push({ id: L.uid(), name: 'New location', equipment: [] }); save(); render(); },

  setPage: d => {
    ui.setPage = d.p || null;
    if (d.p === 'fitnotes' && (!ui.fn || ui.fn.stage === 'done')) ui.fn = { stage: 'pick' };
    if (d.p === 'data') { ui.vault = null; openDataPage(); }
    render(); window.scrollTo(0, 0);
  },

  libArchived: () => { ui.showArchived = !ui.showArchived; render(); },

  fnToggle: d => {
    const id = Number(d.id);
    ui.fn.open.has(id) ? ui.fn.open.delete(id) : ui.fn.open.add(id);
    render();
  },
  fnOlder: () => { ui.fn.showOlder = !ui.fn.showOlder; render(); },
  fnCancel: () => { ui.fn = { stage: 'pick' }; render(); window.scrollTo(0, 0); },
  fnImport: () => {
    const f = ui.fn;
    if (!keepCopy('before-import')) return toast('Couldn’t make a safety copy first, so nothing was imported. Free up some space and try again.');
    snapshotNow('before-import');
    const undo = msg => {
      const snap = readCopy('before-import');
      if (snap) replaceState(snap);
      dropCopy('before-import');
      ui.fn = { ...f, error: msg };
    };
    try {
      const summary = FN.applyImport(state, f.data, f.plan, { bodyweight: f.bodyweight });
      state.settings.bodyweight ??= f.bodyweight;
      if (save()) ui.fn = { stage: 'done', summary };
      else undo('That much history is too big to save in this browser. Nothing changed: try fewer years.');
    } catch (e) {
      console.error(e);
      undo(`The import stopped: ${e.message}. Nothing changed.`);
    }
    ui.ci = defaultCheckin();
    render(); window.scrollTo(0, 0);
  },
  fnLibrary: () => { ui.fn = null; ui.setPage = null; ui.tab = 'library'; render(); window.scrollTo(0, 0); },
  fnFinish: () => { ui.fn = null; ui.setPage = 'data'; ui.vault = null; openDataPage(); render(); window.scrollTo(0, 0); },
  fnUndo: () => askConfirm('Undo the last import?', 'Everything goes back to how it was just before the import, including anything you logged since.', 'Undo import', () => {
    const snap = readCopy('before-import');
    if (!snap) return toast('There’s nothing to undo.');
    replaceState(snap);
    dropCopy('before-import');
    ui.ci = defaultCheckin();
    render(); toast('Import undone');
  }),

  copyRaw: () => {
    const raw = loadProblem?.raw ?? '';
    try {
      navigator.clipboard.writeText(raw).then(() => toast('Copied. Paste it somewhere safe.'), () => openSheet({ type: 'backupText', json: raw }));
    } catch {
      openSheet({ type: 'backupText', json: raw });
    }
  },
  startFresh: () => askConfirm('Start fresh?', 'The data that couldn’t be opened gets replaced, so copy it first if you want to keep it.', 'Start fresh', () => {
    resolveLoadProblem();
    save();
    render();
  }),
  goWeek: () => { ui.tab = 'week'; ui.setPage = null; render(); window.scrollTo(0, 0); },

  goalNew: () => openSheet({ type: 'goal', isNew: true,
    draft: { familyId: [...state.families].sort((a, b) => a.name.localeCompare(b.name))[0]?.id, exerciseId: null, tier: 'T3', quota: 1, priority: 1, repMin: null } }),
  goalEdit: d => {
    const sl = L.byId(state.slots, d.id);
    openSheet({ type: 'goal', id: sl.id, draft: { familyId: sl.familyId, exerciseId: sl.exerciseId ?? null, tier: sl.tier, quota: sl.quota, priority: sl.priority ?? 1, repMin: sl.repMin ?? null } });
  },
  goalSet: d => { readGoalReps(); ui.sheet.draft[d.k] = d.k === 'priority' ? Number(d.v) : d.v; renderSheet(); },
  // An area on or paused: an active one keeps any count it had, so switching T3 as areas off brings it back.
  goalActive: d => { readGoalReps(); const g = ui.sheet.draft; g.quota = d.v === '1' ? Math.max(1, g.quota || 0) : 0; renderSheet(); },
  goalStep: d => { readGoalReps(); const g = ui.sheet.draft; g.quota = Math.min(7, Math.max(ui.sheet.isNew ? 1 : 0, g.quota + Number(d.d))); renderSheet(); },
  goalSave: () => {
    readGoalReps();
    const { draft, id, isNew } = ui.sheet;
    if (isNew) state.slots.push({ id: L.uid(), ...draft });
    else Object.assign(L.byId(state.slots, id), draft);
    ui.sheet = null;
    save(); render();
    toast(isNew ? 'Goal added' : 'Goal saved');
  },
  goalDelete: () => {
    const sl = L.byId(state.slots, ui.sheet.id);
    askConfirm(`Delete the ${slotLabel(sl)} goal?`, 'Sets that counted toward it stay logged but stop counting.', 'Delete goal', () => {
      state.slots = state.slots.filter(x => x !== sl);
      save(); render();
    });
  },

  schemeNew: () => openSheet({ type: 'scheme', draft: { sets: 4, reps: 5, restSec: 120, minutes: null, tiers: ['T2'] } }),
  schemeEdit: d => { const sc = schOf(d.id); openSheet({ type: 'scheme', id: sc.id, draft: { ...sc, tiers: [...sc.tiers] } }); },
  schemeTier: d => {
    readSchemeInputs();
    const t = ui.sheet.draft.tiers;
    ui.sheet.draft.tiers = t.includes(d.t) ? t.filter(x => x !== d.t) : [...t, d.t];
    renderSheet();
  },
  schemeSave: () => {
    readSchemeInputs();
    const d = ui.sheet.draft;
    if (!d.tiers.length) return toast('Pick at least one tier');
    const est = Math.max(1, Math.round((d.sets * (d.reps * 4 + d.restSec)) / 60));
    const fields = { name: `${d.sets}×${d.reps}`, sets: d.sets, reps: d.reps, restSec: d.restSec, minutes: d.minutes || est, tiers: d.tiers };
    if (ui.sheet.id) Object.assign(schOf(ui.sheet.id), fields);
    else state.schemes.push({ id: L.uid(), ...fields });
    ui.sheet = null;
    save(); render();
  },
  schemeDelete: () => {
    const sc = schOf(ui.sheet.id);
    askConfirm(`Delete the ${sc.name} scheme?`, 'Suggestions stop using it.', 'Delete scheme', () => {
      state.schemes = state.schemes.filter(x => x !== sc);
      save(); render();
    });
  },

  export: () => {
    state.settings.lastExportAt = Date.now();
    save();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fitness-backup-${L.dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    render();
  },

  reset: () => askConfirm('Erase everything and start from the seed?', 'All sessions, sets, plans and edits are deleted. A saved copy stays on this device under Backup and data; copy a backup too if you might want them later.', 'Erase all data', () => {
    snapshotNow('before-erase');
    resetState();
    ui.ci = defaultCheckin();
    render(); toast('Reset to seed');
  }),

  confirmYes: () => {
    const fn = ui.sheet.onYes;
    ui.sheet = null;
    renderSheet();
    fn();
  },

  // Downloads are blocked in some hosts (e.g. claude.ai artifacts), so the clipboard is the fallback.
  copyBackup: () => {
    const json = JSON.stringify(state);
    const done = () => { state.settings.lastExportAt = Date.now(); save(); render(); toast('Backup copied. Paste it somewhere safe.'); };
    const fallback = () => openSheet({ type: 'backupText', json });
    try {
      navigator.clipboard.writeText(json).then(done, fallback);
    } catch {
      fallback();
    }
  },
  // Share sheet on phones (Files, iCloud Drive, Google Drive, email), a download elsewhere. Only a completed share or
  // download counts as a backup. Built and shared in one go: the browser wants the share to start from the tap.
  saveBackup: () => {
    const name = `fitness-backup-${L.dayKey()}.json`;
    const text = JSON.stringify(state, null, 2);
    const done = () => { state.settings.lastExportAt = Date.now(); save(); render(); toast('Backup saved'); };
    const download = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      done();
    };
    let file = null;
    try { file = new File([text], name, { type: 'application/json' }); } catch { /* no File constructor */ }
    if (file && navigator.canShare?.({ files: [file] })) {
      navigator.share({ files: [file], title: 'Training backup' }).then(done, e => { if (e?.name !== 'AbortError') download(); });
    } else download();
  },
  cloudMode: d => { ui.cloud = { mode: d.m, email: (appEl.querySelector('#cloud-email')?.value ?? '').trim() }; render(); },
  // Sign in, or create the account (the first time), with an email and a password.
  cloudPassword: async d => {
    const address = (appEl.querySelector('#cloud-email')?.value ?? '').trim().toLowerCase();
    const password = appEl.querySelector('#cloud-password')?.value ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return toast('Type your email address');
    if (password.length < 6) return toast('Type a password of 6 or more characters');
    ui.cloud = { busy: true, email: address };
    render();
    try {
      await (d.m === 'up' ? Cloud.signUp(address, password) : Cloud.signInWithPassword(address, password));
      ui.cloud = {};
      toast(d.m === 'up' ? 'Account created' : 'Signed in');
      render();
      handleSync(await Sync.sync());
    } catch (e) { ui.cloud = { email: address, error: e.message }; render(); }
  },
  cloudSend: async () => {
    const address = (appEl.querySelector('#cloud-email')?.value ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return toast('Type your email address');
    ui.cloud = { busy: true, email: address, mode: 'link' };
    render();
    try { await Cloud.sendCode(address); ui.cloud = { sentTo: address }; } catch (e) { ui.cloud = { email: address, mode: 'link', error: e.message }; }
    render();
  },
  cloudVerify: async () => {
    const code = (appEl.querySelector('#cloud-code')?.value ?? '').trim();
    if (!/^\d{6,10}$/.test(code)) return toast('Type the code from the email');
    const sentTo = ui.cloud.sentTo;
    ui.cloud = { sentTo, busy: true };
    render();
    try {
      await Cloud.verifyCode(sentTo, code);
      ui.cloud = {};
      toast('Signed in');
      render();
      handleSync(await Sync.sync());
    } catch (e) { ui.cloud = { sentTo, error: e.message }; render(); }
  },
  cloudChange: () => { ui.cloud = {}; render(); },
  cloudSync: async () => { (ui.cloud ??= {}).busy = true; render(); handleSync(await Sync.sync()); },
  cloudSignOut: () => askConfirm('Sign out?', 'Your data stays on this device. Signing back in asks what to do with the account\'s copy.', 'Sign out', async () => {
    await Sync.signOut();
    ui.cloud = {};
    render(); toast('Signed out');
  }),
  cloudAsk: () => openSheet({ type: 'cloudAsk' }),
  cloudAuthPage: () => { ui.tab = 'more'; actions.setPage({ p: 'data' }); },
  cloudChoose: async d => {
    ui.sheet = null; renderSheet();
    (ui.cloud ??= {}).busy = true;
    render();
    handleSync(await Sync.resolve(d.c));
  },
  histEdit: d => { ui.history.edit = d.id; render(); window.scrollTo(0, 0); },
  histEditDone: () => { delete ui.history.edit; render(); window.scrollTo(0, 0); },
  histDelSet: d => {
    const st = L.byId(state.sets, d.id), s = L.byId(state.sessions, st?.sessionId);
    if (!s) return;
    const snap = sessionSnap(s);
    state.sets = state.sets.filter(x => x !== st);
    tidyBlocks(s);
    save(); render();
    toast('Set deleted', () => restoreSnap(snap));
  },
  histDelGroup: d => {
    const s = L.byId(state.sessions, ui.history.edit), g = s && histGroups(s).find(x => x.key === d.g);
    if (!g) return;
    const snap = sessionSnap(s);
    state.sets = state.sets.filter(x => !g.sets.includes(x));
    tidyBlocks(s);
    save(); render();
    toast(`Removed ${g.ex?.name ?? 'exercise'}`, () => restoreSnap(snap));
  },
  histAddSet: d => {
    const s = L.byId(state.sessions, ui.history.edit), g = s && histGroups(s).find(x => x.key === d.g);
    if (!g) return;
    const from = [...g.sets].reverse().find(x => !x.warmup) ?? g.sets.at(-1);
    state.sets.push(histNewSet(s, { id: from.blockId, tier: g.tier }, g.ex, from.loggedAt + 1000, from));
    save(); render();
  },
  histSwap: d => openSheet({ type: 'addEx', mode: 'histSwap', sessionId: ui.history.edit, group: d.g, q: '' }),
  histAddEx: () => openSheet({ type: 'addEx', mode: 'histAdd', sessionId: ui.history.edit, tier: 'T3', q: '' }),
  histDeleteWorkout: () => askConfirm('Delete this workout?', 'Its sets, and any mobility logged in it, are removed. Goals and estimated maxes recalculate. You can undo right after.', 'Delete workout', () => {
    const s = L.byId(state.sessions, ui.history.edit);
    if (!s) return;
    const snap = sessionSnap(s);
    state.sessions = state.sessions.filter(x => x !== s);
    state.sets = state.sets.filter(x => x.sessionId !== s.id);
    delete ui.history.edit;
    save(); render(); window.scrollTo(0, 0);
    toast('Workout deleted', () => restoreSnap(snap));
  }),
  reloadApp: () => location.reload(),
  // Throws away the saved app files and loads everything fresh. Needs the network: the saved copy is what works offline.
  refreshApp: async () => {
    if (navigator.onLine === false) return toast('You\'re offline, so there\'s nothing newer to get.');
    toast('Getting the latest version…');
    try { await (await navigator.serviceWorker?.getRegistration())?.update(); } catch { /* reload anyway */ }
    try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* nothing saved */ }
    location.reload();
  },
  backupSnooze: () => { state.settings.backupSnoozeUntil = Date.now() + 3 * 864e5; save(); render(); },
  recoveryUse: () => {
    useRecoveryCopy();
    ui.ci = defaultCheckin();
    render(); toast('Back to the saved copy. Your previous data is under Backup and data.');
  },
  recoveryIgnore: () => { dismissRecoveryCopy(); render(); },
  recoveredOk: () => { ui.recovered = null; render(); },
  // Rolling back to a saved copy: it replaces what's here, after a snapshot of what's here, and can be undone.
  vaultRestore: async d => {
    const rec = await Vault.read(Number(d.at));
    if (!rec) return toast('That saved copy couldn’t be read.');
    askConfirm(`Go back to ${fmtDateTime(rec.at)}?`, `${rec.workouts ?? '?'} workouts and ${rec.sets ?? '?'} sets. What's here now is replaced; you can undo this right after.`, 'Restore', () => {
      const before = JSON.stringify(state);
      snapshotNow('before-restore');
      try { replaceState(JSON.parse(rec.json)); } catch (e) { return toast(`That copy couldn’t be opened: ${e.message}`); }
      ui.ci = defaultCheckin();
      render();
      toast('Restored', () => { replaceState(JSON.parse(before)); ui.ci = defaultCheckin(); render(); toast('Back to how it was'); });
      loadVault();
    });
  },
  pasteImport: () => openSheet({ type: 'pasteImport' }),
  pasteImportGo: () => importText(sheetEl.querySelector('#paste-json').value),
};

// ---------- events ----------

document.addEventListener('click', e => {
  if (e.target === sheetEl) return closeSheet();
  const el = e.target.closest('[data-act]');
  if (!el) return;
  rollDay(); // before the action looks for today's workout
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});

// Copies the onboarding step's typed values into the draft.
// An exercise added from the setup's heavy or support step: you added it as a lift, so it's a main lift, and it's picked
// on that step when it can be (a loaded, non-explosive lift with gear at one of your locations).
function obAdded(e) {
  const d = ui.onboard, kind = O.STEPS[d.step] === 'heavy' ? 't1' : 't2';
  e.role = 'main';
  save();
  ui.sheet = null;
  const missing = e.equipment.filter(eq => !d.locations.some(l => l.equipment.includes(eq)));
  if (e.metric !== 'load_reps' || e.explosive) toast(`Added ${e.name}. T1/T2 goals need a loaded, non-explosive lift.`);
  else if (missing.length) toast(`Added ${e.name}, but none of your locations has ${missing.join(', ')}. Go back to Where you train to add it.`);
  else { d[kind][e.id] = 1; toast(`Added and picked ${e.name}`); }
  render();
}

function readObInputs() {
  const d = ui.onboard;
  if (!d) return;
  for (const el of appEl.querySelectorAll('[data-ob]')) {
    const k = el.dataset.ob, v = el.value.trim();
    if (k === 'bodyweight') d.bodyweight = v === '' ? null : Number(v);
    else if (k.startsWith('week.')) d.week[k.slice(5)] = v === '' ? null : Number(v);
    else if (k.startsWith('loc.')) d.locations[Number(k.split('.')[1])].name = el.value;
    else if (k.startsWith('max.')) { const id = k.slice(4); if (v === '') delete d.maxes[id]; else d.maxes[id] = Number(v); }
  }
}

function setPath(obj, path, val) {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts.at(-1)] = val;
}

function readValue(el) {
  const t = el.dataset.type;
  if (t === 'bool') return el.checked;
  if (t === 'num') return el.value === '' ? null : Number(el.value);
  if (t === 'pct') return el.value === '' ? null : Number(el.value) / 100;
  return el.value;
}

document.addEventListener('change', e => {
  const el = e.target;
  const d = el.dataset;
  if (d.set) {
    const st = L.byId(state.sets, d.set);
    st[d.f] = el.value === '' ? null : Number(el.value);
    if (st.done) { const was = st.pr; if (markPR(st) && !was) toast(`🏆 ${st.prText}`); if (was !== st.pr) render(); }
    save();
  } else if (d.hgtier !== undefined) {
    const s = L.byId(state.sessions, ui.history?.edit), g = s && histGroups(s).find(x => x.key === d.hgtier);
    if (g) { for (const st of g.sets) st.tier = el.value; tidyBlocks(s); save(); render(); }
  } else if (d.countgoal !== undefined) {
    const b = d.hist ? L.byId(state.sessions, d.hist)?.blocks.find(x => x.id === d.countgoal) : findBlock(d.countgoal).b;
    if (b) { if (el.checked) b.countGoal = true; else delete b.countGoal; save(); render(); }
  } else if (d.qafam !== undefined) {
    const input = sheetEl.querySelector('#qa-fam');
    input.hidden = el.value !== '__new';
    if (!input.hidden) input.focus();
  } else if (d.bsched !== undefined && ui.blockSetup) {
    const wd = Number(d.bsched);
    ui.blockSetup.schedule = [...ui.blockSetup.schedule.filter(x => x.weekday !== wd), ...(el.value ? [{ weekday: wd, planId: el.value }] : [])].sort((a, b) => a.weekday - b.weekday);
    render();
  } else if (d.bdeload !== undefined && ui.blockSetup) {
    ui.blockSetup.deloadEvery = el.checked ? 4 : 0;
  } else if (d.proglift !== undefined && ui.prog) {
    ui.prog.lift = el.value;
    render();
  } else if (d.hdate !== undefined) {
    moveWorkout(el.value);
  } else if (d.hloc !== undefined) {
    const s = L.byId(state.sessions, ui.history?.edit);
    if (s) { s.locationId = el.value || null; delete s.locationIds; save(); }
  } else if (d.iv !== undefined) {
    const v = ivDraft();
    if (d.iv === 'name') v.name = el.value;
    else if (['work', 'rest', 'setRest', 'prep'].includes(d.iv)) v[d.iv] = /^\s*0+(:0+)?\s*$/.test(el.value) ? 0 : parseMSS(el.value) ?? v[d.iv];
    else v[d.iv] = Number(el.value) || v[d.iv];
    Object.assign(v, I.clean(v), { presetId: v.presetId });
    render();
  } else if (d.ivex !== undefined) {
    const v = ivDraft();
    const ex = Array.from({ length: v.sets }, (_, i) => I.exerciseFor(v, i + 1));
    ex[Number(d.ivex)] = el.value;
    v.exercises = ex;
  } else if (d.hdur !== undefined) {
    const s = L.byId(state.sessions, ui.history?.edit), v = Math.round(Number(el.value));
    if (s) { if (el.value.trim() !== '' && v > 0) s.durationMin = v; else delete s.durationMin; save(); }
  } else if (d.mset) {
    const [iid, sid] = d.mset.split('|');
    const st = findMobItem(iid).item?.sets.find(x => x.id === sid);
    if (st) { st[d.f] = el.value.trim() === '' ? null : d.f === 'extra' ? el.value.trim() : Number(el.value); save(); }
  } else if (d.vert) {
    const [id, w] = d.vert.split('|');
    state.programs ??= {};
    const p = state.programs[id] ??= { stopped: true, verticals: [] }; // verticals can be logged before starting
    {
      p.verticals = (p.verticals || []).filter(v => v.week !== Number(w));
      const v = Number(el.value);
      if (el.value.trim() !== '' && v > 0) p.verticals.push({ week: Number(w), value: v, at: Date.now() });
      save();
    }
  } else if (d.max) {
    if (ui.sheet?.type === 'goal') readGoalReps(); // keep what's typed in the goal sheet across the redraw
    setTestedMax(exOf(d.max), el.value);
    save(); render();
  } else if (d.progweek) {
    P.setWeek(state, d.progweek, Number(el.value));
    save(); render(); toast(`Week ${el.value}, day 1`);
  } else if (d.mnote) {
    const it = findMobItem(d.mnote).item;
    if (it) { it.note = el.value.trim(); save(); }
  } else if (d.bind !== undefined) {
    setPath(state, d.bind, readValue(el));
    save();
    if (d.bind === 'settings.timer.notify') {
      if (el.checked) enableNotifications(el).then(render);
      else { syncTimerToWorker(true); render(); }
    }
    if (d.rerender !== undefined) render();
  } else if (d.pbind !== undefined) {
    setPath(ui.plan, d.pbind, el.value);
    for (const it of ui.plan.items) {
      if (!L.schemeOptions(state, it.tier).some(s => s.id === it.schemeId)) it.schemeId = L.schemeOptions(state, it.tier)[0]?.id;
    }
    render();
  } else if (d.counts) {
    const st = L.byId(state.sets, d.counts);
    if (el.value === 'auto') { delete st.countsManual; delete st.countsToward; }
    else { st.countsManual = true; st.countsToward = el.value === 'none' ? null : el.value; }
    save(); render();
  } else if (d.loceq) {
    const [id, eq] = d.loceq.split('|');
    const loc = L.byId(state.locations, id);
    loc.equipment = el.checked ? [...loc.equipment, eq] : loc.equipment.filter(x => x !== eq);
    save(); render();
  } else if (el.hasAttribute('data-kb')) {
    state.settings.kettlebells = el.value.split(/[,\s]+/).map(Number).filter(n => n > 0).sort((a, b) => a - b);
    save();
  } else if (d.gdraft) {
    readGoalReps();
    const g = ui.sheet.draft;
    g[d.gdraft] = el.value || null;
    if (d.gdraft === 'familyId') g.exerciseId = null; // the old exercise belongs to the old family
    renderSheet();
  } else if (['split', 'jumps', 'cond', 'condpair'].some(k => el.hasAttribute(`data-ci-${k}`))) {
    const k = ['split', 'jumps', 'cond', 'condpair'].find(x => el.hasAttribute(`data-ci-${x}`));
    ui.ci[k === 'condpair' ? 'condPair' : k] = el.checked;
    el.closest('label.chip')?.classList.toggle('on', el.checked);
  } else if (el.hasAttribute('data-import')) {
    importFile(el.files[0]);
  } else if (el.hasAttribute('data-fnfile')) {
    startFitnotes(el.files[0]);
    el.value = '';
  } else if (d.fn) {
    fnSet(d.fn, d.k, el);
  } else if (d.gs) {
    const r = ui.goalSuggest.rows.find(x => x.key === d.gs);
    if (d.k === 'include') r.include = el.checked;
    else r.repMin = el.value.trim() === '' ? null : Math.max(1, Number(el.value) || 1);
    render();
  } else if (el.name === 'qa-region') {
    ui.sheet.regionTouched = true;
  } else if (el.id === 'qa-expl') {
    ui.sheet.explTouched = true;
  } else if (d.eqnew !== undefined) {
    addEquipment(el);
  } else if (el.type === 'checkbox' && el.closest('label.chip')) {
    el.closest('label.chip').classList.toggle('on', el.checked);
  }
});

document.addEventListener('input', e => {
  if (e.target.hasAttribute('data-sheetq')) {
    ui.sheet.q = e.target.value;
    ui.sheetFocus = '#sheetq';
    renderSheet();
  } else if (e.target.hasAttribute('data-catq')) {
    readCatInputs();
    ui.sheet.q = e.target.value;
    ui.sheetFocus = '#catq';
    renderSheet();
  } else if (e.target.hasAttribute('data-qaname')) {
    onQaName(e.target.value);
  } else if (e.target.hasAttribute('data-histq')) {
    ui.history.q = e.target.value;
    ui.history.limit = HISTORY_PAGE;
    ui.focus = '#histq';
    render();
  } else if (e.target.hasAttribute('data-libq')) {
    ui.libQuery = e.target.value;
    ui.focus = '#libq';
    render();
  } else if (e.target.hasAttribute('data-mrname')) {
    ui.mobRoutine.name = e.target.value;
  } else if (e.target.dataset.pbind === 'name') {
    ui.plan.name = e.target.value;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset?.eqnew !== undefined) { e.preventDefault(); e.target.blur(); }
});

document.addEventListener('toggle', e => {
  if (e.target.hasAttribute?.('data-why')) ui.whyOpen = e.target.open;
  if (e.target.hasAttribute?.('data-mix')) ui.mixOpen = e.target.open;
  if (e.target.hasAttribute?.('data-skip')) ui.skipOpen = e.target.open;
}, true);

function addEquipment(el) {
  const eq = el.value.trim().toLowerCase();
  el.value = '';
  if (!eq) return;
  if (!state.equipment.includes(eq)) state.equipment.push(eq);
  const target = el.dataset.eqnew;
  if (target.startsWith('loc:')) {
    const loc = L.byId(state.locations, target.slice(4));
    if (!loc.equipment.includes(eq)) loc.equipment.push(eq);
    save(); render();
    return;
  }
  // In an exercise form: add a ticked chip in place so the rest of the form keeps what you typed.
  const box = [...el.parentElement.querySelectorAll(`input[name="${target}"]`)].find(i => i.value === eq);
  if (box) { box.checked = true; box.closest('label').classList.add('on'); }
  else el.insertAdjacentHTML('beforebegin', equipChip(eq, true, target));
  if (ui.sheet) (ui.sheet.newEq ??= []).push(eq);
  save();
}

// As you type a name: offer to copy a similar exercise, and treat "Weighted …" as added load.
function readGoalReps() {
  const el = sheetEl.querySelector('#g-reps');
  if (el) ui.sheet.draft.repMin = el.value.trim() === '' ? null : Math.max(1, Number(el.value) || 1);
}

function onQaName(value) {
  const sh = ui.sheet;
  sh.name = value;
  const hint = sheetEl.querySelector('#qa-hint');
  if (hint) hint.innerHTML = qaHint(value, sh);
  if (!sh.regionTouched) {
    const r = sheetEl.querySelector(`input[name="qa-region"][value="${L.guessRegion(value)}"]`);
    if (r) r.checked = true;
  }
  if (!sh.explTouched) { const x = sheetEl.querySelector('#qa-expl'); if (x) x.checked = L.guessExplosive(value); }
  if (/^weighted\b/i.test(value.trim()) && !sh.weightedApplied) {
    sh.weightedApplied = true;
    const w = weightedDefaults({ equipment: [] });
    const metric = sheetEl.querySelector('input[name="qa-metric"][value="load_reps"]');
    if (metric) metric.checked = true;
    sheetEl.querySelector('#qa-bw').checked = true;
    for (const eq of w.equipment) {
      const box = [...sheetEl.querySelectorAll('input[name="qa-eq"]')].find(i => i.value === eq);
      if (box) { box.checked = true; box.closest('label').classList.add('on'); }
    }
  }
}

function importFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => importText(r.result);
  r.readAsText(file);
}

function importText(text) {
  let data;
  try {
    data = JSON.parse(text);
    if (!Array.isArray(data.exercises) || !Array.isArray(data.sets)) throw new Error('it is not a backup from this app');
  } catch (err) {
    return toast(`Import failed: ${err.message}`);
  }
  const n = data.sets.filter(x => x.done).length;
  askConfirm('Replace all current data with this backup?', `The backup has ${data.sessions?.length ?? 0} sessions and ${n} logged sets. What's here now is replaced (a saved copy stays on this device).`, 'Replace data', () => {
    snapshotNow('before-paste');
    replaceState(data);
    ui.ci = defaultCheckin();
    render(); toast('Imported');
  });
}

// Which version of the app is running (the service worker's cache name), for Settings. Resolves null without a worker.
function swVersion() {
  const c = navigator.serviceWorker?.controller;
  if (!c) return Promise.resolve(null);
  return new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = e => resolve(e.data);
    c.postMessage({ type: 'version' }, [ch.port2]);
    setTimeout(() => resolve(null), 1000);
  });
}

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  // On a slow signal the saved copy loads first; the worker says when the newer one has arrived.
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'update-ready' && !ui.updateReady) { ui.updateReady = true; render(); } });
  // A home-screen app can resume without reloading: look for a new version whenever you come back to it.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {}); });
  swVersion().then(v => { ui.swVersion = v; });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(err => console.warn('Service worker not registered', err));
  // A new version took over: reload once so every file comes from the same version.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}

// A home-screen app can sit open for days without reloading. Coming back after a while, reload to pick up
// updates; everything is saved as you go, including an open workout and its rest timer.
let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 30 * 60 * 1000 && !ui.sheet && HR.live.status === 'off') location.reload();
  else if (rollDay()) render();
});

onSaveFail(() => { toast('Couldn’t save your last change. See the message at the top.'); });

// Before anything saves: if this browser lost the saved data but the second copy in IndexedDB has it, it comes back here.
{
  const r = await recover();
  if (r.kind === 'restored') { ui.recovered = r; ui.ci = defaultCheckin(); }
}

// Coming back from the emailed sign-in link: the address carries the session.
{
  const back = Cloud.takeSessionFromUrl();
  if (back === 'signedIn') { ui.tab = 'more'; ui.setPage = 'data'; ui.vault = null; }
  else if (back) { ui.tab = 'more'; ui.setPage = 'data'; ui.cloud = { error: back }; }
}

closeStale();
slimHistory(state);
// Drop a timer left over from an earlier visit.
if (state.timer && ((!currentSession() && !currentMobility()) || Date.now() - state.timer.endsAt > 10 * 60e3)) state.timer = null;
save();
if (O.isNewUser(state)) ui.onboard = O.startDraft(state);
render();
if (!ui.onboard) requestPersist();
Sync.start(handleSync);
if (state.settings.hrStrap && HR.supported()) HR.reconnect(state.settings.hrStrap).then(ok => { if (ok) render(); });
if (ui.setPage === 'data') openDataPage();
