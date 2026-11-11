// sw.js — Rende l'app apribile anche senza rete (i file dell'app restano in cache).
// Strategia: prima la rete (così gli aggiornamenti arrivano subito), poi la cache.
// Non intercetta le chiamate a Google o al sito dei modelli.
const CACHE = 'lectio-v2';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png',
  './js/app.js', './js/ui/views.js', './js/ui/dom.js',
  './js/core/audio.js', './js/core/cleaning.js', './js/core/config.js', './js/core/dates.js', './js/core/docplan.js', './js/core/schedule.js',
  './js/services/engine.js', './js/services/google.js', './js/services/pipeline.js', './js/services/store.js', './js/services/whisper-worker.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('lectio-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
