/**
 * sw.js — Service Worker
 *
 * Estrategia: Cache First para assets estáticos,
 * Network First para datos dinámicos.
 *
 * Esto permite que la app funcione completamente offline después
 * de la primera carga. Las grabaciones siempre se guardan en
 * IndexedDB (nunca en la caché del SW).
 */

const CACHE_VERSION = 'grabador-ideas-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/db.js',
  '/recorder.js',
  '/app.js',
  '/manifest.json',
];

// ── Install ───────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Error en install:', err))
  );
});

// ── Activate ──────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  // Ignorar peticiones no GET y Chrome extensions
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;

        return fetch(event.request)
          .then(response => {
            // Solo cachear respuestas válidas de assets estáticos
            if (response.ok && STATIC_ASSETS.some(a => event.request.url.endsWith(a))) {
              const clone = response.clone();
              caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Offline fallback
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
          });
      })
  );
});
