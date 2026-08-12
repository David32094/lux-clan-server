const EDITOR_PAGE = './LUX_CLAN_EDITOR_BY.DAVID.XIT.html';
const CACHE_NAME = 'fluxo-clan-offline-v58';
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
  './lux-match-ocr.js',
  './lux-platform-v3.js',
  './lux-platform-v3.css',
  './vendor/qrcode.js',
  './ICONOS/FLUXO_LOGO.png'
];

// Estas plantillas son pesadas. Se descargan después de mostrar la interfaz,
// de modo que la primera pantalla abra rápido y el editor siga disponible sin
// conexión una vez terminada la preparación en segundo plano.
const EDITOR_ASSETS = [
  './INTEGRANTES/base.png',
  './ENFRETAMIENTOS/base.png',
  './ENFRETAMIENTOS/OVERLAY%20POR%20ENCIMA%20DE%20LA%20FOTO%20DEL%20RESULTADO.png'
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
        .filter(key => (key.startsWith('lux-clan-editor-') || key.startsWith('fluxo-clan-')) && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_EDITOR_ASSETS') return;
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(EDITOR_ASSETS))
      .then(() => event.source?.postMessage?.({ type: 'EDITOR_ASSETS_READY' }))
      .catch(error => console.warn('No se pudieron preparar las plantillas offline:', error))
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





