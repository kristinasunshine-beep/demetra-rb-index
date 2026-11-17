/* DEMETRA RB app-shell offline support. Prices, catalog JSON and personal quotes are NOT cached. */
const CACHE = 'demetra-rb-pwa-shell-02x';
const SHELL = ['./', './index.html', './manifest.webmanifest', './assets/control-room.css', './assets/control-room-mobile-outline.css', './assets/icons/icon.svg', './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/icon-maskable-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const url = new URL(req.url);
  // Never put current or archival prices, dynamic catalog entries, exports or private quotes into SW cache.
  if (url.pathname.includes('/data/') || /\.(?:json|xlsx|xls|csv|zip)$/i.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  const pathSuffixes = SHELL.filter(path => path !== './').map(path => path.replace(/^\.\//, ''));
  if (pathSuffixes.some(path => url.pathname.endsWith('/' + path))) {
    event.respondWith(caches.match(req,{ignoreSearch:true}).then(cached => cached || fetch(req)));
  }
});
