import { state, save, replaceState, resetState, loadProblem, lastSaveError, resolveLoadProblem, onSaveFail, keepCopy, readCopy, hasCopy, dropCopy } from './store.js';
import * as L from './logic.js';
import * as FN from './fitnotes.js';
import * as G from './goals.js';

const appEl = document.getElementById('app');
const navEl = document.getElementById('nav');
const sheetEl = document.getElementById('sheet');

const TABS = [['today', 'Today'], ['week', 'Week'], ['library', 'Library'], ['plans', 'Plans'], ['more', 'Settings']];
const INTENTS = [['auto', 'You pick'], ['heavy', 'Heavy'], ['sweat', 'Sweat'], ['easy', 'Easy']];
const TIMES = [10, 15, 20, 30, 45, 60, 90];
const REASONS = ['Equipment busy', 'Pain / niggle', 'Preference', 'Variety', 'Time'];
const METRICS = [['load_reps', 'Load × reps'], ['reps', 'Reps only'], ['time', 'Time'], ['distance', 'Distance'], ['none', 'None']];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ui = { tab: 'today', ci: defaultCheckin(), sheet: null, plan: null, whyOpen: false, libQuery: '', focus: null, setPage: null };

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
    if (s.status !== 'open' || s.day === today) continue;
    endSession(s);
  }
}

function endSession(s) {
  if (state.sets.some(x => x.sessionId === s.id && x.done)) {
    s.status = 'done';
    state.sets = state.sets.filter(x => x.sessionId !== s.id || x.done);
  } else {
    removeSession(s);
  }
}

const blockSets = b => state.sets.filter(s => s.blockId === b.id);

function newSet(session, block, ex, sc, load) {
  return {
    id: L.uid(), sessionId: session.id, blockId: block.id, exerciseId: ex.id, tier: block.tier, schemeId: sc.id,
    load: ex.metric === 'load_reps' ? load : null,
    reps: ['load_reps', 'reps'].includes(ex.metric) ? sc.reps : null,
    time: null, distance: null, done: false,
  };
}

// Regenerate a block's undone sets after an exercise or scheme change; logged sets stay.
function genSets(session, block) {
  state.sets = state.sets.filter(s => !(s.blockId === block.id && !s.done));
  const ex = exOf(block.exerciseId), sc = schOf(block.schemeId);
  const done = state.sets.filter(s => s.blockId === block.id).length;
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
  genSets(s, b);
  return b;
}

function createSession(blocks, source, extra = {}) {
  const s = {
    id: L.uid(), day: L.dayKey(), checkinAt: Date.now(), firstSetAt: null, status: 'open',
    ...ui.ci, source, blocks, ...extra,
  };
  state.sessions.push(s);
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
  return s.minutes - s.blocks.filter(b => b !== exceptBlock)
    .reduce((m, b) => m + (schOf(b.schemeId)?.minutes || 0) + L.WARMUP[b.tier], 0);
}

function videoUrl(ex) {
  if (!ex.youtube) return null;
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

function startTimer(s, b, setId = null) {
  const secs = effectiveRest(b);
  if (!secs) return;
  state.timer = { endsAt: Date.now() + secs * 1000, total: secs, blockId: b.id, setId, next: nextSetLabel(s), warned: false, alerted: false };
  setWakeLock(true);
}

function stopTimer() {
  state.timer = null;
  renderTimer();
}

// Hand the timer to the service worker so it can notify while the page is hidden.
let syncedEndsAt;
function syncTimerToWorker(force = false) {
  const endsAt = state.timer?.endsAt ?? null;
  if (!force && endsAt === syncedEndsAt) return;
  syncedEndsAt = endsAt;
  if (!navigator.serviceWorker) return;
  const wanted = timerCfg().notify && window.Notification?.permission === 'granted';
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
  const s = currentSession();
  return banners() + (s ? viewSession(s) : viewCheckin());
}

function seg(key, items, cur) {
  return `<div class="seg">${items.map(([v, t]) =>
    `<button data-act="ci" data-k="${key}" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${t}</button>`).join('')}</div>`;
}

function viewCheckin() {
  const ci = ui.ci;
  const doneToday = state.sessions.filter(s => s.day === L.dayKey() && s.status === 'done');
  let h = `<header class="top"><h1>Check in</h1></header>`;
  if (doneToday.length) {
    const n = state.sets.filter(x => x.done && doneToday.some(s => s.id === x.sessionId)).length;
    h += `<div class="card muted">Done today: ${doneToday.length} session${doneToday.length > 1 ? 's' : ''}, ${n} sets.</div>`;
  }
  h += `<div class="field"><label>Where</label>${seg('locationId', state.locations.map(l => [l.id, esc(l.name)]), ci.locationId)}</div>
    <div class="field"><label>Time (min)</label>${seg('minutes', TIMES.map(t => [t, t]), ci.minutes)}</div>
    <div class="field"><label>Fatigue <span class="hint">1 fresh · 5 wrecked</span></label>${seg('fatigue', [1, 2, 3, 4, 5].map(n => [n, n]), ci.fatigue)}</div>
    <div class="field"><label>Sleep <span class="hint">optional · 1 poor · 5 great · tap again to clear</span></label>${seg('sleep', [1, 2, 3, 4, 5].map(n => [n, n]), ci.sleep)}</div>
    <div class="field"><label>Intent</label>${seg('intent', INTENTS, ci.intent)}</div>
    <label class="toggle"><input type="checkbox" data-ci-split ${ci.split ? 'checked' : ''}> I may split this across the day</label>
    <button class="primary big" data-act="suggest">Suggest a session</button>`;
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
  let h = `<header class="top"><div><h1>Today</h1>
    <div class="sub">${esc(loc?.name)} · ${s.minutes} min · ${esc(intent)} · est ${est} min</div>${s.ready ? `<div class="sub ready ${s.ready.fresh && !s.ready.heavy.length ? 'good' : ''}">${esc(readyText(s.ready))}</div>` : ''}</div>
    <span class="badge ${s.source}">${s.source}</span></header>`;
  if (!s.blocks.length) {
    h += `<div class="card muted">Nothing from your weekly goals fits this location and time. Add an exercise below, use a plan, or check in with more time.</div>`;
  }
  h += s.blocks.map(b => viewBlock(s, b, credit)).join('');
  h += `<button class="addblock" data-act="addEx">+ Add exercise</button>`;
  if (s.why?.length) {
    h += `<details class="why" ${ui.whyOpen ? 'open' : ''} data-why><summary>Why this session</summary><ul>${s.why.map(w =>
      `<li class="${w.picked ? 'picked' : ''}"><b>${esc(w.label)}</b> ${w.score.toFixed(2)}${w.picked ? ' ✓' : ''} <span class="meta">${esc(w.why.join(' · '))}${w.note ? ' · ' + esc(w.note) : ''}</span></li>`).join('')}</ul></details>`;
  }
  h += `<div class="actions">
    <button data-act="usePlan">Use a plan instead</button>
    <button data-act="recheck">New check-in</button>
    <button class="primary" data-act="finish">Finish</button></div>`;
  return h;
}

function viewBlock(s, b, credit) {
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

  if (ex.explosive && (b.tier === 'T1' || b.tier === 'T2')) {
    const rd = L.powerReadiness(state, s, ex, Date.now(), b.id);
    if (!rd.fresh) dose += `<div class="dose warn">Not fresh for power work: ${esc(rd.reasons.join('; '))}. <button class="link" data-act="toTech" data-b="${b.id}">Do it as technique</button></div>`;
  }

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
      inputs = `<input class="num" inputmode="numeric" data-set="${st.id}" data-f="time" value="${esc(st.time)}"><span class="u">sec</span>`;
    } else if (sx.metric === 'distance') {
      inputs = `<input class="num" inputmode="decimal" data-set="${st.id}" data-f="distance" value="${esc(st.distance)}"><span class="u">m</span>`;
    }
    return `<div class="set ${st.done ? 'done' : ''}"><span class="n">${i + 1}</span>${inputs}${other}
      <button class="check" data-act="check" data-id="${st.id}" aria-label="Log set">${st.done ? '✓' : ''}</button></div>`;
  }).join('');

  const vid = videoUrl(ex);
  return `<section class="block">
    <div class="bhead"><button class="tier ${b.tier}" data-act="tierEdit" data-b="${b.id}" aria-label="Change tier">${b.tier} ▾</button>
      <button class="chip" data-act="swapEx" data-b="${b.id}">${esc(ex.name)} ▾</button>
      <button class="chip" data-act="swapScheme" data-b="${b.id}">${esc(sc.name)} · ${sc.minutes}m ▾</button></div>
    <div class="meta">${info.join(' · ')} ${restBtn}</div>
    ${dose}
    <div class="sets">${rows}</div>
    <div class="brow">
      <button class="small" data-act="addSet" data-b="${b.id}">+ set</button>
      <button class="small" data-act="removeSet" data-b="${b.id}">− set</button>
      <button class="small" data-act="timerStart" data-b="${b.id}">⏱ Rest</button>
      ${vid ? `<a class="small" href="${esc(vid)}" target="_blank" rel="noopener">▶ Video</a>` : ''}
      <button class="small quiet" data-act="removeBlock" data-b="${b.id}">Remove</button>
    </div>
    ${ex.cues ? `<details class="cues"><summary>Cues</summary><p>${esc(ex.cues)}</p></details>` : ''}
  </section>`;
}

function viewWeek() {
  if (ui.goalSuggest) return viewGoalSuggest(ui.goalSuggest);
  const c = L.creditWeek(state);
  const fmt = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dayName = k => new Date(k + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' });
  let h = `<header class="top"><div><h1>This week</h1><div class="sub">${fmt(c.start)} – ${fmt(c.end - 864e5)} · ${L.daysLeftInWeek(state)} day(s) left</div></div></header>`;
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

  const sets = state.sets.filter(s => s.done && s.loggedAt >= c.start && s.loggedAt < c.end).sort((a, b) => a.loggedAt - b.loggedAt);
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
        const amount = ex?.metric === 'load_reps' ? `${ex.bodyweight ? 'BW+' : ''}${s.load ?? 0}×${s.reps}` : ex?.metric === 'time' ? `${s.time ?? '?'}s` : ex?.metric === 'distance' ? `${s.distance ?? '?'}m` : `${s.reps ?? ''} reps`;
        return `<div class="setlog"><div class="grow"><span class="tier ${s.tier}">${s.tier}</span> ${esc(ex?.name ?? '?')} <span class="meta">${esc(amount)}</span></div>
          <select data-counts="${s.id}">${opts([['auto', `Auto: ${autoLbl}`], ...state.slots.map(sl => [sl.id, slotLabel(sl)]), ['none', 'Counts toward nothing']], val)}</select></div>`;
      }).join('')}</div>`;
    }
  } else {
    h += `<p class="muted">No sets logged this week yet.</p>`;
  }
  return h;
}

function viewLibrary() {
  const q = ui.libQuery.trim().toLowerCase();
  const archivedCount = state.exercises.filter(e => e.archived).length;
  let h = `<header class="top"><h1>Library</h1><button class="primary" data-act="quickAdd">+ Exercise</button></header>
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
  return `<p class="meta pad">Each scheme sets the rest. An exercise can override it, and you can change it for today by tapping ⏱ on a block.</p>
    <div class="menu">
      ${sw('autoStart', 'Start when I log a set')}
      ${sw('sound', 'Beep when rest is over')}
      ${sw('warn10', 'Beep at 10 seconds left')}
      ${sw('vibrate', 'Vibrate when rest is over', 'Android only')}
      ${sw('keepAwake', 'Keep the screen on', 'During a session')}
      ${sw('notify', 'Notify in the background', 'Works best on Android with the app installed')}
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
    addEx: sheetAddEx, tier: sheetTier, goal: sheetGoal, scheme: sheetScheme }[s.type](s);
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
  const tier = sh.mode === 'add' ? sh.tier : findBlock(sh.blockId).b.tier;
  const rows = [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([f, list]) =>
    `<div class="label">${esc(f)}</div>${list.map(e => `<button class="row" data-act="addExPick" data-id="${e.id}"><span>${esc(e.name)}</span>
      <span class="meta">${(tier === 'T1' || tier === 'T2') && e.metric !== 'load_reps' && !e.explosive ? 'reps only' : ''}</span></button>`).join('')}`).join('');
  const raw = (sh.q || '').trim();
  return `<h3>${sh.mode === 'add' ? 'Add an exercise' : 'Swap to any exercise'}</h3>
    ${sh.mode === 'add' ? `<div class="seg tierseg">${L.TIERS.map(t => `<button class="${sh.tier === t ? 'on' : ''}" data-act="addExTier" data-t="${t}">${t}</button>`).join('')}</div>
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
    render(); window.scrollTo(0, 0);
  },

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

  startPlan: d => {
    const p = L.byId(state.plans, d.id);
    createSession(planBlocks(p), 'custom', { planId: p.id });
    render();
  },

  check: d => {
    const st = L.byId(state.sets, d.id);
    const s = L.byId(state.sessions, st.sessionId);
    if (!st.done) {
      st.done = true;
      st.loggedAt = Date.now();
      st.bw = state.settings.bodyweight;
      st.refMax = L.estimatedMax(state, st.exerciseId, s.checkinAt);
      if (!s.firstSetAt) s.firstSetAt = st.loggedAt;
      // Carry the load forward into empty rows so the next set is one tap.
      for (const o of blockSets({ id: st.blockId })) {
        if (!o.done && (o.load == null || o.load === '') && st.load != null && st.load !== '' && o.exerciseId === st.exerciseId) o.load = st.load;
      }
      unlockAudio();
      const b = s.blocks.find(x => x.id === st.blockId);
      const more = state.sets.some(x => x.sessionId === s.id && !x.done);
      if (timerCfg().autoStart && b && more) startTimer(s, b, st.id);
      else if (!more) state.timer = null; // session's last set: nothing to rest for
    } else {
      st.done = false;
      delete st.loggedAt;
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
    endSession(currentSession());
    state.timer = null;
    setWakeLock(false);
    save(); render(); toast('Session saved');
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
    } else if (sh.from === 'add' && s) {
      if (here) { addBlock(s, e, sh.tier); toast(`Added ${e.name}`); }
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
    addBlock(s, exOf(d.id), sh.tier);
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
    const logged = blockSets(b).some(x => x.done);
    state.sets = state.sets.filter(x => x.blockId !== b.id || x.done);
    if (logged) toast('Logged sets kept; the rest removed');
    else s.blocks = s.blocks.filter(x => x !== b);
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
  } else if (e.target.hasAttribute('data-libq')) {
    ui.libQuery = e.target.value;
    ui.focus = '#libq';
    render();
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
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered', err));
}

onSaveFail(() => { toast('Couldn’t save your last change. See the message at the top.'); });

closeStale();
// Drop a timer left over from an earlier visit.
if (state.timer && (!currentSession() || Date.now() - state.timer.endsAt > 10 * 60e3)) state.timer = null;
save();
render();
