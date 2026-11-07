// Program blocks: a plan group (e.g. the THP-style jump plan) runs for a set number of weeks and owns a slice of your
// training (a body half for T1/T2 work, and/or whole tiers like JUMP). Inside the slice your weekly goals pause and the
// script decides; outside it everything runs as before. Pure: no DOM, no storage.
//   state.block  = the running block or null: { id, group, schedule: [{ weekday, planId }], owns: { half, tiers },
//                  weeks, deloadEvery, startedAt, pausedAt, pausedMs }
//   state.blocks = finished blocks, newest first, each with its `endedAt` and `report`.
// Which program session is due is worked out from what you've done this week, so a missed Monday means Tuesday
// offers Monday's session, and moving a session to tomorrow is simply not doing it today.
import * as L from './logic.js';
import * as M from './morning.js';

const DAY = 864e5, WEEK = 7 * DAY;
export const DELOAD_CUT = 0.4;           // deload weeks: 40% fewer sets, nothing else changes
export const BEFORE_WEEKS = 4;           // the end report compares the block with this many weeks before it
export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const groupPlans = (state, group) => state.plans.filter(p => p.group === group);

// Weekdays named in a plan's name: "THP · High day A (Mon)" → [1]; "(Tue/Thu)" → [2, 4].
export function planDays(name = '') {
  const m = String(name).match(/\(([^)]*)\)/);
  if (!m) return [];
  return m[1].split(/[\/,&+]| and /i).map(x => WEEKDAY_NAMES.findIndex(d => x.trim().toLowerCase().startsWith(d.toLowerCase()))).filter(i => i >= 0);
}

// Upper, lower or null for a goal: from its exercise, else its family's usual one.
export function slotHalf(state, sl) {
  const ex = L.byId(state.exercises, sl.exerciseId ?? L.byId(state.families, sl.familyId)?.defaultExerciseId);
  return ex ? L.bodyRegion(state, ex) : null;
}
const exHalf = (state, id) => { const ex = L.byId(state.exercises, id); return ex ? L.bodyRegion(state, ex) : null; };

// A first draft of a block for a plan group: weekdays from the plans' names (the first one named for "Fri/Sat"),
// a slice from what the plans hold (the half all their T1/T2 lifts are in, and jumps if they have any), 4 weeks with a
// deload in the 4th, starting next week.
export function draftFor(state, group) {
  const plans = groupPlans(state, group);
  const schedule = [];
  const taken = new Set();
  for (const p of plans) {
    // Two days side by side ("Fri/Sat") are a choice: the first one. Days apart ("Tue/Thu") are both.
    const days = planDays(p.name);
    const choice = days.length === 2 && (days[1] - days[0] + 7) % 7 === 1;
    for (const wd of choice ? days.slice(0, 1) : days) if (!taken.has(wd)) { schedule.push({ weekday: wd, planId: p.id }); taken.add(wd); }
  }
  const items = plans.flatMap(p => p.items);
  const halves = new Set(items.filter(i => L.isStrength(i.tier)).map(i => exHalf(state, i.exerciseId)).filter(Boolean));
  return {
    group, schedule: schedule.sort((a, b) => a.weekday - b.weekday),
    owns: { half: halves.size === 1 ? [...halves][0] : null, tiers: items.some(i => i.tier === 'JUMP') ? ['JUMP'] : [] },
    weeks: 4, deloadEvery: 4, start: 'next',
  };
}

// ---------- time ----------

export const weekStartOf = (state, t) => L.weekBounds(state, t).start;
// When the block ends: the start of the week after its last, pushed back by any time it was paused.
export const endsAt = (state, b) => weekStartOf(state, b.startedAt) + b.weeks * WEEK + (b.pausedMs || 0) + (b.pausedAt ? Math.max(0, Date.now() - b.pausedAt) : 0);
// Week of the block holding `t`, 1-based (pauses don't count).
export function weekNo(state, b, t = Date.now()) {
  const paused = (b.pausedMs || 0) + (b.pausedAt ? Math.max(0, t - b.pausedAt) : 0);
  return Math.floor((weekStartOf(state, t - paused) - weekStartOf(state, b.startedAt)) / WEEK + 0.5) + 1;
}
export const isDeload = (b, wk) => !!b.deloadEvery && wk % b.deloadEvery === 0;

// The block that owns training at `t`: the running one (not paused), or a finished one that covered that time.
export function blockAt(state, t = Date.now()) {
  const b = state.block;
  if (b && !b.pausedAt && t >= b.startedAt && t < endsAt(state, b)) return b;
  return (state.blocks || []).find(x => t >= x.startedAt && t < (x.endedAt ?? 0)) ?? null;
}

// ---------- the slice ----------

export const ownsSlot = (state, b, sl) => !!b && (b.owns.tiers.includes(sl.tier) || (!!b.owns.half && L.isStrength(sl.tier) && slotHalf(state, sl) === b.owns.half));
export const ownedSlotIds = (state, t = Date.now()) => { const b = blockAt(state, t); return new Set(b ? state.slots.filter(sl => ownsSlot(state, b, sl)).map(sl => sl.id) : []); };
// A set in the slice (for volume): an owned tier, or T1/T2 work in the owned half.
const setOwned = (state, b, s) => b.owns.tiers.includes(s.tier) || (!!b.owns.half && L.isStrength(s.tier) && exHalf(state, s.exerciseId) === b.owns.half);
// "lower-body T1/T2 and jumps"
export function ownsText(b) {
  const parts = [b.owns.half ? `${b.owns.half}-body T1/T2` : null, ...b.owns.tiers.map(t => (t === 'JUMP' ? 'jumps' : t === 'COND' ? 'conditioning' : t))].filter(Boolean);
  return parts.length ? parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : 'nothing';
}

// ---------- what's due ----------

const offset = (state, wd) => (wd - state.settings.weekStartDay + 7) % 7;
// The week's program sessions in order: [{ weekday, planId }].
export const sequence = (state, b) => [...b.schedule].filter(x => L.byId(state.plans, x.planId)).sort((x, y) => offset(state, x.weekday) - offset(state, y.weekday));

// Workouts started from the block that have a set done.
export const blockSessions = (state, b) => state.sessions.filter(s => s.blockRun === b.id && state.sets.some(x => x.sessionId === s.id && x.done && !x.warmup));

// Where the block stands today: { block, week, deload, due, next, doneToday, done, scheduled }. `due`: the session to do
// today (today's, or one you're behind on), else null; `next`: the next one in order, even if it isn't due yet.
export function today(state, t = Date.now()) {
  const b = state.block;
  if (!b || b.pausedAt || t < b.startedAt || t >= endsAt(state, b)) return null;
  const { start, end } = L.weekBounds(state, t);
  const seq = sequence(state, b);
  const week = blockSessions(state, b).filter(s => (s.firstSetAt ?? s.checkinAt) >= start && (s.firstSetAt ?? s.checkinAt) < end);
  const doneToday = week.some(s => s.day === L.dayKey(t));
  const next = seq[week.length] ?? null;
  const todayOff = offset(state, new Date(t).getDay());
  const due = !doneToday && next && offset(state, next.weekday) <= todayOff ? { ...next, behind: offset(state, next.weekday) < todayOff } : null;
  const wk = weekNo(state, b, t);
  return { block: b, week: wk, deload: isDeload(b, wk), due, next, doneToday, done: week.length, scheduled: seq.length, sessions: week };
}

// The plan's sets, cut for a deload: `n` sets become round(n × 0.6), at least 1.
export const deloadSets = n => Math.max(1, Math.round(n * (1 - DELOAD_CUT)));

// Whether a program workout was done as written: every plan item there, at its scheme, every set done.
export function asWritten(state, s) {
  if (!s.planItems?.length) return false;
  return s.planItems.every(it => {
    const b = s.blocks.find(x => x.exerciseId === it.exerciseId && x.tier === it.tier && x.schemeId === it.schemeId && !(x.swaps || []).length);
    if (!b) return false;
    const sets = state.sets.filter(x => x.blockId === b.id && !x.warmup);
    return sets.length > 0 && sets.every(x => x.done);
  });
}

// ---------- start, pause, end ----------

export function startBlock(state, draft, t = Date.now()) {
  const startedAt = draft.start === 'today' ? L.startOfDay(t) : L.weekBounds(state, t).end;
  state.block = {
    id: L.uid(), group: draft.group, schedule: draft.schedule.map(x => ({ weekday: x.weekday, planId: x.planId })),
    owns: { half: draft.owns.half ?? null, tiers: [...draft.owns.tiers] },
    weeks: Math.max(2, Math.min(16, Math.round(draft.weeks) || 4)), deloadEvery: draft.deloadEvery || 0,
    startedAt, pausedAt: null, pausedMs: 0,
  };
  return state.block;
}
export function pauseBlock(state, t = Date.now()) { if (state.block && !state.block.pausedAt) state.block.pausedAt = t; }
export function resumeBlock(state, t = Date.now()) {
  const b = state.block;
  if (b?.pausedAt) { b.pausedMs = (b.pausedMs || 0) + Math.max(0, t - b.pausedAt); b.pausedAt = null; }
}
// Finishes the running block (early when before its end) and keeps it with its report. Returns the finished record.
export function endBlock(state, t = Date.now()) {
  const b = state.block;
  if (!b) return null;
  resumeBlock(state, t);
  const end = Math.min(t, endsAt(state, b));
  const done = { ...b, endedAt: end, early: t < endsAt(state, b) };
  done.report = report(state, done);
  done.reportSeen = false;
  state.blocks = [done, ...(state.blocks || [])];
  state.block = null;
  return done;
}
// A block past its end is finished on the next look (its report then waits on Today).
export function settle(state, t = Date.now()) {
  if (state.block && !state.block.pausedAt && t >= endsAt(state, state.block)) return endBlock(state, t);
  return null;
}
export const unseenReport = state => (state.blocks || []).find(x => x.reportSeen === false) ?? null;

// ---------- the end report ----------

// Workout weeks in [from, to): [{ start, end, sessions }] (sessions with a set done).
function weeksIn(state, from, to) {
  const out = [];
  for (let w = weekStartOf(state, from); w < to; w = L.weekBounds(state, w + WEEK + 3600e3).start) {
    const { start, end } = L.weekBounds(state, w + 3600e3);
    const sessions = state.sessions.filter(s => s.source !== 'imported' && (s.firstSetAt ?? 0) >= Math.max(start, from) && (s.firstSetAt ?? 0) < Math.min(end, to)
      && state.sets.some(x => x.sessionId === s.id && x.done && !x.warmup)).length;
    out.push({ start, end, sessions });
  }
  return out;
}

function windowStats(state, b, from, to, weeks) {
  const sets = state.sets.filter(s => s.done && !s.warmup && s.loggedAt >= from && s.loggedAt < to);
  const n = Math.max(1, weeks.length);
  const plans = groupPlans(state, b.group);
  const lifts = [...new Set(plans.flatMap(p => p.items).filter(i => i.tier === 'T1').map(i => i.exerciseId))]
    .filter(id => L.byId(state.exercises, id)?.metric === 'load_reps');
  const e1rm = Object.fromEntries(lifts.map(id => [id, Math.max(0, ...sets.filter(s => s.exerciseId === id).map(s => L.setE1rm(state, s) || 0)) || null]));
  const jumpIds = [...new Set([...plans.flatMap(p => p.items).filter(i => i.tier === 'JUMP').map(i => i.exerciseId), ...sets.filter(s => s.jump > 0).map(s => s.exerciseId)])];
  const jumps = Object.fromEntries(jumpIds.map(id => [id, Math.max(0, ...sets.filter(s => s.exerciseId === id && s.jump > 0).map(s => Number(s.jump))) || null]));
  const owned = sets.filter(s => setOwned(state, b, s)).length / n;
  // Your other goals: goal sessions filled over quota, for goals outside the slice, across whole weeks in the window.
  let filled = 0, quota = 0;
  for (const w of weeks) {
    const c = L.creditWeek(state, w.start + 3600e3);
    for (const sl of state.slots) if (L.counted(state, sl) && !ownsSlot(state, b, sl)) { filled += Math.min(c.slots.get(sl.id)?.filled ?? 0, sl.quota); quota += sl.quota; }
  }
  return {
    weeks: weeks.length, sessionsPerWeek: weeks.reduce((x, w) => x + w.sessions, 0) / n,
    e1rm, jumps, ownedSetsPerWeek: owned, goalsHit: quota ? filled / quota : null,
    painFlags: M.painFlags(state, from, to).length, energy: M.averageEnergy(state, from, to),
  };
}

// The block against the weeks before it: { block, before (null when fewer than 2 usable weeks), adherence, verdict }.
// Usable weeks before: the BEFORE_WEEKS before the block's first week, leaving out weeks with fewer than 2 workouts.
export function report(state, b) {
  const first = weekStartOf(state, b.startedAt);
  const to = b.endedAt ?? Date.now();
  const blockWeeks = weeksIn(state, b.startedAt, to);
  const beforeWeeks = weeksIn(state, first - BEFORE_WEEKS * WEEK + 3600e3, first).filter(w => w.sessions >= 2);
  const sessions = blockSessions(state, b);
  const out = {
    weeks: blockWeeks.length, early: !!b.early,
    block: windowStats(state, b, b.startedAt, to, blockWeeks),
    before: beforeWeeks.length >= 2 ? windowStats(state, b, beforeWeeks[0].start, first, beforeWeeks) : null,
    sessions: sessions.length, asWritten: sessions.filter(s => asWritten(state, s)).length,
    edited: groupPlans(state, b.group).some(p => (p.editedAt ?? 0) > b.startedAt),
  };
  out.adherence = out.sessions ? out.asWritten / out.sessions : null;
  out.verdict = verdict(state, out);
  return out;
}

const signed = (x, u) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x))}${u}`;
// One line from the numbers only: what moved. No advice.
export function verdict(state, r) {
  const name = id => L.byId(state.exercises, id)?.name ?? '?';
  const u = state.settings.unit ?? 'lb', ju = jumpUnit(state);
  const bits = [];
  if (r.before) {
    for (const [id, v] of Object.entries(r.block.e1rm)) { const was = r.before.e1rm[id]; if (v && was) bits.push(`${name(id)} e1RM ${signed(v - was, ` ${u}`)}`); }
    for (const [id, v] of Object.entries(r.block.jumps)) { const was = r.before.jumps[id]; if (v && was) bits.push(`${name(id)} ${signed(v - was, ` ${ju}`)}`); }
    if (r.block.goalsHit != null && r.before.goalsHit != null) bits.push(`your other goals ${Math.round(100 * r.before.goalsHit)}% → ${Math.round(100 * r.block.goalsHit)}%`);
  } else {
    for (const [id, v] of Object.entries(r.block.e1rm)) if (v) bits.push(`${name(id)} e1RM ${Math.round(v)} ${u}`);
    for (const [id, v] of Object.entries(r.block.jumps)) if (v) bits.push(`${name(id)} best ${v} ${ju}`);
  }
  if (r.adherence != null) bits.push(`${r.asWritten} of ${r.sessions} sessions as written`);
  return bits.length ? `${bits.join(', ')}.` : 'Not enough logged to compare yet.';
}

export const jumpUnit = state => (state.settings?.unit === 'kg' ? 'cm' : 'in');

// Plain text to paste to Claude or a coach.
export function reportText(state, b) {
  const r = b.report ?? report(state, b);
  const d = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const name = id => L.byId(state.exercises, id)?.name ?? '?';
  const u = state.settings.unit ?? 'lb', ju = jumpUnit(state);
  const num = (v, unit = '', dp = 0) => (v == null ? '—' : `${dp ? v.toFixed(dp) : Math.round(v)}${unit}`);
  const pair = (f, unit = '', dp = 0) => `${r.before ? `${num(f(r.before), unit, dp)} → ` : ''}${num(f(r.block), unit, dp)}`;
  const lines = [
    `${b.group}: ${d(b.startedAt)} – ${d((b.endedAt ?? Date.now()) - 1)}, ${r.weeks} week${r.weeks === 1 ? '' : 's'}${r.early ? ' (ended early)' : ''}`,
    `Owned: ${ownsText(b)}`,
    r.before ? `Compared with ${r.before.weeks} weeks before it.` : 'Fewer than 2 usable weeks before it, so the block alone.',
    '',
    `Sessions per week: ${pair(x => x.sessionsPerWeek, '', 1)}`,
    `Program sessions as written: ${r.asWritten} of ${r.sessions}${r.edited ? ' (plans were edited during the block)' : ''}`,
    ...Object.keys(r.block.e1rm).map(id => `${name(id)} e1RM: ${pair(x => x.e1rm[id], ` ${u}`)}`),
    ...Object.keys(r.block.jumps).map(id => `${name(id)} best: ${pair(x => x.jumps[id], ` ${ju}`)}`),
    `Sets per week in the slice: ${pair(x => x.ownedSetsPerWeek, '', 1)}`,
    `Your other goals hit: ${pair(x => (x.goalsHit == null ? null : 100 * x.goalsHit), '%')}`,
    `Pain flags: ${pair(x => x.painFlags)}`,
    `Average morning energy: ${pair(x => x.energy, '', 1)}`,
    '',
    r.verdict,
  ];
  return lines.join('\n');
}

// The block's line in a weekly review: "4 of 5 sessions as written, 1 changed".
export function weekLine(state, start, end) {
  const b = blockAt(state, start + 3.5 * DAY) ?? (state.block && state.block.startedAt < end ? state.block : null);
  if (!b) return null;
  const sessions = blockSessions(state, b).filter(s => (s.firstSetAt ?? s.checkinAt) >= start && (s.firstSetAt ?? s.checkinAt) < end);
  const written = sessions.filter(s => asWritten(state, s)).length;
  const sched = b.schedule.length;
  return { group: b.group, scheduled: sched, done: sessions.length, asWritten: written,
    text: `${b.group}: ${sessions.length} of ${sched} sessions${sessions.length ? `, ${written} as written` : ''}` };
}
