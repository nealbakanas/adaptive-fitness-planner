import { state, save, replaceState, resetState, loadProblem, lastSaveError, resolveLoadProblem, onSaveFail, keepCopy, readCopy, hasCopy, dropCopy } from './store.js';
import * as L from './logic.js';
import * as FN from './fitnotes.js';
import * as G from './goals.js';
import * as M from './mobility.js';

const appEl = document.getElementById('app');
const navEl = document.getElementById('nav');
const sheetEl = document.getElementById('sheet');

const TABS = [['today', 'Today'], ['week', 'Week'], ['library', 'Library'], ['plans', 'Plans'], ['more', 'Settings']];
const INTENTS = [['auto', 'You pick'], ['heavy', 'Heavy'], ['sweat', 'Sweat'], ['easy', 'Easy']];
const TIMES = [10, 15, 20, 30, 45, 60, 90];
const REASONS = ['Equipment busy', 'Pain / niggle', 'Preference', 'Variety', 'Time'];
const METRICS = [['load_reps', 'Load × reps'], ['reps', 'Reps only'], ['time', 'Time'], ['distance', 'Distance'], ['none', 'None']];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ui = { tab: 'today', ci: defaultCheckin(), sheet: null, plan: null, whyOpen: false, libQuery: '', focus: null, setPage: null, history: null };

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
    minutes: last?.minutes ?? 45,
    fatigue: 2, sleep: null, intent: 'auto', split: false,
  };
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function currentSession() {
  const today = L.dayKey();
  return state.sessions.filter(s => s.day === today && s.status === 'open').sort((a, b) => b.checkinAt - a.checkinAt)[0];
}

function removeSession(s) {
  state.sets = state.sets.filter(x => x.sessionId !== s.id);
  state.sessions = state.sessions.filter(x => x.id !== s.id);
}

// Close anything left open from a previous day; drop sessions where nothing was logged.
function closeStale() {
  const today = L.dayKey();
  for (const s of [...state.sessions]) {
    if ((s.status !== 'open' && s.status !== 'paused') || s.day === today) continue;
    endSession(s);
  }
  for (const m of [...state.mobility.sessions]) if (m.status === 'open' && m.day !== today) endMobility(m);
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
  : ex?.metric === 'time' ? `${s.time ?? '?'}s` : ex?.metric === 'distance' ? `${s.distance ?? '?'}m` : `${s.reps ?? ''} reps`;

// Most recent time logged for a timed exercise, so the next hold starts from it.
function lastTime(exerciseId) {
  let best = null;
  for (const s of state.sets) if (s.done && !s.warmup && s.exerciseId === exerciseId && s.time > 0 && (!best || s.loggedAt > best.loggedAt)) best = s;
  return best ? Number(best.time) : null;
}

// ---------- mobility (its own exercises and sessions; no tiers, goals or maxes) ----------

const mobEx = id => L.byId(state.mobility.exercises, id);
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
  if (m.items.length) { m.status = 'done'; m.endedAt = Date.now(); }
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
    if (i >= 0) return `${mobEx(it.exerciseId)?.name ?? ''} · set ${i + 1}`;
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
  return { avg, plan, n: m.length, text: `real rest ${clock(avg)} avg · planned ${clock(plan)}` };
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
  const load = L.targetLoad(state, ex, block.tier, sc);
  for (let i = done; i < sc.sets; i++) state.sets.push(newSet(session, block, ex, sc, load));
}

function slotIdFor(exerciseId, tier) {
  const ex = exOf(exerciseId);
  return ex ? L.slotFor(state, ex, tier)?.id ?? null : null;
}

// Best scheme for an exercise added or re-tiered by hand: fits the time left if possible, never over its rep cap.
function schemeForBlock(s, ex, tier, exceptBlock) {
  const budget = sessionBudget(s, exceptBlock) - L.WARMUP[tier];
  const dose = L.slotDose(state, L.slotFor(state, ex, tier), tier);
  return L.pickScheme(state, tier, ex, Math.max(budget, 0), s, dose)
    || L.pickScheme(state, tier, ex, Infinity, s, dose)
    || L.schemeOptions(state, tier)[0];
}

function newExercise({ name, familyName, metric = 'load_reps', bodyweight = false, equipment = [], rank = null, anytime = false, region = 'full', explosive = false }) {
  // No family given: the exercise starts its own, so it can still be swapped and ranked later.
  const fname = (familyName || name).trim();
  let fam = state.families.find(f => f.name.toLowerCase() === fname.toLowerCase());
  if (!fam) {
    fam = { id: L.uid(), name: fname, defaultExerciseId: null };
    state.families.push(fam);
  }
  const e = {
    id: L.uid(), name, familyId: fam.id, rank: rank ?? (L.familyMembers(state, fam.id).at(-1)?.rank ?? 0) + 1,
    metric, bodyweight, equipment, anytime, region, explosive, youtube: '', start: null, cues: '', startMax: null, maxReps: null, restSec: null,
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
  if (tier === 'T3') L.pairT3s(state, s.blocks);
  b.schemeId = schemeForBlock(s, ex, tier, b).id;
  if (s.source === 'suggested') s.source = 'swapped';
  genSets(s, b);
}

const readyText = r => r.tired ? 'Tired: explosive work becomes technique'
  : r.heavy.length ? `Heavy ${r.heavy.join('/')} work since yesterday: explosive work there becomes technique`
  : 'Fresh for power work';

function addBlock(s, ex, tier) {
  const b = { id: L.uid(), tier, slotId: slotIdFor(ex.id, tier), exerciseId: ex.id, schemeId: null, swaps: [{ type: 'add', to: ex.id, at: Date.now() }] };
  b.schemeId = schemeForBlock(s, ex, tier, b).id;
  s.blocks.push(b);
  if (s.source === 'suggested') s.source = 'swapped';
  if (tier === 'T3') {
    L.pairT3s(state, s.blocks);
    if (b.pairOf) b.schemeId = schemeForBlock(s, ex, tier, b).id; // a partner only costs half its time
  }
  genSets(s, b);
  return b;
}

function createSession(blocks, source, extra = {}) {
  const s = {
    id: L.uid(), day: L.dayKey(), checkinAt: Date.now(), firstSetAt: null, status: 'open',
    ...ui.ci, source, blocks, ...extra,
  };
  state.sessions.push(s);
  L.pairT3s(state, blocks);
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
    .reduce((m, b) => m + ((schOf(b.schemeId)?.minutes || 0) + L.WARMUP[b.tier]) * (b.pairOf ? 0.5 : 1), 0));
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

function startTimer(s, b, setId = null) {
  const secs = effectiveRest(b);
  if (!secs) return;
  state.timer = { endsAt: Date.now() + secs * 1000, total: secs, blockId: b.id, setId, next: nextLabelAfter(s, b), warned: false, alerted: false };
  setWakeLock(true);
}

function startMobTimer(list, item, set) {
  const secs = mobEx(item.exerciseId)?.restSec || 0;
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
  timerEl.innerHTML = `<div class="fill" style="width:${pct}%"></div>
    <div class="tbody"><div class="tmain"><span class="tclock">${over ? '+' + clock(-rem) : clock(rem)}</span>
      <span class="tlabel">${over ? 'Go' : 'Rest'}${t.next ? ` · next: ${esc(t.next)}` : ''}</span></div>
      <div class="tbtns">${over ? '' : `<button data-act="timerAdj" data-d="-15">−15</button><button data-act="timerAdj" data-d="15">+15</button>`}
      <button data-act="timerStop">${over ? 'Done' : 'Skip'}</button></div></div>`;
}

function renderWork(t) {
  const ph = workPhase(t);
  if (!ph) return;
  timerEl.hidden = false;
  timerEl.className = ph.p.hold ? 'work' : 'prep';
  const held = workHeld(t);
  timerEl.innerHTML = `<div class="fill" style="width:${Math.min(100, ph.frac * 100)}%"></div>
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
  navEl.innerHTML = TABS.map(([k, t]) => `<button data-act="nav" data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${t}</button>`).join('');
  const views = { today: viewToday, week: viewWeek, library: viewLibrary, plans: viewPlans, more: viewSettings };
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
  if (loadProblem) {
    h += `<div class="banner bad">${esc(loadProblem.message)}${loadProblem.raw ? ' <button class="link" data-act="copyRaw">Copy the saved data</button>' : ''}
      <button class="link" data-act="startFresh">Start fresh</button></div>`;
  }
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
  // Nudge once data is a week older than the last backup (or than the first logged set).
  const firstLog = Math.min(...state.sets.filter(s => s.done).map(s => s.loggedAt));
  const since = state.settings.lastExportAt ?? firstLog;
  if (Number.isFinite(since) && Date.now() - since > 7 * 864e5) {
    h += `<div class="banner">It's been a while since your last backup. <button class="link" data-act="copyBackup">Copy backup</button></div>`;
  }
  return h;
}

function viewToday() {
  const s = currentSession(), m = currentMobility();
  if (m && !(s && ui.showWorkout)) return banners() + viewMobSession(m, !!s);
  const back = m ? `<div class="banner">Your mobility session is still open. <button class="link" data-act="showMobility">Switch to it</button></div>` : '';
  return banners() + back + (s ? viewSession(s) : viewCheckin());
}

function seg(key, items, cur) {
  return `<div class="seg">${items.map(([v, t]) =>
    `<button data-act="ci" data-k="${key}" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${t}</button>`).join('')}</div>`;
}

// Upper/lower workouts from the whole library, for when the weekly goals are done.
const focusName = (r, x) => `${r === 'upper' ? 'Upper' : 'Lower'} body${x ? ' + explosive' : ''}`;
const focusButtons = () => `<div class="focusgrid">${L.FOCUS_REGIONS.flatMap(r => [false, true].map(x =>
  `<button data-act="focus" data-r="${r}" ${x ? 'data-x="1"' : ''}>${focusName(r, x)}</button>`)).join('')}</div>`;

function viewCheckin() {
  const ci = ui.ci;
  const doneToday = state.sessions.filter(s => s.day === L.dayKey() && s.status === 'done');
  const paused = state.sessions.filter(s => s.day === L.dayKey() && s.status === 'paused');
  let h = `<header class="top"><h1>Check in</h1></header>`;
  for (const p of paused) {
    const left = state.sets.filter(x => x.sessionId === p.id && !x.done && !x.warmup).length;
    const blocksLeft = p.blocks.filter(b => blockSets(b).some(x => !x.done)).length;
    const at = new Date(p.pausedAt ?? p.checkinAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    h += `<div class="card resume"><div><b>Paused at ${at}</b><div class="meta">${left} set${left === 1 ? '' : 's'} left in ${blocksLeft} exercise${blocksLeft === 1 ? '' : 's'}</div></div>
      <button class="primary" data-act="resume" data-id="${p.id}">Resume</button></div>`;
  }
  if (doneToday.length) {
    const sets = state.sets.filter(x => x.done && !x.warmup && doneToday.some(s => s.id === x.sessionId));
    const rest = restSummary(sets);
    h += `<div class="card muted">Done today: ${doneToday.length} session${doneToday.length > 1 ? 's' : ''}, ${sets.length} sets${rest ? ` · ${rest.text}` : ''}.</div>`;
  }
  h += `<div class="field"><label>Where</label>${seg('locationId', state.locations.map(l => [l.id, esc(l.name)]), ci.locationId)}</div>
    <div class="field"><label>Time (min)</label>${seg('minutes', TIMES.map(t => [t, t]), ci.minutes)}</div>
    <div class="field"><label>Energy <span class="hint">1 wrecked · 5 fresh</span></label>${seg('energy', [1, 2, 3, 4, 5].map(n => [n, n]), 6 - ci.fatigue)}</div>
    <div class="field"><label>Sleep <span class="hint">optional · 1 poor · 5 great · tap again to clear</span></label>${seg('sleep', [1, 2, 3, 4, 5].map(n => [n, n]), ci.sleep)}</div>
    <div class="field"><label>Intent</label>${seg('intent', INTENTS, ci.intent)}</div>
    <label class="toggle"><input type="checkbox" data-ci-split ${ci.split ? 'checked' : ''}> I may split this across the day</label>
    <button class="primary big" data-act="suggest">Suggest a session</button>
    <div class="field"><label>Or a focused workout <span class="hint">from your whole library, not just open goals</span></label>${focusButtons()}</div>`;
  const lastRoutine = id => { const t = Math.max(0, ...state.mobility.sessions.filter(x => x.routineId === id && x.status === 'done').map(x => x.startedAt)); return t ? ` · last ${fmtAgo(t)}` : ''; };
  h += `<div class="field"><label>Mobility <span class="hint">its own session, outside your weekly goals</span></label><div class="list">${state.mobility.routines.map(r =>
    `<button class="row" data-act="mobStart" data-id="${r.id}"><span>${esc(r.name)}</span><span class="meta">${r.items.length} exercises${lastRoutine(r.id)}</span></button>`).join('')}
    <button class="row add" data-act="mobPick" data-mode="new">Pick body parts ›</button></div></div>`;
  if (state.plans.length) {
    h += `<div class="field"><label>Or start a saved plan</label><div class="list">${state.plans.map(p =>
      `<button class="row" data-act="startPlan" data-id="${p.id}"><span>${esc(p.name)}</span><span class="meta">${p.items.length} items</span></button>`).join('')}</div></div>`;
  }
  return h;
}

function viewSession(s) {
  const loc = L.byId(state.locations, s.locationId);
  const credit = L.creditWeek(state);
  const est = s.minutes - sessionBudget(s);
  const intent = INTENTS.find(i => i[0] === s.intent)?.[1] ?? s.intent;
  const rest = restSummary(state.sets.filter(x => x.sessionId === s.id));
  let h = `<header class="top"><div><h1>Today</h1>
    <div class="sub">${esc(loc?.name)} · ${s.minutes} min · ${esc(intent)} · est ${est} min</div>${s.ready ? `<div class="sub ready ${s.ready.fresh && !s.ready.heavy.length ? 'good' : ''}">${esc(readyText(s.ready))}</div>` : ''}
    ${rest ? `<div class="sub">${esc(rest.text)}</div>` : ''}</div>
    <div class="hbtns"><span class="badge ${s.source}">${esc(s.source === 'focus' ? focusName(s.focusRegion, s.focusExplosive) : s.source)}</span><button class="small" data-act="moreTime">+ Time</button></div></header>`;
  if (!s.blocks.length) {
    h += `<div class="card muted">Nothing from your weekly goals fits this location and time. Add an exercise below, use a plan, or check in with more time.</div>`;
  }
  // Goals nearly done: the suggestion fills little of the time. Offer a full workout instead.
  if (s.source === 'suggested' && sessionBudget(s) >= Math.max(15, s.minutes * 0.4) && !state.sets.some(x => x.sessionId === s.id && x.done)) {
    h += `<div class="card focusoffer"><b>${s.blocks.length ? `Your open goals only fill about ${s.minutes - sessionBudget(s)} of your ${s.minutes} minutes.` : 'Nothing left from your goals here.'}</b>
      <p class="meta">Want a full workout instead? It uses your whole library and still counts toward any goal it matches.</p>${focusButtons()}</div>`;
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
  h += `<div class="addrow"><button class="addblock" data-act="addEx">+ Add exercise</button><button class="addblock" data-act="mobPick" data-mode="workout">+ Mobility</button></div>`;
  if (s.focusNotes?.length) {
    h += `<details class="why" ${ui.whyOpen ? 'open' : ''} data-why><summary>How this was built</summary><ul>${s.focusNotes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>`;
  }
  if (s.why?.length) {
    h += `<details class="why" ${ui.whyOpen ? 'open' : ''} data-why><summary>Why this session</summary><ul>${s.why.map(w =>
      `<li class="${w.picked ? 'picked' : ''}"><b>${esc(w.label)}</b> ${w.score.toFixed(2)}${w.picked ? ' ✓' : ''} <span class="meta">${esc(w.why.join(' · '))}${w.note ? ' · ' + esc(w.note) : ''}</span></li>`).join('')}</ul></details>`;
  }
  h += `<div class="actions">
    <button data-act="usePlan">Use a plan instead</button>
    <button data-act="recheck">New check-in</button>
    <button data-act="pause">Pause for later</button>
    <button class="primary" data-act="finish">Finish</button></div>`;
  return h;
}

// One superset idea per main block that has sets left and no partner yet, each from a different family.
function pairIdeas(s, ordered, credit) {
  const out = new Map();
  const used = s.blocks.map(b => exOf(b.exerciseId)?.familyId);
  for (const b of ordered) {
    if (!['T1', 'T2', 'TECH'].includes(b.tier) || b.noPair || inPair(s, b) || !blockSets(b).some(x => !x.done)) continue;
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

  let info = [];
  if (ex.metric === 'load_reps' && pct) info.push(`${round(pct * 100)}% of e1RM`);
  if (max) info.push(`e1RM ${round(max)}${ex.bodyweight ? ' total' : ''}`);
  else if (ex.metric === 'load_reps' && b.tier !== 'T3') info.push('no max yet: enter a load');
  const restBtn = `<button class="restchip" data-act="restEdit" data-b="${b.id}">⏱ rest ${clock(effectiveRest(b))}${b.restSec != null ? ' (set today)' : ex.restSec != null ? ' (exercise)' : ''}</button>`;

  let dose = '';
  const slot = b.slotId && L.byId(state.slots, b.slotId);
  if (slot) {
    const r = credit.slots.get(slot.id);
    const agg = r?.days.get(L.dayKey()) || { reps: 0, sets: 0 };
    const need = L.slotDose(state, slot, b.tier).repMin;
    const prog = b.tier === 'T3' ? `${agg.reps}/${need} reps or ${agg.sets}/${cfg.setMin} sets` : `${agg.reps}/${need} ${b.tier === 'TECH' ? 'technique reps' : 'qualifying reps'}`;
    dose = `<div class="dose ${r?.todayMet ? 'met' : ''}">${r?.todayMet ? '✓ Filled' : 'Toward'} ${esc(slotLabel(slot))}: ${prog}</div>`;
  }
  if ((b.tier === 'T1' || b.tier === 'T2') && ex.metric !== 'load_reps' && !ex.explosive) {
    dose += `<div class="dose warn">Reps-only, so it won't count toward a ${b.tier} goal on its own. Tag the sets in Week if you want it to.</div>`;
  } else if (!slot) {
    dose += `<div class="dose">Not part of a weekly goal. It still builds history.</div>`;
  }

  const rest = restSummary(sets);
  if (rest) info.push(rest.text);

  if (ex.explosive && (b.tier === 'T1' || b.tier === 'T2')) {
    const rd = L.powerReadiness(state, s, ex, Date.now(), b.id);
    if (!rd.fresh) dose += `<div class="dose warn">Not fresh for power work: ${esc(rd.reasons.join('; '))}. <button class="link" data-act="toTech" data-b="${b.id}">Do it as technique</button></div>`;
  }

  const warmRows = warmSets(b).map((st, i) => {
    const hint = warmHint(b, ex, i);
    return `<div class="set warm ${st.done ? 'done' : ''}"><span class="n" title="Warm-up">W</span>
      <input class="num" inputmode="decimal" data-set="${st.id}" data-f="load" value="${esc(st.load)}" placeholder="${esc(hint.load ?? '—')}"><span class="u">${ex.bodyweight ? '+' : ''}${unit()}</span>
      <span class="x">×</span><input class="num" inputmode="numeric" data-set="${st.id}" data-f="reps" value="${esc(st.reps)}" placeholder="${hint.reps}">
      <button class="check" data-act="check" data-id="${st.id}" aria-label="Log warm-up set">${st.done ? '✓' : ''}</button></div>`;
  }).join('');

  const rows = sets.map((st, i) => {
    const sx = exOf(st.exerciseId) || ex;
    const other = st.exerciseId !== ex.id ? `<span class="meta">${esc(sx.name)}</span>` : '';
    let inputs = '';
    if (sx.metric === 'load_reps') {
      inputs = `<input class="num" inputmode="decimal" data-set="${st.id}" data-f="load" value="${esc(st.load)}" placeholder="—"><span class="u">${sx.bodyweight ? '+' : ''}${unit()}</span>
        <span class="x">×</span><input class="num" inputmode="numeric" data-set="${st.id}" data-f="reps" value="${esc(st.reps)}">`;
    } else if (sx.metric === 'reps') {
      inputs = `<input class="num" inputmode="numeric" data-set="${st.id}" data-f="reps" value="${esc(st.reps)}"><span class="u">reps</span>`;
    } else if (sx.metric === 'time') {
      inputs = `<input class="num" inputmode="numeric" data-set="${st.id}" data-f="time" value="${esc(st.time)}"><span class="u">sec</span>${st.done ? '' : goBtn(`data-act="workStart" data-id="${st.id}"`, state.timer?.target?.set === st.id)}`;
    } else if (sx.metric === 'distance') {
      inputs = `<input class="num" inputmode="decimal" data-set="${st.id}" data-f="distance" value="${esc(st.distance)}"><span class="u">m</span>`;
    }
    return `<div class="set ${st.done ? 'done' : ''}"><span class="n">${i + 1}</span>${inputs}${other}
      <button class="check" data-act="check" data-id="${st.id}" aria-label="Log set">${st.done ? '✓' : ''}</button></div>`;
  }).join('');

  const vid = videoUrl(ex);
  const group = groupOf(s, b);
  const main = b.pairOf && group[0] !== b ? group[0] : null;
  const others = group.filter(x => x !== b).map(x => esc(exOf(x.exerciseId)?.name)).join(' and ');
  const what = main?.tier !== 'T3' ? `Superset with ${others}: do a set in its rest`
    : group.length > 2 ? `Giant set with ${others}: one set of each, then rest` : `Superset with ${others}: alternate sets, rest after each round`;
  const pairHead = main ? `<div class="sslabel">↔ ${what}
    <button class="link" data-act="pairUnlink" data-b="${b.id}">Unlink</button></div>` : '';
  const ideaRow = idea ? `<div class="pairidea"><span>Superset idea: <b>${esc(idea.exercise.name)}</b> <span class="meta">T3 · ${esc(idea.why)}</span></span>
    <span class="brow"><button class="small" data-act="pairAdd" data-b="${b.id}" data-ex="${idea.exercise.id}">+ Add</button>
    <button class="small quiet" data-act="pairOpen" data-b="${b.id}">Other</button>
    <button class="small quiet" data-act="pairNo" data-b="${b.id}">No thanks</button></span></div>` : '';
  return `<section class="block ${main ? 'paired' : ''} ${s.blocks.some(x => x.pairOf === b.id) ? 'haspair' : ''}">
    ${pairHead}
    <div class="bhead"><button class="tier ${b.tier}" data-act="tierEdit" data-b="${b.id}" aria-label="Change tier">${b.tier} ▾</button>
      <button class="chip" data-act="swapEx" data-b="${b.id}">${esc(ex.name)} ▾</button>
      <button class="chip" data-act="swapScheme" data-b="${b.id}">${esc(sc.name)} · ${sc.minutes}m ▾</button></div>
    <div class="meta">${info.join(' · ')} ${restBtn}</div>
    ${dose}
    <div class="sets">${warmRows}${rows}</div>
    <div class="brow">
      ${canWarm(b, ex) ? `<button class="small" data-act="addWarm" data-b="${b.id}">+ warm-up</button>` : ''}
      <button class="small" data-act="addSet" data-b="${b.id}">+ set</button>
      <button class="small" data-act="removeSet" data-b="${b.id}">− set</button>
      <button class="small" data-act="timerStart" data-b="${b.id}">⏱ Rest</button>
      ${inPair(s, b) ? '' : `<button class="small" data-act="pairOpen" data-b="${b.id}">↔ Superset</button>`}
      ${vid ? `<a class="small" href="${esc(vid)}" target="_blank" rel="noopener">▶ Video</a>` : ''}
      <button class="small quiet" data-act="removeBlock" data-b="${b.id}">Remove</button>
    </div>
    ${ideaRow}
    ${ex.cues ? `<details class="cues"><summary>Cues</summary><p>${esc(ex.cues)}</p></details>` : ''}
  </section>`;
}

function viewMobItem(item) {
  const ex = mobEx(item.exerciseId);
  if (!ex) return '';
  const t = ex.track, last = M.lastFor(state, ex.id, item.id);
  const input = (st, f, mode, ph = '—') => `<input class="num${f === 'extra' ? ' wide' : ''}" inputmode="${mode}" data-mset="${item.id}|${st.id}" data-f="${f}" value="${esc(st[f])}" placeholder="${esc(ph)}">`;
  const rows = item.sets.map((st, i) => {
    let h = '';
    if (t.load) h += `${input(st, 'load', 'decimal')}<span class="u">${unit()}</span>`;
    if (t.reps) h += `${input(st, 'reps', 'numeric')}<span class="u">reps</span>`;
    // A timer only for moves dosed as a hold (couch stretch), not reps with a pause at the top (cobra).
    if (t.hold) h += `${input(st, 'hold', 'numeric')}<span class="u">s</span>${st.done || !ex.hold ? '' : goBtn(`data-act="mworkStart" data-i="${item.id}" data-s="${st.id}"`, state.timer?.target?.mset === st.id)}`;
    if (t.extra) h += input(st, 'extra', 'text', t.extra);
    return `<div class="set ${st.done ? 'done' : ''}"><span class="n">${i + 1}</span>${h}
      <button class="check" data-act="mcheck" data-i="${item.id}" data-s="${st.id}" aria-label="Log set">${st.done ? '✓' : ''}</button></div>`;
  }).join('');
  const vid = M.videoSearch(ex.video);
  const day = x => new Date(x).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<section class="block mob">
    <div class="bhead"><span class="tier MOB">MOB</span><span class="mobname">${esc(ex.name)}</span></div>
    <div class="meta">${esc(M.doseText(ex))} · rest ${clock(ex.restSec || 0)} · ${esc(ex.parts.join(', '))}</div>
    ${last ? `<div class="dose">Last time (${day(last.at)}): ${esc(M.itemText(ex, last.item, unit()))}${last.item.note ? ` · “${esc(last.item.note)}”` : ''}</div>` : ''}
    <div class="sets">${rows}</div>
    <input class="mobnote" data-mnote="${item.id}" value="${esc(item.note)}" placeholder="Notes for today: depth, pain, how it felt">
    <div class="brow">
      <button class="small" data-act="mAddSet" data-i="${item.id}">+ set</button>
      <button class="small" data-act="mRemoveSet" data-i="${item.id}">− set</button>
      ${vid ? `<a class="small" href="${esc(vid)}" target="_blank" rel="noopener">▶ Video</a>` : ''}
      <button class="small quiet" data-act="mRemove" data-i="${item.id}">Remove</button>
    </div>
    ${ex.cues || ex.notes ? `<details class="cues"><summary>Cues${ex.notes ? ' and history' : ''}</summary>${ex.cues ? `<p>${esc(ex.cues)}</p>` : ''}${ex.notes ? `<p class="meta">${esc(ex.notes)}</p>` : ''}</details>` : ''}
  </section>`;
}

function viewMobSession(m, workoutOpen) {
  const total = m.items.reduce((n, it) => n + it.sets.length, 0);
  const done = m.items.reduce((n, it) => n + it.sets.filter(s => s.done).length, 0);
  const title = L.byId(state.mobility.routines, m.routineId)?.name ?? (m.parts?.length ? m.parts.join(', ') : 'Your picks');
  let h = `<header class="top"><div><h1>Mobility</h1><div class="sub">${esc(title)} · ${done}/${total} sets</div></div><span class="badge mobility">mobility</span></header>`;
  if (workoutOpen) h += `<div class="banner">Your workout is still open. <button class="link" data-act="showWorkout">Switch to it</button></div>`;
  h += m.items.map(viewMobItem).join('') || '<div class="card muted">Nothing here yet. Add some mobility work below.</div>';
  return h + `<button class="addblock" data-act="mobPick" data-mode="session">+ Add mobility</button>
    <div class="actions"><button data-act="mobDiscard">Discard</button><button class="primary" data-act="mobFinish">Finish</button></div>`;
}

const libModeSeg = () => `<div class="seg libmode"><button class="${ui.libMode !== 'mobility' ? 'on' : ''}" data-act="libMode" data-v="strength">Strength</button>
  <button class="${ui.libMode === 'mobility' ? 'on' : ''}" data-act="libMode" data-v="mobility">Mobility</button></div>`;

function viewMobLibrary() {
  const q = ui.libQuery.trim().toLowerCase(), pf = ui.mobPart;
  const last = M.lastDoneAt(state);
  const list = state.mobility.exercises.filter(e => (ui.showArchived || !e.archived) && (!q || e.name.toLowerCase().includes(q)) && (!pf || e.parts.includes(pf)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return `<header class="top"><h1>Library</h1><button class="primary" data-act="mobExNew">+ Mobility</button></header>${libModeSeg()}
    <input class="search" id="libq" placeholder="Search mobility" value="${esc(ui.libQuery)}" data-libq>
    <div class="chips">${M.BODY_PARTS.map(p => `<button class="chip ${pf === p ? 'on' : ''}" data-act="mobPartFilter" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <div class="card">${list.map(e => `<div class="exrow"><button class="name" data-act="mobExEdit" data-id="${e.id}">${esc(e.name)}<span class="meta">${esc([M.doseText(e), e.parts.join(', '),
      last.has(e.id) ? `last ${fmtAgo(last.get(e.id))}` : 'not logged yet', e.archived ? 'archived' : ''].filter(Boolean).join(' · '))}</span></button></div>`).join('') || '<p class="muted">No matches.</p>'}</div>`;
}

function viewMobRoutine(r) {
  return `<header class="top"><h1>${r.id ? 'Edit routine' : 'New mobility routine'}</h1></header>
    <div class="field"><label>Name</label><input id="mr-name" data-mrname value="${esc(r.name)}" placeholder="e.g. Hips before volleyball"></div>
    <div class="card">${r.items.map((id, i) => {
      const e = mobEx(id);
      return `<div class="exrow"><span class="name">${esc(e?.name ?? '?')}<span class="meta">${e ? esc(`${M.doseText(e)} · ${e.parts.join(', ')}`) : ''}</span></span>
        <button class="icon" data-act="mobRoutineMove" data-i="${i}" data-dir="-1" aria-label="Move up">↑</button>
        <button class="icon" data-act="mobRoutineMove" data-i="${i}" data-dir="1" aria-label="Move down">↓</button>
        <button class="icon" data-act="mobRoutineDel" data-i="${i}" aria-label="Remove">✕</button></div>`;
    }).join('') || '<p class="muted">No exercises yet.</p>'}</div>
    <button data-act="mobPick" data-mode="routine">+ Add exercises</button>
    <div class="actions">${r.id ? '<button class="danger" data-act="mobRoutineDelete">Delete</button>' : ''}
      <button data-act="mobRoutineCancel">Cancel</button><button class="primary" data-act="mobRoutineSave">Save routine</button></div>`;
}

function viewWeek() {
  if (ui.history) return viewHistory(ui.history);
  if (ui.goalSuggest) return viewGoalSuggest(ui.goalSuggest);
  const c = L.creditWeek(state);
  const fmt = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dayName = k => new Date(k + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' });
  let h = `<header class="top"><div><h1>This week</h1><div class="sub">${fmt(c.start)} – ${fmt(c.end - 864e5)} · ${L.daysLeftInWeek(state)} day(s) left</div></div>
    <button class="small" data-act="histOpen">History</button></header>`;
  if (ui.goalsUndo) h += `<div class="banner">Goals updated. <button class="link" data-act="gsUndo">Undo</button></div>`;

  const slots = [...c.slots.values()].sort((a, b) => a.slot.tier.localeCompare(b.slot.tier) || (b.slot.priority - a.slot.priority));
  h += `<div class="sectionhead"><h3>Weekly goals</h3><div class="brow"><button class="small" data-act="gsOpen">Suggest from history</button><button class="small" data-act="goalNew">+ Add goal</button></div></div>
    <div class="card flush">${slots.map(r => {
    const pips = Array.from({ length: r.slot.quota }, (_, i) => `<span class="pip ${i < r.filled ? 'on' : ''}"></span>`).join('');
    const days = [...r.days].map(([k, a]) => `${dayName(k)} ${a.reps ? a.reps + ' reps' : a.sets + ' sets'}${a.met ? ' ✓' : ' (partial)'}`).join(' · ');
    const ex = exOf(r.slot.exerciseId);
    const name = ex?.name ?? famOf(r.slot.familyId)?.name;
    const sub = [ex ? famOf(r.slot.familyId)?.name : 'any exercise in family', days].filter(Boolean).join(' · ');
    return `<button class="slotrow" data-act="goalEdit" data-id="${r.slot.id}"><span class="tier ${r.slot.tier}">${r.slot.tier}</span>
      <span class="grow"><span class="name">${esc(name)}</span><span class="meta">${esc(sub)}</span></span>
      <span class="pips">${pips}</span></button>`;
  }).join('') || '<p class="muted pad">No weekly goals yet. Add one to get suggestions.</p>'}</div>`;

  const wk = L.sessionStats(state, c.start, c.end), all = L.sessionStats(state);
  const secs = v => v == null ? '—' : `${round(v)}s`;
  const acc = st => st.count ? `${round(100 * st.bySource.suggested / st.count)}% as suggested · ${st.bySource.swapped} swapped · ${st.bySource.custom} custom` : '—';
  h += `<div class="card"><h3>Loop health</h3>
    <div class="kv"><span>Check-in → first set (median)</span><b>${secs(wk.medianToFirstSet)} week · ${secs(all.medianToFirstSet)} all</b></div>
    <div class="kv"><span>Sessions this week</span><b>${wk.count}</b></div>
    <div class="kv"><span>Acceptance (week)</span><b>${acc(wk)}</b></div></div>`;

  const sets = state.sets.filter(s => s.done && !s.warmup && s.loggedAt >= c.start && s.loggedAt < c.end).sort((a, b) => a.loggedAt - b.loggedAt);
  if (sets.length) {
    const byDay = new Map();
    for (const s of sets) { const k = L.dayKey(s.loggedAt); byDay.set(k, [...(byDay.get(k) || []), s]); }
    h += `<h3>Sets and what they count toward</h3>`;
    for (const [k, list] of byDay) {
      h += `<div class="card"><div class="dayhead">${dayName(k)}</div>${list.map(s => {
        const ex = exOf(s.exerciseId);
        const auto = L.autoSlotFor(state, s);
        const autoLbl = auto ? slotLabel(L.byId(state.slots, auto)) : 'none';
        const val = s.countsManual ? (s.countsToward ?? 'none') : 'auto';
        const amount = setAmount(ex, s);
        return `<div class="setlog"><div class="grow"><span class="tier ${s.tier}">${s.tier}</span> ${esc(ex?.name ?? '?')} <span class="meta">${esc(amount)}</span></div>
          <select data-counts="${s.id}">${opts([['auto', `Auto: ${autoLbl}`], ...state.slots.map(sl => [sl.id, slotLabel(sl)]), ['none', 'Counts toward nothing']], val)}</select></div>`;
      }).join('')}</div>`;
    }
  } else {
    h += `<p class="muted">No sets logged this week yet.</p>`;
  }
  const mw = M.weekSummary(state, c.start, c.end);
  h += `<div class="sectionhead"><h3>Mobility this week</h3></div><div class="card">${mw.sessions
    ? `<p>${mw.sessions} session${mw.sessions === 1 ? '' : 's'} on ${mw.days} day${mw.days === 1 ? '' : 's'}. Highlighted: body parts you've worked.</p>
      <div class="chips">${M.BODY_PARTS.map(p => `<span class="chip ${mw.parts.includes(p) ? 'on' : ''}">${esc(p)}</span>`).join('')}</div>`
    : '<p class="muted">None yet. Start one from Today, or add mobility to a workout.</p>'}</div>`;
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
  const mobLines = items => (items || []).filter(it => it.sets.some(x => x.done) && match(mobEx(it.exerciseId)?.name));
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

function viewHistory(hs) {
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
        bits.push(L.byId(state.locations, s.locationId)?.name);
        const mins = Math.round((e.end - e.at) / 60e3);
        if (mins > 0) bits.push(`${mins} min`);
      }
      if (e.sets) bits.push(`${e.sets} set${e.sets === 1 ? '' : 's'}`);
      if (s.status === 'open' || s.status === 'paused') bits.push(s.status === 'open' ? 'in progress' : 'paused');
    } else {
      bits.push(L.byId(state.mobility.routines, m.routineId)?.name ?? (m.parts?.length ? m.parts.join(', ') : 'Mobility'));
      if (m.status === 'open') bits.push('in progress');
    }
    const lines = e.groups.map(g => `<div class="histex"><span class="tier ${g.tier}">${g.tier}</span><span class="grow"><span class="name">${esc(g.ex?.name ?? '?')}</span>
      <span class="meta">${esc(histSets(g))}</span></span></div>`).join('')
      + e.mob.map(it => {
        const ex = mobEx(it.exerciseId);
        return `<div class="histex"><span class="tier MOB">MOB</span><span class="grow"><span class="name">${esc(ex?.name ?? '?')}</span>
          <span class="meta">${esc(ex ? M.itemText(ex, it, unit()) : '')}${it.note ? ` · “${esc(it.note)}”` : ''}</span></span></div>`;
      }).join('');
    return `<div class="card hist"><div class="histhead"><b>${esc(dateText(e.at))}</b><span class="meta">${esc(bits.filter(Boolean).join(' · '))}</span></div>${lines}</div>`;
  };
  return `<header class="top sub"><button class="back" data-act="histClose">‹ This week</button></header><h1 class="pagetitle">History</h1>
    <input class="search" id="histq" placeholder="Search an exercise" value="${esc(hs.q)}" data-histq>
    ${q ? `<p class="meta pad">${all.length} session${all.length === 1 ? '' : 's'} with “${esc(hs.q.trim())}”.</p>` : ''}
    ${shown.map(card).join('') || `<p class="muted">${q ? 'No sessions match.' : 'Nothing logged yet. Finished workouts and mobility sessions show up here.'}</p>`}
    ${all.length > shown.length ? `<button class="addblock" data-act="histMore">Show ${Math.min(HISTORY_PAGE, all.length - shown.length)} more (${all.length - shown.length} older)</button>` : ''}`;
}

function viewLibrary() {
  if (ui.libMode === 'mobility') return viewMobLibrary();
  const q = ui.libQuery.trim().toLowerCase();
  const archivedCount = state.exercises.filter(e => e.archived).length;
  let h = `<header class="top"><h1>Library</h1><button class="primary" data-act="quickAdd">+ Exercise</button></header>${libModeSeg()}
    <input class="search" id="libq" placeholder="Search exercises or families" value="${esc(ui.libQuery)}" data-libq>
    ${archivedCount ? `<button class="small quiet libarch" data-act="libArchived">${ui.showArchived ? 'Hide' : 'Show'} archived (${archivedCount})</button>` : ''}`;
  const fams = [...state.families].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of fams) {
    const famMatch = f.name.toLowerCase().includes(q);
    const all = L.familyMembers(state, f.id);
    const members = all.filter(e => (ui.showArchived || !e.archived) && (!q || famMatch || e.name.toLowerCase().includes(q)));
    if (!members.length && (q || all.length)) continue; // nothing to show; truly empty families stay so you can add to them
    h += `<div class="card"><h3>${esc(f.name)} <span class="hint">harder ↑ easier ↓</span></h3>${members.map(e => {
      const max = e.metric === 'load_reps' ? L.estimatedMax(state, e.id) : null;
      const meta = [METRICS.find(m => m[0] === e.metric)?.[1], e.equipment.join(', ') || 'no equipment', e.explosive ? 'explosive' : '', e.region === 'lower' || e.region === 'upper' ? `${e.region} body` : '', e.anytime ? 'any time' : '', e.archived ? 'archived' : '', max ? `e1RM ${round(max)}` : ''].filter(Boolean).join(' · ');
      return `<div class="exrow"><button class="name" data-act="libEdit" data-id="${e.id}">${f.defaultExerciseId === e.id ? '★ ' : ''}${esc(e.name)}<span class="meta">${esc(meta)}</span></button>
        <button class="icon" data-act="libMove" data-id="${e.id}" data-dir="-1" aria-label="Move up">↑</button>
        <button class="icon" data-act="libMove" data-id="${e.id}" data-dir="1" aria-label="Move down">↓</button></div>`;
    }).join('') || '<p class="muted">Empty family.</p>'}
    <button class="small" data-act="quickAdd" data-fam="${f.id}">+ Add to ${esc(f.name)}</button></div>`;
  }
  return h;
}

function exerciseOptions(sel) {
  return [...state.families].sort((a, b) => a.name.localeCompare(b.name)).map(f =>
    `<optgroup label="${esc(f.name)}">${L.familyMembers(state, f.id).filter(e => !e.archived || e.id === sel).map(e =>
      `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</optgroup>`).join('');
}

function viewPlans() {
  if (ui.mobRoutine) return viewMobRoutine(ui.mobRoutine);
  const p = ui.plan;
  if (p) {
    return `<header class="top"><h1>${p.id ? 'Edit plan' : 'New plan'}</h1></header>
      <div class="field"><label>Name</label><input data-pbind="name" value="${esc(p.name)}" placeholder="e.g. Office pump 20"></div>
      ${p.items.map((it, i) => `<div class="card planitem">
        <select data-pbind="items.${i}.exerciseId">${exerciseOptions(it.exerciseId)}</select>
        <div class="row2">
          <select data-pbind="items.${i}.tier">${opts(L.TIERS.map(t => [t, t]), it.tier)}</select>
          <select data-pbind="items.${i}.schemeId">${opts(L.schemeOptions(state, it.tier).map(s => [s.id, `${s.name} · ${s.minutes}m`]), it.schemeId)}</select>
          <button class="icon" data-act="planDelItem" data-i="${i}" aria-label="Remove">✕</button></div></div>`).join('')}
      <button data-act="planAddItem">+ Add exercise</button>
      <div class="actions">${p.id ? '<button class="danger" data-act="planDelete">Delete</button>' : ''}
        <button data-act="planCancel">Cancel</button><button class="primary" data-act="planSave">Save plan</button></div>`;
  }
  let h = `<header class="top"><h1>Plans</h1><button class="primary" data-act="planNew">+ New plan</button></header>`;
  if (!state.plans.length) h += `<p class="muted">Hand-built sessions you can pick instead of the suggestion. Choosing one is logged as an override.</p>`;
  h += state.plans.map(p => `<button class="card row" data-act="planEdit" data-id="${p.id}"><span><b>${esc(p.name)}</b>
    <span class="meta">${esc(p.items.map(it => `${it.tier} ${exOf(it.exerciseId)?.name ?? '?'} ${schOf(it.schemeId)?.name ?? ''}`).join(' · '))}</span></span><span>›</span></button>`).join('');
  h += `<div class="sectionhead"><h3>Mobility routines</h3><button class="small" data-act="mobRoutineNew">+ New routine</button></div>`;
  h += state.mobility.routines.map(r => `<button class="card row" data-act="mobRoutineEdit" data-id="${r.id}"><span><b>${esc(r.name)}</b>
    <span class="meta">${esc(r.items.map(id => mobEx(id)?.name ?? '?').join(' · '))}</span></span><span>›</span></button>`).join('')
    || '<p class="muted">No mobility routines yet.</p>';
  return h;
}

const SETTINGS_PAGES = [
  ['you', 'You and training'],
  ['timer', 'Rest timer'],
  ['locations', 'Locations and equipment'],
  ['tiers', 'Tier doses'],
  ['schemes', 'Schemes'],
  ['data', 'Backup and data'],
  ['fitnotes', 'Import from FitNotes'],
];

function viewSettings() {
  const page = ui.setPage;
  if (!page) return viewSettingsMenu();
  const title = SETTINGS_PAGES.find(p => p[0] === page)[1];
  const body = { you: settingsYou, timer: settingsTimer, locations: settingsLocations, tiers: settingsTiers, schemes: settingsSchemes, data: settingsData, fitnotes: settingsFitnotes }[page]();
  return `<header class="top sub"><button class="back" data-act="setPage" data-p="">‹ Settings</button></header><h1 class="pagetitle">${title}</h1>${body}`;
}

function viewSettingsMenu() {
  const st = state.settings, tc = st.timer;
  const t1 = state.tiers.T1;
  const summary = {
    you: `${st.bodyweight ? `${st.bodyweight} ${unit()}` : 'Bodyweight not set'} · week starts ${WEEKDAYS[st.weekStartDay]}`,
    timer: [tc.autoStart ? 'Starts automatically' : 'Manual start', tc.sound ? 'beeps' : 'silent', tc.keepAwake ? 'screen stays on' : ''].filter(Boolean).join(' · '),
    locations: state.locations.map(l => l.name).join(', '),
    tiers: `T1 ${t1.repMin}–${t1.repMax} reps at ${round(t1.intMin * 100)}%+ · T2 · T3`,
    schemes: `${state.schemes.length} schemes`,
    data: `Last backup: ${st.lastExportAt ? new Date(st.lastExportAt).toLocaleDateString() : 'never'}`,
  };
  return `<header class="top"><h1>Settings</h1></header>
    <div class="menu">
      ${SETTINGS_PAGES.slice(0, 3).map(([k, t]) => menuRow(k, t, summary[k])).join('')}
      <button class="menurow" data-act="goWeek"><span class="grow"><span class="name">Weekly goals</span>
        <span class="meta">${state.slots.length} goals · edit on the Week tab</span></span><span class="chev">›</span></button>
    </div>
    <div class="label">Programming</div>
    <div class="menu">${SETTINGS_PAGES.slice(3, 5).map(([k, t]) => menuRow(k, t, summary[k])).join('')}</div>
    <div class="menu">${menuRow('data', 'Backup and data', summary.data)}</div>`;
}

const menuRow = (k, t, sub) => `<button class="menurow" data-act="setPage" data-p="${k}"><span class="grow"><span class="name">${esc(t)}</span>
  <span class="meta">${esc(sub)}</span></span><span class="chev">›</span></button>`;

// One labelled setting per row: label (and hint) on the left, control on the right.
const frow = (label, control, hint = '') => `<label class="frow"><span class="grow"><span class="name">${label}</span>${hint ? `<span class="meta">${hint}</span>` : ''}</span>${control}</label>`;
const numIn = (path, val, extra = '') => `<input class="num" inputmode="decimal" data-bind="${path}" data-type="num" value="${esc(val)}" ${extra}>`;
const pctIn = (path, val) => `<input class="num" inputmode="numeric" data-bind="${path}" data-type="pct" value="${val == null ? '' : round(val * 100)}">`;
const switchIn = (path, on) => `<input type="checkbox" class="switch" data-bind="${path}" data-type="bool" ${on ? 'checked' : ''}>`;

function settingsYou() {
  const st = state.settings;
  return `<div class="menu">
      ${frow(`Bodyweight (${unit()})`, numIn('settings.bodyweight', st.bodyweight), 'Used for weighted pull-ups and dips')}
      ${frow('Units', `<select data-bind="settings.unit" data-rerender>${opts([['lb', 'lb'], ['kg', 'kg']], st.unit)}</select>`)}
      ${frow('Round loads to', numIn('settings.increment', st.increment), `Smallest jump you can load, in ${unit()}`)}
      ${frow(`Kettlebells (${unit()})`, `<input class="list" inputmode="decimal" data-kb value="${esc((st.kettlebells || []).join(', '))}" placeholder="30, 40, 53">`, 'Kettlebell loads use these')}
      ${frow('Week starts on', `<select data-bind="settings.weekStartDay" data-type="num">${opts(WEEKDAYS.map((d, i) => [i, d]), st.weekStartDay)}</select>`, 'Weekly goals reset on this day')}
    </div>
    <div class="label">Suggestions</div>
    <div class="menu">${frow('Go easier on T1 the day after T1', switchIn('settings.recovery.t1AfterT1', st.recovery?.t1AfterT1))}</div>`;
}

function settingsTimer() {
  const tc = state.settings.timer;
  const sw = (key, label, hint) => frow(label, switchIn(`settings.timer.${key}`, tc[key]), hint);
  return `<p class="meta pad">Each scheme sets the rest. An exercise can override it, and you can change it for today by tapping ⏱ on a block.
      Timed sets and mobility holds have ▶ to run a hold timer: it counts you in, times the hold (each side in turn when it's per side) and logs the set.</p>
    <div class="menu">
      ${sw('autoStart', 'Start when I log a set')}
      ${sw('sound', 'Beep when rest is over')}
      ${sw('warn10', 'Beep at 10 seconds left')}
      ${sw('vibrate', 'Vibrate when rest is over', 'Android only')}
      ${sw('keepAwake', 'Keep the screen on', 'During a session')}
      ${sw('notify', 'Notify in the background', 'Works best on Android with the app installed')}
      ${frow('Get-ready countdown (s)', numIn('settings.timer.prep', tc.prep ?? 5), 'Before a hold timer starts, and between sides')}
    </div>
    <div class="actions"><button data-act="timerTest">Test sound</button>
      ${tc.notify ? '<button data-act="notifyTest">Test notification</button>' : ''}</div>`;
}

function settingsLocations() {
  return state.locations.map((l, i) => `<div class="card">
      <input class="titleinput" data-bind="locations.${i}.name" value="${esc(l.name)}" aria-label="Location name">
      <div class="meta">Tap the equipment available here.</div>
      <div class="chips">${state.equipment.map(eq => `<label class="chip ${l.equipment.includes(eq) ? 'on' : ''}"><input type="checkbox" data-loceq="${l.id}|${esc(eq)}" ${l.equipment.includes(eq) ? 'checked' : ''}>${esc(eq)}</label>`).join('')}
        <input class="chipinput" data-eqnew="loc:${l.id}" placeholder="+ New" aria-label="Add equipment" enterkeyhint="done"></div>
    </div>`).join('') + `<button class="addblock" data-act="locAdd">+ Add location</button>`;
}

function settingsTiers() {
  const desc = {
    T1: 'Heavy sets of 1–3 on main lifts (GZCL: 85–100%, 10–15 reps)',
    T2: 'Sets of 5–8 on supporting lifts (GZCL: 65–85%, 20–30 reps)',
    T3: 'Accessory work, 10+ reps a set (GZCL: 30+ reps total)',
    TECH: 'Technique: quality explosive reps when tired or after a heavy day',
  };
  return `<p class="meta pad">A session fills a goal when its counted sets reach the minimum reps for that tier. For T1 and T2, only sets at or above the minimum intensity count.</p>` +
    L.TIERS.map(t => {
      const c = state.tiers[t];
      return `<div class="label"><span class="tier ${t}">${t}</span> ${desc[t]}</div><div class="menu">
        ${frow('Minimum reps', numIn(`tiers.${t}.repMin`, c.repMin), 'Working reps needed to count')}
        ${frow('Maximum reps', numIn(`tiers.${t}.repMax`, c.repMax), 'Upper end when picking schemes')}
        ${t === 'T3' ? frow('Or minimum sets', numIn('tiers.T3.setMin', c.setMin), 'For time or bodyweight work')
          : t === 'TECH' ? frow('Target load from (%)', pctIn(`tiers.${t}.intMin`, c.intMin), 'Of estimated max. Any load still counts.') + frow('Target load up to (%)', pctIn(`tiers.${t}.intMax`, c.intMax))
          : frow('Intensity from (%)', pctIn(`tiers.${t}.intMin`, c.intMin), 'Of estimated max') + frow('Intensity up to (%)', pctIn(`tiers.${t}.intMax`, c.intMax))}
      </div>`;
    }).join('');
}

function settingsSchemes() {
  return `<p class="meta pad">Ways to deliver a tier's dose. Suggestions pick one that fits your time.</p>` +
    L.TIERS.map(t => {
      const list = state.schemes.filter(sc => sc.tiers.includes(t));
      return `<div class="label"><span class="tier ${t}">${t}</span></div><div class="menu">${list.map(sc =>
        `<button class="menurow" data-act="schemeEdit" data-id="${sc.id}"><span class="grow"><span class="name">${esc(sc.name)}</span>
          <span class="meta">${sc.sets * sc.reps} reps · ${sc.minutes} min · rest ${clock(sc.restSec)}</span></span><span class="chev">›</span></button>`).join('')
        || '<p class="muted pad">None yet.</p>'}</div>`;
    }).join('') + `<button class="addblock" data-act="schemeNew">+ Add scheme</button>`;
}

function settingsData() {
  const st = { ...state.settings, imports: state.imports };
  return `<p class="meta pad">Everything is stored only on this device, in this browser. Clearing browser data erases it, so keep a backup.</p>
    <div class="label">Back up</div>
    <div class="menu">
      <button class="menurow" data-act="copyBackup"><span class="grow"><span class="name">Copy backup</span><span class="meta">Paste it into a note or email to yourself</span></span></button>
      <button class="menurow" data-act="export"><span class="grow"><span class="name">Download backup file</span><span class="meta">Last backup: ${st.lastExportAt ? new Date(st.lastExportAt).toLocaleString() : 'never'}</span></span></button>
    </div>
    <div class="label">Import</div>
    <div class="menu">
      <button class="menurow" data-act="setPage" data-p="fitnotes"><span class="grow"><span class="name">Import from FitNotes</span>
        <span class="meta">${st.imports?.fitnotes?.at ? `Last import ${new Date(st.imports.fitnotes.at).toLocaleDateString()}` : 'Bring in your workout history'}</span></span><span class="chev">›</span></button>
      ${hasCopy('before-import') ? '<button class="menurow" data-act="fnUndo"><span class="grow"><span class="name">Undo last import</span><span class="meta">Puts everything back the way it was just before</span></span></button>' : ''}
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
    <p class="meta pad">Brings in your FitNotes history: exercises, sets and estimated maxes. The file is read on this phone and never uploaded.
      You'll check the exercises you use most before anything is saved, and you can undo the import afterwards.</p>
    <div class="menu">
      ${frow(`Bodyweight (${unit()})`, `<input id="fn-bw" class="num" inputmode="decimal" value="${esc(bw)}">`, 'Used for weighted pull-ups and dips in your history')}
      ${frow('How far back', `<select id="fn-years">${opts([[1, 'Last year'], [2, 'Last 2 years'], [4, 'Last 4 years']], f.years ?? 2)}</select>`)}
    </div>
    <label class="btn primary big fnpick">Choose the FitNotes backup<input type="file" data-fnfile hidden></label>
    <p class="meta pad">Make a backup in FitNotes first, then pick the .fitnotes file it saves.${state.imports?.fitnotes?.at ? ' Sets you already imported are skipped, so a newer backup only adds what\'s new.' : ''}</p>`;
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
    <button class="menurow" data-act="fnToggle" data-id="${r.fnId}"><span class="grow"><span class="name">${esc(r.fnName)}</span>
      <span class="meta">${esc(fnLine(r))}</span><span class="meta">${esc(count)}</span></span><span class="chev">${open ? '−' : '+'}</span></button>
    ${open ? fnEditor(r) : ''}</div>`;
}

function fnEditor(r) {
  const id = r.fnId;
  const choices = [['new', 'A new exercise'], ...state.exercises.filter(e => !e.archived || e.id === r.target)
    .map(e => [e.id, `${e.name} (${famOf(e.familyId)?.name ?? ''})`]).sort((a, b) => a[1].localeCompare(b[1]))];
  let h = `<div class="fnedit"><div class="field"><label>Bring in as</label><select data-fn="${id}" data-k="target">${opts(choices, r.target)}</select></div>`;
  if (r.target === 'new') {
    h += `<div class="field"><label>Name</label><input data-fn="${id}" data-k="name" value="${esc(r.name)}"></div>
      <div class="field"><label>Family</label><input data-fn="${id}" data-k="family" list="fn-fams" value="${esc(r.family)}"></div>
      <div class="field"><label>How it was logged</label><select data-fn="${id}" data-k="mode">${opts(FN.MODES, r.mode)}</select></div>
      <div class="field"><label>Body region</label><select data-fn="${id}" data-k="region">${opts(Object.entries(REGION_LABEL), r.region)}</select></div>
      <label class="toggle"><input type="checkbox" data-fn="${id}" data-k="explosive" ${r.explosive ? 'checked' : ''}> Explosive</label>
      <label class="toggle"><input type="checkbox" data-fn="${id}" data-k="archive" ${r.archive ? 'checked' : ''}> Archive it <span class="hint">kept for history, left out of suggestions</span></label>
      <div class="field"><label>Equipment</label><div class="chips">${[...new Set([...state.equipment, ...r.equipment])].map(eq =>
        `<label class="chip ${r.equipment.includes(eq) ? 'on' : ''}"><input type="checkbox" data-fn="${id}" data-k="eq" value="${esc(eq)}" ${r.equipment.includes(eq) ? 'checked' : ''}>${esc(eq)}</label>`).join('')}</div></div>`;
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
    <p class="meta pad">${rows.length} exercises and ${f.plan.sets} sets since ${fmtDay(f.plan.cutoff)}. Check the ${active.length} you've used most in the last year: tap one to change anything.
      ${older.length ? `The other ${older.length} come in archived, kept for your history.` : ''}</p>
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
      ${s.defaults.length ? `<p class="meta">Each family's usual choice is now what you do most: ${esc(s.defaults.join(' · '))}. Change it in Library.</p>` : ''}
    </div>
    <div class="card"><h3>Estimated maxes from your history</h3>
      ${s.maxes.map(m => `<div class="kv"><span>${esc(m.name)}<span class="meta">last done ${fmtDay(m.last)}${m.stale ? ' · over 12 weeks ago, so treat it as rough' : ''}</span></span>
        <b>${m.added != null ? `BW+${round(m.added)}` : round(m.max)} ${unit()}</b></div>`).join('') || '<p class="muted">Not enough loaded sets yet.</p>'}
    </div>
    <button class="primary big" data-act="gsOpen">Suggest weekly goals from this history</button>
    <div class="actions"><button data-act="fnLibrary">Open Library</button><button data-act="fnFinish">Done</button></div>
    <p class="meta pad">To take it back out: Settings → Backup and data → Undo last import.</p>`;
}

// ---------- suggested goals ----------

const PRIORITY_LABEL = { 1: 'low', 2: 'medium', 3: 'high' };

function viewGoalSuggest(g) {
  const head = `<header class="top sub"><button class="back" data-act="gsCancel">‹ This week</button></header><h1 class="pagetitle">Suggested goals</h1>`;
  if (!g.rows.length) {
    return `${head}<p class="meta pad">Not enough history yet: ${g.workouts} workouts in the last ${g.weeks} weeks. Log a few weeks, or import from FitNotes (Settings → Backup and data).</p>`;
  }
  const total = g.rows.filter(r => r.include).reduce((t, r) => t + r.quota, 0);
  return `${head}
    <p class="meta pad">From your last ${g.weeks} weeks: ${g.workouts} workouts, about ${g.perWeek.toFixed(1)} a week. Explosive work comes first and lifts use GZCL tiers,
      with about one heavy (T1) lift per workout. Untick anything you don't want, or tap a goal to change it.</p>
    <div class="card"><div class="kv ${total > g.capacity ? 'over' : ''}"><span>Goal sessions a week</span><b>${total}</b></div>
      <div class="kv"><span>What about ${g.perWeek.toFixed(1)} workouts of ~45 min fit</span><b>about ${g.capacity}</b></div></div>
    <div class="menu">${g.rows.map(r => gsRow(r, g)).join('')}</div>
    <button class="primary big" data-act="gsApply" data-mode="replace">Replace my goals with these</button>
    <div class="actions"><button data-act="gsApply" data-mode="add">Add to my goals</button><button data-act="gsCancel">Cancel</button></div>`;
}

function gsRow(r, g) {
  const open = g.open.has(r.key);
  const name = famOf(r.familyId)?.name ?? '?';
  const bits = [`${r.quota}× a week`, `${PRIORITY_LABEL[r.priority]} priority`, r.repMin ? `${r.repMin}+ reps` : ''].filter(Boolean).join(' · ');
  return `<div class="fnrow ${open ? 'open' : ''} ${r.include ? '' : 'off'}">
    <div class="gsline"><input type="checkbox" class="gsinc" data-gs="${r.key}" data-k="include" ${r.include ? 'checked' : ''} aria-label="Include ${esc(name)}">
      <button class="menurow" data-act="gsToggle" data-key="${r.key}"><span class="tier ${r.tier}">${r.tier}</span>
        <span class="grow"><span class="name">${esc(name)}</span><span class="meta">${esc(bits)}</span><span class="meta">${esc(r.reason)}</span></span>
        <span class="chev">${open ? '−' : '+'}</span></button></div>
    ${open ? `<div class="fnedit">
      <div class="field"><label>Tier</label><div class="seg">${L.TIERS.map(t => `<button class="${r.tier === t ? 'on' : ''}" data-act="gsSet" data-key="${r.key}" data-k="tier" data-v="${t}">${t}</button>`).join('')}</div>
        <p class="meta">${TIER_DESC[r.tier]}</p></div>
      <div class="field"><label>Times per week</label><div class="stepper">
        <button data-act="gsStep" data-key="${r.key}" data-d="-1" aria-label="Fewer">−</button><span>${r.quota}</span><button data-act="gsStep" data-key="${r.key}" data-d="1" aria-label="More">+</button></div></div>
      <div class="field"><label>Priority</label><div class="seg">${PRIORITIES.map(([v, t]) => `<button class="${r.priority === v ? 'on' : ''}" data-act="gsSet" data-key="${r.key}" data-k="priority" data-v="${v}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>Reps per session <span class="hint">optional · ${L.slotDose(state, null, r.tier).repMin} by default for ${r.tier}</span></label>
        <input inputmode="numeric" data-gs="${r.key}" data-k="repMin" value="${esc(r.repMin ?? '')}" placeholder="${L.slotDose(state, null, r.tier).repMin}"></div>
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
    confirm: sheetConfirm, backupText: sheetBackupText, pasteImport: sheetPasteImport,
    addEx: sheetAddEx, tier: sheetTier, goal: sheetGoal, scheme: sheetScheme, pair: sheetPair, finishAsk: sheetFinishAsk, moreTime: sheetMoreTime, mobPick: sheetMobPick, mobEx: sheetMobEx }[s.type](s);
  sheetEl.innerHTML = `<div class="panel"><button class="close" data-act="sheetClose" aria-label="Close">✕</button>${body}</div>`;
  sheetEl.hidden = false;
  if (ui.sheetFocus) {
    const el = sheetEl.querySelector(ui.sheetFocus);
    if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); }
    ui.sheetFocus = null;
  }
}

const TIER_DESC = {
  T1: 'Heavy: sets of 1–3 at 85%+ of your max, 10–15 reps total.',
  T2: 'Moderate: sets of 5–8 at 65–85%, 20–30 reps total.',
  T3: 'Accessory: 10+ reps a set, 30+ total. Any load counts.',
  TECH: 'Technique: crisp, low-volume explosive work when tired or after heavy days. Has its own goal.',
};

// Pick any exercise, from any family: mode 'add' adds a block, mode 'swap' replaces one.
function sheetAddEx(sh) {
  const s = currentSession();
  const loc = L.byId(state.locations, s.locationId);
  const q = (sh.q || '').trim().toLowerCase();
  const matches = state.exercises.filter(e => !e.archived && (!q || e.name.toLowerCase().includes(q) || famOf(e.familyId)?.name.toLowerCase().includes(q)));
  const here = matches.filter(e => L.isAvailable(e, loc));
  const away = matches.length - here.length;
  const groups = new Map();
  for (const e of here.sort((a, b) => a.rank - b.rank)) {
    const f = famOf(e.familyId)?.name ?? '';
    groups.set(f, [...(groups.get(f) || []), e]);
  }
  const tier = sh.mode === 'swap' ? findBlock(sh.blockId).b.tier : sh.tier;
  const title = sh.mode === 'add' ? 'Add an exercise' : sh.mode === 'pair' ? `Superset with ${esc(exOf(findBlock(sh.blockId).b.exerciseId)?.name)}` : 'Swap to any exercise';
  const rows = [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([f, list]) =>
    `<div class="label">${esc(f)}</div>${list.map(e => `<button class="row" data-act="addExPick" data-id="${e.id}"><span>${esc(e.name)}</span>
      <span class="meta">${(tier === 'T1' || tier === 'T2') && e.metric !== 'load_reps' && !e.explosive ? 'reps only' : ''}</span></button>`).join('')}`).join('');
  const raw = (sh.q || '').trim();
  return `<h3>${title}</h3>
    ${sh.mode !== 'swap' ? `<div class="seg tierseg">${L.TIERS.map(t => `<button class="${sh.tier === t ? 'on' : ''}" data-act="addExTier" data-t="${t}">${t}</button>`).join('')}</div>
      <p class="meta">${TIER_DESC[sh.tier]}</p>` : ''}
    <input class="search" id="sheetq" data-sheetq value="${esc(sh.q || '')}" placeholder="Search, or type a new name" autocomplete="off">
    <div class="list">${rows || '<p class="muted">No matches here.</p>'}
      <button class="row add" data-act="addExCreate">+ ${raw ? `Create “${esc(raw)}”` : 'New exercise'}</button></div>
    ${away ? `<p class="meta">${away} more need equipment that isn't at ${esc(loc?.name)}.</p>` : ''}`;
}

function sheetTier(sh) {
  const { b } = findBlock(sh.blockId);
  const ex = exOf(b.exerciseId);
  return `<h3>Tier for ${esc(ex.name)}</h3><p class="meta">Changing the tier picks a new scheme and load. Sets you've logged keep their tier.</p>
    <div class="list">${L.TIERS.map(t => {
      const sl = L.slotFor(state, ex, t);
      return `<button class="row ${b.tier === t ? 'on' : ''}" data-act="tierPick" data-t="${t}"><span><span class="tier ${t}">${t}</span> ${TIER_DESC[t]}</span>
        <span class="meta">${sl ? `counts toward ${esc(slotLabel(sl))}` : 'no goal'}</span></button>`;
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
    <div class="field"><label>Tier</label><div class="seg">${L.TIERS.map(t => `<button class="${g.tier === t ? 'on' : ''}" data-act="goalSet" data-k="tier" data-v="${t}">${t}</button>`).join('')}</div>
      <p class="meta">${TIER_DESC[g.tier]}</p></div>
    <div class="field"><label>Family</label><select data-gdraft="familyId">${opts(famOpts, g.familyId)}</select></div>
    <div class="field"><label>Exercise</label><select data-gdraft="exerciseId">${opts([['', `Any${usual ? ` (usually ${usual})` : ''}`], ...members.map(e => [e.id, e.name])], g.exerciseId ?? '')}</select>
      <p class="meta">Pick an exercise to make the goal about it, like T1 Weighted dip plus T3 Bar dip in the same week.</p></div>
    <div class="field"><label>Times per week</label><div class="stepper">
      <button data-act="goalStep" data-d="-1" aria-label="Fewer">−</button><span>${g.quota}</span><button data-act="goalStep" data-d="1" aria-label="More">+</button></div></div>
    <div class="field"><label>Reps per session <span class="hint">optional · ${L.slotDose(state, null, g.tier).repMin} by default for ${g.tier}</span></label>
      <input id="g-reps" inputmode="numeric" value="${esc(g.repMin ?? '')}" placeholder="${L.slotDose(state, null, g.tier).repMin}"></div>
    <div class="field"><label>Priority</label><div class="seg">${PRIORITIES.map(([v, t]) => `<button class="${g.priority === v ? 'on' : ''}" data-act="goalSet" data-k="priority" data-v="${v}">${t}</button>`).join('')}</div></div>
    <div class="actions">${sh.isNew ? '' : '<button class="danger" data-act="goalDelete">Delete</button>'}
      <button class="primary" data-act="goalSave">${sh.isNew ? 'Add goal' : 'Save'}</button></div>`;
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
      <div class="field"><label>Minutes</label><input id="sc-min" class="num" inputmode="numeric" value="${esc(d.minutes ?? '')}" placeholder="${est}"></div>
    </div>
    <p class="meta">${d.sets * d.reps} total reps. About ${est} minutes at that rest.</p>
    <div class="field"><label>Use for</label><div class="seg">${L.TIERS.map(t => `<button class="${d.tiers.includes(t) ? 'on' : ''}" data-act="schemeTier" data-t="${t}">${t}</button>`).join('')}</div></div>
    <div class="actions">${sh.id ? (used ? '<p class="meta">In use by logged sets or plans, so it can’t be deleted.</p>' : '<button class="danger" data-act="schemeDelete">Delete</button>') : ''}
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
  return `<div class="chips">${REASONS.map(r => `<button class="chip ${cur === r ? 'on' : ''}" data-act="reason" data-v="${r}">${r}</button>`).join('')}</div>`;
}

function sheetSwapEx(sh) {
  const { s, b } = findBlock(sh.blockId);
  const cur = exOf(b.exerciseId), fam = famOf(cur.familyId);
  const loc = L.byId(state.locations, s.locationId);
  const alts = L.alternatives(state, cur, loc);
  return `<h3>Swap ${esc(cur.name)}</h3><div class="meta">${esc(fam?.name)} at ${esc(loc?.name)} · closest first</div>
    <div class="label">Reason (optional)</div>${reasonChips(sh.reason)}
    <div class="list">${alts.map(a => `<button class="row" data-act="pickEx" data-id="${a.id}"><span>${esc(a.name)}</span>
      <span class="meta">${a.rank < cur.rank ? 'harder' : 'easier'}${a.metric !== 'load_reps' && !a.explosive && (b.tier === 'T1' || b.tier === 'T2') ? ' · won’t auto-count' : ''}</span></button>`).join('')
      || '<p class="muted">No other family members available here.</p>'}
    <button class="row add" data-act="qaVariation" data-id="${cur.id}" data-from="swap">+ New variation of ${esc(cur.name)}</button>
    <button class="row add" data-act="swapAny">Pick from all exercises ›</button></div>`;
}

function sheetSwapScheme(sh) {
  const { s, b } = findBlock(sh.blockId);
  const ex = exOf(b.exerciseId);
  const budget = sessionBudget(s, b) - L.WARMUP[b.tier];
  return `<h3>Scheme for ${esc(ex.name)}</h3><div class="meta">${b.tier} · ${budget} min left in budget · loads recalculate automatically</div>
    <div class="label">Reason (optional)</div>${reasonChips(sh.reason)}
    <div class="list">${L.schemeOptions(state, b.tier).map(sc => {
      const load = L.targetLoad(state, ex, b.tier, sc);
      const bits = [`${sc.minutes} min`, `${sc.sets * sc.reps} reps`, L.doseFit(state, b.tier, sc, L.slotDose(state, L.byId(state.slots, b.slotId), b.tier)) ? 'fits dose' : 'off dose',
        load != null ? `${ex.bodyweight ? 'BW+' : ''}${load} ${unit()}` : '', sc.minutes > budget ? 'over time' : '',
        L.overRepCap(ex, sc) ? `over ${ex.maxReps}-rep cap` : ''].filter(Boolean);
      const dim = sc.minutes > budget || L.overRepCap(ex, sc);
      return `<button class="row ${sc.id === b.schemeId ? 'on' : ''} ${dim ? 'dim' : ''}" data-act="pickScheme" data-id="${sc.id}">
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
    <p class="meta">${b.tier === 'T3' ? 'Alternate sets and rest after each round.' : `Do a set of the partner in ${esc(ex.name)}'s rest. The rest timer keeps counting for ${esc(ex.name)}.`}</p>
    <div class="list">
      ${idea && b.tier !== 'T3' ? `<button class="row" data-act="pairAdd" data-b="${b.id}" data-ex="${idea.exercise.id}"><span>+ ${esc(idea.exercise.name)} <span class="tier T3">T3</span></span><span class="meta">${esc(idea.why)}</span></button>` : ''}
      ${others.length ? `<div class="label">Already in this workout</div>${others.map(o => `<button class="row" data-act="pairLink" data-b="${b.id}" data-o="${o.id}">
        <span>${names(o)} <span class="tier ${o.tier}">${o.tier}</span></span><span class="meta">${inPair(s, o) ? 'make it a giant set' : 'pair them'}</span></button>`).join('')}` : ''}
      <button class="row add" data-act="pairAny" data-b="${b.id}">Choose any exercise ›</button></div>`;
}

const MOB_PICK_TITLE = { new: 'Mobility session', session: 'Add mobility', workout: 'Add mobility to this workout', routine: 'Add to routine' };

function sheetMobPick(sh) {
  const last = M.lastDoneAt(state);
  const shown = sh.parts.length || sh.mode === 'routine' ? M.rankForParts(state, sh.parts, sh.exclude) : [];
  return `<h3>${MOB_PICK_TITLE[sh.mode]}</h3>
    <p class="meta">Pick up to 3 body parts. The moves you've done least recently are ticked; change the ticks as you like.</p>
    <div class="chips">${M.BODY_PARTS.map(p => `<button class="chip ${sh.parts.includes(p) ? 'on' : ''}" data-act="mobPart" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <div class="list">${shown.map(({ e }) => `<button class="row ${sh.picked.includes(e.id) ? 'on' : ''}" data-act="mobTick" data-id="${e.id}">
      <span>${sh.picked.includes(e.id) ? '☑' : '☐'} ${esc(e.name)}</span>
      <span class="meta">${esc(`${e.parts.join(', ')} · ${M.doseText(e)} · ${last.has(e.id) ? fmtAgo(last.get(e.id)) : 'not logged yet'}`)}</span></button>`).join('')
      || `<p class="muted">${sh.parts.length ? 'Nothing for those body parts yet.' : 'Pick a body part to see moves.'}</p>`}
      <button class="row add" data-act="mobExNew">+ New mobility exercise</button></div>
    <div class="actions"><button class="primary" data-act="mobAddPicked">${sh.mode === 'new' ? 'Start' : 'Add'}${sh.picked.length ? ` ${sh.picked.length}` : ''}</button></div>`;
}

function sheetMobEx(sh) {
  const d = sh.draft;
  const num = (id, v) => `<input id="${id}" class="num" inputmode="numeric" value="${esc(v ?? '')}">`;
  const box = (id, on, label) => `<label class="toggle"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;
  const used = sh.id && M.loggedItems(state).some(x => x.item.exerciseId === sh.id);
  return `<h3>${sh.isNew ? 'New mobility exercise' : 'Edit mobility exercise'}</h3>
    <div class="field"><label>Name</label><input id="me-name" value="${esc(d.name)}" placeholder="e.g. 90/90 hip switch"></div>
    <div class="field"><label>Body parts</label><div class="chips">${M.BODY_PARTS.map(p => `<button class="chip ${d.parts.includes(p) ? 'on' : ''}" data-act="mobExPart" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>
    <div class="row2 fields">
      <div class="field"><label>Sets</label>${num('me-sets', d.sets)}</div>
      <div class="field"><label>Reps</label>${num('me-reps', d.reps)}</div>
      <div class="field"><label>Up to</label>${num('me-repsmax', d.repsMax)}</div></div>
    <div class="row2 fields">
      <div class="field"><label>Hold (s)</label>${num('me-hold', d.hold)}</div>
      <div class="field"><label>Up to</label>${num('me-holdmax', d.holdMax)}</div>
      <div class="field"><label>Rest</label><input id="me-rest" class="num" value="${esc(clock(d.restSec || 0))}"></div></div>
    ${box('me-side', d.perSide, 'Each side')}
    <div class="field"><label>Tempo or detail <span class="hint">optional</span></label><input id="me-tempo" value="${esc(d.tempo)}" placeholder="e.g. 4s down / 2s hold"></div>
    <div class="field"><label>Log each set with</label>${box('me-t-reps', d.track.reps, 'Reps')}${box('me-t-hold', d.track.hold, 'Hold time')}${box('me-t-load', d.track.load, 'Load')}
      <input id="me-t-extra" value="${esc(d.track.extra)}" placeholder="Anything else, e.g. Depth or Deficit (cm)"></div>
    <div class="field"><label>Cues</label><textarea id="me-cues" rows="2">${esc(d.cues)}</textarea></div>
    <div class="field"><label>Video search <span class="hint">opens YouTube results</span></label><input id="me-video" value="${esc(d.video)}" placeholder="e.g. kneesovertoesguy elephant walk"></div>
    <div class="field"><label>History notes</label><textarea id="me-notes" rows="2">${esc(d.notes)}</textarea></div>
    ${sh.isNew ? '' : box('me-arch', d.archived, 'Archived <span class="hint">kept for history, left out of pickers</span>')}
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

function sheetFinishAsk(sh) {
  return `<h3>${sh.left} set${sh.left === 1 ? '' : 's'} not logged yet</h3>
    <p class="meta">Pause to pick this workout up later today: what you haven't done stays waiting on the Today tab. Finishing drops the unlogged sets.</p>
    <div class="actions"><button data-act="finishNow">Finish now</button><button class="primary" data-act="pause">Pause for later</button></div>`;
}

function sheetMoreTime() {
  return `<h3>More time?</h3>
    <p class="meta">Adds exercises from your weekly goals that fit the extra minutes, after what's left in this workout.</p>
    <div class="seg">${[10, 15, 20, 30, 45].map(m => `<button data-act="addTime" data-v="${m}">+${m} min</button>`).join('')}</div>`;
}

// In-app confirmation; native confirm() is unavailable in some hosts.
function askConfirm(title, body, yes, onYes) {
  openSheet({ type: 'confirm', title, body, yes, onYes });
}

function sheetConfirm(sh) {
  return `<h3>${esc(sh.title)}</h3><p class="meta">${esc(sh.body)}</p>
    <div class="actions"><button data-act="sheetClose">Cancel</button><button class="danger solid" data-act="confirmYes">${esc(sh.yes)}</button></div>`;
}

function sheetBackupText(sh) {
  return `<h3>Copy your backup</h3><p class="meta">Copying was blocked here. Select all of the text below, copy it, and paste it into a note.</p>
    <textarea id="backup-json" rows="8" readonly>${esc(sh.json)}</textarea>`;
}

function sheetPasteImport() {
  return `<h3>Restore from a backup</h3><p class="meta">Paste the backup text you copied earlier.</p>
    <textarea id="paste-json" rows="8" placeholder='{"version":1,...}'></textarea>
    <div class="actions"><button class="primary" data-act="pasteImportGo">Restore</button></div>`;
}

const REST_PRESETS = [30, 45, 60, 90, 120, 150, 180, 240, 300];

function sheetRest(sh) {
  const { b } = findBlock(sh.blockId);
  const ex = exOf(b.exerciseId), sc = schOf(b.schemeId);
  const cur = sh.value ?? effectiveRest(b);
  return `<h3>Rest for ${esc(ex.name)}</h3>
    <div class="meta">Scheme ${esc(sc.name)} default ${clock(sc.restSec)}${ex.restSec != null ? ` · exercise default ${clock(ex.restSec)}` : ''}</div>
    <div class="restbig">${clock(cur)}</div>
    <div class="seg"><button data-act="restNudge" data-d="-15">−15s</button><button data-act="restNudge" data-d="15">+15s</button></div>
    <div class="chips">${REST_PRESETS.map(v => `<button class="chip ${v === cur ? 'on' : ''}" data-act="restPreset" data-v="${v}">${clock(v)}</button>`).join('')}</div>
    <label class="toggle"><input type="checkbox" id="rest-save" ${sh.saveDefault ? 'checked' : ''}> Make ${clock(cur)} the default for ${esc(ex.name)}</label>
    <div class="actions">
      ${b.restSec != null || ex.restSec != null ? '<button data-act="restClear">Back to scheme default</button>' : ''}
      <button class="primary" data-act="restApply">Use ${clock(cur)}</button></div>`;
}

function sheetPlans() {
  if (!state.plans.length) return `<h3>Plans</h3><p class="muted">No saved plans yet.</p><button data-act="goPlans">Build one</button>`;
  return `<h3>Use a plan instead</h3><div class="meta">Logged sets stay; the rest is replaced.</div><div class="list">${state.plans.map(p =>
    `<button class="row" data-act="applyPlan" data-id="${p.id}"><span>${esc(p.name)}</span><span class="meta">${p.items.length} items</span></button>`).join('')}</div>`;
}

const equipChip = (eq, on, name) => `<label class="chip ${on ? 'on' : ''}"><input type="checkbox" name="${name}" value="${esc(eq)}" ${on ? 'checked' : ''}>${esc(eq)}</label>`;

function equipChips(sel, name) {
  return `<div class="chips">${state.equipment.map(eq => equipChip(eq, sel.includes(eq), name)).join('')}
    <input class="chipinput" data-eqnew="${name}" placeholder="+ New" aria-label="Add equipment" enterkeyhint="done"></div>`;
}

const LOG_TYPES = [['load_reps', 'Weight × reps'], ['reps', 'Reps'], ['time', 'Time'], ['distance', 'Distance']];

// Starting values for the new-exercise form: copied from the base exercise for a variation.
function qaDefaults(sh, base) {
  const name = sh.name ?? '';
  const d = base
    ? { famName: famOf(base.familyId)?.name ?? '', metric: base.metric, bodyweight: base.bodyweight, equipment: [...base.equipment] }
    : { famName: famOf(sh.familyId)?.name ?? '', metric: 'load_reps', bodyweight: false, equipment: [] };
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
  return `Looks like a variation of ${esc(m.e.name)}. <button class="link" data-act="qaUseBase" data-id="${m.e.id}">Copy its details</button>`;
}

function sheetQuickAdd(sh) {
  const base = sh.baseId ? exOf(sh.baseId) : null;
  const d = qaDefaults(sh, base);
  const label = sh.from === 'swap' ? 'Add and use' : sh.from === 'add' ? `Add to today as ${sh.tier}` : 'Add exercise';
  const radio = (name, value, text, on) => `<label><input type="radio" name="${name}" value="${value}" ${on ? 'checked' : ''}>${text}</label>`;
  return `<h3>${base ? `New variation of ${esc(base.name)}` : 'New exercise'}</h3>
    <div class="field"><label>Name</label><input id="qa-name" data-qaname autocomplete="off" value="${esc(sh.name ?? '')}"
      placeholder="${base ? `e.g. Weighted ${esc(base.name.toLowerCase())}` : 'e.g. Pause squat'}"></div>
    <div id="qa-hint" class="qahint">${qaHint(sh.name ?? '', sh)}</div>
    ${base ? `<div class="field"><label>Compared with ${esc(base.name)}</label><div class="seg radio">
      ${radio('qa-place', 'harder', 'Harder', true)}${radio('qa-place', 'easier', 'Easier', false)}</div></div>` : ''}
    <div class="field"><label>Family <span class="hint">exercises in a family can swap for each other</span></label>
      <input id="qa-fam" list="famlist" autocomplete="off" value="${esc(d.famName)}" placeholder="Leave blank to start a new one">
      <datalist id="famlist">${state.families.map(f => `<option value="${esc(f.name)}">`).join('')}</datalist></div>
    <div class="field"><label>How do you log it?</label><div class="seg radio">
      ${LOG_TYPES.map(([v, t]) => radio('qa-metric', v, t, d.metric === v)).join('')}</div></div>
    <label class="toggle"><input type="checkbox" id="qa-bw" ${d.bodyweight ? 'checked' : ''}> Weight is added to bodyweight <span class="hint">(weighted pull-ups, dips)</span></label>
    <div class="field"><label>Equipment <span class="hint">it's only suggested where this is available</span></label>${equipChips(d.equipment, 'qa-eq')}</div>
    <label class="toggle"><input type="checkbox" id="qa-any" ${base ? (base.anytime ? 'checked' : '') : ''}> Easy to do any time <span class="hint">no setup, fits a spare few minutes</span></label>
    <div class="field"><label>Body region <span class="hint">heavy work here makes explosive work wait</span></label><div class="seg radio">
      ${radio('qa-region', 'lower', 'Lower', d.region === 'lower')}${radio('qa-region', 'upper', 'Upper', d.region === 'upper')}${radio('qa-region', 'full', 'Whole body', d.region === 'full')}</div></div>
    <label class="toggle"><input type="checkbox" id="qa-expl" ${d.explosive ? 'checked' : ''}> Explosive <span class="hint">jumps, throws, Olympic lifts: best done fresh</span></label>
    <button class="primary big" data-act="qaSave">${label}</button>`;
}

function sheetEditEx(sh) {
  const e = exOf(sh.id);
  const fam = famOf(e.familyId);
  const famOpts = [...state.families].sort((a, b) => a.name.localeCompare(b.name)).map(f => [f.id, f.name]);
  const hasHistory = state.sets.some(s => s.done && s.exerciseId === e.id);
  const max = e.metric === 'load_reps' ? L.estimatedMax(state, e.id) : null;
  return `<h3>Edit exercise</h3>
    <div class="field"><label>Name</label><input id="ee-name" value="${esc(e.name)}"></div>
    <div class="field"><label>Family</label><select id="ee-fam">${opts(famOpts, e.familyId)}</select></div>
    <label class="toggle"><input type="checkbox" id="ee-default" ${fam?.defaultExerciseId === e.id ? 'checked' : ''}> Usual choice for this family</label>
    <div class="field"><label>How do you log it?</label><select id="ee-metric">${opts(METRICS, e.metric)}</select></div>
    <label class="toggle"><input type="checkbox" id="ee-bw" ${e.bodyweight ? 'checked' : ''}> Weight is added to bodyweight <span class="hint">(weighted pull-ups, dips)</span></label>
    <div class="field"><label>Starting max (${unit()}${e.bodyweight ? ', added load' : ''})</label>
      <input id="ee-max" inputmode="decimal" value="${esc(e.startMax)}" placeholder="Used until you log sets">
      ${max ? `<div class="meta">Current e1RM: ${round(max)}${e.bodyweight ? ' total incl. bodyweight' : ''}</div>` : ''}</div>
    <div class="field"><label>Max reps per set <span class="hint">optional · e.g. 5 for Olympic lifts</span></label>
      <input id="ee-maxreps" inputmode="numeric" value="${esc(e.maxReps)}"></div>
    <div class="field"><label>Rest override (m:ss) <span class="hint">optional · otherwise the scheme's rest</span></label>
      <input id="ee-rest" value="${esc(e.restSec != null ? clock(e.restSec) : '')}" placeholder="e.g. 2:30"></div>
    <div class="field"><label>Equipment</label>${equipChips(e.equipment, 'ee-eq')}</div>
    <label class="toggle"><input type="checkbox" id="ee-any" ${e.anytime ? 'checked' : ''}> Easy to do any time <span class="hint">no setup, fits a spare few minutes</span></label>
    <div class="field"><label>Body region <span class="hint">heavy work here makes explosive work wait</span></label>
      <select id="ee-region">${opts([['lower', 'Lower body'], ['upper', 'Upper body'], ['full', 'Whole body']], e.region || 'full')}</select></div>
    <label class="toggle"><input type="checkbox" id="ee-expl" ${e.explosive ? 'checked' : ''}> Explosive <span class="hint">jumps, throws, Olympic lifts: best done fresh</span></label>
    <label class="toggle"><input type="checkbox" id="ee-arch" ${e.archived ? 'checked' : ''}> Archived <span class="hint">kept for history, left out of suggestions and pickers</span></label>
    <div class="field"><label>YouTube URL</label><input id="ee-yt" value="${esc(e.youtube)}" placeholder="https://youtu.be/..."></div>
    <div class="field"><label>Start time (m:ss)</label><input id="ee-start" value="${esc(fmtMSS(e.start))}" placeholder="0:42"></div>
    <div class="field"><label>Cues</label><textarea id="ee-cues" rows="3">${esc(e.cues)}</textarea></div>
    <div class="actions">${hasHistory ? '' : `<button class="danger" data-act="exDelete" data-id="${e.id}">Delete</button>`}
      ${hasHistory ? `<button data-act="histOpen" data-q="${esc(e.name)}">History</button>` : ''}
      <button data-act="qaVariation" data-id="${e.id}">Make a variation</button>
      <button class="primary" data-act="exSave" data-id="${e.id}">Save</button></div>`;
}

// ---------- actions ----------

function swapTo(exerciseId) {
  const { s, b } = findBlock(ui.sheet.blockId);
  b.swaps.push({ type: 'exercise', from: b.exerciseId, to: exerciseId, reason: ui.sheet.reason, at: Date.now() });
  b.exerciseId = exerciseId;
  if (s.source === 'suggested') s.source = 'swapped';
  genSets(s, b);
  ui.sheet = null;
  save(); render();
}

function normalizeRanks(familyId) {
  L.familyMembers(state, familyId).forEach((e, i) => { e.rank = i + 1; });
}

const actions = {
  nav: d => {
    ui.tab = d.tab;
    ui.plan = ui.tab === 'plans' ? ui.plan : null;
    ui.setPage = null;
    if (d.tab !== 'week') ui.goalsUndo = null;
    ui.history = null;
    render(); window.scrollTo(0, 0);
  },

  histOpen: d => {
    ui.history = { q: d.q ?? '', limit: HISTORY_PAGE };
    ui.goalSuggest = null;
    ui.sheet = null; renderSheet();
    ui.tab = 'week';
    render(); window.scrollTo(0, 0);
  },
  histClose: () => { ui.history = null; render(); window.scrollTo(0, 0); },
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
  gsUndo: () => {
    if (!ui.goalsUndo) return;
    state.slots = ui.goalsUndo;
    ui.goalsUndo = null;
    save(); render(); toast('Your previous goals are back');
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
    const why = res.scored.map(c => ({ label: slotLabel(c.slot), score: c.score, why: c.why, picked: !!c.picked, note: c.note }));
    createSession(res.blocks, 'suggested', { why, ready: res.ready });
    render(); window.scrollTo(0, 0);
  },

  // A focused workout replaces what's unlogged in the open session (logged work stays), or starts a new one.
  focus: d => {
    const region = d.r, explosive = !!d.x;
    let s = currentSession();
    if (s) {
      const keep = s.blocks.filter(b => state.sets.some(x => x.blockId === b.id && x.done));
      state.sets = state.sets.filter(x => x.sessionId !== s.id || x.done);
      s.blocks = keep;
      for (const b of keep) if (b.pairOf && !keep.some(x => x.id === b.pairOf)) delete b.pairOf;
    }
    const ci = s ? { ...s, minutes: sessionBudget(s) } : ui.ci;
    const res = L.buildFocus(state, ci, { region, explosive }, Date.now(), { excludeFamilies: (s?.blocks || []).map(b => exOf(b.exerciseId)?.familyId) });
    const extra = { focusRegion: region, focusExplosive: explosive, focusNotes: res.notes, ready: res.ready };
    if (s) {
      s.blocks.push(...res.blocks);
      L.pairT3s(state, s.blocks);
      for (const b of res.blocks) genSets(s, b);
      Object.assign(s, extra, { source: 'focus' });
      delete s.why;
      save();
    } else {
      s = createSession(res.blocks, 'focus', extra);
    }
    render(); window.scrollTo(0, 0);
    if (!res.blocks.length) toast('Nothing fits here. Try another location or more time.');
  },

  startPlan: d => {
    const p = L.byId(state.plans, d.id);
    createSession(planBlocks(p), 'custom', { planId: p.id });
    render();
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
    } else {
      st.done = false;
      delete st.loggedAt;
      delete st.restSec;
      delete st.restPlan;
      if (state.timer?.setId === st.id) state.timer = null; // un-logging a set cancels its rest
    }
    save(); render();
  },

  addSet: d => {
    const { s, b } = findBlock(d.b);
    const last = blockSets(b).at(-1);
    const ex = exOf(b.exerciseId), sc = schOf(b.schemeId);
    const ns = newSet(s, b, ex, sc, last?.load ?? L.targetLoad(state, ex, b.tier, sc));
    if (last && last.exerciseId === ex.id) ns.reps = last.reps;
    state.sets.push(ns);
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
    save(); render();
  },

  swapEx: d => openSheet({ type: 'swapEx', blockId: d.b, reason: null }),
  swapScheme: d => openSheet({ type: 'swapScheme', blockId: d.b, reason: null }),
  reason: d => { ui.sheet.reason = ui.sheet.reason === d.v ? null : d.v; renderSheet(); },
  pickEx: d => swapTo(d.id),

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
      ? L.buildFocus(state, { ...s, minutes: extra }, { region: s.focusRegion, accessoriesOnly: true }, Date.now(), { excludeFamilies })
      : L.buildSuggestion(state, { ...s, minutes: extra }, Date.now(), { excludeFamilies });
    s.minutes += extra;
    s.blocks.push(...res.blocks);
    L.pairT3s(state, s.blocks);
    for (const b of res.blocks) genSets(s, b);
    ui.sheet = null;
    save(); render();
    toast(res.blocks.length ? `Added ${res.blocks.map(b => exOf(b.exerciseId)?.name).join(', ')}` : 'Nothing else from your goals fits. Add an exercise below.');
  },

  showWorkout: () => { ui.showWorkout = true; render(); window.scrollTo(0, 0); },
  showMobility: () => { ui.showWorkout = false; render(); window.scrollTo(0, 0); },

  mobStart: d => {
    if (currentMobility()) { ui.showWorkout = false; render(); return toast('A mobility session is already open'); }
    const r = L.byId(state.mobility.routines, d.id);
    startMobility(r.items.map(mobEx).filter(e => e && !e.archived).map(e => M.newItem(state, e)), { routineId: r.id });
    save(); render(); window.scrollTo(0, 0);
  },
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
    if (item.sets.some(s => s.done)) { item.sets = item.sets.filter(s => s.done); toast('Logged sets kept; the rest removed'); }
    else list.splice(list.indexOf(item), 1);
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
    const ex = st && mobEx(item.exerciseId);
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
    const familyName = sheetEl.querySelector('#qa-fam').value.trim();
    const equipment = [...sheetEl.querySelectorAll('input[name="qa-eq"]:checked')].map(i => i.value);
    // A variation sits right next to its base exercise, on the side you picked.
    const base = sh.baseId && exOf(sh.baseId);
    const sameFam = base && (famOf(base.familyId)?.name ?? '').toLowerCase() === familyName.toLowerCase();
    const place = sheetEl.querySelector('input[name="qa-place"]:checked')?.value;
    const e = newExercise({
      name, familyName, equipment,
      metric: sheetEl.querySelector('input[name="qa-metric"]:checked')?.value ?? 'load_reps',
      bodyweight: sheetEl.querySelector('#qa-bw').checked,
      anytime: sheetEl.querySelector('#qa-any').checked,
      region: sheetEl.querySelector('input[name="qa-region"]:checked')?.value ?? 'full',
      explosive: sheetEl.querySelector('#qa-expl').checked,
      rank: sameFam ? base.rank + (place === 'easier' ? 0.5 : -0.5) : null,
    });
    const s = currentSession();
    // Gear you just added while training is gear you have here.
    if (s && sh.from !== 'lib') {
      const loc = L.byId(state.locations, s.locationId);
      for (const eq of sh.newEq || []) if (equipment.includes(eq) && !loc.equipment.includes(eq)) loc.equipment.push(eq);
    }
    save();
    const here = s && L.isAvailable(e, L.byId(state.locations, s.locationId));
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
  addExPick: d => {
    const sh = ui.sheet;
    if (sh.mode === 'swap') return swapTo(d.id);
    const s = currentSession();
    const nb = addBlock(s, exOf(d.id), sh.tier);
    if (sh.mode === 'pair') nb.pairOf = sh.blockId;
    ui.sheet = null;
    save(); render();
    toast(`Added ${exOf(d.id).name} as ${sh.tier}`);
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
    state.sets = state.sets.filter(x => x.blockId !== b.id || x.done);
    if (logged) toast('Logged sets kept; the rest removed');
    else {
      s.blocks = s.blocks.filter(x => x !== b);
      const rest = s.blocks.filter(x => x.pairOf === b.id);
      if (rest.length) { delete rest[0].pairOf; for (const x of rest.slice(1)) x.pairOf = rest[0].id; }
    }
    if (s.source === 'suggested') s.source = 'swapped';
    save(); render();
  },

  libEdit: d => openSheet({ type: 'editEx', id: d.id }),

  libMove: d => {
    const e = exOf(d.id);
    normalizeRanks(e.familyId);
    const members = L.familyMembers(state, e.familyId);
    const i = members.indexOf(e), j = i + Number(d.dir);
    if (j < 0 || j >= members.length) return;
    [members[i].rank, members[j].rank] = [members[j].rank, members[i].rank];
    save(); render();
  },

  exSave: d => {
    const e = exOf(d.id);
    const q = sel => sheetEl.querySelector(sel);
    const newFam = q('#ee-fam').value;
    if (newFam !== e.familyId) {
      const old = famOf(e.familyId);
      if (old?.defaultExerciseId === e.id) old.defaultExerciseId = null;
      e.familyId = newFam;
      e.rank = (L.familyMembers(state, newFam).at(-1)?.rank ?? 0) + 1;
    }
    e.name = q('#ee-name').value.trim() || e.name;
    e.metric = q('#ee-metric').value;
    e.bodyweight = q('#ee-bw').checked;
    const m = q('#ee-max').value.trim();
    e.startMax = m === '' ? null : Number(m);
    e.restSec = q('#ee-rest').value.trim() === '' ? null : parseMSS(q('#ee-rest').value);
    const mr = q('#ee-maxreps').value.trim();
    e.maxReps = mr === '' ? null : Number(mr);
    e.equipment = [...sheetEl.querySelectorAll('input[name="ee-eq"]:checked')].map(i => i.value);
    e.anytime = q('#ee-any').checked;
    e.region = q('#ee-region').value;
    e.explosive = q('#ee-expl').checked;
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
    if (p.id) state.plans[state.plans.findIndex(x => x.id === p.id)] = p;
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
  fnFinish: () => { ui.fn = null; ui.setPage = 'data'; render(); window.scrollTo(0, 0); },
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
  goalStep: d => { readGoalReps(); const g = ui.sheet.draft; g.quota = Math.min(7, Math.max(1, g.quota + Number(d.d))); renderSheet(); },
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

  reset: () => askConfirm('Erase everything and start from the seed?', 'All sessions, sets, plans and edits are deleted. Copy a backup first if you might want them.', 'Erase all data', () => {
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
  pasteImport: () => openSheet({ type: 'pasteImport' }),
  pasteImportGo: () => importText(sheetEl.querySelector('#paste-json').value),
};

// ---------- events ----------

document.addEventListener('click', e => {
  if (e.target === sheetEl) return closeSheet();
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});

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
    save();
  } else if (d.mset) {
    const [iid, sid] = d.mset.split('|');
    const st = findMobItem(iid).item?.sets.find(x => x.id === sid);
    if (st) { st[d.f] = el.value.trim() === '' ? null : d.f === 'extra' ? el.value.trim() : Number(el.value); save(); }
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
  } else if (el.hasAttribute('data-ci-split')) {
    ui.ci.split = el.checked;
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
  askConfirm('Replace all current data with this backup?', `The backup has ${data.sessions?.length ?? 0} sessions and ${n} logged sets. What's here now is erased.`, 'Replace data', () => {
    replaceState(data);
    ui.ci = defaultCheckin();
    render(); toast('Imported');
  });
}

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
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
  else if (hiddenAt && Date.now() - hiddenAt > 30 * 60 * 1000 && !ui.sheet) location.reload();
});

onSaveFail(() => { toast('Couldn’t save your last change. See the message at the top.'); });

closeStale();
// Drop a timer left over from an earlier visit.
if (state.timer && ((!currentSession() && !currentMobility()) || Date.now() - state.timer.endsAt > 10 * 60e3)) state.timer = null;
save();
render();
