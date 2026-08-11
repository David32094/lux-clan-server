const EDITOR_PAGE = './LUX_CLAN_EDITOR_BY.DAVID.XIT.html';
const CACHE_NAME = 'lux-clan-editor-offline-v47';
const MOBILE_TOUCH_FIX = './mobile-touch-fix.js';
const APP_SHELL = [
  './',
  './index.html',
  EDITOR_PAGE,
  MOBILE_TOUCH_FIX,
  './manifest.webmanifest',
  './supabase-client-config.js',
  './prototipo-supabase.js',
  './prototipo-placas.js',
  './prototipo-placas-ocr.js',
  './lux-simple-ui.css',
  './ICONOS/ChatGPT%20Image%207%20ago%202026%2C%2005_48_09%20a.m..png'
];

async function withMobileTouchFix(response) {
  const html = await response.text();
  const script = '<script src="./mobile-touch-fix.js"></script>';
  const patchedHtml = html.includes('mobile-touch-fix.js')
    ? html
    : html.replace(/<\/body>/i, script + '</body>');
  return new Response(patchedHtml, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        await cache.addAll(APP_SHELL);
        const editor = await fetch(EDITOR_PAGE, { cache: 'reload' });
        await cache.put(EDITOR_PAGE, await withMobileTouchFix(editor));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('lux-clan-editor-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate' && url.pathname.endsWith('LUX_CLAN_EDITOR_BY.DAVID.XIT.html')) {
    event.respondWith(
      fetch(event.request)
        .then(response => response.ok ? withMobileTouchFix(response) : response)
        .catch(() => caches.match(EDITOR_PAGE))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || !response.ok) return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      });
    }).catch(() => {
      if (event.request.mode === 'navigate') return caches.match(EDITOR_PAGE);
      return Response.error();
    })
  );
});





