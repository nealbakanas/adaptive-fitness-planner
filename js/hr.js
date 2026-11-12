// A Bluetooth heart-rate strap (any chest strap with the standard heart-rate service: Powr Labs, Polar, Wahoo, Garmin).
// Chrome on Android, Mac, Windows and ChromeOS can reach Bluetooth from a web page; Safari on iPhone can't.
// No DOM and no storage: the app shows the readings and keeps the recording on the workout.
//   recording = { t0, step, v: [bpm, ...], max }: one average per `step` seconds from t0 (0 where there was no reading),
//   and the highest single reading (averaging would hide the peak).

export const STEP = 5;        // seconds per sample while a workout is open
export const KEEP_STEP = 15;  // seconds per sample once it's finished (slimHistory)
const RETRIES = [1, 2, 5, 10, 20]; // seconds between attempts to reconnect after the strap drops

// ---------- pure ----------

// The Heart Rate Measurement value (Bluetooth spec): flags, then the rate as 8 or 16 bits. Null when it can't be read.
export function parseMeasurement(view) {
  if (!view || view.byteLength < 2) return null;
  const flags = view.getUint8(0);
  const wide = flags & 1;
  if (wide && view.byteLength < 3) return null;
  const bpm = wide ? view.getUint16(1, true) : view.getUint8(1);
  return bpm > 0 && bpm < 255 ? bpm : null;
}

// Adds one reading to a recording, averaging readings that land in the same step. Returns the recording.
export function addSample(rec, t, bpm, step = STEP) {
  if (!rec) rec = { t0: t, step, v: [] };
  const i = Math.floor((t - rec.t0) / (rec.step * 1000));
  if (i < 0) return rec;
  if (i - rec.v.length > 3600) return rec; // a gap of hours: not this workout
  while (rec.v.length <= i) rec.v.push(0);
  rec.n ??= [];
  while (rec.n.length <= i) rec.n.push(0);
  const k = rec.n[i];
  rec.v[i] = Math.round((rec.v[i] * k + bpm) / (k + 1));
  rec.n[i] = k + 1;
  if (!(rec.max >= bpm)) rec.max = bpm;
  return rec;
}

// The recording without its working counts, coarser: `step` seconds a sample (averages of the readings in each).
export function resample(rec, step = KEEP_STEP) {
  if (!rec?.v?.length) return null;
  if (rec.step >= step && !rec.n) return rec;
  const f = Math.max(1, Math.round(step / rec.step));
  const v = [];
  for (let i = 0; i < rec.v.length; i += f) {
    const xs = rec.v.slice(i, i + f).filter(x => x > 0);
    v.push(xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  }
  while (v.length && !v.at(-1)) v.pop();
  return v.length ? { t0: rec.t0, step: rec.step * f, v, ...(rec.max ? { max: rec.max } : {}) } : null;
}

// Average and peak over [from, to) (all of it by default): { avg, max, minutes } or null with no readings. Over the whole
// recording the peak is the highest single reading; over a window, the highest average in it.
export function summary(rec, from = -Infinity, to = Infinity) {
  if (!rec?.v?.length) return null;
  let sum = 0, n = 0, max = 0;
  rec.v.forEach((x, i) => {
    const t = rec.t0 + i * rec.step * 1000;
    if (!(x > 0) || t < from || t >= to) return;
    sum += x; n++; if (x > max) max = x;
  });
  const whole = from === -Infinity && to === Infinity;
  return n ? { avg: Math.round(sum / n), max: whole && rec.max > max ? rec.max : max, minutes: Math.round(n * rec.step / 60) } : null;
}

// The readings as points for a chart: [{ t, v }], gaps left out.
export const points = rec => (rec?.v ?? []).map((v, i) => ({ t: rec.t0 + i * rec.step * 1000, v })).filter(p => p.v > 0);

// ---------- the strap ----------

const bt = () => globalThis.navigator?.bluetooth;
export const supported = () => !!bt()?.requestDevice;

let device = null, chr = null, listeners = [], retry = 0, retryTimer = null, wanted = false;
export const live = { status: 'off', bpm: null, at: 0, name: null }; // status: off, connecting, live, lost
export function onChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter(x => x !== fn); }; }
const tell = () => { for (const fn of listeners) { try { fn(live); } catch (e) { console.warn(e); } } };
const set = patch => { Object.assign(live, patch); tell(); };

function onValue(e) {
  const bpm = parseMeasurement(e.target.value);
  if (bpm == null) return;
  set({ status: 'live', bpm, at: Date.now() });
}

async function attach(d) {
  device = d;
  set({ status: 'connecting', name: d.name || 'Heart rate strap' });
  d.removeEventListener?.('gattserverdisconnected', onDrop);
  d.addEventListener?.('gattserverdisconnected', onDrop);
  const server = await d.gatt.connect();
  const svc = await server.getPrimaryService('heart_rate');
  chr = await svc.getCharacteristic('heart_rate_measurement');
  chr.addEventListener('characteristicvaluechanged', onValue);
  await chr.startNotifications();
  retry = 0;
  set({ status: 'live', at: Date.now() });
}

// The strap dropped (out of range, battery, a loose strap): try again a few times, waiting longer each time.
function onDrop() {
  chr = null;
  if (!wanted || !device) return set({ status: 'off', bpm: null });
  set({ status: 'lost', bpm: null });
  clearTimeout(retryTimer);
  if (retry >= RETRIES.length) return set({ status: 'off' });
  retryTimer = setTimeout(async () => {
    retry++;
    try { await attach(device); } catch { onDrop(); }
  }, RETRIES[retry] * 1000);
}

// Asks Chrome to show its device list (must come from a tap). Resolves the strap's name; throws with a message to show.
export async function connect() {
  if (!supported()) throw new Error('This browser can’t reach Bluetooth. Use Chrome on Android or a computer.');
  wanted = true;
  let d;
  try { d = await bt().requestDevice({ filters: [{ services: ['heart_rate'] }] }); }
  catch (e) { wanted = !!device; throw new Error(e?.name === 'NotFoundError' ? 'No strap picked. Wet the strap’s pads, put it on, and try again.' : e?.message || 'Couldn’t connect.'); }
  try { await attach(d); }
  catch (e) { set({ status: 'off' }); throw new Error(`Couldn’t connect to ${d.name || 'the strap'}. Put it on (it sleeps when it’s off you) and try again.`); }
  return live.name;
}

// Without a tap: the strap you picked before, where Chrome lets a page find it again (getDevices). True when it's live.
export async function reconnect(name = null) {
  if (!bt()?.getDevices || live.status === 'live' || live.status === 'connecting') return live.status === 'live';
  try {
    const ds = await bt().getDevices();
    const d = ds.find(x => !name || x.name === name) ?? null;
    if (!d) return false;
    wanted = true;
    await attach(d);
    return true;
  } catch { set({ status: 'off' }); return false; }
}

export function disconnect() {
  wanted = false;
  clearTimeout(retryTimer);
  try { chr?.removeEventListener('characteristicvaluechanged', onValue); } catch { /* gone already */ }
  try { device?.gatt?.disconnect(); } catch { /* gone already */ }
  device = null; chr = null;
  set({ status: 'off', bpm: null });
}

// A reading older than this isn't "now" any more (the strap stopped sending without dropping the connection).
export const fresh = (t = Date.now()) => live.status === 'live' && live.bpm != null && t - live.at < 10e3;
