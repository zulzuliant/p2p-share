'use strict';

/*
  Service worker: bikin website bisa dipasang sebagai aplikasi dan tetap terbuka tanpa internet.
  (Kirim file tetap butuh internet untuk perkenalan awal antar perangkat.)

  Strategi: "jaringan dulu". Selama online, selalu ambil file terbaru dari server, jadi setelah
  deploy versi baru pengguna langsung mendapat kode baru (tidak nyangkut di versi lama).
  Cadangan di cache hanya dipakai kalau jaringan gagal atau lebih dari 4 detik.
*/
const VERSION = 'p2pshare-v4';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'writer.js', 'peerjs.min.js', 'qrcode.js', 'jsqr.js',
  'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
  'icon-maskable-512.png', 'site.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Hanya file milik website ini. Server signaling PeerJS dan lainnya tidak disentuh.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, reject) => setTimeout(() => reject(new Error('lambat')), 4000)),
      ]);
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = (await cache.match(req, { ignoreSearch: true })) ||
                  (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
