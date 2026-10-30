// Offline support and rest-timer notifications.

const CACHE = 'afp-v24'; // bump with every release: the page shows it under Settings, so you can tell which version you're on
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.json',
  'js/app.js', 'js/logic.js', 'js/store.js', 'js/seed.js', 'js/fitnotes.js', 'js/goals.js', 'js/mobility.js', 'js/programs.js', 'js/library.js', 'js/onboard.js', 'js/vault.js', 'js/cloud.js', 'js/cloud-config.js', 'js/sync.js', 'js/merge.js', 'js/taste.js', 'js/pace.js', 'js/review.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT = 2500; // slow gym signal: fall back to cache after this

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Network first so updates show up immediately; cache when offline or slow.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(networkFirst(e, req));
});

async function networkFirst(e, req) {
  const cache = await caches.open(CACHE);
  // no-cache: always ask the server (a cheap 304 when nothing changed), never the browser's 10-minute HTTP cache.
  const net = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  e.waitUntil(net.catch(() => {}));
  try {
    return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), NETWORK_TIMEOUT))]);
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' && await cache.match('index.html'));
    // Slow signal: the saved copy is served now. When the real one arrives and differs, tell the page, so it can offer a reload
    // instead of staying on an old version until the next visit.
    if (hit) e.waitUntil(net.then(res => { if (res.ok && changed(hit, res)) return tellPages({ type: 'update-ready' }); }, () => {}));
    return hit || net; // nothing cached yet: keep waiting on the network
  }
}

// Whether the fresh response differs from the saved one (by ETag or Last-Modified; unknown counts as changed).
function changed(a, b) {
  for (const h of ['etag', 'last-modified']) {
    const x = a.headers.get(h), y = b.headers.get(h);
    if (x && y) return x !== y;
  }
  return true;
}

async function tellPages(msg) {
  for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) w.postMessage(msg);
}

// ---------- rest notifications ----------
// The page posts { type: 'rest', id, endsAt, next } whenever the timer changes (endsAt null = cancelled).
// This is best effort: the browser may stop the worker, and iOS suspends web apps when locked.

let rest = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.type === 'version') { e.ports[0]?.postMessage(CACHE); return; }
  if (m.type !== 'rest') return;
  rest = m.endsAt ? { id: m.id, endsAt: m.endsAt, next: m.next } : null;
  if (rest) e.waitUntil(notifyWhenDone(rest));
});

async function notifyWhenDone(r) {
  while (rest === r && Date.now() < r.endsAt) await sleep(Math.min(1000, r.endsAt - Date.now()));
  if (rest !== r) return; // replaced or cancelled
  rest = null;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.some(w => w.visibilityState === 'visible')) return; // the open page beeps instead
  await self.registration.showNotification('Rest over', {
    body: r.next ? `Next: ${r.next}` : 'Time for your next set',
    tag: 'rest',
    renotify: true,
    vibrate: [250, 120, 250, 120, 250],
    icon: 'icons/icon-192.png',
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins[0]) return wins[0].focus();
    return self.clients.openWindow('./');
  })());
});
