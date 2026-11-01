// The interval timer (the Timer tab): Tabata, EMOM, 30/30 and anything between. Pure: no DOM, no storage.
// A config is { name, work, rest, rounds, sets, setRest, prep, exercises } (seconds; `exercises`: an exercise id per set,
// repeating when there are fewer than sets). A run is laid out as phases ahead of time, so where you are is just a
// matter of how long it has been running (pauses aside): it survives a reload or a locked phone.

export const DEFAULT_PRESETS = [
  { id: 'iv-tabata', name: 'Tabata', work: 20, rest: 10, rounds: 8, sets: 1, setRest: 60, prep: 10 },
  { id: 'iv-tabata-2x6', name: 'Tabata 2 × 6', work: 20, rest: 10, rounds: 2, sets: 6, setRest: 60, prep: 10 }, // 20/10, 20/10, a minute's rest; six times
  { id: 'iv-emom-10', name: 'EMOM 10', work: 60, rest: 0, rounds: 10, sets: 1, setRest: 0, prep: 10 },
  { id: 'iv-30-30', name: '30/30 × 10', work: 30, rest: 30, rounds: 10, sets: 1, setRest: 0, prep: 10 },
];

const n = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };

// A config with every number in range (work at least 5 s; rest, set rest and prep may be 0).
export function clean(cfg = {}) {
  return {
    name: String(cfg.name ?? '').trim() || 'Intervals',
    work: n(cfg.work, 5, 3600, 20), rest: n(cfg.rest, 0, 3600, 10),
    rounds: n(cfg.rounds, 1, 100, 8), sets: n(cfg.sets, 1, 20, 1),
    setRest: n(cfg.setRest, 0, 3600, 60), prep: n(cfg.prep, 0, 60, 10),
    exercises: Array.isArray(cfg.exercises) ? cfg.exercises.filter(Boolean) : [],
  };
}

export const exerciseFor = (cfg, set) => (cfg.exercises?.length ? cfg.exercises[(set - 1) % cfg.exercises.length] : null);

// The run, phase by phase: [{ kind: 'prep' | 'work' | 'rest' | 'setRest', secs, set, round, exerciseId }]. No rest after
// a set's last round (the rest between sets, if any, comes instead) and nothing after the last.
export function phases(raw) {
  const cfg = clean(raw), out = [];
  if (cfg.prep) out.push({ kind: 'prep', secs: cfg.prep, set: 1, round: 1, exerciseId: exerciseFor(cfg, 1) });
  for (let set = 1; set <= cfg.sets; set++) {
    for (let round = 1; round <= cfg.rounds; round++) {
      out.push({ kind: 'work', secs: cfg.work, set, round, exerciseId: exerciseFor(cfg, set) });
      if (round < cfg.rounds && cfg.rest) out.push({ kind: 'rest', secs: cfg.rest, set, round, exerciseId: exerciseFor(cfg, set) });
    }
    if (set < cfg.sets && cfg.setRest) out.push({ kind: 'setRest', secs: cfg.setRest, set, round: cfg.rounds, exerciseId: exerciseFor(cfg, set + 1) });
  }
  return out;
}

export const totalSecs = raw => phases(raw).reduce((t, p) => t + p.secs, 0);

// How long a run has been going, in ms, not counting pauses.
export const elapsed = (run, now = Date.now()) => (run.pausedAt ?? now) - run.startedAt - (run.pausedMs || 0);

// Where a run is after `ms`: { i, phase, rem (s left), frac, next } or null once it's over.
export function phaseAt(list, ms) {
  let at = 0;
  for (let i = 0; i < list.length; i++) {
    const end = at + list[i].secs * 1000;
    if (ms < end) return { i, phase: list[i], rem: Math.ceil((end - ms) / 1000), frac: (ms - at) / (list[i].secs * 1000), next: list[i + 1] ?? null };
    at = end;
  }
  return null;
}

// Start of phase i, in ms from the start of the run.
export const phaseStart = (list, i) => list.slice(0, i).reduce((t, p) => t + p.secs * 1000, 0);

// The rounds a run got through, per set: a work interval counts once it's over, or at least half done when you stopped.
// Returns [{ set, exerciseId, rounds: [{ round, endMs }] }] for sets with at least one round.
export function roundsDone(list, ms) {
  const sets = new Map();
  let at = 0;
  for (const p of list) {
    const end = at + p.secs * 1000;
    if (p.kind === 'work' && (end <= ms || ms - at >= p.secs * 500)) {
      if (!sets.has(p.set)) sets.set(p.set, { set: p.set, exerciseId: p.exerciseId, rounds: [] });
      sets.get(p.set).rounds.push({ round: p.round, endMs: Math.min(end, ms) });
    }
    at = end;
  }
  return [...sets.values()];
}

// A set's total (calories or reps) spread over its rounds: 46 over 6 rounds is 8, 8, 8, 8, 7, 7. Blank stays blank.
export function spread(total, rounds) {
  const t = total === '' || total == null ? null : Math.round(Number(total));
  if (t == null || !Number.isFinite(t) || t < 0) return Array(rounds).fill(null);
  return Array.from({ length: rounds }, (_, i) => Math.floor(t / rounds) + (i < t % rounds ? 1 : 0));
}

// "20s on / 10s off × 8", "1:00 × 10" for an EMOM.
const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export function describe(raw) {
  const c = clean(raw);
  const each = c.rest ? `${c.work}s on / ${c.rest}s off × ${c.rounds}` : `every ${clock(c.work)} × ${c.rounds}`;
  return `${each}${c.sets > 1 ? `, ${c.sets} sets${c.setRest ? ` with ${clock(c.setRest)} between` : ''}` : ''} · ${clock(totalSecs(c))}`;
}
