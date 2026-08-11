/* LUX CLAN: cliente de produccion para Supabase Auth + RLS.
 * No usa service_role ni guarda permisos en el navegador. */
(() => {
  'use strict';

  const config = window.LUX_SUPABASE_CONFIG;
  const SESSION_KEY = 'lux_clan_auth_v1';
  const MAX_AVATAR = 5 * 1024 * 1024;
  const MAX_EVIDENCE = 8 * 1024 * 1024;
  const MAX_BANNER = 10 * 1024 * 1024;
  const AUTH_REDIRECT_VERSION = 'google-v1';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const toast = message => window.showToast?.(message);
  const state = { session:null, user:null, role:'member', isStaff:false, isLeader:false, isOwner:false, profile:null, pendingAvatar:null, profileDraftDirty:false, directory:new Map(), publicDirectory:new Map(), publicPlates:new Map(), ranking:new Map(), roles:new Map(), editorBack:'member', navigationContext:null, adminSection:'home', navigationSerial:0, pendingReviews:0, pendingRequests:0, pendingMatches:0, authStatus:'checking', memberRenderedAt:0, adminRenderedAt:0 };
  let setScreenBase = null;
  let authReadyPromise = null;
  let refreshPromise = null;
  let sessionDbPromise = null;
  let memberRenderPromise = null;
  let navigationBusyTimer = null;

  // Preservar hash de OAuth en sessionStorage para inmunitad total contra escrituras de location.hash por otros scripts
  let rawHash = window.location.hash ? window.location.hash.substring(1) : '';
  if (rawHash.includes('access_token')) {
    try { sessionStorage.setItem('lux_oauth_hash', rawHash); } catch (_) {}
  } else {
    try { rawHash = sessionStorage.getItem('lux_oauth_hash') || rawHash; } catch (_) {}
  }
  const initialOAuthHash = rawHash;
  const arrivedFromOAuth = initialOAuthHash.includes('access_token') || new URLSearchParams(window.location.search).has('code');
  const inviteFromUrl = new URLSearchParams(window.location.search).get('invite');
  if (inviteFromUrl) {
    try { sessionStorage.setItem('lux_clan_invite', inviteFromUrl); } catch (_) {}
  }

  // Exponer loginWithGoogle ANTES del guard de config para que siempre sea callable
  window.luxGoogleLogin = function() {
    const cfg = window.LUX_SUPABASE_CONFIG;
    if (!cfg?.url || !cfg?.publishableKey) {
      window.showToast?.('⚠️ Supabase no está configurado en este entorno. Contacta al admin del clan.');
      console.warn('LUX CLAN: LUX_SUPABASE_CONFIG no está definido. Configura SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY como variables en el repositorio de GitHub.');
      return;
    }
    const base = String(cfg.url).replace(/\/$/, '');
    const redirectUrl = new URL(window.location.origin + window.location.pathname);
    redirectUrl.searchParams.set('auth', AUTH_REDIRECT_VERSION);
    try {
      const invite = sessionStorage.getItem('lux_clan_invite');
      if (invite) redirectUrl.searchParams.set('invite', invite);
    } catch (_) {}
    window.location.href = `${base}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl.href)}&prompt=select_account`;
  };

  if (!config?.url || !config?.publishableKey) {
    console.info('LUX CLAN: configuracion de produccion pendiente. Se mantiene la demo local.');
    return;
  }

  const base = String(config.url).replace(/\/$/, '');
  const headers = (auth = true, extra = {}) => ({
    apikey: config.publishableKey,
    ...(auth && state.session?.access_token ? { Authorization:`Bearer ${state.session.access_token}` } : {}),
    ...extra
  });

  function readSession() {
    let raw = null;
    try { raw = localStorage.getItem(SESSION_KEY); } catch (_) {}
    if (!raw) {
      try { raw = sessionStorage.getItem(SESSION_KEY); } catch (_) {}
    }
    try { return JSON.parse(raw || 'null'); } catch (_) { return null; }
  }
  function openSessionDb() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (sessionDbPromise) return sessionDbPromise;
    sessionDbPromise = new Promise(resolve => {
      try {
        const request = indexedDB.open('lux-clan-session', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('auth');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
    return sessionDbPromise;
  }
  async function readIndexedSession() {
    const db = await openSessionDb();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const request = db.transaction('auth', 'readonly').objectStore('auth').get(SESSION_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  async function writeIndexedSession(session) {
    const db = await openSessionDb();
    if (!db) return;
    try {
      const store = db.transaction('auth', 'readwrite').objectStore('auth');
      if (session) store.put(session, SESSION_KEY);
      else store.delete(SESSION_KEY);
    } catch (_) {}
  }
  function writeSession(session) {
    state.session = session || null;
    const serialized = session ? JSON.stringify(session) : null;
    try {
      if (serialized) localStorage.setItem(SESSION_KEY, serialized);
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) {}
    try {
      if (serialized) sessionStorage.setItem(SESSION_KEY, serialized);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (_) {}
    writeIndexedSession(session || null);
  }
  function errorMessage(error, fallback = 'No se pudo completar la operación') {
    return error?.message || error?.msg || error?.error_description || fallback;
  }
  async function request(path, options = {}, auth = true, retried = false) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: headers(auth, options.headers || {})
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!response.ok && response.status === 401 && auth && !retried && state.session?.refresh_token) {
      await refreshSession();
      return request(path, options, auth, true);
    }
    if (!response.ok) {
      const error = new Error(errorMessage(data, `Error ${response.status}`));
      error.status = response.status;
      error.details = data;
      throw error;
    }
    return data;
  }
  async function rpc(name, payload = {}, auth = true) {
    return request(`/rest/v1/rpc/${name}`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify(payload)
    }, auth);
  }
  function publicUrl(bucket, path) {
    return path ? `${base}/storage/v1/object/public/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}` : '';
  }
  function initial(name) { return esc(String(name || '?').trim().slice(0, 1).toUpperCase()); }
  function avatarHtml(row, className = 'lux-access-avatar') {
    const url = row.avatar_path ? publicUrl('lux-avatars', row.avatar_path) : '';
    return url ? `<img class="${className}" src="${esc(url)}" alt="${esc(row.display_name || row.name)}"/>` : `<span class="${className} lux-access-initial">${initial(row.display_name || row.name)}</span>`;
  }
  function countryName() {
    const select = $('hub-country');
    return select?.options[select.selectedIndex]?.dataset?.name || select?.options[select.selectedIndex]?.textContent?.trim() || null;
  }
  function countryLabel(code) {
    if (!code) return 'País pendiente';
    const option = [...($('hub-country')?.options || [])].find(item => item.value === code);
    return option?.dataset?.name || option?.textContent?.replace(/[^\p{L}\p{N} .'-]/gu, '').trim() || String(code).toUpperCase();
  }
  function roleLabel(role = state.role) {
    return ({owner:'Propietario',leader:'Líder',moderator:'Moderadora',member:'Integrante'})[role] || 'Integrante';
  }
  function isImage(file, limit) {
    return Boolean(file && ['image/jpeg','image/png','image/webp'].includes(file.type) && file.size > 0 && file.size <= limit);
  }
  function extension(file) {
    return ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'})[file?.type] || 'jpg';
  }
  function randomId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function emailRedirectUrl() {
    const redirectUrl = new URL(`${window.location.origin}${window.location.pathname}`);
    redirectUrl.searchParams.set('auth', AUTH_REDIRECT_VERSION);
    try {
      const invite = sessionStorage.getItem('lux_clan_invite');
      if (invite) redirectUrl.searchParams.set('invite', invite);
    } catch (_) {}
    return redirectUrl.href;
  }
  async function sha256(file) {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  async function imageVisualHashes(file) {
    let bitmap;
    if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(file);
    else bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
      image.src = url;
    });
    const hashes = [0, .06, .12].map(inset => {
      const canvas = document.createElement('canvas');
      canvas.width = 9; canvas.height = 8;
      const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
      const width = bitmap.width || bitmap.naturalWidth, height = bitmap.height || bitmap.naturalHeight;
      const cropX = Math.round(width * inset), cropY = Math.round(height * inset);
      context.drawImage(bitmap, cropX, cropY, width - cropX * 2, height - cropY * 2, 0, 0, 9, 8);
      const data = context.getImageData(0, 0, 9, 8).data;
      let bits = '';
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          const offset = (y * 9 + x) * 4, next = offset + 4;
          const left = data[offset] * .299 + data[offset + 1] * .587 + data[offset + 2] * .114;
          const right = data[next] * .299 + data[next + 1] * .587 + data[next + 2] * .114;
          bits += left > right ? '1' : '0';
        }
      }
      return bits.match(/.{4}/g).map(group => parseInt(group, 2).toString(16)).join('');
    });
    bitmap.close?.();
    return [...new Set(hashes)];
  }
  async function imageDHash(file) { return (await imageVisualHashes(file))[0]; }
  async function upload(bucket, path, file) {
    await request(`/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method:'POST',
      headers:{ 'Content-Type':file.type, 'x-upsert':'false' },
      body:file
    });
    return path;
  }
  async function uploadUpsert(bucket, path, file) {
    await request(`/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method:'POST',
      headers:{ 'Content-Type':file.type, 'x-upsert':'true' },
      body:file
    });
    return path;
  }
  async function signedEvidence(path) {
    if (!path) return '';
    const data = await request(`/storage/v1/object/sign/lux-evidence/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ expiresIn:3600 })
    });
    return data?.signedURL ? `${base}/storage/v1${data.signedURL}` : '';
  }
  function blankModeStats() { return { '1v1':0, '2v2':0, '3v3':0, '4v4':0, Otro:0, total:0 }; }
  function modeStats(rows, status = 'approved') {
    return (rows || []).reduce((stats, row) => {
      if (!status || row.status === status) {
        if (Object.prototype.hasOwnProperty.call(stats, row.mode)) stats[row.mode] += 1;
        stats.total += 1;
      }
      return stats;
    }, blankModeStats());
  }
  function rankingModeLine(stats = {}) {
    return `1v1 ${Number(stats.victories_1v1 || 0)} · 2v2 ${Number(stats.victories_2v2 || 0)} · 3v3 ${Number(stats.victories_3v3 || 0)} · 4v4 ${Number(stats.victories_4v4 || 0)}`;
  }

  let evidenceZoom = 1;
  function ensureEvidenceViewer() {
    if ($('lux-evidence-viewer')) return;
    document.body.insertAdjacentHTML('beforeend', `<div id="lux-evidence-viewer" class="lux-evidence-viewer" hidden role="dialog" aria-modal="true" aria-labelledby="lux-evidence-title">
      <div class="lux-evidence-toolbar">
        <strong id="lux-evidence-title">CAPTURA DE VICTORIA</strong>
        <span>
          <button type="button" onclick="window.luxSupabase.zoomEvidence(-0.25)" aria-label="Alejar">−</button>
          <button id="lux-evidence-zoom" type="button" onclick="window.luxSupabase.resetEvidenceZoom()">100%</button>
          <button type="button" onclick="window.luxSupabase.zoomEvidence(0.25)" aria-label="Acercar">+</button>
          <button type="button" class="lux-evidence-close" onclick="window.luxSupabase.closeEvidence()" aria-label="Cerrar">×</button>
        </span>
      </div>
      <div id="lux-evidence-stage" class="lux-evidence-stage"><img id="lux-evidence-image" alt="Captura de victoria ampliada"/></div>
      <small>Usa +/−, la rueda del ratón o pellizca la pantalla para revisar los detalles.</small>
    </div>`);
    const stage = $('lux-evidence-stage');
    stage?.addEventListener('wheel', event => {
      event.preventDefault();
      zoomEvidence(event.deltaY < 0 ? 0.2 : -0.2);
    }, { passive:false });
    $('lux-evidence-viewer')?.addEventListener('click', event => {
      if (event.target?.id === 'lux-evidence-viewer') closeEvidence();
    });
  }
  function applyEvidenceZoom() {
    const image = $('lux-evidence-image');
    const value = $('lux-evidence-zoom');
    if (image) image.style.width = `${Math.round(evidenceZoom * 100)}%`;
    if (value) value.textContent = `${Math.round(evidenceZoom * 100)}%`;
  }
  function openEvidence(url, label = 'Captura de victoria') {
    if (!url) { toast('⚠️ NO SE PUDO CARGAR ESTA CAPTURA'); return; }
    ensureEvidenceViewer();
    evidenceZoom = 1;
    $('lux-evidence-image').src = url;
    $('lux-evidence-title').textContent = label;
    $('lux-evidence-viewer').hidden = false;
    document.body.classList.add('hub-no-scroll');
    applyEvidenceZoom();
  }
  function closeEvidence() {
    const viewer = $('lux-evidence-viewer');
    if (viewer) viewer.hidden = true;
    const image = $('lux-evidence-image');
    if (image) image.removeAttribute('src');
    if ($('hub-modal')?.hidden !== false && $('lux-plates-modal')?.hidden !== false) document.body.classList.remove('hub-no-scroll');
  }
  function zoomEvidence(delta) {
    evidenceZoom = Math.min(4, Math.max(0.5, evidenceZoom + Number(delta || 0)));
    applyEvidenceZoom();
  }
  function resetEvidenceZoom() { evidenceZoom = 1; applyEvidenceZoom(); }
  function evidenceButton(url, label = 'Captura de victoria') {
    return `<button type="button" class="lux-evidence-thumb" onclick="window.luxSupabase.openEvidence('${esc(url)}','${esc(label)}')" aria-label="Ver captura en grande"><img src="${esc(url)}" alt="${esc(label)}" loading="lazy"/><span>AMPLIAR</span></button>`;
  }

  function parseOAuthCallback() {
    try {
      const searchParams = new URLSearchParams(window.location.search);
      const queryError = searchParams.get('error') || searchParams.get('error_description');
      if (queryError) {
        const desc = searchParams.get('error_description') || queryError;
        toast(`⚠️ ERROR AL INICIAR SESIÓN: ${desc}`);
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname);
        }
        return false;
      }
      
      // Algunos scripts de la interfaz cambian el hash a #integrantes antes
      // de que Auth termine de arrancar. Usamos primero la copia capturada al
      // inicio del documento y luego ambos respaldos de sessionStorage.
      let hash = initialOAuthHash || (window.location.hash ? window.location.hash.substring(1) : '');
      if (!hash || !hash.includes('access_token')) {
        try {
          const backup = sessionStorage.getItem('lux_oauth_hash') || sessionStorage.getItem('lux_oauth_hash_backup');
          if (backup && backup.includes('access_token')) {
            hash = backup.substring(backup.startsWith('#') ? 1 : 0);
          }
        } catch (_) {}
      }
      
      if (!hash || !hash.includes('access_token')) return false;
      
      const params = new URLSearchParams(hash);
      const hashError = params.get('error') || params.get('error_description');
      if (hashError) {
        toast(`⚠️ ERROR AL INICIAR SESIÓN: ${params.get('error_description') || hashError}`);
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname);
        }
        return false;
      }
      const access_token = params.get('access_token');
      const refresh_token = params.get('refresh_token');
      const expires_in = params.get('expires_in');
      const token_type = params.get('token_type');
      if (access_token) {
        const expires_at = Math.floor(Date.now() / 1000) + (parseInt(expires_in, 10) || 3600);
        const session = {
          access_token,
          refresh_token,
          expires_in: parseInt(expires_in, 10) || 3600,
          expires_at,
          token_type: token_type || 'bearer'
        };
        writeSession(session);
        
        // Clear both backup storages
        try { 
          sessionStorage.removeItem('lux_oauth_hash');
          sessionStorage.removeItem('lux_oauth_hash_backup');
        } catch (_) {}
        
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname);
        }
        return true;
      }
    } catch (error) {
      console.error('[OAuth] Parse error:', error);
    }
    return false;
  }
  function loginWithGoogle() {
    if (!config?.url) {
      toast('⚠️ CONFIGURACIÓN DE SUPABASE PENDIENTE');
      return;
    }
    const redirectUrl = emailRedirectUrl();
    const authorizeUrl = `${base}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl)}&prompt=select_account`;
    window.location.href = authorizeUrl;
  }

  async function refreshSession() {
    if (refreshPromise) return refreshPromise;
    const current = state.session || readSession();
    if (!current?.refresh_token) return null;
    refreshPromise = (async () => {
      const data = await request('/auth/v1/token?grant_type=refresh_token', {
        method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ refresh_token:current.refresh_token })
      }, false);
      const renewed = {
        ...current,
        ...data,
        refresh_token:data?.refresh_token || current.refresh_token,
        user:data?.user || current.user || null
      };
      writeSession(renewed);
      return renewed;
    })();
    try { return await refreshPromise; }
    finally { refreshPromise = null; }
  }
  async function validateSession() {
    parseOAuthCallback();
    const saved = readSession() || await readIndexedSession();
    if (!saved?.access_token) {
      state.authStatus = 'anonymous';
      return null;
    }
    writeSession(saved);
    try {
      if (!saved.expires_at || saved.expires_at * 1000 < Date.now() + 45_000) await refreshSession();
      const user = await request('/auth/v1/user');
      state.user = user;
      state.authStatus = 'authenticated';
      writeSession({ ...(state.session || saved), user });
      return user;
    } catch (firstError) {
      try {
        await refreshSession();
        const user = await request('/auth/v1/user');
        state.user = user;
        state.authStatus = 'authenticated';
        writeSession({ ...(state.session || saved), user });
        return user;
      } catch (lastError) {
        const definitelyInvalid = [400, 401].includes(Number(lastError?.status)) || (!saved.refresh_token && Number(firstError?.status) === 401);
        if (definitelyInvalid) {
          writeSession(null);
          state.user = null;
          state.authStatus = 'anonymous';
          return null;
        }
        // Un corte de red o un error temporal del servidor no debe cerrar la
        // cuenta. Conservamos la identidad ya verificada y reintentamos en la
        // siguiente carga o petición protegida.
        state.user = saved.user || state.session?.user || null;
        state.authStatus = 'unavailable';
        return state.user;
      }
    }
  }
  async function loadRole() {
    if (!state.user?.id) return 'member';
    const rows = await request(`/rest/v1/user_roles?user_id=eq.${encodeURIComponent(state.user.id)}&select=role`);
    state.role = rows?.[0]?.role || 'member';
    state.isStaff = ['owner','leader','moderator'].includes(state.role);
    state.isLeader = ['owner','leader'].includes(state.role);
    state.isOwner = state.role === 'owner';
    return state.role;
  }
  async function loadProfile() {
    if (!state.user?.id) return null;
    let rows = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(state.user.id)}&select=*`).catch(() => []);
    if (!rows?.[0]) {
      const defaultName = state.user.user_metadata?.full_name || state.user.user_metadata?.name || state.user.email?.split('@')[0] || 'Integrante';
      try {
        await request('/rest/v1/profiles', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', Prefer:'return=representation' },
          body:JSON.stringify({
            id: state.user.id,
            display_name: defaultName
          })
        });
        rows = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(state.user.id)}&select=*`).catch(() => []);
      } catch (_) {}
    }
    state.profile = rows?.[0] || null;
    return state.profile;
  }
  async function hydrateAccount() {
    if (!await validateSession()) return null;
    await Promise.allSettled([loadRole(), loadProfile()]);
    renderAccountState();
    return state.user;
  }
  async function waitForAuth() {
    if (state.authStatus === 'checking' && authReadyPromise) {
      try { await authReadyPromise; } catch (_) {}
    }
    return state.user;
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }

  function scrollTopNow() {
    if (window.scrollY < 2) return;
    window.scrollTo({ top:0, left:0, behavior:'auto' });
  }

  function animateView(target) {
    if (!target || target.hidden || prefersReducedMotion()) return;
    target.classList.remove('lux-view-enter');
    requestAnimationFrame(() => target.classList.add('lux-view-enter'));
  }

  function revealActiveTab(container) {
    if (!container) return;
    const active = container.querySelector('button.active');
    if (!active || container.scrollWidth <= container.clientWidth + 2) return;
    const left = Math.max(0, active.offsetLeft - (container.clientWidth - active.offsetWidth) / 2);
    if (Math.abs(container.scrollLeft - left) < 4) return;
    container.scrollTo({ left, behavior:prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  function beginNavigation(label = 'view') {
    const token = ++state.navigationSerial;
    clearTimeout(navigationBusyTimer);
    document.body.classList.add('lux-navigation-busy');
    document.documentElement.dataset.luxView = label;
    navigationBusyTimer = setTimeout(() => {
      if (token === state.navigationSerial) document.body.classList.remove('lux-navigation-busy');
    }, 8000);
    return token;
  }

  function endNavigation(token, target = null) {
    if (token !== state.navigationSerial) return false;
    clearTimeout(navigationBusyTimer);
    requestAnimationFrame(() => {
      if (token !== state.navigationSerial) return;
      document.body.classList.remove('lux-navigation-busy');
      animateView(target);
      const activeTabs = document.body.classList.contains('lux-hub-admin')
        ? document.querySelector('#hub-admin .lux-admin-tabs')
        : document.body.classList.contains('lux-hub-member')
          ? document.querySelector('#hub-member .lux-member-tabs')
          : document.body.classList.contains('lux-hub-public')
            ? document.querySelector('#lux-public-screen .lux-context-tabs')
            : document.querySelector('#hub-editor-nav .lux-context-tabs');
      revealActiveTab(activeTabs);
    });
    return true;
  }

  function showPageChildren(page, panel, persistentIds = []) {
    if (!page || !panel) return false;
    const keep = new Set(persistentIds);
    [...page.children].forEach(child => { child.hidden = child !== panel && !keep.has(child.id); });
    panel.hidden = false;
    scrollTopNow();
    return true;
  }

  function setStableHtml(target, key, html) {
    if (!target || target.dataset.luxRenderKey === key) return false;
    const scrollLeft = target.scrollLeft;
    target.innerHTML = html;
    target.dataset.luxRenderKey = key;
    requestAnimationFrame(() => { target.scrollLeft = scrollLeft; });
    return true;
  }

  function syncStickyOffsets() {
    const selector = document.body.classList.contains('lux-hub-admin') ? '#hub-admin .hub-nav'
      : document.body.classList.contains('lux-hub-member') ? '#hub-member .hub-nav'
      : document.body.classList.contains('lux-hub-public') ? '#lux-public-screen .hub-nav'
      : document.body.classList.contains('lux-hub-editor') ? '#hub-editor-nav .lux-editor-context-bar' : null;
    const nav = selector ? document.querySelector(selector) : null;
    document.documentElement.style.setProperty('--lux-sticky-nav-height', `${Math.ceil(nav?.getBoundingClientRect().height || 0)}px`);
  }

  function setScreenStable(name) {
    const allowed = new Set(['home','member','admin','public','editor']);
    const next = allowed.has(name) ? name : 'home';
    document.body.classList.remove('lux-hub-home','lux-hub-member','lux-hub-admin','lux-hub-public','lux-hub-editor');
    document.body.classList.add(`lux-hub-${next}`);
    ['home','member','admin'].forEach(item => { const screen = $(`hub-${item}`); if (screen) screen.hidden = item !== next; });
    const publicScreen = $('lux-public-screen');
    if (publicScreen) publicScreen.hidden = next !== 'public';
    const editorNav = $('hub-editor-nav');
    if (editorNav) editorNav.hidden = next !== 'editor';
    document.documentElement.dataset.luxScreen = next;
    requestAnimationFrame(syncStickyOffsets);
  }

  function memberNavigationContent() {
    return `<button type="button" onclick="window.luxHub.setScreen('home')">← INICIO</button><strong>MI CUENTA<small>${esc(roleLabel())}</small></strong><span class="lux-nav-actions">${state.isStaff ? '<button type="button" class="lux-owner-nav" onclick="window.luxAccess.loginLeader()">ADMINISTRAR</button>' : ''}<button type="button" class="lux-nav-logout" onclick="window.luxSupabase.logout()">SALIR</button></span>`;
  }

  function adminNavigationContent(includeSessionId = true) {
    const sessionId = includeSessionId ? ' id="lux-leader-session"' : '';
    const sessionText = state.user && state.isStaff ? `${esc(roleLabel())} · cuenta verificada` : 'Acceso restringido';
    return `<button type="button" onclick="window.luxSupabase.openMember('home')">← MI CUENTA</button><strong>ADMINISTRACIÓN<small${sessionId}>${sessionText}</small></strong><span class="lux-nav-actions"><button type="button" class="lux-nav-logout" onclick="window.luxSupabase.logout()">SALIR</button></span>`;
  }

  function renderNavigation() {
    const publicNav = document.querySelector('#lux-public-screen .hub-nav');
    if (publicNav) {
      if (state.navigationContext === 'admin' && state.isStaff) {
        setStableHtml(publicNav, `public-admin:${state.user?.id || ''}:${state.role}`, adminNavigationContent(false));
      } else if (state.navigationContext === 'member' && state.user) {
        setStableHtml(publicNav, `public-member:${state.user.id}:${state.role}:${state.isStaff}`, memberNavigationContent());
      } else {
        const accountActions = state.user
          ? `<button type="button" onclick="window.luxSupabase.openMember('home')">MI CUENTA</button>${state.isStaff ? '<button type="button" class="lux-owner-nav" onclick="window.luxAccess.loginLeader()">ADMINISTRAR</button>' : ''}<button type="button" class="lux-nav-logout" onclick="window.luxSupabase.logout()">SALIR</button>`
          : '<button type="button" class="lux-nav-login" onclick="window.luxAccess.openLogin(\'member\')">ENTRAR</button>';
        setStableHtml(publicNav, `public:${state.user?.id || 'guest'}:${state.role}:${state.isStaff}:${state.authStatus}`, `<button type="button" class="lux-nav-brand" onclick="window.luxHub.setScreen('home')">⚡ LUX CLAN</button><strong>CLASIFICACIÓN DEL CLAN</strong><span class="lux-nav-actions">${accountActions}</span>`);
      }
    }

    const memberNav = document.querySelector('#hub-member .hub-nav');
    if (memberNav) {
      setStableHtml(memberNav, `member:${state.user?.id || 'guest'}:${state.role}:${state.isStaff}`, memberNavigationContent());
    }

    const adminNav = document.querySelector('#hub-admin .hub-nav');
    if (adminNav) {
      setStableHtml(adminNav, `admin:${state.user?.id || 'guest'}:${state.role}:${state.isStaff}`, adminNavigationContent());
    }
    renderAdminTabs();
    renderAdminMenu();
    requestAnimationFrame(syncStickyOffsets);
  }
  function renderAccountState() {
    const note = document.querySelector('.hub-local');
    if (note) note.textContent = state.authStatus === 'checking' ? '● REVISANDO LA SESIÓN GUARDADA…' : state.user ? `● SESIÓN SEGURA · ${state.user.email || 'cuenta conectada'}` : '● DATOS PROTEGIDOS · crea una cuenta para participar';
    const memberChoice = document.querySelector('.hub-choice.player');
    const memberAction = memberChoice?.querySelector(':scope > b');
    const memberDescription = memberChoice?.querySelector('small');
    if (memberAction) memberAction.textContent = state.authStatus === 'checking' ? 'REVISANDO…' : state.user ? 'ABRIR →' : 'ENTRAR →';
    if (memberDescription) memberDescription.textContent = state.user ? 'Tu sesión ya está abierta en este navegador' : 'Mi perfil, mi banner y mis victorias';
    const leaderChoice = document.querySelector('.hub-choice.leader');
    const leaderAction = leaderChoice?.querySelector(':scope > b');
    if (leaderAction) leaderAction.textContent = state.authStatus === 'checking' ? 'REVISANDO…' : state.isStaff ? 'ABRIR →' : 'ENTRAR →';
    const leader = $('lux-leader-session');
    if (leader) leader.textContent = state.user && state.isStaff ? `${roleLabel()} · cuenta verificada` : 'Acceso con cuenta';
    document.body.classList.toggle('lux-supabase-ready', Boolean(state.user));
    document.documentElement.dataset.luxAuth = state.authStatus;
    renderNavigation();
  }

  function setAdminSection(section = 'home') {
    state.adminSection = section;
    document.querySelectorAll('#lux-admin-tabs [data-admin-section]').forEach(button => {
      const active = button.dataset.adminSection === section;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    requestAnimationFrame(() => revealActiveTab($('lux-admin-tabs')));
  }

  function renderAdminTabs() {
    const target = $('lux-admin-tabs');
    if (!target || !state.isStaff) return;
    const items = [
      { section:'home', icon:'&#8962;', label:'INICIO' },
      { section:'requests', icon:'&#128075;', label:'SOLICITUDES', count:state.pendingRequests },
      { section:'matches', icon:'&#127918;', label:'PARTIDOS', count:state.pendingMatches },
      { section:'ranking', icon:'&#128202;', label:'RANKING' },
      { section:'review', icon:'&#9989;', label:'CAPTURAS', count:state.pendingReviews },
      { section:'directory', icon:'&#128101;', label:'INTEGRANTES' },
      { section:'events', icon:'&#128197;', label:'CONVOCATORIAS' },
      ...(state.isLeader ? [{ section:'plates', icon:'&#127941;', label:'PLACAS' }] : []),
      { section:'editor', icon:'&#127912;', label:'BANNERS' },
      { section:'announcements', icon:'&#128226;', label:'AVISOS' },
      ...(state.isOwner ? [{ section:'accounts', icon:'&#128274;', label:'CUENTAS' },{ section:'operations', icon:'&#9881;', label:'OPERACIONES' }] : [])
    ];
    const markup = items.map(item => `<button type="button" data-admin-section="${item.section}" onclick="window.luxSupabase.navigateAdmin('${item.section}')"><span aria-hidden="true">${item.icon}</span><strong>${item.label}</strong>${item.count ? `<b aria-label="${item.count} pendientes">${item.count}</b>` : ''}</button>`).join('');
    const renderKey = items.map(item => `${item.section}:${item.count || 0}`).join('|');
    setStableHtml(target, renderKey, markup);
    target.style.setProperty('--lux-admin-tab-count', items.length);
    setAdminSection(state.adminSection);
  }

  function openAdminEditor() {
    if (!state.isStaff) return;
    state.navigationContext = 'admin';
    setAdminSection('editor');
    openEditor(true);
  }

  function clonePrimaryTabs(context, activeSection) {
    ensureSimpleExperience();
    if (context === 'admin') renderAdminTabs();
    const source = context === 'admin' ? $('lux-admin-tabs') : $('lux-member-tabs');
    if (!source) return null;
    const clone = source.cloneNode(true);
    clone.id = `lux-${context}-context-tabs`;
    clone.classList.add('lux-context-tabs');
    clone.querySelectorAll('button').forEach(button => {
      const section = context === 'admin' ? button.dataset.adminSection : button.dataset.memberSection;
      const active = section === activeSection;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    return clone;
  }

  function mountRankingTabs(context) {
    const page = document.querySelector('#lux-public-screen .hub-page');
    if (!page) return;
    const existing = page.querySelector(':scope > .lux-context-tabs');
    if (!context) return;
    if (existing?.dataset.luxContext === context) {
      existing.querySelectorAll('button').forEach(button => {
        const section = context === 'admin' ? button.dataset.adminSection : button.dataset.memberSection;
        button.classList.toggle('active', section === 'ranking');
      });
      revealActiveTab(existing);
      return;
    }
    existing?.remove();
    const tabs = clonePrimaryTabs(context, 'ranking');
    if (tabs) { tabs.dataset.luxContext = context; page.prepend(tabs); revealActiveTab(tabs); }
  }

  function mountEditorNavigation(context) {
    const host = $('hub-editor-nav');
    if (!host) return;
    if (host.dataset.luxContext === context && host.querySelector('.lux-editor-context-bar')) {
      host.querySelectorAll('.lux-context-tabs button').forEach(button => {
        const section = context === 'admin' ? button.dataset.adminSection : button.dataset.memberSection;
        button.classList.toggle('active', section === (context === 'admin' ? 'editor' : 'profile'));
      });
      requestAnimationFrame(syncStickyOffsets);
      return;
    }
    const navigation = context === 'admin' ? adminNavigationContent(false) : memberNavigationContent();
    host.classList.add('lux-editor-context-nav');
    host.innerHTML = `<div class="hub-nav lux-editor-context-bar">${navigation}</div><div class="lux-editor-context-tabs-wrap"></div>`;
    host.dataset.luxContext = context;
    const tabs = clonePrimaryTabs(context, context === 'admin' ? 'editor' : 'profile');
    if (tabs) host.querySelector('.lux-editor-context-tabs-wrap')?.appendChild(tabs);
    requestAnimationFrame(syncStickyOffsets);
  }

  async function openRanking(context = null) {
    const inferredContext = context
      || (document.body.classList.contains('lux-hub-admin') ? 'admin' : null)
      || (document.body.classList.contains('lux-hub-member') ? 'member' : null);
    const navigationToken = beginNavigation(`ranking:${inferredContext || 'public'}`);
    state.navigationContext = inferredContext;
    if (inferredContext === 'admin' && state.isStaff) setAdminSection('ranking');
    const editorNavigation = $('hub-editor-nav');
    if (editorNavigation) editorNavigation.hidden = true;
    try {
      setScreenBase?.('public');
      ensureSimpleExperience();
      mountRankingTabs(inferredContext);
      renderNavigation();
      scrollTopNow();
      await renderPublic();
      if (navigationToken === state.navigationSerial) mountRankingTabs(inferredContext);
    } finally {
      endNavigation(navigationToken, document.querySelector('#lux-public-screen .hub-page'));
    }
  }

  async function navigateAdmin(section = 'home') {
    if (!state.isStaff) return;
    state.navigationContext = 'admin';
    if (section === 'ranking') return openRanking('admin');
    if (section === 'editor') return openAdminEditor();
    if (['requests','matches','events','announcements','operations'].includes(section) && window.luxPlatformV3?.navigateAdmin) {
      return window.luxPlatformV3.navigateAdmin(section);
    }
    if (section === 'home') return showAdminSummary();
    const navigationToken = beginNavigation(`admin:${section}`);
    window.luxHub.setScreen('admin');
    setAdminSection(section);
    renderNavigation();
    try {
      if (section === 'review') return await showAdminReview();
      if (section === 'directory') return await showDirectory();
      if (section === 'plates') return await showPlates();
      if (section === 'accounts') return await showOwnerAccounts();
    } finally {
      const page = document.querySelector('#hub-admin .hub-page');
      endNavigation(navigationToken, [...(page?.children || [])].find(child => !child.hidden && child.id !== 'lux-admin-tabs'));
    }
  }

  function ensureSimpleExperience() {
    const publicHead = document.querySelector('#lux-public-screen .lux-public-head');
    if (publicHead) {
      const kicker = publicHead.querySelector('.hub-kicker');
      const title = publicHead.querySelector('h2');
      const copy = publicHead.querySelector('p');
      if (kicker) kicker.textContent = 'RESULTADOS DEL CLAN';
      if (title) title.innerHTML = 'Clasificación<br/><em>del clan.</em>';
      if (copy) copy.textContent = 'Consulta los jugadores, sus estadísticas y las capturas que ya fueron aprobadas.';
    }
    const publicPodiumCard = $('lux-public-podium')?.closest('.lux-public-card');
    if (publicPodiumCard) publicPodiumCard.hidden = true;
    const publicRankingCard = $('lux-public-ranking')?.closest('.lux-public-card');
    if (publicRankingCard) {
      const title = publicRankingCard.querySelector('h3');
      if (title) title.textContent = 'Jugadores';
      if (!publicRankingCard.querySelector('.lux-simple-help')) title?.insertAdjacentHTML('afterend', '<p class="lux-simple-help">Toca un jugador para abrir su perfil y ver sus victorias aprobadas.</p>');
    }

    const memberPage = document.querySelector('#hub-member .hub-page');
    if (memberPage && !$('lux-member-tabs')) {
      memberPage.insertAdjacentHTML('afterbegin', `<div id="lux-member-tabs" class="lux-member-tabs" aria-label="Secciones de mi cuenta">
        <button type="button" data-member-section="home" onclick="window.luxSupabase.openMember('home')"><span>⌂</span>INICIO</button>
        <button type="button" data-member-section="profile" onclick="window.luxSupabase.showMyProfile()"><span>👤</span>MI PERFIL</button>
        <button type="button" data-member-section="matches" onclick="window.luxPlatformV3.showMemberSection('matches')"><span>🎮</span>PARTIDOS</button>
        <button type="button" data-member-section="ranking" onclick="window.luxSupabase.openRanking('member')"><span>📊</span>RANKING</button>
        <button type="button" data-member-section="directory" onclick="window.luxSupabase.showMemberDirectory()"><span>👥</span>INTEGRANTES</button>
        <button type="button" data-member-section="events" onclick="window.luxPlatformV3.showMemberSection('events')"><span>📅</span>CONVOCATORIAS</button>
        <button type="button" data-member-section="announcements" onclick="window.luxPlatformV3.showMemberSection('announcements')"><span>📢</span>AVISOS</button>
      </div>`);
      $('lux-member-tabs').insertAdjacentHTML('afterend', `<section id="lux-member-home" class="lux-member-home">
        <header><span class="hub-kicker">MI CUENTA</span><h2>¿Qué quieres hacer?</h2><p>Elige una opción. Solo verás la parte que necesitas.</p></header>
        <div class="lux-simple-actions">
          <button type="button" onclick="window.luxSupabase.showMyProfile()"><i>👤</i><strong>Completar mi perfil</strong><small>Cambia tu nombre, edad, país o foto.</small><b>ABRIR</b></button>
          <button type="button" onclick="window.luxPlatformV3.showMemberSection('matches')"><i>🎮</i><strong>Registrar un partido</strong><small>Una captura, participantes y estadísticas del equipo.</small><b>ABRIR</b></button>
          <button type="button" onclick="window.luxSupabase.showMemberDirectory()"><i>👥</i><strong>Ver integrantes</strong><small>Mira perfiles, estadísticas y capturas.</small><b>ABRIR</b></button>
          <button type="button" onclick="window.luxPlatformV3.showMemberSection('events')"><i>📅</i><strong>Ver convocatorias</strong><small>Confirma si puedes jugar y tu rol preferido.</small><b>ABRIR</b></button>
          <button type="button" onclick="window.luxPlatformV3.showMemberSection('announcements')"><i>📢</i><strong>Avisos del clan</strong><small>Lee las novedades publicadas por el equipo.</small><b>ABRIR</b></button>
          <button type="button" onclick="window.luxSupabase.downloadMyBanner()"><i>🖼️</i><strong>Descargar mi banner</strong><small>Se genera con los datos guardados en tu perfil.</small><b>DESCARGAR</b></button>
        </div>
        <div class="lux-simple-steps"><strong>¿Cómo funciona?</strong><span><b>1</b> Completa tu perfil</span><span><b>2</b> Registra el partido</span><span><b>3</b> El equipo lo revisa</span></div>
      </section>`);
    }
    const memberIntroTitle = document.querySelector('#hub-member .hub-intro h2');
    const memberIntroCopy = document.querySelector('#hub-member .hub-intro p');
    if (memberIntroTitle) memberIntroTitle.textContent = 'Mi perfil';
    if (memberIntroCopy) memberIntroCopy.textContent = 'Guarda aquí tu nombre, edad, país y foto. Esta información también completa tu banner.';
    const winTitle = document.querySelector('#hub-member .hub-win h3');
    const winCopy = document.querySelector('#hub-member .hub-win p');
    if (winTitle) winTitle.textContent = 'Subir una victoria';
    if (winCopy) winCopy.textContent = 'Elige el modo, selecciona la captura y envíala. Solo contará cuando un administrador la apruebe.';
    const historyTitle = document.querySelector('#hub-member .hub-history h3');
    if (historyTitle) historyTitle.textContent = 'Mis capturas';

    const adminPage = document.querySelector('#hub-admin .hub-page');
    if (adminPage && !$('lux-admin-tabs')) adminPage.insertAdjacentHTML('afterbegin', '<nav id="lux-admin-tabs" class="lux-admin-tabs" aria-label="Herramientas de administracion"></nav>');
    if (adminPage && !$('lux-admin-menu')) {
      const tabs = $('lux-admin-tabs');
      if (tabs) tabs.insertAdjacentHTML('afterend', '<section id="lux-admin-menu" class="lux-admin-menu"></section>');
      else adminPage.insertAdjacentHTML('afterbegin', '<section id="lux-admin-menu" class="lux-admin-menu"></section>');
    }
    const directoryBack = document.querySelector('#hub-member-directory .hub-directory-head>button');
    const platesBack = document.querySelector('#lux-plates-panel .lux-plates-head>button');
    if (directoryBack) directoryBack.textContent = '← VOLVER AL PANEL';
    if (platesBack) platesBack.textContent = '← VOLVER AL PANEL';
    renderAdminTabs();
    renderAdminMenu();
  }

  function renderAdminMenu() {
    const target = $('lux-admin-menu');
    if (!target) return;
    if (!target.querySelector('.lux-admin-dashboard')) {
      target.innerHTML = `<div class="lux-admin-dashboard">
        <div class="lux-admin-overview-slot"></div>
        <div class="lux-admin-stats-slot"></div>
        <section class="lux-admin-focus" aria-live="polite">
          <span class="lux-admin-focus-icon" aria-hidden="true">✓</span>
          <div><span class="hub-kicker">ESTADO DE MODERACIÓN</span><strong id="lux-admin-focus-title">Todo está al día</strong><small id="lux-admin-focus-copy">No hay victorias esperando revisión.</small></div>
          <button type="button" onclick="window.luxSupabase.showAdminReview()">VER VICTORIAS →</button>
        </section>
      </div>`;
    }

    const adminPage = document.querySelector('#hub-admin .hub-page');
    const intro = adminPage?.querySelector('.hub-admin-head');
    const stats = adminPage?.querySelector('.hub-admin-stats');
    const introSlot = target.querySelector('.lux-admin-overview-slot');
    const statsSlot = target.querySelector('.lux-admin-stats-slot');
    if (intro && introSlot && intro.parentElement !== introSlot) introSlot.appendChild(intro);
    if (stats && statsSlot && stats.parentElement !== statsSlot) statsSlot.appendChild(stats);

    if (intro) {
      intro.hidden = false;
      intro.classList.add('lux-admin-overview');
      const kicker = intro.querySelector('.hub-kicker');
      const title = intro.querySelector('h2');
      const copy = intro.querySelector('p');
      if (kicker) kicker.textContent = 'CENTRO DE MANDO';
      if (title) title.innerHTML = 'Estado <em>del clan.</em>';
      if (copy) copy.textContent = 'Lo importante, ordenado en una sola vista. Usa la barra superior cuando necesites administrar algo.';
    }

    if (stats) {
      stats.hidden = false;
      const cards = [...stats.children];
      if (cards[0]?.querySelector('small')) cards[0].querySelector('small').textContent = 'INTEGRANTES';
      if (cards[1]?.querySelector('small')) cards[1].querySelector('small').textContent = 'VICTORIAS 4V4';
      if (cards[2] && !cards[2].querySelector('#admin-total-wins')) cards[2].innerHTML = '<b id="admin-total-wins">0</b><small>VICTORIAS TOTALES</small>';
      if (!$('admin-pending')) stats.insertAdjacentHTML('beforeend', '<article><b id="admin-pending">0</b><small>POR REVISAR</small></article>');
    }

    const pending = Number(state.pendingReviews || 0);
    const focus = target.querySelector('.lux-admin-focus');
    const focusIcon = target.querySelector('.lux-admin-focus-icon');
    const focusTitle = $('lux-admin-focus-title');
    const focusCopy = $('lux-admin-focus-copy');
    if (focus) focus.classList.toggle('has-pending', pending > 0);
    if (focusIcon) focusIcon.textContent = pending > 0 ? '!' : '✓';
    if (focusTitle) focusTitle.textContent = pending > 0 ? `${pending} ${pending === 1 ? 'victoria pendiente' : 'victorias pendientes'}` : 'Todo está al día';
    if (focusCopy) focusCopy.textContent = pending > 0 ? 'Hay capturas nuevas que necesitan una decisión.' : 'No hay victorias esperando revisión.';
  }

  function showMemberSection(section = 'home') {
    if (['matches','events','announcements','pending'].includes(section) && window.luxPlatformV3?.showMemberSection) {
      window.luxPlatformV3.showMemberSection(section);
      return;
    }
    const page = document.querySelector('#hub-member .hub-page');
    if (!page) return;
    ensureSimpleExperience();
    const groups = {
      home:[$('lux-member-home'), $('lux-member-top')],
      profile:[page.querySelector('.hub-intro'), page.querySelector('.hub-grid')],
      victories:[page.querySelector('.hub-win'), page.querySelector('.hub-history')],
      directory:[$('lux-member-directory')]
    };
    const visible = new Set((groups[section] || groups.home).filter(Boolean));
    [...page.children].forEach(child => { child.hidden = child.id !== 'lux-member-tabs' && !visible.has(child); });
    page.querySelectorAll('[data-member-section]').forEach(button => button.classList.toggle('active', button.dataset.memberSection === section));
    scrollTopNow();
    requestAnimationFrame(() => revealActiveTab($('lux-member-tabs')));
  }

  async function renderPublic() {
    try {
      const [ranking, plates, clanDirectory] = await Promise.all([
        rpc('get_public_ranking', {}, false),
        rpc('get_public_plate_ranking', {}, false),
        state.user ? rpc('get_clan_directory').catch(() => []) : Promise.resolve([])
      ]);
      const all = Array.isArray(ranking) ? ranking : [];
      const memberRows = Array.isArray(clanDirectory) && clanDirectory.length ? clanDirectory : all;
      state.publicDirectory = new Map(memberRows.map(row => [row.player_id, row]));
      state.publicPlates = new Map((plates || []).map(row => [row.player_id, row]));
      const total4 = all.reduce((sum, row) => sum + Number(row.victories_4v4 || 0), 0);
      const total = all.reduce((sum, row) => sum + Number(row.victories_total || 0), 0);
      if ($('lux-public-members')) $('lux-public-members').textContent = all.length;
      if ($('lux-public-wins')) $('lux-public-wins').textContent = total4;
      if ($('lux-public-total')) $('lux-public-total').textContent = total;
      if ($('lux-public-podium')) $('lux-public-podium').innerHTML = all.slice(0, 3).map((row, index) => `<button type="button" onclick="window.luxSupabase.openPublicPlayer('${esc(row.player_id)}')"><i>#${index + 1}</i>${avatarHtml(row, 'lux-podium-avatar')}<strong>${esc(row.display_name)}</strong><small>${row.victories_total} victorias aprobadas</small><em>VER PERFIL</em></button>`).join('') || '<p class="hub-empty">Todavía no hay resultados confirmados.</p>';
      if ($('lux-public-ranking')) $('lux-public-ranking').innerHTML = all.map((row, index) => `<button type="button" class="lux-public-row" aria-label="Abrir perfil de ${esc(row.display_name)}" onclick="window.luxSupabase.openPublicPlayer('${esc(row.player_id)}')"><i>#${index + 1}</i>${avatarHtml(row)}<div><strong>${esc(row.display_name)}</strong><small>${rankingModeLine(row)} · TOTAL ${Number(row.victories_total || 0)}</small></div></button>`).join('') || '<p class="hub-empty">El ranking aparecerá al aprobarse victorias.</p>';
      renderPublicPlates(plates || []);
      renderMemberTop(all);
      renderMemberDirectory();
      renderNavigation();
    } catch (_) {
      if ($('lux-public-ranking')) $('lux-public-ranking').innerHTML = '<p class="hub-empty">No se pudo cargar la clasificación. Revisa tu conexión.</p>';
    }
  }
  function renderMemberTop(all) {
    const target = $('lux-member-top');
    if (!target) return;
    const mine = all.find(row => row.player_id === state.user?.id);
    const position = mine ? all.findIndex(row => row.player_id === mine.player_id) + 1 : 0;
    target.innerHTML = `<div class="lux-member-top-head"><div><span class="hub-kicker">MI POSICIÓN</span><h3>Resumen competitivo</h3></div></div><div class="lux-member-top-grid lux-member-top-simple"><article><b>${position ? `#${position}` : '—'}</b><small>POSICIÓN GENERAL</small></article><article><b>${mine?.victories_total || 0}</b><small>VICTORIAS APROBADAS</small></article><section><button type="button" onclick="window.luxSupabase.openRanking('member')">VER CLASIFICACIÓN</button><button type="button" onclick="window.luxSupabase.showMemberDirectory()">VER INTEGRANTES</button></section></div>`;
  }
  function ensureMemberDirectory() {
    const page = document.querySelector('#hub-member .hub-page');
    if (!page || $('lux-member-directory')) return;
    page.insertAdjacentHTML('beforeend', `<section id="lux-member-directory" class="hub-card lux-member-directory">
      <div class="lux-member-directory-head"><div><span class="hub-kicker">COMPAÑEROS DEL CLAN</span><h3>Integrantes</h3><p>Consulta sus fichas, estadísticas y capturas aprobadas sin exponer correos.</p></div></div>
      <label class="lux-member-search">BUSCAR INTEGRANTE<input id="lux-member-search" type="search" placeholder="Nombre o país" oninput="window.luxSupabase.renderMemberDirectory()"/></label>
      <div id="lux-member-directory-list" class="lux-member-directory-list"></div>
    </section>`);
  }
  function renderMemberDirectory() {
    ensureMemberDirectory();
    const target = $('lux-member-directory-list');
    if (!target) return;
    const query = String($('lux-member-search')?.value || '').trim().toLocaleLowerCase('es');
    const rows = [...state.publicDirectory.values()].filter(row => {
      const searchable = `${row.display_name || ''} ${countryLabel(row.country_code)}`.toLocaleLowerCase('es');
      return !query || searchable.includes(query);
    });
    target.innerHTML = rows.length ? rows.map((row, index) => `<button type="button" class="lux-member-public-row" onclick="window.luxSupabase.openPublicPlayer('${esc(row.player_id)}')"><i>#${index + 1}</i>${avatarHtml(row, 'lux-member-public-avatar')}<span><strong>${esc(row.display_name || 'Integrante')}</strong><small>${esc(countryLabel(row.country_code))}${row.age ? ` · ${Number(row.age)} años` : ''} · ${rankingModeLine(row)} · TOTAL ${Number(row.victories_total || 0)}</small></span><b>VER PERFIL</b></button>`).join('') : '<p class="hub-empty">No hay integrantes que coincidan con la búsqueda.</p>';
  }
  async function showMemberDirectory() {
    if (!state.user) { openLogin('member'); return; }
    await openMember('directory');
    renderMemberDirectory();
  }
  async function showMyProfile() {
    await openMember('profile');
  }
  async function showMyVictories() {
    await openMember('victories');
  }
  function ensurePublicPlates() {
    const page = document.querySelector('#lux-public-screen .hub-page');
    if (page && !$('lux-public-plates-ranking')) page.insertAdjacentHTML('beforeend', '<section class="lux-public-card lux-public-plates"><span class="hub-kicker">ACTIVIDAD DEL CLAN</span><h3>Top de placas</h3><p>Lecturas confirmadas por las líderes desde el panel de Free Fire.</p><div id="lux-public-plates-ranking"></div></section>');
  }
  function renderPublicPlates(rows) {
    ensurePublicPlates();
    const target = $('lux-public-plates-ranking');
    if (!target) return;
    const active = rows.filter(row => Number(row.plates_total || row.plate_count || 0) > 0 || Number(row.glory_total || 0) > 0);
    target.innerHTML = active.length ? active.slice(0, 5).map((row, index) => `<button type="button" class="lux-public-plate-row" onclick="window.luxPlates.openGallery('${esc(row.player_id)}')"><b>#${index + 1}</b>${avatarHtml(row, 'lux-public-plate-avatar')}<span>${esc(row.display_name)}<small>${Number(row.plates_week || 0)} esta semana</small></span><em>${Number(row.plates_total || row.plate_count || 0)} placas</em></button>`).join('') : '<p class="lux-plates-public-empty">Aún no hay una captura de actividad confirmada.</p>';
  }

  function ensureMemberModeStats() {
    const target = document.querySelector('.hub-stats>div');
    if (!target || $('hub-1v1')) return;
    target.classList.add('lux-mode-summary');
    target.innerHTML = `<article><b id="hub-1v1">0</b><small>1V1</small></article><article><b id="hub-2v2">0</b><small>2V2</small></article><article><b id="hub-3v3">0</b><small>3V3</small></article><article><b id="hub-4v4">0</b><small>4V4</small></article><article><b id="hub-other">0</b><small>OTRAS</small></article><article><b id="hub-total">0</b><small>TOTAL</small></article>`;
  }

  async function renderMemberFresh() {
    if (!state.user) return;
    ensureMemberModeStats();
    const profile = await loadProfile();
    const rows = await request(`/rest/v1/victories?player_id=eq.${encodeURIComponent(state.user.id)}&select=id,mode,evidence_path,status,created_at,rejection_reason&order=created_at.desc`);
    const accepted = rows.filter(row => row.status === 'approved');
    const stats = modeStats(rows);
    if (!state.profileDraftDirty) {
      if ($('hub-name')) $('hub-name').value = profile?.display_name === 'Jugador' ? '' : (profile?.display_name || '');
      if ($('hub-age')) $('hub-age').value = profile?.age || '';
      if ($('hub-country')) $('hub-country').value = profile?.country_code || '';
    }
    if ($('hub-role')) $('hub-role').value = roleLabel();
    const avatar = profile?.avatar_path ? publicUrl('lux-avatars', profile.avatar_path) : '';
    if (!state.pendingAvatar) {
      if ($('hub-avatar')) { $('hub-avatar').src = avatar; $('hub-avatar').hidden = !avatar; }
      if ($('hub-avatar-empty')) $('hub-avatar-empty').hidden = Boolean(avatar);
    }
    if ($('hub-1v1')) $('hub-1v1').textContent = stats['1v1'];
    if ($('hub-2v2')) $('hub-2v2').textContent = stats['2v2'];
    if ($('hub-3v3')) $('hub-3v3').textContent = stats['3v3'];
    if ($('hub-4v4')) $('hub-4v4').textContent = stats['4v4'];
    if ($('hub-other')) $('hub-other').textContent = stats.Otro;
    if ($('hub-total')) $('hub-total').textContent = accepted.length;
    const list = $('hub-history-list');
    if (list) {
      const signed = await Promise.all(rows.map(async row => ({ ...row, url:await signedEvidence(row.evidence_path).catch(() => '') })));
      list.innerHTML = signed.length ? signed.map(row => `<article class="hub-evidence">${evidenceButton(row.url, `Victoria ${row.mode}`)}<b>${esc(row.mode)} · ${row.status === 'approved' ? 'APROBADA' : row.status === 'rejected' ? 'RECHAZADA' : 'PENDIENTE'}</b>${row.rejection_reason ? `<small>${esc(row.rejection_reason)}</small>` : ''}</article>`).join('') : '<p class="hub-empty">Todavía no has subido capturas.</p>';
    }
    if (!state.publicDirectory.size) await renderPublic();
    const combined = state.publicDirectory.get(state.user.id);
    if (combined) {
      if ($('hub-1v1')) $('hub-1v1').textContent = Number(combined.victories_1v1 || 0);
      if ($('hub-2v2')) $('hub-2v2').textContent = Number(combined.victories_2v2 || 0);
      if ($('hub-3v3')) $('hub-3v3').textContent = Number(combined.victories_3v3 || 0);
      if ($('hub-4v4')) $('hub-4v4').textContent = Number(combined.victories_4v4 || 0);
      if ($('hub-other')) $('hub-other').textContent = Number(combined.victories_other || 0);
      if ($('hub-total')) $('hub-total').textContent = Number(combined.victories_total || 0);
    }
  }
  async function renderMember(force = false) {
    if (!state.user) return;
    if (!force && state.profile && state.memberRenderedAt && Date.now() - state.memberRenderedAt < 20_000) return;
    if (memberRenderPromise) return memberRenderPromise;
    memberRenderPromise = renderMemberFresh()
      .then(result => { state.memberRenderedAt = Date.now(); return result; })
      .finally(() => { memberRenderPromise = null; });
    return memberRenderPromise;
  }
  async function saveProfile(quiet = false) {
    if (!state.user) { openLogin('member'); return null; }
    try {
    const display_name = $('hub-name')?.value.trim();
    const age = Number($('hub-age')?.value || 0) || null;
    const country_code = $('hub-country')?.value || null;
    const country_name = countryName();
    if (!display_name || display_name.length < 2) { $('hub-name')?.focus(); toast('⚠️ ESCRIBE UN NOMBRE DE 2 A 24 CARACTERES'); return null; }
    if (display_name.length > 24 || !age || age < 13 || age > 99) { $('hub-age')?.focus(); toast('⚠️ ESCRIBE UNA EDAD ENTRE 13 Y 99'); return null; }
    if (!country_code || !country_name) { $('hub-country')?.focus(); toast('⚠️ SELECCIONA TU PAÍS'); return null; }
    let avatar_path = state.profile?.avatar_path || null;
    if (state.pendingAvatar) {
      avatar_path = `${state.user.id}/avatar-${Date.now()}.${extension(state.pendingAvatar)}`;
      await upload('lux-avatars', avatar_path, state.pendingAvatar);
      state.pendingAvatar = null;
    }
    await rpc('complete_my_onboarding', {
      p_display_name:display_name,
      p_age:age,
      p_country_code:country_code,
      p_country_name:country_name,
      p_avatar_path:avatar_path,
      p_message:null,
      p_primary_game_role:$('lux-primary-role') ? ($('lux-primary-role').value || null) : (state.profile?.primary_game_role || null),
      p_secondary_game_role:$('lux-secondary-role') ? ($('lux-secondary-role').value || null) : (state.profile?.secondary_game_role || null),
      p_experience_level:$('lux-experience-level') ? ($('lux-experience-level').value || null) : (state.profile?.experience_level || null)
    });
    await loadProfile();
    try {
      const invite = sessionStorage.getItem('lux_clan_invite');
      if (invite && !['active','trial','reserve'].includes(state.profile?.membership_status)) {
        await rpc('redeem_clan_invite', { p_token:invite });
        sessionStorage.removeItem('lux_clan_invite');
        await loadProfile();
      }
    } catch (inviteError) {
      if (!quiet) toast(`⚠️ PERFIL GUARDADO · ${errorMessage(inviteError).toUpperCase()}`);
    }
    state.profileDraftDirty = false;
    if (state.profile && state.user?.id) {
      state.directory.set(state.user.id, state.profile);
    }
    await Promise.all([renderMember(true), renderPublic()]);
    if (state.isStaff) await renderAdmin();
    const updatedAvatarUrl = state.profile?.avatar_path ? publicUrl('lux-avatars', state.profile.avatar_path) : '';
    if (updatedAvatarUrl && window.readPlayerFileInteg) {
      try {
        const blob = await fetch(updatedAvatarUrl).then(response => response.blob());
        window.readPlayerFileInteg(new File([blob], 'perfil.jpg', { type:'image/jpeg' }));
      } catch (_) {}
    }
    await window.luxPlatformV3?.afterProfileSaved?.();
    if (!quiet) toast('✅ PERFIL GUARDADO DE FORMA SEGURA');
    return state.profile;
    } catch (error) {
      if (!quiet) toast(`⚠️ NO SE PUDO GUARDAR EL PERFIL: ${errorMessage(error).toUpperCase()}`);
      return null;
    }
  }
  async function pickAvatar(event) {
    const file = event?.target?.files?.[0];
    if (!isImage(file, MAX_AVATAR)) { toast('⚠️ USA JPG, PNG O WEBP DE HASTA 5 MB'); return; }
    state.pendingAvatar = file;
    state.profileDraftDirty = true;
    const url = URL.createObjectURL(file);
    if ($('hub-avatar')) { $('hub-avatar').src = url; $('hub-avatar').hidden = false; }
    if ($('hub-avatar-empty')) $('hub-avatar-empty').hidden = true;
    if (event?.target) event.target.value = '';
    toast('✅ FOTO LISTA PARA GUARDAR');
  }
  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => canvas?.toBlob(blob => blob ? resolve(blob) : reject(new Error('No se pudo leer el banner')), 'image/png'));
  }
  async function saveCurrentBanner(canvas) {
    if (!state.user || state.editorBack !== 'member') return;
    try {
      const blob = await canvasBlob(canvas);
      if (blob.size > MAX_BANNER) throw new Error('El banner supera el límite de 10 MB');
      const banner_path = `${state.user.id}/integrante.png`;
      await uploadUpsert('lux-banners', banner_path, new File([blob], 'integrante.png', { type:'image/png' }));
      await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(state.user.id)}`, {
        method:'PATCH', headers:{ 'Content-Type':'application/json', Prefer:'return=representation' }, body:JSON.stringify({ banner_path })
      });
      if (state.profile) state.profile.banner_path = banner_path;
      if (state.directory.has(state.user.id)) state.directory.get(state.user.id).banner_path = banner_path;
      toast('✅ TU MISMO BANNER QUEDÓ GUARDADO PARA LAS LÍDERES');
    } catch (error) {
      toast(`⚠️ EL BANNER SE DESCARGÓ, PERO NO SE PUDO GUARDAR: ${errorMessage(error).toUpperCase()}`);
    }
  }
  async function loadMine() { return state.profile; }
  async function registerVictory() {
    if (!state.user) { openLogin('member'); return; }
    const file = $('hub-victory')?.files?.[0];
    if (!isImage(file, MAX_EVIDENCE)) { toast('⚠️ USA JPG, PNG O WEBP DE HASTA 8 MB'); return; }
    let evidence_path = '';
    try {
      const [evidence_sha256, evidence_visual_hashes] = await Promise.all([sha256(file), imageVisualHashes(file)]);
      evidence_path = `${state.user.id}/${randomId()}.${extension(file)}`;
      await upload('lux-evidence', evidence_path, file);
      await rpc('submit_victory_secure', {
        p_mode:$('hub-mode')?.value || '4v4',
        p_evidence_path:evidence_path,
        p_evidence_sha256:evidence_sha256,
        p_evidence_dhash:evidence_visual_hashes[0],
        p_visual_hashes:evidence_visual_hashes,
        p_client_captured_at:new Date(file.lastModified || Date.now()).toISOString()
      });
      $('hub-victory').value = '';
      toast('🕒 CAPTURA ENVIADA · ESPERA LA REVISIÓN DE UNA LÍDER');
      await renderMember(true);
    } catch (error) {
      if (evidence_path) await request(`/storage/v1/object/lux-evidence/${evidence_path.split('/').map(encodeURIComponent).join('/')}`, { method:'DELETE' }).catch(() => {});
      const message = errorMessage(error, 'NO SE PUDO ENVIAR LA CAPTURA').toUpperCase();
      if (/SUBMIT_VICTORY_SECURE|SCHEMA CACHE|PGRST202/.test(message)) {
        toast('⚠️ LA VALIDACIÓN SE ESTÁ ACTUALIZANDO. RECARGA E INTENTA DE NUEVO.');
        return;
      }
      toast(`⚠️ ${message}`);
    }
  }

  function orderedDirectory() {
    return [...state.directory.values()].filter(member => !member.membership_status || ['active','trial','reserve'].includes(member.membership_status)).sort((a, b) => {
      const statsA = state.ranking.get(a.id) || {};
      const statsB = state.ranking.get(b.id) || {};
      return Number(statsB.victories_4v4 || 0) - Number(statsA.victories_4v4 || 0)
        || Number(statsB.victories_3v3 || 0) - Number(statsA.victories_3v3 || 0)
        || Number(statsB.victories_2v2 || 0) - Number(statsA.victories_2v2 || 0)
        || Number(statsB.victories_1v1 || 0) - Number(statsA.victories_1v1 || 0)
        || Number(statsB.victories_total || 0) - Number(statsA.victories_total || 0)
        || String(a.display_name || '').localeCompare(String(b.display_name || ''), 'es');
    });
  }
  function canRemoveMember(id) {
    if (!state.isLeader || !id || id === state.user?.id) return false;
    return state.isOwner || state.roles.get(id) === 'member';
  }
  function bannerButton(member) {
    return `<button type="button" onclick="window.luxSupabase.downloadOfficialBanner('${esc(member.id)}')">BANNER ↓</button>`;
  }
  function removalButton(member, label = 'EXPULSAR') {
    return canRemoveMember(member.id)
      ? `<button type="button" class="lux-danger-action" onclick="window.luxSupabase.requestMemberRemoval('${esc(member.id)}')">${label}</button>`
      : '';
  }
  function renderDirectory() {
    const target = $('hub-member-directory-list');
    if (!target) return;
    const query = String($('hub-directory-search')?.value || '').trim().toLocaleLowerCase('es');
    const rows = orderedDirectory().filter(member => !query || `${member.display_name || ''} ${member.country_name || ''} ${member.country_code || ''}`.toLocaleLowerCase('es').includes(query));
    target.innerHTML = rows.length ? rows.map((member, index) => {
      const stats = state.ranking.get(member.id) || {};
      const profileState = member.display_name === 'Jugador' ? ' · PERFIL PENDIENTE' : '';
      return `<article class="hub-member-row"><i>#${index + 1}</i>${avatarHtml(member, 'hub-directory-avatar')}<div><strong>${esc(member.display_name || 'Jugador')}</strong><small>${esc(member.country_name || member.country_code || 'País pendiente')} · ${rankingModeLine(stats)} · TOTAL ${Number(stats.victories_total || 0)}${profileState}</small></div><span class="hub-member-row-actions"><button type="button" onclick="window.luxHub.openPlayer('${esc(member.id)}')">VER</button>${bannerButton(member)}${removalButton(member)}</span></article>`;
    }).join('') : '<p class="hub-empty">No hay integrantes que coincidan con la búsqueda.</p>';
  }
  async function showDirectory() {
    if (!state.isStaff) return;
    const page = $('hub-admin')?.querySelector('.hub-page');
    const panel = $('hub-member-directory');
    if (!page || !panel) return;
    showPageChildren(page, panel, ['lux-admin-tabs']);
    setAdminSection('directory');
    if (!state.directory.size && $('hub-member-directory-list')) $('hub-member-directory-list').innerHTML = '<p class="hub-empty lux-loading-placeholder">Cargando integrantes…</p>';
    if (!state.directory.size) await renderAdmin();
    if ($('hub-directory-search')) $('hub-directory-search').value = '';
    renderDirectory();
  }
  async function showAdminSummary() {
    if (!state.isStaff) return;
    const navigationToken = beginNavigation('admin:home');
    state.navigationContext = 'admin';
    window.luxHub.setScreen('admin');
    const page = $('hub-admin')?.querySelector('.hub-page');
    if (!page) { endNavigation(navigationToken); return; }
    ensureSimpleExperience();
    const visible = new Set([$('lux-admin-tabs'), $('lux-admin-menu'), page.querySelector('.hub-admin-head'), page.querySelector('.hub-admin-stats')].filter(Boolean));
    [...page.children].forEach(child => { child.hidden = !visible.has(child); });
    setAdminSection('home');
    renderNavigation();
    scrollTopNow();
    try {
      if (!state.directory.size || Date.now() - state.adminRenderedAt > 20_000) await renderAdmin();
      else await window.luxPlatformV3?.refreshAdminSummary?.();
    } finally {
      endNavigation(navigationToken, $('lux-admin-menu'));
    }
  }

  function ensureOwnerPanel() {
    const admin = $('hub-admin');
    const page = admin?.querySelector('.hub-page');
    if (!admin || !page) return;
    if (!state.isOwner) {
      $('lux-owner-panel')?.remove();
      return;
    }
    if (!$('lux-owner-panel')) page.insertAdjacentHTML('beforeend', `<section id="lux-owner-panel" class="lux-owner-panel" hidden>
      <header class="hub-directory-head"><div><span class="hub-kicker">CONTROL PRIVADO</span><h2>Cuentas, roles y<br/><em>respaldo.</em></h2><p>Solo la cuenta propietaria puede ver correos, nombrar líderes o moderadores, eliminar cuentas y descargar el respaldo.</p></div><span class="lux-owner-panel-actions"><button type="button" onclick="window.luxHub.backup()">DESCARGAR RESPALDO</button><button type="button" onclick="window.luxHub.showAdminSummary()">← VOLVER AL PANEL</button></span></header>
      <div class="lux-owner-notice">🔒 Solo tú ves los correos y cambias los roles. Un líder administra integrantes y victorias; un moderador puede revisar victorias. La cuenta owner nunca puede modificarse desde aquí.</div>
      <div id="lux-owner-accounts" class="lux-owner-accounts"></div>
    </section>`);
  }
  async function showOwnerAccounts() {
    if (!state.isOwner) return;
    ensureOwnerPanel();
    const page = $('hub-admin')?.querySelector('.hub-page');
    const panel = $('lux-owner-panel');
    const target = $('lux-owner-accounts');
    if (!page || !panel || !target) return;
    showPageChildren(page, panel, ['lux-admin-tabs']);
    setAdminSection('accounts');
    target.innerHTML = '<p class="hub-empty">Cargando cuentas seguras…</p>';
    try {
      const rows = await rpc('owner_list_clan_users');
      target.innerHTML = rows.length ? rows.map(row => {
        const connected = String(row.providers || '').split(',').map(item => item.trim()).filter(Boolean);
        const profile = state.directory.get(row.user_id);
        const canDelete = row.user_id !== state.user?.id;
        const currentRole = ['owner','leader','moderator','member'].includes(row.role) ? row.role : 'member';
        const roleOptions = ['member','moderator','leader'].map(role => `<option value="${role}"${currentRole === role ? ' selected' : ''}>${esc(roleLabel(role).toUpperCase())}</option>`).join('');
        const roleEditor = canDelete ? `<label class="lux-owner-role-field"><span>ROL</span><select id="lux-account-role-${esc(row.user_id)}" aria-label="Rol de ${esc(row.display_name || 'Jugador')}">${roleOptions}</select></label><button type="button" class="lux-role-save" onclick="window.luxSupabase.setAccountRole('${esc(row.user_id)}')">GUARDAR ROL</button>` : '<em>CUENTA OWNER</em>';
        return `<article class="lux-owner-account">${avatarHtml(profile || { display_name:row.display_name }, 'lux-owner-avatar')}<div><strong>${esc(row.display_name || 'Jugador')}</strong><span>${esc(row.email || 'Sin correo visible')}</span><small>${esc(roleLabel(currentRole).toUpperCase())} · ${connected.includes('google') ? 'GOOGLE CONECTADO' : 'ACCESO ANTIGUO POR CORREO'} · ${row.display_name === 'Jugador' ? 'PERFIL PENDIENTE' : 'PERFIL ACTIVO'} · ${new Date(row.created_at).toLocaleDateString('es-ES')}</small></div><span class="lux-owner-actions">${profile ? `<button type="button" onclick="window.luxHub.openPlayer('${esc(row.user_id)}')">VER PERFIL</button>` : '<em>SIN PERFIL</em>'}${roleEditor}${canDelete ? `<button type="button" class="lux-danger-action" onclick="window.luxSupabase.requestMemberRemoval('${esc(row.user_id)}')">ELIMINAR</button>` : ''}</span></article>`;
      }).join('') : '<p class="hub-empty">Todavía no hay cuentas registradas.</p>';
    } catch (error) {
      target.innerHTML = `<p class="hub-empty">No se pudo cargar el control de cuentas: ${esc(errorMessage(error))}</p>`;
    }
  }

  async function setAccountRole(id) {
    if (!state.isOwner || !id || id === state.user?.id) return;
    const select = $(`lux-account-role-${id}`);
    const nextRole = select?.value;
    if (!['member','moderator','leader'].includes(nextRole)) return;
    const account = state.directory.get(id);
    const name = account?.display_name || 'esta cuenta';
    if (!window.confirm(`¿Cambiar el rol de ${name} a ${roleLabel(nextRole)}?`)) return;
    if (select) select.disabled = true;
    try {
      await rpc('owner_set_member_role', { p_user_id:id, p_role:nextRole });
      state.roles.set(id, nextRole);
      toast(`✅ ${name.toUpperCase()} AHORA ES ${roleLabel(nextRole).toUpperCase()}`);
      await showOwnerAccounts();
    } catch (error) {
      if (select) select.disabled = false;
      toast(`⚠️ ${errorMessage(error, 'NO SE PUDO CAMBIAR EL ROL').toUpperCase()}`);
    }
  }

  async function renderAdmin() {
    if (!state.isStaff) return;
    const sessionLabel = $('lux-leader-session');
    if (sessionLabel) sessionLabel.textContent = state.isOwner ? 'Control privado · cuenta verificada' : `${roleLabel()} · cuenta verificada`;
    const [profiles, victories, ranking, roles] = await Promise.all([
      request('/rest/v1/profiles?select=id,display_name,age,country_code,country_name,avatar_path,banner_path,is_public,onboarding_complete,membership_status,public_slug,primary_game_role,secondary_game_role,experience_level,status_reason,removed_at,purge_after,merged_into,created_at&order=display_name.asc'),
      request('/rest/v1/victories?select=id,player_id,mode,evidence_path,status,duplicate_risk,duplicate_of,created_at,rejection_reason&order=created_at.desc'),
      rpc('get_public_ranking', {}, false),
      rpc('staff_list_member_roles')
    ]);
    state.directory = new Map((profiles || []).map(row => [row.id, row]));
    state.roles = new Map((roles || []).map(row => [row.user_id, row.role]));
    const approved = (victories || []).filter(row => row.status === 'approved');
    const byId = new Map((ranking || []).map(row => [row.player_id, row]));
    state.ranking = byId;
    const ordered = orderedDirectory();
    const mvp = ordered[0];
    if ($('admin-members')) $('admin-members').textContent = ordered.length;
    if ($('admin-wins')) $('admin-wins').textContent = approved.filter(row => row.mode === '4v4').length;
    if ($('admin-total-wins')) $('admin-total-wins').textContent = approved.length;
    if ($('admin-mvp')) $('admin-mvp').innerHTML = mvp ? avatarHtml(mvp, 'hub-mvp-avatar') : '<span class="hub-mvp-avatar hub-avatar-empty">★</span>';
    if ($('admin-mvp-name')) $('admin-mvp-name').textContent = mvp?.display_name || 'Aún sin MVP';
    if ($('admin-mvp-detail')) $('admin-mvp-detail').textContent = mvp ? `${byId.get(mvp.id)?.victories_total || 0} victorias aprobadas` : 'Registra la primera victoria';
    if ($('admin-ranking')) $('admin-ranking').innerHTML = ordered.map((member, index) => { const stats = byId.get(member.id) || {}; return `<button type="button" class="hub-rank" onclick="window.luxHub.openPlayer('${esc(member.id)}')"><i>#${index + 1}</i>${avatarHtml(member, 'hub-rank-avatar')}<span><strong>${esc(member.display_name)}</strong><small>${rankingModeLine(stats)} · TOTAL ${Number(stats.victories_total || 0)}</small></span><b>VER</b></button>`; }).join('') || '<p class="hub-empty">Aún no hay integrantes registrados.</p>';
    const duplicateRanking = document.querySelector('#hub-admin .hub-ranking');
    if (duplicateRanking) duplicateRanking.hidden = true;
    const pendingVictories = (victories || []).filter(row => row.status === 'pending');
    state.pendingReviews = pendingVictories.length;
    if ($('admin-pending')) $('admin-pending').textContent = pendingVictories.length;
    renderReviewQueue(pendingVictories);
    renderDirectory();
    ensureOwnerPanel();
    renderAdminTabs();
    renderAdminMenu();
    await renderPlatesSelector();
    await renderPlatesRanking();
    await window.luxPlatformV3?.refreshAdminSummary?.();
    state.adminRenderedAt = Date.now();
  }
  function ensureReviewPanel() {
    const page = $('hub-admin')?.querySelector('.hub-page');
    if (page && !$('lux-review-queue')) page.insertAdjacentHTML('beforeend', '<section id="lux-review-queue" class="hub-card lux-review-queue" hidden><header class="lux-section-heading"><div><span class="hub-kicker">REVISIÓN</span><h2>Victorias pendientes</h2><p>Abre cada captura y decide si corresponde a una victoria real.</p></div><button type="button" onclick="window.luxHub.showAdminSummary()">← VOLVER AL PANEL</button></header><div id="lux-review-list"></div></section>');
  }
  async function showAdminReview() {
    if (!state.isStaff) return;
    ensureReviewPanel();
    const page = $('hub-admin')?.querySelector('.hub-page');
    const panel = $('lux-review-queue');
    if (!page || !panel) return;
    showPageChildren(page, panel, ['lux-admin-tabs']);
    setAdminSection('review');
    if (!state.directory.size && $('lux-review-list')) $('lux-review-list').innerHTML = '<p class="hub-empty lux-loading-placeholder">Cargando capturas…</p>';
    if (!state.directory.size) await renderAdmin();
  }
  async function renderReviewQueue(rows) {
    ensureReviewPanel();
    const target = $('lux-review-list');
    if (!target) return;
    const cards = await Promise.all(rows.map(async row => ({ ...row, image:await signedEvidence(row.evidence_path).catch(() => '') })));
    target.innerHTML = cards.length ? cards.map(row => { const player = state.directory.get(row.player_id); return `<article class="lux-review-row">${evidenceButton(row.image, `Victoria pendiente de ${player?.display_name || 'Jugador'}`)}<div><strong>${esc(player?.display_name || 'Jugador')}</strong><small>${esc(row.mode)} · ${new Date(row.created_at).toLocaleDateString('es-ES')}</small></div><span><button type="button" onclick="window.luxSupabase.reviewVictory('${esc(row.id)}','approved')">APROBAR</button><button type="button" onclick="window.luxSupabase.reviewVictory('${esc(row.id)}','rejected')">RECHAZAR</button></span></article>`; }).join('') : '<p class="hub-empty">No hay victorias pendientes.</p>';
  }
  async function reviewVictory(id, status) {
    if (!state.isStaff) return;
    let reason = null;
    if (status === 'rejected') reason = window.prompt('Motivo breve para la persona (opcional):') || null;
    try {
      await rpc('review_victory', { p_victory_id:id, p_status:status, p_reason:reason });
      toast(status === 'approved' ? '✅ VICTORIA APROBADA' : '↩️ VICTORIA RECHAZADA');
      await Promise.all([renderAdmin(), renderPublic()]);
    } catch (error) { toast(`⚠️ ${errorMessage(error).toUpperCase()}`); }
  }
  async function openPublicPlayer(id) {
    if (!state.publicDirectory.size) await renderPublic();
    const member = state.publicDirectory.get(id);
    if (!member) { toast('⚠️ NO SE ENCONTRÓ EL PERFIL PÚBLICO'); return; }
    const plateStats = state.publicPlates.get(id) || {};
    const plateCount = Number(plateStats.plates_total || plateStats.plate_count || 0);
    const victories = await rpc('get_public_player_victories', { p_player_id:id }, false).catch(() => []);
    const signed = (await Promise.all((victories || []).map(async row => ({ ...row, image:await signedEvidence(row.evidence_path).catch(() => '') })))).filter(row => row.image);
    $('hub-modal-body').innerHTML = `<button class="hub-close" type="button" onclick="window.luxHub.closePlayer()" aria-label="Cerrar">×</button>
      <header class="lux-player-hero lux-public-player-hero"><div class="lux-player-avatar-ring">${avatarHtml(member, 'hub-modal-avatar')}</div><div><span>INTEGRANTE LUX CLAN</span><h2>${esc(member.display_name)}</h2><p>${esc(countryLabel(member.country_code))}${member.age ? ` · ${Number(member.age)} años` : ''}</p></div></header>
      <section class="hub-modal-stats lux-player-stats lux-public-player-stats"><div><b>${Number(member.victories_1v1 || 0)}</b><small>1V1</small></div><div><b>${Number(member.victories_2v2 || 0)}</b><small>2V2</small></div><div><b>${Number(member.victories_3v3 || 0)}</b><small>3V3</small></div><div><b>${Number(member.victories_4v4 || 0)}</b><small>4V4</small></div><div><b>${Number(member.victories_other || 0)}</b><small>OTRAS</small></div><div><b>${Number(member.victories_total || 0)}</b><small>VICTORIAS</small></div><div><b>${Number(plateStats.plates_week || 0)}</b><small>PLACAS SEM.</small></div><div><b>${plateCount}</b><small>PLACAS TOTAL</small></div></section>
      <section class="lux-public-profile-note"><span class="hub-kicker">PERFIL VERIFICADO</span><h3>Actividad aprobada</h3><p>El correo y los controles administrativos siguen siendo privados. Solo se publican victorias aprobadas y lecturas del panel confirmadas por una líder.</p>${plateCount || Number(plateStats.glory_total || 0) ? `<button type="button" onclick="window.luxPlates.openGallery('${esc(id)}')">VER HISTORIAL DE PLACAS</button>` : ''}</section>
      <div class="lux-player-history-title"><div><span class="hub-kicker">EVIDENCIAS PÚBLICAS</span><h3>Victorias aprobadas</h3></div><small>Pulsa una captura para ampliarla y hacer zoom.</small></div>
      <section class="hub-modal-gallery lux-public-victory-gallery">${signed.length ? signed.map(row => `<figure>${evidenceButton(row.image, `Victoria ${row.mode} de ${member.display_name}`)}<figcaption><strong>${esc(row.mode)}</strong> · APROBADA<br/>${new Date(row.created_at).toLocaleDateString('es-ES')}</figcaption></figure>`).join('') : '<p class="hub-empty">Todavía no hay capturas aprobadas.</p>'}</section>`;
    $('hub-modal').hidden = false;
    document.body.classList.add('hub-no-scroll');
  }
  async function openPlayer(id) {
    if (!state.isStaff) return;
    const member = state.directory.get(id) || (await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=*`))[0];
    if (!member) return;
    const victories = await request(`/rest/v1/victories?player_id=eq.${encodeURIComponent(id)}&select=id,mode,evidence_path,status,created_at,rejection_reason&order=created_at.desc`);
    const signed = await Promise.all(victories.map(async row => ({ ...row, image:await signedEvidence(row.evidence_path).catch(() => '') })));
    const stats = modeStats(victories);
    const pending = victories.filter(row => row.status === 'pending').length;
    const bannerAction = `<button type="button" class="lux-download-avatar" onclick="window.luxSupabase.downloadOfficialBanner('${esc(member.id)}')">DESCARGAR BANNER OFICIAL</button>`;
    $('hub-modal-body').innerHTML = `<button class="hub-close" type="button" onclick="window.luxHub.closePlayer()" aria-label="Cerrar">×</button><header class="lux-player-hero"><div class="lux-player-avatar-ring">${avatarHtml(member, 'hub-modal-avatar')}</div><div><span>FICHA OFICIAL LUX CLAN</span><h2>${esc(member.display_name)}</h2><p>${esc(member.country_name || member.country_code || 'País pendiente')} · ${member.age || '—'} años</p><div class="lux-player-actions">${bannerAction}${removalButton(member)}</div></div></header><section class="hub-modal-stats lux-player-stats"><div><b>${stats['1v1']}</b><small>1V1</small></div><div><b>${stats['2v2']}</b><small>2V2</small></div><div><b>${stats['3v3']}</b><small>3V3</small></div><div><b>${stats['4v4']}</b><small>4V4</small></div><div><b>${stats.Otro}</b><small>OTRAS</small></div><div><b>${stats.total}</b><small>APROBADAS</small></div><div class="lux-pending-stat"><b>${pending}</b><small>PENDIENTES</small></div></section><div class="lux-player-history-title"><div><span class="hub-kicker">EVIDENCIAS</span><h3>Historial de victorias</h3></div><small>Pulsa una captura para ampliarla y hacer zoom.</small></div><section class="hub-modal-gallery">${signed.length ? signed.map(row => `<figure>${evidenceButton(row.image, `Victoria ${row.mode} de ${member.display_name}`)}<figcaption><strong>${esc(row.mode)}</strong> · ${row.status === 'approved' ? 'APROBADA' : row.status === 'rejected' ? 'RECHAZADA' : 'PENDIENTE'}<br/>${new Date(row.created_at).toLocaleDateString('es-ES')}${row.status === 'pending' ? `<span><button type="button" onclick="window.luxSupabase.reviewVictory('${esc(row.id)}','approved')">APROBAR</button><button type="button" onclick="window.luxSupabase.reviewVictory('${esc(row.id)}','rejected')">RECHAZAR</button></span>` : ''}</figcaption></figure>`).join('') : '<p class="hub-empty">Aún no hay capturas.</p>'}</section>`;
    $('hub-modal').hidden = false;
    document.body.classList.add('hub-no-scroll');
  }
  function closePlayer() { $('hub-modal').hidden = true; document.body.classList.remove('hub-no-scroll'); }
  async function downloadOfficialBanner(id) {
    if (!state.isStaff && id !== state.user?.id) return;
    const member = state.directory.get(id) || (id === state.user?.id ? state.profile : null) || (await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=*`))[0];
    if (!member) { toast('⚠️ NO SE ENCONTRÓ EL PERFIL'); return; }
    if (typeof window.downloadOfficialMemberBanner !== 'function') { toast('⚠️ EL EDITOR OFICIAL TODAVÍA NO ESTÁ LISTO'); return; }
    let photoObjectUrl = '';
    try {
      const avatarUrl = member.avatar_path ? publicUrl('lux-avatars', member.avatar_path) : '';
      if (avatarUrl) {
        const blob = await fetch(avatarUrl).then(response => { if (!response.ok) throw new Error('No se pudo cargar la foto del perfil'); return response.blob(); });
        photoObjectUrl = URL.createObjectURL(blob);
      }
      await window.downloadOfficialMemberBanner({
        name:member.display_name || 'Jugador',
        age:member.age || '',
        countryCode:member.country_code || '',
        photoUrl:photoObjectUrl
      });
      toast('✅ BANNER OFICIAL GENERADO CON LOS DATOS DEL PERFIL');
    } catch (error) {
      toast(`⚠️ ${errorMessage(error).toUpperCase()}`);
    } finally {
      if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
    }
  }
  async function downloadMyBanner() {
    if (!state.user) { openLogin('member'); return; }
    await downloadOfficialBanner(state.user.id);
  }

  function ensureRemovalDialog() {
    if ($('lux-remove-dialog')) return;
    document.body.insertAdjacentHTML('beforeend', `<div id="lux-remove-dialog" class="lux-remove-dialog" hidden role="dialog" aria-modal="true" aria-labelledby="lux-remove-title"><div><span class="hub-kicker">ACCIÓN PROTEGIDA</span><h2 id="lux-remove-title">Expulsar integrante</h2><p id="lux-remove-copy"></p><label class="lux-remove-reason">MOTIVO<input id="lux-remove-reason" maxlength="300" placeholder="Ej.: ya no pertenece al clan"/></label><small>La ficha dejará de aparecer de inmediato, pero quedará 30 días en la papelera del owner por si fue un error. Durante ese tiempo se conservan sus fotos y estadísticas.</small><span><button type="button" onclick="window.luxSupabase.closeMemberRemoval()">CANCELAR</button><button id="lux-remove-confirm" type="button" class="lux-danger-action" onclick="window.luxSupabase.confirmMemberRemoval()">EXPULSAR</button></span></div></div>`);
  }
  let removalTarget = null;
  function requestMemberRemoval(id) {
    if (!canRemoveMember(id)) { toast('⛔ NO TIENES PERMISO PARA ELIMINAR ESTA CUENTA'); return; }
    ensureRemovalDialog();
    const member = state.directory.get(id);
    removalTarget = { id, name:member?.display_name || 'esta cuenta' };
    $('lux-remove-title').textContent = state.isOwner ? 'Eliminar cuenta' : 'Expulsar integrante';
    $('lux-remove-copy').textContent = `¿Confirmas que quieres eliminar a ${removalTarget.name} de LUX CLAN?`;
    $('lux-remove-dialog').hidden = false;
    document.body.classList.add('hub-no-scroll');
  }
  function closeMemberRemoval() {
    removalTarget = null;
    if ($('lux-remove-dialog')) $('lux-remove-dialog').hidden = true;
    if ($('hub-modal')?.hidden !== false && $('lux-plates-modal')?.hidden !== false) document.body.classList.remove('hub-no-scroll');
  }
  async function confirmMemberRemoval() {
    if (!removalTarget || !canRemoveMember(removalTarget.id)) return;
    const target = { ...removalTarget };
    const button = $('lux-remove-confirm');
    if (button) { button.disabled = true; button.textContent = 'MOVIENDO A PAPELERA…'; }
    try {
      const reason = $('lux-remove-reason')?.value.trim() || 'Expulsado desde el panel';
      await rpc('staff_soft_delete_member', { p_user_id:target.id, p_reason:reason });
      state.directory.delete(target.id); state.ranking.delete(target.id); state.roles.delete(target.id);
      closeMemberRemoval(); closePlayer();
      await Promise.all([renderAdmin(), renderPublic()]);
      if (state.isOwner && $('lux-owner-panel')?.hidden === false) await showOwnerAccounts();
      toast(`✅ ${target.name.toUpperCase()} FUE EXPULSADO · SE PUEDE RESTAURAR DURANTE 30 DÍAS`);
    } catch (error) {
      toast(`⚠️ NO SE CAMBIÓ LA CUENTA: ${errorMessage(error).toUpperCase()}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = 'EXPULSAR'; }
    }
  }
  async function backup() {
    if (!state.isStaff) return;
    if (state.isOwner && window.luxPlatformV3?.downloadFullBackup) {
      return window.luxPlatformV3.downloadFullBackup();
    }
    const ranking = await rpc('get_public_ranking', {}, false);
    const rows = [...state.directory.values()].map(row => ({ id:row.id, name:row.display_name, country:row.country_code, public:row.is_public, statistics:ranking.find(item => item.player_id === row.id) || null }));
    const blob = new Blob([JSON.stringify({ exportedAt:new Date().toISOString(), members:rows }, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'LUX_CLAN_DIRECTORIO.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('✅ COPIA DE CONSULTA DESCARGADA · EL RESPALDO COMPLETO ES EXCLUSIVO DEL OWNER');
  }

  async function renderPlatesSelector() {
    window.luxPlateImport?.setDirectory?.([...state.directory.values()]);
  }
  async function renderPlatesRanking() {
    const target = $('lux-plates-ranking');
    if (!target) return;
    const rows = await rpc('get_public_plate_ranking', {}, false);
    const active = rows.filter(row => Number(row.plates_total || 0) > 0 || Number(row.glory_total || 0) > 0);
    target.innerHTML = active.length ? active.map((row, index) => `<button type="button" class="lux-plate-row" onclick="window.luxPlates.openGallery('${esc(row.player_id)}')"><i>#${index + 1}</i>${avatarHtml(row, 'lux-plate-avatar')}<span class="lux-plate-player"><strong>${esc(row.display_name)}</strong><small>${row.last_captured_on ? `Actualizado ${new Date(`${row.last_captured_on}T12:00:00`).toLocaleDateString('es-ES')}` : 'Sin lectura reciente'}</small></span><span class="lux-plate-stat week glory"><b>${Number(row.glory_week || 0)}</b><small>GLORIA SEM.</small></span><span class="lux-plate-stat glory"><b>${Number(row.glory_total || 0)}</b><small>GLORIA TOTAL</small></span><span class="lux-plate-stat week week-plates"><b>${Number(row.plates_week || 0)}</b><small>PLACAS SEM.</small></span><span class="lux-plate-stat total-plates"><b>${Number(row.plates_total || 0)}</b><small>PLACAS TOTAL</small></span></button>`).join('') : '<p class="hub-empty">Aún no hay una captura de actividad confirmada.</p>';
  }
  async function showPlates() {
    if (!state.isLeader) { toast('⛔ SOLO PROPIETARIA O LÍDERES GESTIONAN PLACAS'); return; }
    const page = $('hub-admin')?.querySelector('.hub-page'); const panel = $('lux-plates-panel');
    if (!page || !panel) return;
    showPageChildren(page, panel, ['lux-admin-tabs']);
    setAdminSection('plates');
    await Promise.all([renderPlatesSelector(), renderPlatesRanking()]);
    await window.luxPlateImport?.prepare?.();
  }
  async function addPlate() {
    if (!state.isLeader || !state.user) return;
    const player_id = $('lux-plate-player')?.value;
    const title = $('lux-plate-title')?.value.trim() || 'Placa del clan';
    const file = $('lux-plate-file')?.files?.[0];
    if (!player_id || !isImage(file, MAX_AVATAR)) { toast('⚠️ ELIGE INTEGRANTE Y UNA IMAGEN JPG, PNG O WEBP DE HASTA 5 MB'); return; }
    try {
      const image_path = `${state.user.id}/${randomId()}.${extension(file)}`;
      await upload('lux-plates', image_path, file);
      await request('/rest/v1/plates', { method:'POST', headers:{ 'Content-Type':'application/json', Prefer:'return=representation' }, body:JSON.stringify({ player_id, title:title.slice(0,42), image_path, created_by:state.user.id }) });
      $('lux-plate-title').value = ''; $('lux-plate-file').value = '';
      toast('🏅 PLACA REGISTRADA');
      await Promise.all([renderPlatesRanking(), renderPublic()]);
    } catch (error) { toast(`⚠️ ${errorMessage(error).toUpperCase()}`); }
  }
  async function openPlateGallery(playerId) {
    const member = state.directory.get(playerId) || state.publicDirectory.get(playerId) || { display_name:'Integrante' };
    const [history, legacy] = await Promise.all([
      rpc('get_public_player_plate_history', { p_player_id:playerId }, false).catch(() => []),
      state.isStaff ? request(`/rest/v1/plates?player_id=eq.${encodeURIComponent(playerId)}&select=*&order=created_at.desc`).catch(() => []) : Promise.resolve([])
    ]);
    const modal = $('lux-plates-modal'); if (!modal) return;
    modal.innerHTML = `<div class="lux-plates-modal-box"><button class="lux-plates-close" type="button" onclick="window.luxPlates.closeGallery()">×</button><span class="hub-kicker">ACTIVIDAD DE FREE FIRE</span><h2>${esc(member.display_name)}</h2><p>Las lecturas son estados confirmados del panel: una captura repetida nunca vuelve a sumar.</p><section class="lux-plate-history">${history.length ? history.map(row => `<article><strong>SEMANA DEL ${new Date(`${row.week_start}T12:00:00`).toLocaleDateString('es-ES')}</strong><span><b>${Number(row.glory_week || 0)}</b><small>GLORIA SEM.</small></span><span><b>${Number(row.glory_total || 0)}</b><small>GLORIA TOTAL</small></span><span><b>${Number(row.plates_week || 0)}</b><small>PLACAS SEM.</small></span><span><b>${Number(row.plates_total || 0)}</b><small>PLACAS TOTAL</small></span></article>`).join('') : '<p class="hub-empty">Todavía no tiene lecturas confirmadas.</p>'}</section>${legacy.length ? `<details class="lux-legacy-plates"><summary>${legacy.length} imágenes antiguas registradas</summary><section>${legacy.map(row => `<figure><img src="${esc(publicUrl('lux-plates', row.image_path))}" alt="${esc(row.title)}"/><figcaption>${esc(row.title)}</figcaption></figure>`).join('')}</section></details>` : ''}</div>`;
    modal.hidden = false; document.body.classList.add('hub-no-scroll');
  }
  function closePlateGallery() { $('lux-plates-modal').hidden = true; document.body.classList.remove('hub-no-scroll'); }
  async function removePlate(id, image_path) {
    if (!state.isLeader) return;
    try {
      await request(`/rest/v1/plates?id=eq.${encodeURIComponent(id)}`, { method:'DELETE' });
      await request(`/storage/v1/object/lux-plates/${image_path.split('/').map(encodeURIComponent).join('/')}`, { method:'DELETE' });
      closePlateGallery(); toast('🗑 PLACA ELIMINADA'); await Promise.all([renderPlatesRanking(), renderPublic()]);
    } catch (error) { toast(`⚠️ ${errorMessage(error).toUpperCase()}`); }
  }

  async function getActivityImportContext() {
    if (!state.isLeader || !state.user) throw new Error('Solo propietaria o líderes pueden importar actividad');
    if (!state.directory.size) await renderAdmin();
    const aliases = await request('/rest/v1/game_player_aliases?select=alias_key,game_name,player_id&order=last_seen_at.desc');
    return {
      members:[...state.directory.values()].map(row => ({ id:row.id, display_name:row.display_name, avatar_path:row.avatar_path })),
      aliases:aliases || []
    };
  }
  async function activityImportExists(imageSha256) {
    if (!state.isLeader || !/^[0-9a-f]{64}$/.test(imageSha256 || '')) return false;
    const rows = await request(`/rest/v1/clan_activity_imports?image_sha256=eq.${encodeURIComponent(imageSha256)}&select=id&limit=1`);
    return Boolean(rows?.length);
  }
  async function submitActivityCapture(file, imageSha256, capturedOn, rows) {
    if (!state.isLeader || !state.user) throw new Error('No tienes permisos para guardar esta lectura');
    if (!isImage(file, 10 * 1024 * 1024)) throw new Error('Usa una imagen JPG, PNG o WEBP de hasta 10 MB');
    const imagePath = `${state.user.id}/imports/${imageSha256}.${extension(file)}`;
    await uploadUpsert('lux-clan-imports', imagePath, file);
    try {
      const importId = await rpc('staff_submit_activity_snapshot', {
        p_image_sha256:imageSha256,
        p_image_path:imagePath,
        p_captured_on:capturedOn,
        p_rows:rows
      });
      await Promise.all([renderPlatesRanking(), renderPublic()]);
      return importId;
    } catch (error) {
      await request(`/storage/v1/object/lux-clan-imports/${imagePath.split('/').map(encodeURIComponent).join('/')}`, { method:'DELETE' }).catch(() => {});
      throw error;
    }
  }

  async function openEditor(leader = false) {
    if (!state.user) { openLogin(leader ? 'leader' : 'member'); return; }
    if (leader && !state.isStaff) { toast('⛔ TU CUENTA NO TIENE PERMISOS DE LÍDER'); return; }
    const navigationToken = beginNavigation(`${leader ? 'admin' : 'member'}:editor`);
    try {
      if (!leader) {
      // Un perfil completo ya vive en Supabase. No debemos intentar guardarlo
      // otra vez usando campos que pueden estar ocultos o aún sin montar al
      // entrar al editor directamente desde Inicio.
        if (state.profileDraftDirty) {
          if (!await saveProfile(true)) return;
        } else if (!state.profile?.onboarding_complete) {
          await renderMember(true);
          if (!await saveProfile(true)) return;
        }
      }
      state.editorBack = leader ? 'admin' : 'member';
      state.navigationContext = state.editorBack;
      if (!leader) {
        const profile = state.profile;
        if ($('t-nombre-integ')) $('t-nombre-integ').value = profile?.display_name || '';
        if ($('t-edad-integ')) $('t-edad-integ').value = profile?.age || '';
        if ($('t-pais-integ')) $('t-pais-integ').value = profile?.country_code || '';
        window.onFlagInteg?.(); window.renderInteg?.();
        const avatar = profile?.avatar_path ? publicUrl('lux-avatars', profile.avatar_path) : '';
        if (avatar && window.readPlayerFileInteg) { try { const blob = await fetch(avatar).then(response => response.blob()); window.readPlayerFileInteg(new File([blob], 'perfil.jpg', { type:'image/jpeg' })); } catch (_) {} }
      }
      window.luxLeaderDemo?.setMode(leader ? 'leader' : 'member');
      window.switchTab?.('integrantes');
      window.luxHub.setScreen('editor');
      mountEditorNavigation(state.editorBack);
      scrollTopNow();
    } finally {
      endNavigation(navigationToken, document.querySelector('.tab-content.active') || document.querySelector('.tab-content:not([hidden])'));
    }
  }
  function backFromEditor() {
    if (state.editorBack === 'admin') openLeader();
    else openMember('profile');
  }

  function closeLogin() {
    const modal = $('lux-login-modal');
    if (modal) modal.hidden = true;
  }

  function renderLoginLoading() {
    const modal = $('lux-login-modal');
    if (!modal) return;
    modal.innerHTML = `<div class="lux-login-box lux-login-checking" role="status" aria-live="polite">
      <span class="lux-auth-spinner" aria-hidden="true"></span>
      <span class="hub-kicker">CUENTA DEL CLAN</span>
      <h2>Revisando tu sesión</h2>
      <p>Espera un momento. Si ya habías entrado en este navegador, abriremos tu cuenta automáticamente.</p>
    </div>`;
    modal.hidden = false;
  }

  async function openLogin(kind = 'member') {
    if (state.authStatus === 'checking') {
      renderLoginLoading();
      await waitForAuth();
    }
    if (state.user) {
      closeLogin();
      if (kind === 'leader') openLeader();
      else openMember();
      return;
    }
    const modal = $('lux-login-modal'); if (!modal) return;
    const googleSvg = `<svg width="20" height="20" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.74-.06-1.28-.19-1.84H9v3.34h4.96c-.1.83-.64 2.08-1.84 2.92l-.02.12 2.67 2.07.18.02c1.7-1.57 2.69-3.88 2.69-6.63z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.83-2.21c-.76.53-1.78.9-3.13.9-2.38 0-4.41-1.57-5.13-3.72l-.12.01-2.61 2.02-.04.11C2.58 15.93 5.56 18 9 18z"/><path fill="#FBBC05" d="M3.87 10.79c-.19-.58-.3-1.2-.3-1.79s.11-1.21.3-1.79l-.01-.12-2.62-2.03-.09.04C.42 6.55 0 7.72 0 9s.42 2.45 1.15 3.91l2.72-2.12z"/><path fill="#EA4335" d="M9 3.58c1.69 0 2.83.73 3.48 1.34l2.54-2.48C13.45.97 11.43 0 9 0 5.56 0 2.58 2.07 1.15 5.09l2.72 2.12C4.59 5.06 6.62 3.58 9 3.58z"/></svg>`;
    modal.innerHTML = `<div class="lux-login-box">
      <button class="lux-login-close" type="button" onclick="window.luxAccess.closeLogin()">×</button>
      <span class="hub-kicker">${kind === 'leader' ? 'ACCESO DEL EQUIPO' : 'CUENTA DEL CLAN'}</span>
      <h2>Registrarse es gratis</h2>
      <p>Usa tu cuenta de Google para entrar al clan. No necesitas recordar ninguna contraseña.</p>
      <button class="lux-google-btn lux-google-btn--big" type="button" id="lux-google-main-btn" onclick="window.luxGoogleLogin()">
        ${googleSvg}
        <span>CONTINUAR CON GOOGLE</span>
      </button>
      <p class="lux-auth-note"><strong>¿YA TENÍAS PERFIL?</strong> Elige la misma dirección de Gmail que usabas antes y conservarás tu ficha, fotos y estadísticas.<br/>Tu cuenta de Google solo se usa para identificarte dentro del clan.</p>
    </div>`;
    modal.hidden = false;
    setTimeout(() => document.getElementById('lux-google-main-btn')?.focus(), 20);
  }
  function toggleSignup() {
    const wrap = $('lux-auth-name-wrap'); const signup = wrap?.hidden;
    if (wrap) wrap.hidden = !signup;
    if ($('lux-auth-submit')) $('lux-auth-submit').textContent = signup ? 'CREAR MI CUENTA' : 'ENTRAR';
    const switcher = document.querySelector('.lux-auth-switch'); if (switcher) switcher.textContent = signup ? 'YA TENGO CUENTA' : 'CREAR CUENTA';
    if ($('lux-auth-help')) $('lux-auth-help').textContent = signup ? 'Te llegará una confirmación al correo si está activada.' : 'Usa el mismo correo y contraseña en iPhone o Android.';
  }
  async function authSubmit() {
    const email = $('lux-auth-email')?.value.trim().toLowerCase();
    const password = $('lux-auth-password')?.value || '';
    const creating = !$('lux-auth-name-wrap')?.hidden;
    const display_name = $('lux-auth-name')?.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || (creating && (!display_name || display_name.length < 2))) { toast('⚠️ REVISA CORREO, CONTRASEÑA Y NOMBRE'); return; }
    try {
      const data = creating
        ? await request('/auth/v1/signup', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ email, password, data:{ display_name }, options:{ emailRedirectTo:emailRedirectUrl() } }) }, false)
        : await request('/auth/v1/token?grant_type=password', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ email, password }) }, false);
      const session = data?.session || (data?.access_token ? {
        access_token:data.access_token,
        refresh_token:data.refresh_token,
        expires_at:data.expires_at,
        expires_in:data.expires_in,
        token_type:data.token_type,
        user:data.user
      } : null);
      if (!session) { if ($('lux-auth-help')) $('lux-auth-help').textContent = 'Revisa tu correo. Si el enlace falla, pulsa “Reenviar confirmación”.'; toast('✉️ REVISA TU CORREO Y CONFIRMA LA CUENTA'); return; }
      writeSession(session); state.user = data.user || session.user || null;
      await hydrateAccount(); 
      if (window.luxAccess?.closeLogin) window.luxAccess.closeLogin();
      if (creating && display_name) { if ($('hub-name')) $('hub-name').value = display_name; await saveProfile(true); }
      await openMember('home');
      toast('✅ SESIÓN ABIERTA');
    } catch (error) { toast(`⚠️ ${errorMessage(error, 'NO SE PUDO INICIAR SESIÓN').toUpperCase()}`); }
  }
  async function resendConfirmation() {
    const email = $('lux-auth-email')?.value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { toast('⚠️ ESCRIBE TU CORREO PRIMERO'); return; }
    try {
      await request('/auth/v1/resend', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ type:'signup', email, options:{ emailRedirectTo:emailRedirectUrl() } }) }, false);
      if ($('lux-auth-help')) $('lux-auth-help').textContent = 'Correo reenviado. El enlace volverá a esta página.';
      toast('✉️ CONFIRMACIÓN REENVIADA');
    } catch (error) { toast(`⚠️ ${errorMessage(error).toUpperCase()}`); }
  }
  async function logout() {
    try { if (state.session?.access_token) await request('/auth/v1/logout', { method:'POST' }); } catch (_) {}
    writeSession(null); state.user = null; state.profile = null; state.pendingAvatar = null; state.profileDraftDirty = false; state.role = 'member'; state.isStaff = false; state.isLeader = false; state.isOwner = false; state.directory = new Map(); state.ranking = new Map(); state.roles = new Map(); state.navigationContext = null; state.adminSection = 'home'; state.pendingReviews = 0; state.authStatus = 'anonymous'; renderAccountState(); ensureOwnerPanel(); window.luxHub.setScreen('home'); toast('SESIÓN CERRADA');
  }
  async function openMember(section = 'home') {
    await waitForAuth();
    if (!state.user) { openLogin('member'); return; }
    const navigationToken = beginNavigation(`member:${section}`);
    state.navigationContext = 'member';
    window.luxHub.setScreen('member');
    ensureSimpleExperience();
    renderNavigation();
    if (!['matches','events','announcements','pending'].includes(section)) showMemberSection(section);
    try {
      await renderMember();
      if (window.luxPlatformV3?.guardMember && await window.luxPlatformV3.guardMember(section)) {
        renderNavigation();
        return;
      }
      showMemberSection(section);
      renderNavigation();
    } finally {
      const page = document.querySelector('#hub-member .hub-page');
      endNavigation(navigationToken, [...(page?.children || [])].find(child => !child.hidden && child.id !== 'lux-member-tabs'));
    }
  }

  async function submitActivityBatch(captures) {
    if (!state.isLeader || !state.user) throw new Error('No tienes permisos para guardar este lote');
    if (!Array.isArray(captures) || captures.length < 1 || captures.length > 12) throw new Error('Selecciona entre 1 y 12 capturas');
    const uploaded = [];
    try {
      for (let index = 0; index < captures.length; index += 1) {
        const capture = captures[index];
        if (!isImage(capture.file, 10 * 1024 * 1024)) throw new Error(`La captura ${index + 1} no es válida`);
        const imagePath = `${state.user.id}/imports/${capture.hash}.${extension(capture.file)}`;
        await uploadUpsert('lux-clan-imports', imagePath, capture.file);
        uploaded.push(imagePath);
        capture.image_path = imagePath;
      }
      const ids = await rpc('staff_submit_activity_batch', { p_captures:captures.map((capture,index) => ({
        image_sha256:capture.hash,
        image_path:capture.image_path,
        captured_on:capture.capturedOn,
        source_index:index,
        rows:capture.rows
      })) });
      await Promise.all([renderPlatesRanking(), renderPublic()]);
      return ids;
    } catch (error) {
      for (const path of uploaded) await request(`/storage/v1/object/lux-clan-imports/${path.split('/').map(encodeURIComponent).join('/')}`, { method:'DELETE' }).catch(() => {});
      throw error;
    }
  }
  async function openLeader() {
    await waitForAuth();
    if (!state.user) { openLogin('leader'); return; }
    if (!state.isStaff) { toast('⛔ ESTA CUENTA NO TIENE PERMISOS DE LÍDER'); return; }
    state.navigationContext = 'admin';
    await showAdminSummary();
  }
  function installStyles() {
    const style = document.createElement('style');
    style.textContent = `.lux-login-checking{text-align:center}.lux-auth-spinner{display:block;width:46px;height:46px;margin:2px auto 17px;border:4px solid #ffffff18;border-top-color:#ff3b24;border-radius:50%;animation:lux-auth-spin .75s linear infinite}.lux-login-checking p{max-width:310px;margin:9px auto 0}.lux-login-checking .hub-kicker{display:block}@keyframes lux-auth-spin{to{transform:rotate(360deg)}}`;
    style.textContent += `.lux-google-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px;margin-top:18px;border:1px solid #ffffff35;border-radius:12px;background:#ffffff;color:#1a1a1a;font:700 1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.2px;cursor:pointer;box-shadow:0 4px 20px #00000060;transition:transform .15s,box-shadow .15s}.lux-google-btn:hover{background:#f0f0f0;transform:translateY(-2px);box-shadow:0 8px 28px #00000080}.lux-google-btn:active{transform:translateY(0)}.lux-google-btn svg{flex-shrink:0}.lux-google-btn--big{padding:16px;font-size:1.05rem;letter-spacing:1.8px;border-radius:14px}.lux-auth-note{margin-top:14px;color:#6e6875;font-size:.65rem;line-height:1.5;text-align:center}.lux-auth-switch,.lux-auth-resend{width:100%;margin-top:9px;border:1px solid #ffffff2b;border-radius:9px;background:#ffffff08;color:#ddd;padding:9px;font:1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px;cursor:pointer}.lux-auth-resend{color:#ffb29f;border-color:#ff674855;background:#ff22000d}.lux-review-queue{margin-top:15px}.lux-review-queue>p{margin:0 0 12px;color:#aaa4aa;font-size:.78rem}.lux-review-row{display:grid;grid-template-columns:82px 1fr auto;gap:10px;align-items:center;margin-top:8px;padding:8px;border:1px solid #ffffff18;border-radius:10px;background:#09090d}.lux-review-row img{width:82px;height:58px;border-radius:6px;object-fit:cover}.lux-review-row div{display:grid;gap:4px}.lux-review-row strong{font:1.15rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.8px}.lux-review-row small{color:#aaa;font-size:.65rem}.lux-review-row span{display:flex;gap:5px}.lux-review-row button,.hub-modal-gallery button,.lux-download-avatar{border:1px solid #ff664d77;border-radius:6px;background:#ff220018;color:#ffab9b;padding:6px 7px;font:.78rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.5px;cursor:pointer}.lux-review-row button:first-child,.hub-modal-gallery button:first-child{border:0;background:#bd2f18;color:#fff}.lux-download-avatar{margin-top:8px}.hub-evidence small{display:block;padding:0 7px 7px;color:#ffab9b;font-size:.62rem}@media(max-width:620px){.lux-review-row{grid-template-columns:65px 1fr}.lux-review-row img{width:65px;height:51px}.lux-review-row span{grid-column:2;justify-content:flex-start}.lux-review-row button{flex:1}}`;
    style.textContent += `.lux-evidence-thumb{position:relative;display:block;width:100%;overflow:hidden;border:0!important;border-radius:8px;background:#050507!important;padding:0!important;cursor:zoom-in}.lux-evidence-thumb img{display:block;width:100%!important;height:130px;object-fit:cover;transition:transform .2s}.lux-evidence-thumb:hover img{transform:scale(1.035)}.lux-evidence-thumb>span{position:absolute!important;right:6px;bottom:6px;display:block!important;padding:4px 7px;border:1px solid #ffffff35;border-radius:999px;background:#000c;color:#fff;font:700 .55rem 'Segoe UI',sans-serif;letter-spacing:.7px}.lux-review-row>.lux-evidence-thumb{width:82px}.lux-review-row>.lux-evidence-thumb img{height:58px}.hub-modal-gallery .lux-evidence-thumb img{height:150px}.lux-evidence-viewer[hidden]{display:none!important}.lux-evidence-viewer{position:fixed;z-index:100010;inset:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;padding:12px;background:#030306f5;backdrop-filter:blur(12px);color:#fff}.lux-evidence-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;width:min(1180px,100%);margin:auto;padding:7px 0 10px}.lux-evidence-toolbar strong{overflow:hidden;font:1.2rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.5px;text-overflow:ellipsis;white-space:nowrap}.lux-evidence-toolbar span{display:flex;gap:6px}.lux-evidence-toolbar button{min-width:42px;height:40px;border:1px solid #ffffff33;border-radius:8px;background:#15151b;color:#fff;font:1.1rem 'Bebas Neue',Impact,sans-serif;cursor:pointer}.lux-evidence-toolbar .lux-evidence-close{border-color:#ff3c2c88;background:#8d160e;font-size:1.55rem}.lux-evidence-stage{width:min(1180px,100%);height:100%;margin:auto;overflow:auto;display:block;border:1px solid #ffffff1f;border-radius:12px;background:#000;text-align:center;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.lux-evidence-stage img{display:inline-block;width:100%;height:auto;min-height:100%;object-fit:contain;vertical-align:top;transform-origin:top center;touch-action:pan-x pan-y pinch-zoom}.lux-evidence-viewer>small{padding:9px 4px 2px;color:#a8a2ab;text-align:center;font-size:.68rem}.lux-player-hero{padding:18px;border:1px solid #ff3a2445!important;border-radius:16px!important;background:radial-gradient(circle at 12% 30%,#57130d80,transparent 32%),linear-gradient(135deg,#1b1117,#0c0c11)!important}.lux-player-avatar-ring{display:grid;place-items:center;padding:5px;border:1px solid #ff816f55;border-radius:50%;box-shadow:0 0 30px #ff220033}.lux-player-history-title{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-top:22px}.lux-player-history-title h3{margin:5px 0 0!important}.lux-player-history-title>small{max-width:250px;color:#948e97;font-size:.66rem;text-align:right}.lux-owner-nav{border-color:#e5b84c88!important;color:#ffdc7c!important}.lux-owner-panel em{color:#ffca55!important}.lux-owner-notice{margin-bottom:14px;padding:12px;border:1px solid #d39b3566;border-radius:10px;background:#c9871112;color:#d8c395;font-size:.73rem;line-height:1.45}.lux-owner-accounts{display:grid;gap:8px}.lux-owner-account{display:grid;grid-template-columns:52px minmax(0,1fr) auto;align-items:center;gap:11px;padding:12px;border:1px solid #ffffff17;border-radius:12px;background:linear-gradient(145deg,#171219,#0d0d12)}.lux-owner-avatar{width:52px;height:52px;display:grid;place-items:center;border:1px solid #e9b94488;border-radius:50%;object-fit:cover}.lux-owner-account>div{display:grid;gap:3px;min-width:0}.lux-owner-account strong{color:#fff;font:1.3rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px}.lux-owner-account span{overflow:hidden;color:#c5bec8;font-size:.72rem;text-overflow:ellipsis;white-space:nowrap}.lux-owner-account small{color:#9d969f;font-size:.6rem}.lux-owner-account>button{border:1px solid #e8b94b66;border-radius:7px;background:#e8b94b12;color:#ffd36e;padding:8px;font:.9rem 'Bebas Neue',Impact,sans-serif;cursor:pointer}.lux-owner-account>em{color:#817b84;font-size:.65rem;font-style:normal}@media(max-width:620px){.lux-review-row>.lux-evidence-thumb{width:65px}.lux-review-row>.lux-evidence-thumb img{height:51px}.lux-evidence-viewer{padding:6px}.lux-evidence-toolbar strong{font-size:.9rem}.lux-evidence-toolbar button{min-width:36px;height:36px}.lux-evidence-viewer>small{font-size:.58rem}.lux-player-hero{padding:13px!important}.lux-player-avatar-ring .hub-modal-avatar{width:68px;height:68px}.lux-player-history-title{display:block}.lux-player-history-title>small{display:block;margin-top:6px;text-align:left}.lux-owner-account{grid-template-columns:45px minmax(0,1fr)}.lux-owner-avatar{width:45px;height:45px}.lux-owner-account>button,.lux-owner-account>em{grid-column:2;justify-self:start}}`;
    style.textContent += `
      .lux-mode-summary{grid-template-columns:repeat(3,minmax(0,1fr))!important}
      #hub-modal-body{width:min(820px,100%)}
      #hub-modal-body header.lux-player-hero{display:grid;grid-template-columns:1fr!important;justify-items:center;gap:13px;text-align:center;padding:25px!important}
      .lux-player-avatar-ring{width:170px;height:170px;padding:7px}
      .lux-player-avatar-ring .hub-modal-avatar{width:154px;height:154px;flex-basis:154px;border-width:3px}
      #hub-modal-body .lux-player-hero h2{margin:7px 0 3px;font-size:3.2rem;line-height:.95}
      #hub-modal-body .lux-player-hero p{margin:6px 0 0;font-size:.9rem}
      .lux-player-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin-top:12px}
      .lux-player-actions .lux-download-avatar{margin:0}
      .lux-player-stats{grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}
      .lux-player-stats .lux-pending-stat{grid-column:span 2}
      .lux-danger-action{border-color:#ff4949!important;background:#8d0f12!important;color:#fff!important}
      button[disabled]{cursor:not-allowed!important;opacity:.46}
      .hub-member-row-actions{flex-wrap:wrap;justify-content:flex-end}
      .hub-member-row-actions .lux-danger-action{background:#5d0b0e!important}
      .lux-owner-actions{display:flex!important;align-items:center;justify-content:flex-end;gap:6px;overflow:visible!important;white-space:normal!important}
      .lux-owner-actions button{border:1px solid #e8b94b66;border-radius:7px;background:#e8b94b12;color:#ffd36e;padding:8px;font:.9rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.5px;cursor:pointer;white-space:nowrap}
      .lux-owner-actions em{color:#9a949c;font-size:.62rem;font-style:normal}
      .lux-remove-dialog[hidden]{display:none!important}
      .lux-remove-dialog{position:fixed;z-index:100020;inset:0;display:grid;place-items:center;padding:15px;background:#000d;backdrop-filter:blur(8px)}
      .lux-remove-dialog>div{width:min(480px,100%);padding:24px;border:1px solid #ff3e36aa;border-radius:16px;background:linear-gradient(145deg,#231014,#0d0c11);box-shadow:0 25px 80px #000}
      .lux-remove-dialog h2{margin:7px 0;color:#fff;font:2.2rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.5px}
      .lux-remove-dialog p{margin:0 0 10px;color:#f3d7d4;line-height:1.5}
      .lux-remove-dialog small{display:block;color:#a89da1;font-size:.7rem;line-height:1.5}
      .lux-remove-dialog>div>span:last-child{display:flex;gap:8px;margin-top:18px}
      .lux-remove-dialog>div>span:last-child button{flex:1;border:1px solid #ffffff2d;border-radius:9px;background:#ffffff0b;color:#eee;padding:11px;font:1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px;cursor:pointer}
      @media(max-width:760px){
        #hub-admin .hub-nav{align-items:flex-start;flex-wrap:wrap}
        #hub-admin .hub-nav>strong{order:-1;width:100%;text-align:center}
        #hub-admin .hub-nav>span{max-width:calc(100vw - 95px);overflow-x:auto;padding-bottom:3px}
        #hub-admin .hub-nav>span button{flex:0 0 auto}
        .hub-member-row-actions{justify-content:stretch}
        .hub-member-row-actions button{min-width:31%;padding:8px 5px}
      }
      @media(max-width:620px){
        #hub-modal-body header.lux-player-hero{padding:20px 12px!important}
        .lux-player-avatar-ring{width:148px;height:148px}
        .lux-player-avatar-ring .hub-modal-avatar{width:134px!important;height:134px!important;flex-basis:134px}
        #hub-modal-body .lux-player-hero h2{font-size:2.7rem}
        .lux-player-actions{width:100%}
        .lux-player-actions button{flex:1;min-width:140px}
        .lux-player-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
        .lux-player-stats .lux-pending-stat{grid-column:span 2}
        .lux-player-history-title{text-align:center}
        .lux-player-history-title>small{text-align:center}
        .lux-owner-account{grid-template-columns:45px minmax(0,1fr)}
        .lux-owner-actions{grid-column:1/-1;justify-content:stretch}
        .lux-owner-actions button{flex:1}
      }
    `;
    style.textContent += `
      .lux-nav-actions{display:flex;gap:6px;max-width:min(72vw,850px);overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none;-webkit-overflow-scrolling:touch}
      .lux-nav-actions::-webkit-scrollbar{display:none}
      .hub-nav .lux-nav-brand{border-color:#ff422c66;color:#fff}
      .hub-nav .lux-nav-login{border-color:#ff321ccc;background:#b71c0d;color:#fff}
      .hub-nav .lux-nav-logout{border-color:#ffffff22;background:#ffffff08;color:#aaa}
      .hub-nav>strong small{display:block;margin-top:2px;color:#ff9c83;font:600 .54rem 'Segoe UI',sans-serif;letter-spacing:.4px}
      .lux-public-podium>button{display:grid;justify-items:center;gap:6px;padding:14px 6px;border:1px solid #ffc44844;border-radius:12px;background:#ffc4480d;color:#fff;text-align:center;cursor:pointer}
      .lux-public-podium>button:hover,.lux-public-row:hover,.lux-member-public-row:hover{border-color:#ff6849aa;background:#ff220012}
      .lux-public-podium>button em{color:#ffcf72;font:.7rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.8px}
      .lux-public-row{width:100%;color:#fff;text-align:left;cursor:pointer}
      .lux-member-top-simple{grid-template-columns:130px 160px minmax(220px,1fr)}
      .lux-member-top-simple>section{display:flex;align-items:stretch;justify-content:flex-end;gap:8px;padding:0}
      .lux-member-top-simple>section button,.lux-member-directory-head>button,.lux-owner-panel-actions button,.lux-public-profile-note button{border:1px solid #ffc44566;border-radius:8px;background:#ffc44512;color:#ffdc7a;padding:9px 11px;font:.9rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.8px;cursor:pointer}
      .lux-member-directory{margin-top:15px;scroll-margin-top:78px}
      .lux-member-directory-head{display:flex;align-items:end;justify-content:space-between;gap:15px}
      .lux-member-directory-head h3{margin-bottom:4px}
      .lux-member-directory-head p{max-width:620px;margin:0;color:#918b92;font-size:.76rem;line-height:1.45}
      .lux-member-search{display:block;margin:17px 0 11px;color:#ff8069;font:1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px}
      .lux-member-search input{display:block;width:100%;height:45px;margin-top:5px;border:1px solid #ff220044;border-radius:9px;background:#050507;color:#fff;padding:8px 11px;font:16px 'Segoe UI',sans-serif}
      .lux-member-directory-list{display:grid;gap:8px}
      .lux-member-public-row{display:grid;grid-template-columns:34px 50px minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:10px;border:1px solid #ffffff15;border-radius:11px;background:#ffffff06;color:#fff;text-align:left;cursor:pointer}
      .lux-member-public-row>i{color:#ff745c;font:1.3rem 'Bebas Neue',Impact,sans-serif;text-align:center}
      .lux-member-public-avatar{width:50px;height:50px;display:grid;place-items:center;border-radius:50%;object-fit:cover}
      .lux-member-public-row>span{display:grid;gap:3px;min-width:0}
      .lux-member-public-row strong{overflow:hidden;font:1.2rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px;text-overflow:ellipsis;white-space:nowrap}
      .lux-member-public-row small{color:#9f99a1;font-size:.64rem;line-height:1.4}
      .lux-member-public-row>b{color:#ff937d;font:1rem 'Bebas Neue',Impact,sans-serif;white-space:nowrap}
      .lux-public-profile-note{margin-top:17px;padding:17px;border:1px solid #ffffff14;border-radius:13px;background:#ffffff05;text-align:center}
      .lux-public-profile-note h3{margin:6px 0;color:#fff;font:1.6rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px}
      .lux-public-profile-note p{max-width:560px;margin:0 auto 13px;color:#9c959e;font-size:.75rem;line-height:1.5}
      .lux-public-player-stats{grid-template-columns:repeat(4,minmax(0,1fr))}
      .lux-owner-panel-actions{display:flex;gap:7px}
      @media(max-width:900px){
        .hub-nav{align-items:flex-start;flex-wrap:wrap}
        .hub-nav>strong{order:-1;width:100%;text-align:center}
        .hub-nav>.lux-nav-actions{width:calc(100% - 105px);max-width:none;padding-bottom:3px}
        .hub-nav>.lux-nav-actions button{flex:0 0 auto}
      }
      @media(max-width:620px){
        .lux-member-top-simple{grid-template-columns:1fr 1fr}
        .lux-member-top-simple>section{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr}
        .lux-member-directory-head{display:grid;grid-template-columns:1fr}
        .lux-member-directory-head>button{justify-self:start}
        .lux-member-public-row{grid-template-columns:29px 45px minmax(0,1fr)}
        .lux-member-public-avatar{width:45px;height:45px}
        .lux-member-public-row>b{grid-column:2/-1;text-align:center;padding:7px;border:1px solid #ff624d55;border-radius:7px}
        .lux-public-player-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
        .lux-owner-panel-actions{width:100%;display:grid;grid-template-columns:1fr 1fr}
      }
    `;
    document.head.appendChild(style);
  }
  function install() {
    installStyles();
    setScreenBase = setScreenStable;
    window.luxHub = { ...window.luxHub, setScreen:setScreenStable, saveProfile, loadMine, pickAvatar, registerVictory, renderAdmin, openPlayer, closePlayer, openEditor, backFromEditor, backup, showDirectory, showAdminSummary, renderDirectory, downloadPhoto:downloadOfficialBanner,
      askAdmin:openLeader, confirmAdmin:openLeader, closeAdminKey:() => {}, setRole:() => toast('ℹ️ LOS PERMISOS SE GESTIONAN EN EL SERVIDOR'), removePlayer:requestMemberRemoval };
    window.luxAccess = { ...window.luxAccess, openPublic:openRanking, openLogin, closeLogin, loginMember:openMember, loginLeader:openLeader, renderPublic, renderMemberTop:() => renderPublic() };
    window.luxPlates = { ...window.luxPlates, show:showPlates, openGallery:openPlateGallery, closeGallery:closePlateGallery, renderSelector:renderPlatesSelector, renderRanking:renderPlatesRanking, renderPublic:renderPublic };
    window.luxPlateActivityApi = { getContext:getActivityImportContext, exists:activityImportExists, submit:submitActivityCapture, submitBatch:submitActivityBatch, refresh:renderPlatesRanking };
    document.querySelector('.hub-choice.player')?.setAttribute('onclick', 'window.luxAccess.loginMember()');
    document.querySelector('.hub-choice.leader')?.setAttribute('onclick', 'window.luxAccess.loginLeader()');
    document.querySelector('.lux-public-entry')?.remove();
    const mode = $('hub-mode');
    if (mode) mode.innerHTML = '<option value="1v1">VICTORIA 1V1</option><option value="2v2">VICTORIA 2V2</option><option value="3v3">VICTORIA 3V3</option><option value="4v4" selected>VICTORIA 4V4</option><option value="Otro">OTRA PARTIDA</option>';
    const nameInput = $('hub-name');
    if (nameInput) {
      nameInput.maxLength = 24;
      nameInput.removeAttribute('onblur');
      nameInput.onblur = null;
    }
    [$('hub-name'), $('hub-age'), $('hub-country')].filter(Boolean).forEach(field => {
      const eventName = field.tagName === 'SELECT' ? 'change' : 'input';
      field.addEventListener(eventName, () => { state.profileDraftDirty = true; });
    });
    const memberBannerButton = document.querySelector('#hub-member .hub-profile .hub-actions .primary');
    if (memberBannerButton) {
      memberBannerButton.textContent = '⬇️ DESCARGAR MI BANNER';
      memberBannerButton.setAttribute('onclick', 'window.luxSupabase.downloadMyBanner()');
    }
    const memberIntro = document.querySelector('#hub-member .hub-intro p');
    if (memberIntro) memberIntro.textContent = 'Completa tu perfil una sola vez, genera tu banner y registra tus victorias. Todo queda unido a tu cuenta.';
    const adminIntro = document.querySelector('#hub-admin .hub-admin-head p');
    if (adminIntro) adminIntro.textContent = 'Revisa integrantes, banners, estadísticas y capturas desde un solo lugar.';
    const rankingIntro = document.querySelector('#hub-admin .hub-ranking>p');
    if (rankingIntro) rankingIntro.textContent = 'Ordenado por 4v4, 3v3, 2v2, 1v1 y victorias totales.';
    const directoryIntro = document.querySelector('#hub-member-directory .hub-directory-head p');
    if (directoryIntro) directoryIntro.textContent = 'Consulta perfiles y estadísticas, genera sus banners oficiales o expulsa integrantes del clan.';
    document.querySelectorAll('.hub-profile-title .hub-kicker').forEach(node => { node.textContent = 'PERFIL SEGURO'; });
    document.querySelectorAll('.hub-local').forEach(node => { node.textContent = '● DATOS PROTEGIDOS · crea una cuenta para participar'; });
    ensureMemberDirectory();
    ensureSimpleExperience();
    window.luxSupabase = { authSubmit, loginWithGoogle, resendConfirmation, toggleSignup, logout, reviewVictory, openMember, openLeader, openRanking, navigateAdmin, renderPublic, renderAdmin, openEvidence, closeEvidence, zoomEvidence, resetEvidenceZoom, downloadOfficialBanner, downloadMyBanner, saveCurrentBanner, showOwnerAccounts, setAccountRole, requestMemberRemoval, closeMemberRemoval, confirmMemberRemoval, openPublicPlayer, showMemberDirectory, renderMemberDirectory, showMyProfile, showMyVictories, showAdminReview, openAdminEditor,
      _core:{ state, request, rpc, upload, uploadUpsert, publicUrl, signedEvidence, sha256, imageDHash, imageVisualHashes, extension, randomId, isImage, errorMessage, loadProfile, loadRole, hydrateAccount, renderAccountState, renderNavigation, setAdminSection, showMemberSection, renderMember, renderAdmin, renderPublic, openMember, openLeader, toast, beginNavigation, endNavigation, showPageChildren, scrollTopNow, revealActiveTab, animateView, syncStickyOffsets }
    };
    if (window.ResizeObserver) {
      const navigationResizeObserver = new ResizeObserver(syncStickyOffsets);
      document.querySelectorAll('.hub-nav,#hub-editor-nav').forEach(node => navigationResizeObserver.observe(node));
    }
    document.body.classList.add('lux-auth-checking');
    document.documentElement.dataset.luxAuth = 'checking';
    renderAccountState();
    const authNavigationSerial = state.navigationSerial;
    authReadyPromise = hydrateAccount().then(async user => {
      await renderPublic();
      if (state.navigationSerial !== authNavigationSerial) return user;
      if (user && arrivedFromOAuth) {
        await openMember('home');
      } else {
        window.luxHub.setScreen('home');
      }
      renderNavigation();
      return user;
    }).catch(async () => {
      if (state.authStatus === 'checking') state.authStatus = readSession()?.access_token ? 'unavailable' : 'anonymous';
      await renderPublic();
      if (state.navigationSerial === authNavigationSerial) window.luxHub.setScreen('home');
      return null;
    }).finally(() => {
      document.body.classList.remove('lux-auth-checking');
      document.documentElement.dataset.luxAuth = state.authStatus;
      renderAccountState();
    });
    const refreshWhenNeeded = async () => {
      const saved = state.session || readSession() || await readIndexedSession();
      if (!saved?.refresh_token || document.hidden) return;
      if (!saved.expires_at || saved.expires_at * 1000 < Date.now() + 5 * 60_000) {
        try { await refreshSession(); state.authStatus = 'authenticated'; renderAccountState(); } catch (_) {}
      }
    };
    window.addEventListener('online', refreshWhenNeeded);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshWhenNeeded(); });
    setInterval(refreshWhenNeeded, 10 * 60_000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
