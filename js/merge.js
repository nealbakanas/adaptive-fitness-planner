// Merging two devices' data. Pure: no DOM, no storage. A three-way merge against `base`, the data as of the last sync:
// a change made on only one side is kept, a record deleted on one side (present in base, missing there) stays deleted
// unless the other side edited it, and when both sides changed the same record or setting the side saved most recently wins.
// With no base (a first sync), everything present on either side is kept and the newer side wins ties.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// One value that may have changed on either side. `newer`: 'local' or 'remote', who wins a real conflict.
function pick(b, l, r, newer) {
  if (same(l, r)) return l;
  if (same(l, b)) return r;
  if (same(r, b)) return l;
  return newer === 'local' ? l : r;
}

// Plain objects merge key by key (settings, tiers, programs), nested ones too.
export function mergeObject(b, l, r, newer) {
  const out = {};
  for (const k of new Set([...Object.keys(l ?? {}), ...Object.keys(r ?? {})])) {
    const bv = b?.[k], lv = l?.[k], rv = r?.[k];
    const v = isObj(lv) && isObj(rv) && (bv === undefined || isObj(bv)) ? mergeObject(bv, lv, rv, newer) : pick(bv, lv, rv, newer);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Arrays of records with an `id`: the union, with deletions. Local order first, then what only the other side has.
export function mergeById(base, local, remote, newer) {
  const B = new Map((base ?? []).map(x => [x.id, x])), L = new Map((local ?? []).map(x => [x.id, x])), R = new Map((remote ?? []).map(x => [x.id, x]));
  const keep = id => {
    const b = B.get(id), l = L.get(id), r = R.get(id);
    if (l && r) return b === undefined ? (same(l, r) ? l : newer === 'local' ? l : r) : pick(b, l, r, newer);
    if (l) return b !== undefined && same(l, b) ? undefined : l; // the other side deleted it: gone unless this side edited it
    if (r) return b !== undefined && same(r, b) ? undefined : r;
    return undefined;
  };
  const out = [];
  for (const id of [...L.keys(), ...[...R.keys()].filter(id => !L.has(id))]) { const v = keep(id); if (v !== undefined) out.push(v); }
  return out;
}

const ARRAYS = ['sessions', 'sets', 'exercises', 'families', 'slots', 'schemes', 'plans', 'locations', 'reviews'];
const OBJECTS = ['settings', 'tiers', 'programs', 'imports'];
const MOBILITY_ARRAYS = ['exercises', 'routines', 'sessions'];

// Merges two whole states. `base` may be null. Returns a new state (not yet migrated). `timer` stays this device's.
export function mergeStates(base, local, remote) {
  const newer = (local.savedAt ?? 0) >= (remote.savedAt ?? 0) ? 'local' : 'remote';
  const out = { ...remote, ...local };
  for (const k of ARRAYS) out[k] = mergeById(base?.[k], local[k], remote[k], newer);
  for (const k of OBJECTS) out[k] = mergeObject(base?.[k], local[k], remote[k], newer);
  out.mobility = { ...mergeObject(base?.mobility, local.mobility, remote.mobility, newer) };
  for (const k of MOBILITY_ARRAYS) out.mobility[k] = mergeById(base?.mobility?.[k], local.mobility?.[k], remote.mobility?.[k], newer);
  out.equipment = [...new Set([...(local.equipment ?? []), ...(remote.equipment ?? [])])];
  out.version = Math.max(local.version ?? 0, remote.version ?? 0);
  out.savedAt = Math.max(local.savedAt ?? 0, remote.savedAt ?? 0) || null;
  out.timer = local.timer ?? null;
  return out;
}
