/* RST FixPoint — Service Worker พื้นฐาน
 * - แคชเฉพาะไฟล์หน้าเว็บของแอป (same-origin)
 * - ไม่แคช/ไม่แตะคำขอ POST ไป Google Apps Script (ข้อมูลต้องสดเสมอ)
 * - ใช้ network-first: ออนไลน์ได้ข้อมูลล่าสุด, ออฟไลน์ใช้ไฟล์ที่แคชไว้
 */
const CACHE = 'fixpoint-shell-v1';
const SHELL = ['./', './index.html', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                     // POST (API ของ GAS) ไม่ผ่าน SW
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // CDN / Google Fonts ไม่แคช

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});