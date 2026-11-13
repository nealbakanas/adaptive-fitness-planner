// Photos to play behind the running timer. You pick them from the phone (on Android the picker includes your Google
// Photos), they're shrunk to screen size and kept in IndexedDB on this device only: never synced or backed up, and not
// in the saved data. Every function resolves and never throws; without IndexedDB there are simply no photos.
// Test pages name their own database (globalThis.AFP_PHOTOS_NAME).

const NAME = globalThis.AFP_PHOTOS_NAME ?? 'afp-photos';
export const MAX_SIDE = 1600;   // longest side kept, in pixels: sharp on a phone, about 200-400 KB a photo
export const MAX_PHOTOS = 300;

let dbP = null;
function open() {
  if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve(null);
  dbP ??= new Promise(resolve => {
    try {
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('photos', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbP;
}
async function run(mode, fn) {
  const db = await open();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx = db.transaction('photos', mode);
      let value = null;
      tx.oncomplete = () => resolve({ value });
      tx.onerror = tx.onabort = () => resolve(null);
      fn(tx.objectStore('photos'), v => { value = v; });
    } catch { resolve(null); }
  });
}

// The size a photo is kept at: the longest side at most `max`, never enlarged.
export function fitSize(w, h, max = MAX_SIDE) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// A picked file, upright and shrunk, as a JPEG blob; null when the browser can't read it (some HEIC files).
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { w, h } = fitSize(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  } catch { return null; }
}

// Adds picked files. Resolves { added, failed, full } (full: over MAX_PHOTOS, the rest weren't added).
export async function add(files) {
  let added = 0, failed = 0, have = await count();
  for (const f of files) {
    if (have >= MAX_PHOTOS) return { added, failed, full: true };
    const blob = await shrink(f);
    if (!blob) { failed++; continue; }
    const ok = await run('readwrite', st => st.put({ id: `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, blob, at: Date.now() }));
    if (ok) { added++; have++; } else failed++;
  }
  return { added, failed, full: false };
}

export async function ids() {
  const r = await run('readonly', (st, set) => { st.getAllKeys().onsuccess = e => set(e.target.result); });
  return r?.value ?? [];
}
export const count = async () => (await ids()).length;
export async function get(id) {
  const r = await run('readonly', (st, set) => { st.get(id).onsuccess = e => set(e.target.result?.blob ?? null); });
  return r?.value ?? null;
}
export async function clear() { return !!(await run('readwrite', st => st.clear())); }

// A shuffled order (Fisher-Yates), so each run plays them differently. `rand` for tests.
export function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
