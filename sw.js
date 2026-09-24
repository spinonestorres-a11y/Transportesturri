/* =========================================================================
   sw.js — Service worker de Gestión de Transporte
   -------------------------------------------------------------------------
   Estrategia de caché y actualización:
   1. Precarga los archivos de la app en una caché con nombre versionado.
   2. Sirve primero desde caché (funciona sin conexión tras la primera carga).
   3. Para publicar cambios: subir VERSION (y APP_VERSION en app.js).
      Las llamadas al backend (script.google.com) no pasan por esta caché.
      El navegador detecta que sw.js cambió, instala la versión nueva y la
      deja "en espera" (no se activa sola para no romper una sesión abierta).
   4. La app muestra "Hay una nueva versión" → al aceptar envía SKIP_WAITING,
      el service worker nuevo toma control y la página se recarga.
   5. Al activarse, borra las cachés de versiones anteriores.
   El registro usa updateViaCache: 'none' para que sw.js nunca quede
   retenido por la caché HTTP (GitHub Pages cachea ~10 minutos).
   ========================================================================= */
'use strict';

const VERSION = '2.0.1';
const PREFIJO = 'gestion-transporte-';
const CACHE = `${PREFIJO}${VERSION}`;
const ARCHIVOS = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './calculos.js',
  './db.js',
  './api.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  // cache: 'reload' evita copiar archivos viejos desde la caché HTTP.
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ARCHIVOS.map(url => new Request(url, { cache: 'reload' }))))
  );
  // Sin skipWaiting(): la versión nueva espera la confirmación del usuario.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const claves = await caches.keys();
    await Promise.all(claves.filter(k => k.startsWith(PREFIJO) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const datos = event.data || {};
  if (datos.tipo === 'SKIP_WAITING') self.skipWaiting();
  if (datos.tipo === 'VERSION' && event.ports && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const alcance = new URL(self.registration.scope);
  const esInicio = req.mode === 'navigate' &&
    (url.pathname === alcance.pathname || url.pathname === `${alcance.pathname}index.html`);

  if (esInicio) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const enCache = await cache.match('./index.html');
      if (enCache) return enCache;
      try {
        return await fetch(req);
      } catch (err) {
        return new Response('Sin conexión y sin copia local. Abre la app con internet una vez.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const enCache = await cache.match(req, { ignoreSearch: true });
    if (enCache) return enCache;
    try {
      return await fetch(req);
    } catch (err) {
      return new Response('', { status: 504, statusText: 'Sin conexión' });
    }
  })());
});
