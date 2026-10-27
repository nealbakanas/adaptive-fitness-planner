// The weekly review: a finished week as numbers, reasons and goal changes to accept. Pure: no DOM, no storage.
// `weekReview(state, weekStart)` reads the week's sets (creditWeek), the "why" notes saved on suggested sessions, swaps
// and removals, and lift outcomes; `applyProposal` makes one accepted change to `state.slots`.
import * as L from './logic.js';
import { weekBudget, tierCost } from './goals.js';

const DAY = 864e5;
export const KEEP_WEEKS = 26;
const LOOKBACK_WEEKS = 12;
const BREAK_MIN = 30;

export const slotName = (state, sl) => L.byId(state.exercises, sl.exerciseId)?.name ?? L.byId(state.families, sl.familyId)?.name ?? '?';
export const slotLabel = (state, sl) => `${sl.tier} ${slotName(state, sl)}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Why a goal slipped, first match wins. `text` is for people; `kind` for code and tests.
export const REASONS = {
  gear: 'No location has the gear for it',
  swapped: 'Suggested, then swapped away or removed',
  fresh: 'Waited for a fresh day (power work)',
  time: 'Never fit the time',
  others: 'Other goals came first',
  jumps: 'Jumps were off at check-in',
  workouts: 'Not enough workouts',
  short: 'Done, but short of the reps',
  fewer: 'Picked fewer times than its quota',
  none: 'Not picked this week',
};

// The week that holds `t`: { start, end }.
export const weekOf = (state, t) => L.weekBounds(state, t);

// Whether the slot's goal can be done anywhere at its tier.
const doableAnywhere = (state, sl, tier = sl.tier, exerciseId = sl.exerciseId) =>
  state.locations.some(loc => L.pickExercise(state, sl.familyId, loc, tier, exerciseId));

function slipReason(state, sl, r, wk) {
  if (!doableAnywhere(state, sl)) return 'gear';
  const label = slotLabel(state, sl);
  const rows = wk.sessions.flatMap(s => (s.why || []).filter(w => (w.slotId ? w.slotId === sl.id : w.label === label)));
  const blocks = wk.sessions.flatMap(s => (s.blocks || []).filter(b => b.slotId === sl.id));
  const removed = wk.sessions.flatMap(s => (s.removed || []).filter(x => (x.slotId ? x.slotId === sl.id : x.tier === sl.tier && L.byId(state.exercises, x.exerciseId)?.familyId === sl.familyId)));
  if (removed.length || blocks.some(b => (b.swaps || []).some(w => w.type === 'exercise'))) return 'swapped';
  const notes = rows.filter(w => !w.picked).map(w => w.note || '');
  if (notes.some(n => /waits for a fresh day/.test(n))) return 'fresh';
  if (notes.some(n => /no scheme fits/.test(n))) return 'time';
  if (notes.some(n => /score too low|cap reached|favors other work/.test(n))) return 'others';
  if (notes.some(n => /jumps are off/.test(n))) return 'jumps';
  if (wk.workouts < sl.quota) return 'workouts';
  if (r && r.days.size > r.exposures) return 'short';
  return r?.filled ? 'fewer' : 'none';
}

// Last time a set counted toward the goal, before `end`.
function lastDone(state, sl, end) {
  let at = null;
  for (const s of state.sets) if (s.done && !s.warmup && s.loggedAt < end && (!at || s.loggedAt > at) && L.slotForSet(state, s) === sl.id) at = s.loggedAt;
  return at;
}

// T1/T2 lifts done in the week: up, held, down, or stalled (the same load 3 sessions running).
function liftTrends(state, start, end) {
  const seen = new Map();
  for (const s of state.sets) {
    if (!s.done || s.warmup || s.loggedAt < start || s.loggedAt >= end || (s.tier !== 'T1' && s.tier !== 'T2') || s.load == null || s.load === '') continue;
    seen.set(`${s.exerciseId}|${s.tier}`, { exerciseId: s.exerciseId, tier: s.tier });
  }
  const out = [];
  for (const { exerciseId, tier } of seen.values()) {
    const chain = [];
    let before = end;
    while (chain.length < 3) {
      const o = L.lastOutcome(state, exerciseId, tier, before);
      if (!o) break;
      chain.push(o);
      before = Math.min(...o.sets.map(x => x.loggedAt));
    }
    if (!chain.length) continue;
    const [now, prev] = chain;
    let trend = 'new';
    if (chain.length === 3 && chain.every(o => o.load === now.load)) trend = 'stalled';
    else if (prev) trend = now.load > prev.load ? 'up' : now.load < prev.load ? 'down' : 'held';
    out.push({ exerciseId, tier, name: L.byId(state.exercises, exerciseId)?.name ?? '?', load: now.load, prev: prev?.load ?? null, complete: now.complete, trend });
  }
  return out.sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name));
}

// The week's own facts: sessions, workout days, minutes, sets by tier.
function weekFacts(state, start, end) {
  const sets = state.sets.filter(s => s.done && !s.warmup && s.loggedAt >= start && s.loggedAt < end);
  const days = new Set(sets.map(s => L.dayKey(s.loggedAt)));
  const bySession = new Map();
  for (const s of sets) bySession.set(s.sessionId, [...(bySession.get(s.sessionId) || []), s.loggedAt]);
  // First set to last per workout, leaving out breaks over half an hour (a workout picked up again later in the day).
  let minutes = 0;
  for (const ts of bySession.values()) {
    ts.sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) { const g = (ts[i] - ts[i - 1]) / 6e4; if (g <= BREAK_MIN) minutes += g; }
  }
  const byTier = Object.fromEntries(L.TIERS.map(t => [t, 0]));
  for (const s of sets) if (byTier[s.tier] != null) byTier[s.tier]++;
  const sessions = state.sessions.filter(s => (s.firstSetAt ?? s.checkinAt ?? 0) >= start && (s.firstSetAt ?? s.checkinAt ?? 0) < end);
  return { workouts: days.size, minutes: Math.round(minutes), sets: sets.length, byTier, sessions };
}

// When people started using the app (imported FitNotes history doesn't count as missed goals).
const firstUse = state => Math.min(...state.sessions.filter(s => s.source !== 'imported').map(s => s.firstSetAt ?? s.checkinAt ?? Infinity), Infinity);

// Day index (0 = first day of the week) on which a goal reached its quota, or null.
function metOnDay(r, start) {
  const met = [...r.days].filter(([, a]) => a.met).map(([k]) => k).sort();
  const k = met[r.slot.quota - 1];
  return k == null ? null : Math.round((new Date(`${k}T12:00`).getTime() - start) / DAY - 0.5);
}

// The review of the week starting at `weekStart`. `finished`: false for the week in progress (no ease-off or step-up yet).
export function weekReview(state, weekStart, { now = Date.now() } = {}) {
  const { start, end } = weekOf(state, weekStart + 3600e3);
  const finished = end <= now;
  const credit = L.creditWeek(state, start + 3600e3);
  const wk = weekFacts(state, start, end);
  const used = firstUse(state);
  // Earlier weeks' credit, newest first, for "missed N weeks running" and "met early twice".
  const earlier = [];
  for (let i = 1; i <= LOOKBACK_WEEKS; i++) {
    const b = weekOf(state, start - (i - 1) * 7 * DAY - DAY);
    if (b.end <= used) break;
    earlier.push({ ...b, credit: L.creditWeek(state, b.start + 3600e3) });
  }
  const goals = [];
  for (const sl of state.slots) {
    if (!(sl.quota > 0)) continue; // paused
    const r = credit.slots.get(sl.id);
    const met = r.filled >= sl.quota;
    let missed = met ? 0 : 1;
    if (!met) for (const e of earlier) { const x = e.credit.slots.get(sl.id); if (x && x.filled < sl.quota) missed++; else break; }
    const early = d => d != null && d <= 3; // by the middle day of the week
    const earlyNow = early(metOnDay(r, start));
    const earlyPrev = earlier[0] ? early(metOnDay(earlier[0].credit.slots.get(sl.id), earlier[0].start)) : false;
    goals.push({
      slotId: sl.id, label: slotLabel(state, sl), tier: sl.tier, quota: sl.quota, filled: r.filled, met, missed,
      metEarly: earlyNow && earlyPrev, lastDone: lastDone(state, sl, end), reason: met ? null : slipReason(state, sl, r, wk),
    });
  }
  const lifts = liftTrends(state, start, end);
  const totals = {
    workouts: wk.workouts, minutes: wk.minutes, sets: wk.sets, byTier: wk.byTier,
    filled: goals.reduce((n, g) => n + g.filled, 0), quota: goals.reduce((n, g) => n + g.quota, 0),
    goalsMet: goals.filter(g => g.met).length, goals: goals.length,
  };
  const counts = new Map();
  for (const g of goals) if (g.reason) counts.set(g.reason, (counts.get(g.reason) ?? 0) + 1);
  const topReason = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const review = { weekStart: start, weekEnd: end, finished, totals, goals, lifts, topReason };
  review.proposals = proposals(state, review);
  return review;
}

// Times each proposal was skipped in earlier reviews (a proposal skipped twice for a goal isn't offered again).
export function skipCounts(state, exceptWeek = null) {
  const n = new Map();
  for (const r of state.reviews || []) {
    if (r.weekStart === exceptWeek) continue;
    for (const p of r.proposals || []) if (p.status === 'skipped') n.set(p.id, (n.get(p.id) ?? 0) + 1);
  }
  return n;
}

// Goal changes worth making: [{ id, kind, slotId, text, change }]. `change` is data for applyProposal (null: a flag only).
function proposals(state, review) {
  const out = [];
  const skipped = skipCounts(state, review.weekStart);
  const offer = p => { if ((skipped.get(p.id) ?? 0) < 2) out.push(p); };
  const budget = weekBudget(state);
  let room = budget.room;
  const after = new Map(state.slots.map(sl => [sl.id, sl.quota])); // quotas once the proposals above are accepted
  for (const g of review.goals) {
    const sl = L.byId(state.slots, g.slotId);
    const name = slotLabel(state, sl);
    if (g.reason === 'gear') {
      const here = loc => L.pickExercise(state, sl.familyId, loc, sl.tier, null);
      const swap = state.locations.map(here).find(Boolean);
      if (swap && swap.id !== sl.exerciseId) offer({ id: `gear:${sl.id}`, kind: 'gear', slotId: sl.id, text: `${name}: no location has the gear. Switch it to ${swap.name}.`, change: { exerciseId: swap.id } });
      else if (sl.tier !== 'T3' && doableAnywhere(state, sl, 'T3', null)) offer({ id: `gear:${sl.id}`, kind: 'gear', slotId: sl.id, text: `${name}: no location has the gear for it at ${sl.tier}. Make it a T3 ${L.byId(state.families, sl.familyId)?.name ?? ''} goal.`, change: { tier: 'T3', exerciseId: null } });
      else offer({ id: `gear:${sl.id}`, kind: 'gear', slotId: sl.id, text: `${name}: no location has the gear for it. Remove the goal.`, change: { remove: true } });
      continue;
    }
    if (!review.finished) continue;
    if (g.missed >= 2) {
      after.set(sl.id, g.quota - 1);
      room += tierCost(state, sl.tier);
      offer(g.quota > 1
        ? { id: `ease:${sl.id}`, kind: 'ease', slotId: sl.id, text: `${name}: missed ${g.missed} weeks running. Ease off to ${g.quota - 1}× a week.`, change: { quota: g.quota - 1 } }
        : { id: `ease:${sl.id}`, kind: 'ease', slotId: sl.id, text: `${name}: missed ${g.missed} weeks running. Pause it for now.`, change: { quota: 0 } });
    } else if (g.met && g.metEarly && g.quota < 7) {
      const cost = tierCost(state, sl.tier);
      if (room >= cost) {
        room -= cost;
        offer({ id: `step:${sl.id}`, kind: 'step', slotId: sl.id, text: `${name}: done by mid-week two weeks running. Step up to ${g.quota + 1}× a week.`, change: { quota: g.quota + 1 } });
      }
    }
  }
  // More goal time than training time, even after easing off: T3 quotas come down first, largest first, until it fits.
  if (room < 0) {
    const q = new Map(state.slots.filter(sl => sl.tier === 'T3' && after.get(sl.id) > 1).map(sl => [sl.id, after.get(sl.id)]));
    let r = room;
    const cost = tierCost(state, 'T3');
    while (r < 0) {
      const top = [...q].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])[0];
      if (!top) break;
      q.set(top[0], top[1] - 1);
      r += cost;
    }
    const trims = [...q].filter(([id, n]) => n !== after.get(id)).map(([slotId, quota]) => ({ slotId, quota }));
    if (trims.length) {
      const list = trims.map(t => `${slotName(state, L.byId(state.slots, t.slotId))} ${after.get(t.slotId)}→${t.quota}`).join(', ');
      offer({ id: 'trim', kind: 'budget', slotId: null, text: `Your goals need about ${Math.round(budget.used)} minutes a week and you train about ${Math.round(budget.total)}. Trim T3 goals: ${list}.`, change: { trims } });
    }
  }
  for (const l of review.lifts) if (l.trend === 'stalled') {
    offer({ id: `stall:${l.exerciseId}|${l.tier}`, kind: 'stalled', slotId: null, text: `${l.tier} ${l.name} has been ${l.load} for 3 sessions running. Try a different scheme or rotate the lift.`, change: null });
  }
  return out;
}

// Makes one accepted proposal's change to the goals. Returns true when something changed.
export function applyProposal(state, p) {
  const c = p.change;
  if (!c) return false;
  if (c.trims) {
    for (const t of c.trims) { const sl = L.byId(state.slots, t.slotId); if (sl) sl.quota = t.quota; }
    return true;
  }
  const sl = L.byId(state.slots, p.slotId);
  if (!sl) return false;
  if (c.remove) { state.slots = state.slots.filter(x => x !== sl); return true; }
  if (c.quota != null) sl.quota = c.quota;
  if (c.tier) sl.tier = c.tier;
  if ('exerciseId' in c) { if (c.exerciseId) sl.exerciseId = c.exerciseId; else delete sl.exerciseId; }
  return true;
}

// The stored record of a review: { id, weekStart, summary, proposals: [{ id, kind, text, status }], status }.
// status: 'open', 'reviewed' or 'dismissed'. Newest KEEP_WEEKS weeks are kept.
export function recordReview(state, review, status = 'reviewed') {
  state.reviews ??= [];
  const id = `wk-${review.weekStart}`;
  let rec = state.reviews.find(r => r.id === id);
  if (!rec) {
    rec = { id, weekStart: review.weekStart, proposals: [] };
    state.reviews.push(rec);
  }
  rec.summary = { ...review.totals, topReason: review.topReason };
  for (const p of review.proposals) if (!rec.proposals.some(x => x.id === p.id)) rec.proposals.push({ id: p.id, kind: p.kind, text: p.text, status: 'open' });
  if (rec.status !== 'reviewed') rec.status = status;
  state.reviews.sort((a, b) => b.weekStart - a.weekStart);
  state.reviews.length = Math.min(state.reviews.length, KEEP_WEEKS);
  return rec;
}

export const reviewRecord = (state, weekStart) => (state.reviews || []).find(r => r.weekStart === weekStart) ?? null;

// The Last week card: shown on a new week when last week had training or goals, until reviewed or dismissed.
export function lastWeekDue(state, now = Date.now()) {
  const { start } = weekOf(state, now);
  const last = weekOf(state, start - DAY);
  if (last.end <= firstUse(state)) return null;
  const rec = reviewRecord(state, last.start);
  if (rec && (rec.status === 'reviewed' || rec.status === 'dismissed')) return null;
  return last.start;
}

// Plain text to paste to Claude or a coach.
export function reviewText(state, review) {
  const d = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const t = review.totals;
  const lines = [
    `Week of ${d(review.weekStart)} – ${d(review.weekEnd - DAY)}${review.finished ? '' : ' (so far)'}`,
    `${plural(t.workouts, 'workout')}, ${t.minutes} min trained, ${t.sets} working sets (${L.TIERS.filter(x => t.byTier[x]).map(x => `${x} ${t.byTier[x]}`).join(', ') || 'none'})`,
    `Goal sessions: ${t.filled} of ${t.quota}; goals met: ${t.goalsMet} of ${t.goals}`,
    '',
    'Goals:',
    ...review.goals.map(g => `- ${g.label}: ${g.filled}/${g.quota}${g.met ? ' ✓' : ` — ${REASONS[g.reason]}${g.missed >= 2 ? ` (missed ${g.missed} weeks running)` : ''}`}`),
  ];
  if (review.lifts.length) lines.push('', 'Lifts:', ...review.lifts.map(l => `- ${l.tier} ${l.name}: ${l.load}${l.prev != null ? ` (was ${l.prev})` : ''} — ${l.trend}${l.complete ? '' : ', reps missed'}`));
  if (review.proposals.length) lines.push('', 'Proposed:', ...review.proposals.map(p => `- ${p.text}`));
  return lines.join('\n');
}
