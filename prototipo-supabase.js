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
  const state = { session:null, user:null, role:'member', isStaff:false, isLeader:false, isOwner:false, profile:null, pendingAvatar:null, directory:new Map(), ranking:new Map(), roles:new Map(), editorBack:'member' };

  // Preservar hash de OAuth en sessionStorage para inmunitad total contra escrituras de location.hash por otros scripts
  let rawHash = window.location.hash ? window.location.hash.substring(1) : '';
  if (rawHash.includes('access_token')) {
    try { sessionStorage.setItem('lux_oauth_hash', rawHash); } catch (_) {}
  } else {
    try { rawHash = sessionStorage.getItem('lux_oauth_hash') || rawHash; } catch (_) {}
  }
  const initialOAuthHash = rawHash;

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
    window.location.href = `${base}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl.href)}`;
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
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (_) { return null; }
  }
  function writeSession(session) {
    state.session = session || null;
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
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
    return redirectUrl.href;
  }
  async function sha256(file) {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
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
    const authorizeUrl = `${base}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl)}`;
    window.location.href = authorizeUrl;
  }

  async function refreshSession() {
    const current = state.session || readSession();
    if (!current?.refresh_token) return null;
    const data = await request('/auth/v1/token?grant_type=refresh_token', {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ refresh_token:current.refresh_token })
    }, false);
    writeSession(data);
    return data;
  }
  async function validateSession() {
    parseOAuthCallback();
    const saved = readSession();
    if (!saved?.access_token) return null;
    writeSession(saved);
    try {
      if (!saved.expires_at || saved.expires_at * 1000 < Date.now() + 45_000) await refreshSession();
      const user = await request('/auth/v1/user');
      state.user = user;
      return user;
    } catch (_) {
      try {
        await refreshSession();
        const user = await request('/auth/v1/user');
        state.user = user;
        return user;
      } catch (_) {
        writeSession(null);
        state.user = null;
        return null;
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
    await Promise.all([loadRole(), loadProfile()]);
    renderAccountState();
    return state.user;
  }
  function renderAccountState() {
    const note = document.querySelector('.hub-local');
    if (note) note.textContent = state.user ? `● SESIÓN SEGURA · ${state.user.email || 'cuenta conectada'}` : '● DATOS PROTEGIDOS · crea una cuenta para participar';
    const leader = $('lux-leader-session');
    if (leader) leader.textContent = state.user && state.isStaff ? `${roleLabel()} · cuenta verificada` : 'Acceso con cuenta';
    document.body.classList.toggle('lux-supabase-ready', Boolean(state.user));
  }

  async function renderPublic() {
    try {
      const [ranking, plates] = await Promise.all([
        rpc('get_public_ranking', {}, false),
        rpc('get_public_plate_ranking', {}, false)
      ]);
      const all = Array.isArray(ranking) ? ranking : [];
      const total4 = all.reduce((sum, row) => sum + Number(row.victories_4v4 || 0), 0);
      const total = all.reduce((sum, row) => sum + Number(row.victories_total || 0), 0);
      if ($('lux-public-members')) $('lux-public-members').textContent = all.length;
      if ($('lux-public-wins')) $('lux-public-wins').textContent = total4;
      if ($('lux-public-total')) $('lux-public-total').textContent = total;
      if ($('lux-public-podium')) $('lux-public-podium').innerHTML = all.slice(0, 3).map((row, index) => `<article><i>#${index + 1}</i>${avatarHtml(row, 'lux-podium-avatar')}<strong>${esc(row.display_name)}</strong><small>${row.victories_total} victorias aprobadas</small></article>`).join('') || '<p class="hub-empty">Todavía no hay resultados confirmados.</p>';
      if ($('lux-public-ranking')) $('lux-public-ranking').innerHTML = all.map((row, index) => `<article class="lux-public-row"><i>#${index + 1}</i>${avatarHtml(row)}<div><strong>${esc(row.display_name)}</strong><small>${rankingModeLine(row)} · TOTAL ${Number(row.victories_total || 0)}</small></div></article>`).join('') || '<p class="hub-empty">El ranking aparecerá al aprobarse victorias.</p>';
      renderPublicPlates(plates || []);
      renderMemberTop(all);
    } catch (_) {
      if ($('lux-public-ranking')) $('lux-public-ranking').innerHTML = '<p class="hub-empty">No se pudo cargar la clasificación. Revisa tu conexión.</p>';
    }
  }
  function renderMemberTop(all) {
    const target = $('lux-member-top');
    if (!target) return;
    const mine = all.find(row => row.player_id === state.user?.id);
    const position = mine ? all.findIndex(row => row.player_id === mine.player_id) + 1 : 0;
    target.innerHTML = `<div class="lux-member-top-head"><div><span class="hub-kicker">CLASIFICACIÓN ABIERTA</span><h3>Top del clan</h3></div><button type="button" onclick="window.luxAccess.openPublic()">VER TODO →</button></div><div class="lux-member-top-grid"><article><b>${position ? `#${position}` : '—'}</b><small>MI POSICIÓN</small></article><article><b>${mine?.victories_total || 0}</b><small>MIS VICTORIAS</small></article><section>${all.slice(0, 5).map((row, index) => `<p><b>#${index + 1}</b><span>${esc(row.display_name)}</span><em>${row.victories_total} total</em></p>`).join('') || '<p class="lux-no-ranking">Aún no hay victorias aprobadas.</p>'}</section></div>`;
  }
  function ensurePublicPlates() {
    const page = document.querySelector('#lux-public-screen .hub-page');
    if (page && !$('lux-public-plates-ranking')) page.insertAdjacentHTML('beforeend', '<section class="lux-public-card lux-public-plates"><span class="hub-kicker">CREATIVIDAD DEL CLAN</span><h3>Top de placas</h3><p>Reconocimientos registrados por las líderes.</p><div id="lux-public-plates-ranking"></div></section>');
  }
  function renderPublicPlates(rows) {
    ensurePublicPlates();
    const target = $('lux-public-plates-ranking');
    if (!target) return;
    target.innerHTML = rows.length ? rows.slice(0, 5).map((row, index) => `<p><b>#${index + 1}</b>${avatarHtml(row, 'lux-public-plate-avatar')}<span>${esc(row.display_name)}</span><em>${row.plate_count} placas</em></p>`).join('') : '<p class="lux-plates-public-empty">Aún no hay placas registradas.</p>';
  }

  function ensureMemberModeStats() {
    const target = document.querySelector('.hub-stats>div');
    if (!target || $('hub-1v1')) return;
    target.classList.add('lux-mode-summary');
    target.innerHTML = `<article><b id="hub-1v1">0</b><small>1V1</small></article><article><b id="hub-2v2">0</b><small>2V2</small></article><article><b id="hub-3v3">0</b><small>3V3</small></article><article><b id="hub-4v4">0</b><small>4V4</small></article><article><b id="hub-other">0</b><small>OTRAS</small></article><article><b id="hub-total">0</b><small>TOTAL</small></article>`;
  }

  async function renderMember() {
    if (!state.user) return;
    ensureMemberModeStats();
    const profile = await loadProfile();
    const rows = await request(`/rest/v1/victories?player_id=eq.${encodeURIComponent(state.user.id)}&select=id,mode,evidence_path,status,created_at,rejection_reason&order=created_at.desc`);
    const accepted = rows.filter(row => row.status === 'approved');
    const stats = modeStats(rows);
    if ($('hub-name')) $('hub-name').value = profile?.display_name === 'Jugador' ? '' : (profile?.display_name || '');
    if ($('hub-age')) $('hub-age').value = profile?.age || '';
    if ($('hub-country')) $('hub-country').value = profile?.country_code || '';
    if ($('hub-role')) $('hub-role').value = roleLabel();
    const avatar = profile?.avatar_path ? publicUrl('lux-avatars', profile.avatar_path) : '';
    if ($('hub-avatar')) { $('hub-avatar').src = avatar; $('hub-avatar').hidden = !avatar; }
    if ($('hub-avatar-empty')) $('hub-avatar-empty').hidden = Boolean(avatar);
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
    await renderPublic();
  }
  async function saveProfile(quiet = false) {
    if (!state.user) { openLogin('member'); return null; }
    const display_name = $('hub-name')?.value.trim();
    const age = Number($('hub-age')?.value || 0) || null;
    const country_code = $('hub-country')?.value || null;
    if (!display_name || display_name.length < 2) { $('hub-name')?.focus(); toast('⚠️ ESCRIBE UN NOMBRE DE 2 A 24 CARACTERES'); return null; }
    if (display_name.length > 24 || (age && (age < 13 || age > 99))) { toast('⚠️ REVISA EL NOMBRE Y LA EDAD'); return null; }
    let avatar_path = state.profile?.avatar_path || null;
    if (state.pendingAvatar) {
      avatar_path = `${state.user.id}/avatar-${Date.now()}.${extension(state.pendingAvatar)}`;
      await upload('lux-avatars', avatar_path, state.pendingAvatar);
      state.pendingAvatar = null;
    }
    await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(state.user.id)}`, {
      method:'PATCH', headers:{ 'Content-Type':'application/json', Prefer:'return=representation' },
      body:JSON.stringify({ display_name, age, country_code, country_name:countryName(), avatar_path })
    });
    await loadProfile();
    if (state.profile && state.user?.id) {
      state.directory.set(state.user.id, state.profile);
    }
    await Promise.all([renderMember(), renderPublic()]);
    if (state.isStaff) await renderAdmin();
    const updatedAvatarUrl = state.profile?.avatar_path ? publicUrl('lux-avatars', state.profile.avatar_path) : '';
    if (updatedAvatarUrl && window.readPlayerFileInteg) {
      try {
        const blob = await fetch(updatedAvatarUrl).then(response => response.blob());
        window.readPlayerFileInteg(new File([blob], 'perfil.jpg', { type:'image/jpeg' }));
      } catch (_) {}
    }
    if (!quiet) toast('✅ PERFIL GUARDADO DE FORMA SEGURA');
    return state.profile;
  }
  async function pickAvatar(event) {
    const file = event?.target?.files?.[0];
    if (!isImage(file, MAX_AVATAR)) { toast('⚠️ USA JPG, PNG O WEBP DE HASTA 5 MB'); return; }
    state.pendingAvatar = file;
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
  async function loadMine() { if (state.user) await renderMember(); }
  async function registerVictory() {
    if (!state.user) { openLogin('member'); return; }
    const file = $('hub-victory')?.files?.[0];
    if (!isImage(file, MAX_EVIDENCE)) { toast('⚠️ USA JPG, PNG O WEBP DE HASTA 8 MB'); return; }
    try {
      const evidence_sha256 = await sha256(file);
      const allowed = await rpc('can_submit_victory', { p_evidence_sha256:evidence_sha256 });
      if (!allowed) { toast('⛔ CAPTURA REPETIDA O LÍMITE DE REVISIONES ALCANZADO'); return; }
      const evidence_path = `${state.user.id}/${randomId()}.${extension(file)}`;
      await upload('lux-evidence', evidence_path, file);
      await request('/rest/v1/victories', {
        method:'POST', headers:{ 'Content-Type':'application/json', Prefer:'return=representation' },
        body:JSON.stringify({ player_id:state.user.id, mode:$('hub-mode')?.value || '4v4', evidence_path, evidence_sha256 })
      });
      $('hub-victory').value = '';
      toast('🕒 CAPTURA ENVIADA · ESPERA LA REVISIÓN DE UNA LÍDER');
      await renderMember();
    } catch (error) {
      const message = errorMessage(error, 'NO SE PUDO ENVIAR LA CAPTURA').toUpperCase();
      if (/CAN_SUBMIT_VICTORY|SCHEMA CACHE|PGRST202/.test(message)) {
        toast('⚠️ LA VALIDACIÓN SE ESTÁ ACTUALIZANDO. RECARGA E INTENTA DE NUEVO.');
        return;
      }
      toast(`⚠️ ${message}`);
    }
  }

  function orderedDirectory() {
    return [...state.directory.values()].sort((a, b) => {
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
    if (!state.directory.size) await renderAdmin();
    const page = $('hub-admin')?.querySelector('.hub-page');
    const panel = $('hub-member-directory');
    if (!page || !panel) return;
    [...page.children].forEach(child => { child.hidden = child !== panel; });
    panel.hidden = false;
    if ($('hub-directory-search')) $('hub-directory-search').value = '';
    renderDirectory();
  }
  async function showAdminSummary() {
    if (!state.isStaff) return;
    const page = $('hub-admin')?.querySelector('.hub-page');
    if (!page) return;
    const specialPanels = new Set(['hub-member-directory', 'lux-plates-panel', 'lux-owner-panel']);
    [...page.children].forEach(child => { child.hidden = specialPanels.has(child.id); });
    await renderAdmin();
  }

  function ensureOwnerPanel() {
    const admin = $('hub-admin');
    const page = admin?.querySelector('.hub-page');
    const nav = admin?.querySelector('.hub-nav>span');
    if (!admin || !page || !nav) return;
    const existingButton = $('lux-owner-nav');
    if (!state.isOwner) {
      existingButton?.remove();
      $('lux-owner-panel')?.remove();
      return;
    }
    if (!existingButton) nav.insertAdjacentHTML('afterbegin', '<button id="lux-owner-nav" class="lux-owner-nav" type="button" onclick="window.luxSupabase.showOwnerAccounts()">CUENTAS</button>');
    if (!$('lux-owner-panel')) page.insertAdjacentHTML('beforeend', `<section id="lux-owner-panel" class="lux-owner-panel" hidden>
      <header class="hub-directory-head"><div><span class="hub-kicker">CONTROL PRIVADO</span><h2>Cuentas<br/><em>registradas.</em></h2><p>Esta zona solo existe para la cuenta propietaria. Aquí puedes distinguir cuentas Google, perfiles pendientes y accesos antiguos.</p></div><button type="button" onclick="window.luxHub.showAdminSummary()">← RESUMEN</button></header>
      <div class="lux-owner-notice">🔒 Solo tú ves correos y cuentas. Al eliminar una cuenta se borran también su perfil, victorias, placas, banner e imágenes.</div>
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
    [...page.children].forEach(child => { child.hidden = child !== panel; });
    panel.hidden = false;
    target.innerHTML = '<p class="hub-empty">Cargando cuentas seguras…</p>';
    try {
      const rows = await rpc('owner_list_clan_users');
      target.innerHTML = rows.length ? rows.map(row => {
        const connected = String(row.providers || '').split(',').map(item => item.trim()).filter(Boolean);
        const profile = state.directory.get(row.user_id);
        const canDelete = row.user_id !== state.user?.id;
        return `<article class="lux-owner-account">${avatarHtml(profile || { display_name:row.display_name }, 'lux-owner-avatar')}<div><strong>${esc(row.display_name || 'Jugador')}</strong><span>${esc(row.email || 'Sin correo visible')}</span><small>${connected.includes('google') ? 'GOOGLE CONECTADO' : 'ACCESO ANTIGUO POR CORREO'} · ${row.display_name === 'Jugador' ? 'PERFIL PENDIENTE' : 'PERFIL ACTIVO'} · ${new Date(row.created_at).toLocaleDateString('es-ES')}</small></div><span class="lux-owner-actions">${profile ? `<button type="button" onclick="window.luxHub.openPlayer('${esc(row.user_id)}')">VER PERFIL</button>` : '<em>SIN PERFIL</em>'}${canDelete ? `<button type="button" class="lux-danger-action" onclick="window.luxSupabase.requestMemberRemoval('${esc(row.user_id)}')">ELIMINAR</button>` : '<em>CUENTA OWNER</em>'}</span></article>`;
      }).join('') : '<p class="hub-empty">Todavía no hay cuentas registradas.</p>';
    } catch (error) {
      target.innerHTML = `<p class="hub-empty">No se pudo cargar el control de cuentas: ${esc(errorMessage(error))}</p>`;
    }
  }

  async function renderAdmin() {
    if (!state.isStaff) return;
    const sessionLabel = $('lux-leader-session');
    if (sessionLabel) sessionLabel.textContent = state.isOwner ? 'Control privado · cuenta verificada' : `${roleLabel()} · cuenta verificada`;
    const [profiles, victories, ranking, roles] = await Promise.all([
      request('/rest/v1/profiles?select=id,display_name,age,country_code,country_name,avatar_path,banner_path,is_public,created_at&order=display_name.asc'),
      request('/rest/v1/victories?select=id,player_id,mode,evidence_path,status,created_at,rejection_reason&order=created_at.desc'),
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
    if ($('admin-members')) $('admin-members').textContent = profiles.length;
    if ($('admin-wins')) $('admin-wins').textContent = approved.filter(row => row.mode === '4v4').length;
    if ($('admin-mvp')) $('admin-mvp').innerHTML = mvp ? avatarHtml(mvp, 'hub-mvp-avatar') : '<span class="hub-mvp-avatar hub-avatar-empty">★</span>';
    if ($('admin-mvp-name')) $('admin-mvp-name').textContent = mvp?.display_name || 'Aún sin MVP';
    if ($('admin-mvp-detail')) $('admin-mvp-detail').textContent = mvp ? `${byId.get(mvp.id)?.victories_total || 0} victorias aprobadas` : 'Registra la primera victoria';
    if ($('admin-ranking')) $('admin-ranking').innerHTML = ordered.map((member, index) => { const stats = byId.get(member.id) || {}; return `<button type="button" class="hub-rank" onclick="window.luxHub.openPlayer('${esc(member.id)}')"><i>#${index + 1}</i>${avatarHtml(member, 'hub-rank-avatar')}<span><strong>${esc(member.display_name)}</strong><small>${rankingModeLine(stats)} · TOTAL ${Number(stats.victories_total || 0)}</small></span><b>VER</b></button>`; }).join('') || '<p class="hub-empty">Aún no hay integrantes registrados.</p>';
    renderReviewQueue((victories || []).filter(row => row.status === 'pending'));
    renderDirectory();
    ensureOwnerPanel();
    await renderPlatesSelector();
    await renderPlatesRanking();
  }
  function ensureReviewPanel() {
    const page = $('hub-admin')?.querySelector('.hub-page');
    if (page && !$('lux-review-queue')) page.insertAdjacentHTML('beforeend', '<section id="lux-review-queue" class="hub-card lux-review-queue"><span class="hub-kicker">REVISIÓN</span><h3>Victorias pendientes</h3><p>Solo las capturas aprobadas suman puntos al ranking.</p><div id="lux-review-list"></div></section>');
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

  function ensureRemovalDialog() {
    if ($('lux-remove-dialog')) return;
    document.body.insertAdjacentHTML('beforeend', `<div id="lux-remove-dialog" class="lux-remove-dialog" hidden role="dialog" aria-modal="true" aria-labelledby="lux-remove-title"><div><span class="hub-kicker">ACCIÓN DEFINITIVA</span><h2 id="lux-remove-title">Expulsar integrante</h2><p id="lux-remove-copy"></p><small>Se eliminarán la cuenta, el perfil, banner, placas, victorias y todas sus imágenes. Esta acción no se puede deshacer.</small><span><button type="button" onclick="window.luxSupabase.closeMemberRemoval()">CANCELAR</button><button id="lux-remove-confirm" type="button" class="lux-danger-action" onclick="window.luxSupabase.confirmMemberRemoval()">SÍ, ELIMINAR TODO</button></span></div></div>`);
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
    if (button) { button.disabled = true; button.textContent = 'ELIMINANDO…'; }
    try {
      const assets = await rpc('staff_member_assets', { p_user_id:target.id });
      for (const asset of assets || []) {
        await request(`/storage/v1/object/${encodeURIComponent(asset.bucket_id)}/${String(asset.object_name).split('/').map(encodeURIComponent).join('/')}`, { method:'DELETE' });
      }
      await rpc('staff_delete_member', { p_user_id:target.id });
      state.directory.delete(target.id); state.ranking.delete(target.id); state.roles.delete(target.id);
      closeMemberRemoval(); closePlayer();
      await Promise.all([renderAdmin(), renderPublic()]);
      if (state.isOwner && $('lux-owner-panel')?.hidden === false) await showOwnerAccounts();
      toast(`✅ ${target.name.toUpperCase()} FUE ELIMINADO DEL CLAN`);
    } catch (error) {
      toast(`⚠️ NO SE ELIMINÓ NADA: ${errorMessage(error).toUpperCase()}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = 'SÍ, ELIMINAR TODO'; }
    }
  }
  async function backup() {
    if (!state.isStaff) return;
    const ranking = await rpc('get_public_ranking', {}, false);
    const rows = [...state.directory.values()].map(row => ({ id:row.id, name:row.display_name, country:row.country_code, public:row.is_public, statistics:ranking.find(item => item.player_id === row.id) || null }));
    const blob = new Blob([JSON.stringify({ exportedAt:new Date().toISOString(), members:rows }, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'LUX_CLAN_DIRECTORIO.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('✅ RESPALDO DEL DIRECTORIO DESCARGADO');
  }

  async function renderPlatesSelector() {
    const select = $('lux-plate-player');
    if (!select || !state.isLeader) return;
    const previous = select.value;
    select.innerHTML = '<option value="">— ELEGIR INTEGRANTE —</option>' + [...state.directory.values()].sort((a,b) => a.display_name.localeCompare(b.display_name, 'es')).map(row => `<option value="${esc(row.id)}">${esc(row.display_name)}</option>`).join('');
    select.value = previous;
  }
  async function renderPlatesRanking() {
    const target = $('lux-plates-ranking');
    if (!target) return;
    const rows = await rpc('get_public_plate_ranking', {}, false);
    target.innerHTML = rows.length ? rows.map((row, index) => `<article class="lux-plate-row"><i>#${index + 1}</i>${avatarHtml(row, 'lux-plate-avatar')}<div><strong>${esc(row.display_name)}</strong><small>${row.plate_count} placas</small></div><button type="button" onclick="window.luxPlates.openGallery('${esc(row.player_id)}')">VER</button></article>`).join('') : '<p class="hub-empty">Aún no hay placas registradas.</p>';
  }
  async function showPlates() {
    if (!state.isLeader) { toast('⛔ SOLO PROPIETARIA O LÍDERES GESTIONAN PLACAS'); return; }
    const page = $('hub-admin')?.querySelector('.hub-page'); const panel = $('lux-plates-panel');
    if (!page || !panel) return;
    [...page.children].forEach(child => { child.hidden = child !== panel; });
    panel.hidden = false;
    await Promise.all([renderPlatesSelector(), renderPlatesRanking()]);
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
    const member = state.directory.get(playerId) || { display_name:'Integrante' };
    const rows = state.isStaff ? await request(`/rest/v1/plates?player_id=eq.${encodeURIComponent(playerId)}&select=*&order=created_at.desc`) : await rpc('get_public_player_plates', { p_player_id:playerId }, false);
    const modal = $('lux-plates-modal'); if (!modal) return;
    modal.innerHTML = `<div class="lux-plates-modal-box"><button class="lux-plates-close" type="button" onclick="window.luxPlates.closeGallery()">×</button><span class="hub-kicker">PLACAS DE INTEGRANTE</span><h2>${esc(member.display_name)}</h2><p>${rows.length} placas registradas en el clan.</p><section>${rows.length ? rows.map(row => `<figure><img src="${esc(publicUrl('lux-plates', row.image_path))}" alt="${esc(row.title)}"/><figcaption><strong>${esc(row.title)}</strong><small>${new Date(row.created_at).toLocaleDateString('es-ES')}</small>${state.isLeader && row.id ? `<button type="button" onclick="window.luxPlates.remove('${esc(row.id)}','${esc(row.image_path)}')">ELIMINAR</button>` : ''}</figcaption></figure>`).join('') : '<p class="hub-empty">Todavía no tiene placas.</p>'}</section></div>`;
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

  async function openEditor(leader = false) {
    if (!state.user) { openLogin(leader ? 'leader' : 'member'); return; }
    if (leader && !state.isStaff) { toast('⛔ TU CUENTA NO TIENE PERMISOS DE LÍDER'); return; }
    if (!leader && !await saveProfile(true)) return;
    state.editorBack = leader ? 'admin' : 'member';
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
  }
  function backFromEditor() { window.luxHub.setScreen(state.editorBack); }

  function closeLogin() {
    const modal = $('lux-login-modal');
    if (modal) modal.hidden = true;
  }

  function openLogin(kind = 'member') {
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
      if (state.isStaff) { window.luxHub.setScreen('admin'); await renderAdmin(); }
      else { window.luxHub.setScreen('member'); await renderMember(); }
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
    writeSession(null); state.user = null; state.profile = null; state.role = 'member'; state.isStaff = false; state.isLeader = false; state.isOwner = false; state.directory = new Map(); state.ranking = new Map(); state.roles = new Map(); renderAccountState(); ensureOwnerPanel(); window.luxHub.setScreen('home'); toast('SESIÓN CERRADA');
  }
  async function openMember() {
    if (!state.user) { openLogin('member'); return; }
    window.luxHub.setScreen('member'); await renderMember();
  }
  async function openLeader() {
    if (!state.user) { openLogin('leader'); return; }
    if (!state.isStaff) { toast('⛔ ESTA CUENTA NO TIENE PERMISOS DE LÍDER'); return; }
    window.luxHub.setScreen('admin'); await renderAdmin();
  }
  function installStyles() {
    const style = document.createElement('style');
    style.textContent = `.lux-google-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px;margin-top:18px;border:1px solid #ffffff35;border-radius:12px;background:#ffffff;color:#1a1a1a;font:700 1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.2px;cursor:pointer;box-shadow:0 4px 20px #00000060;transition:transform .15s,box-shadow .15s}.lux-google-btn:hover{background:#f0f0f0;transform:translateY(-2px);box-shadow:0 8px 28px #00000080}.lux-google-btn:active{transform:translateY(0)}.lux-google-btn svg{flex-shrink:0}.lux-google-btn--big{padding:16px;font-size:1.05rem;letter-spacing:1.8px;border-radius:14px}.lux-auth-note{margin-top:14px;color:#6e6875;font-size:.65rem;line-height:1.5;text-align:center}.lux-auth-switch,.lux-auth-resend{width:100%;margin-top:9px;border:1px solid #ffffff2b;border-radius:9px;background:#ffffff08;color:#ddd;padding:9px;font:1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px;cursor:pointer}.lux-auth-resend{color:#ffb29f;border-color:#ff674855;background:#ff22000d}.lux-review-queue{margin-top:15px}.lux-review-queue>p{margin:0 0 12px;color:#aaa4aa;font-size:.78rem}.lux-review-row{display:grid;grid-template-columns:82px 1fr auto;gap:10px;align-items:center;margin-top:8px;padding:8px;border:1px solid #ffffff18;border-radius:10px;background:#09090d}.lux-review-row img{width:82px;height:58px;border-radius:6px;object-fit:cover}.lux-review-row div{display:grid;gap:4px}.lux-review-row strong{font:1.15rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.8px}.lux-review-row small{color:#aaa;font-size:.65rem}.lux-review-row span{display:flex;gap:5px}.lux-review-row button,.hub-modal-gallery button,.lux-download-avatar{border:1px solid #ff664d77;border-radius:6px;background:#ff220018;color:#ffab9b;padding:6px 7px;font:.78rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.5px;cursor:pointer}.lux-review-row button:first-child,.hub-modal-gallery button:first-child{border:0;background:#bd2f18;color:#fff}.lux-download-avatar{margin-top:8px}.hub-evidence small{display:block;padding:0 7px 7px;color:#ffab9b;font-size:.62rem}@media(max-width:620px){.lux-review-row{grid-template-columns:65px 1fr}.lux-review-row img{width:65px;height:51px}.lux-review-row span{grid-column:2;justify-content:flex-start}.lux-review-row button{flex:1}}`;
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
    document.head.appendChild(style);
  }
  function install() {
    installStyles();
    const oldSetScreen = window.luxHub.setScreen;
    window.luxHub = { ...window.luxHub, saveProfile, loadMine, pickAvatar, registerVictory, renderAdmin, openPlayer, closePlayer, openEditor, backFromEditor, backup, showDirectory, showAdminSummary, renderDirectory, downloadPhoto:downloadOfficialBanner,
      askAdmin:openLeader, confirmAdmin:openLeader, closeAdminKey:() => {}, setRole:() => toast('ℹ️ LOS PERMISOS SE GESTIONAN EN EL SERVIDOR'), removePlayer:requestMemberRemoval };
    window.luxAccess = { ...window.luxAccess, openPublic:() => { oldSetScreen('public'); renderPublic(); }, openLogin, closeLogin, loginMember:openMember, loginLeader:openLeader, renderPublic, renderMemberTop:() => renderPublic() };
    window.luxPlates = { ...window.luxPlates, show:showPlates, add:addPlate, openGallery:openPlateGallery, closeGallery:closePlateGallery, remove:removePlate, renderSelector:renderPlatesSelector, renderRanking:renderPlatesRanking, renderPublic:renderPublic };
    document.querySelector('.hub-choice.player')?.setAttribute('onclick', 'window.luxAccess.loginMember()');
    document.querySelector('.hub-choice.leader')?.setAttribute('onclick', 'window.luxAccess.loginLeader()');
    const mode = $('hub-mode');
    if (mode) mode.innerHTML = '<option value="1v1">VICTORIA 1V1</option><option value="2v2">VICTORIA 2V2</option><option value="3v3">VICTORIA 3V3</option><option value="4v4" selected>VICTORIA 4V4</option><option value="Otro">OTRA PARTIDA</option>';
    const nameInput = $('hub-name'); if (nameInput) nameInput.maxLength = 24;
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
    window.luxSupabase = { authSubmit, loginWithGoogle, resendConfirmation, toggleSignup, logout, reviewVictory, openMember, openLeader, renderPublic, renderAdmin, openEvidence, closeEvidence, zoomEvidence, resetEvidenceZoom, downloadOfficialBanner, saveCurrentBanner, showOwnerAccounts, requestMemberRemoval, closeMemberRemoval, confirmMemberRemoval };
    hydrateAccount().then(async user => {
      await renderPublic();
      if (user) {
        if (state.isStaff) {
          window.luxHub.setScreen('admin');
          await renderAdmin();
        } else {
          window.luxHub.setScreen('member');
          await renderMember();
        }
        toast(`✅ SESIÓN ABIERTA CON GOOGLE: ${(user.email || 'INTEGRANTE').toUpperCase()}`);
      }
    }).catch(() => renderPublic());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
