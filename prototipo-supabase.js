/* LUX CLAN: cliente de produccion para Supabase Auth + RLS.
 * No usa service_role ni guarda permisos en el navegador. */
(() => {
  'use strict';

  const config = window.LUX_SUPABASE_CONFIG;
  const SESSION_KEY = 'lux_clan_auth_v1';
  const MAX_AVATAR = 5 * 1024 * 1024;
  const MAX_EVIDENCE = 8 * 1024 * 1024;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const toast = message => window.showToast?.(message);
  const state = { session:null, user:null, role:'member', isStaff:false, isLeader:false, profile:null, pendingAvatar:null, directory:new Map(), editorBack:'member' };

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
    const url = row.avatar_url || (row.avatar_path ? publicUrl('lux-avatars', row.avatar_path) : '');
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
    return `${window.location.origin}${window.location.pathname}`;
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
  async function signedEvidence(path) {
    if (!path) return '';
    const data = await request(`/storage/v1/object/sign/lux-evidence/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ expiresIn:3600 })
    });
    return data?.signedURL ? `${base}/storage/v1${data.signedURL}` : '';
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
    return state.role;
  }
  async function loadProfile() {
    if (!state.user?.id) return null;
    const rows = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(state.user.id)}&select=*`);
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
      if ($('lux-public-podium')) $('lux-public-podium').innerHTML = all.slice(0, 3).map((row, index) => `<article><i>#${index + 1}</i>${avatarHtml(row, 'lux-podium-avatar')}<strong>${esc(row.display_name)}</strong><small>${row.victories_4v4} victorias 4v4</small></article>`).join('') || '<p class="hub-empty">Todavía no hay resultados confirmados.</p>';
      if ($('lux-public-ranking')) $('lux-public-ranking').innerHTML = all.map((row, index) => `<article class="lux-public-row"><i>#${index + 1}</i>${avatarHtml(row)}<div><strong>${esc(row.display_name)}</strong><small>${row.country_code ? `${esc(row.country_code)} · ` : ''}${row.victories_4v4} 4v4 · ${row.victories_total} total</small></div></article>`).join('') || '<p class="hub-empty">El ranking aparecerá al aprobarse victorias.</p>';
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
    target.innerHTML = `<div class="lux-member-top-head"><div><span class="hub-kicker">CLASIFICACIÓN ABIERTA</span><h3>Top del clan</h3></div><button type="button" onclick="window.luxAccess.openPublic()">VER TODO →</button></div><div class="lux-member-top-grid"><article><b>${position ? `#${position}` : '—'}</b><small>MI POSICIÓN</small></article><article><b>${mine?.victories_4v4 || 0}</b><small>MIS 4V4</small></article><section>${all.slice(0, 5).map((row, index) => `<p><b>#${index + 1}</b><span>${esc(row.display_name)}</span><em>${row.victories_4v4} 4v4</em></p>`).join('') || '<p class="lux-no-ranking">Aún no hay victorias aprobadas.</p>'}</section></div>`;
  }
  function ensurePublicPlates() {
    const page = document.querySelector('#lux-public-screen .hub-page');
    if (page && !$('lux-public-plates-ranking')) page.insertAdjacentHTML('beforeend', '<section class="lux-public-card lux-public-plates"><span class="hub-kicker">CREATIVIDAD DEL CLAN</span><h3>Top de placas</h3><p>Reconocimientos registrados por las líderes.</p><div id="lux-public-plates-ranking"></div></section>');
  }
  function renderPublicPlates(rows) {
    ensurePublicPlates();
    const target = $('lux-public-plates-ranking');
    if (!target) return;
    target.innerHTML = rows.length ? rows.slice(0, 5).map((row, index) => `<p><b>#${index + 1}</b><span class="lux-public-plate-avatar lux-access-initial">${initial(row.display_name)}</span><span>${esc(row.display_name)}</span><em>${row.plate_count} placas</em></p>`).join('') : '<p class="lux-plates-public-empty">Aún no hay placas registradas.</p>';
  }

  async function renderMember() {
    if (!state.user) return;
    const profile = await loadProfile();
    const rows = await request(`/rest/v1/victories?player_id=eq.${encodeURIComponent(state.user.id)}&select=id,mode,evidence_path,status,created_at,rejection_reason&order=created_at.desc`);
    const accepted = rows.filter(row => row.status === 'approved');
    const four = accepted.filter(row => row.mode === '4v4').length;
    if ($('hub-name')) $('hub-name').value = profile?.display_name === 'Jugador' ? '' : (profile?.display_name || '');
    if ($('hub-age')) $('hub-age').value = profile?.age || '';
    if ($('hub-country')) $('hub-country').value = profile?.country_code || '';
    if ($('hub-role')) $('hub-role').value = roleLabel();
    const avatar = profile?.avatar_path ? publicUrl('lux-avatars', profile.avatar_path) : '';
    if ($('hub-avatar')) { $('hub-avatar').src = avatar; $('hub-avatar').hidden = !avatar; }
    if ($('hub-avatar-empty')) $('hub-avatar-empty').hidden = Boolean(avatar);
    if ($('hub-4v4')) $('hub-4v4').textContent = four;
    if ($('hub-total')) $('hub-total').textContent = accepted.length;
    const list = $('hub-history-list');
    if (list) {
      const signed = await Promise.all(rows.map(async row => ({ ...row, url:await signedEvidence(row.evidence_path).catch(() => '') })));
      list.innerHTML = signed.length ? signed.map(row => `<article class="hub-evidence"><img src="${esc(row.url)}" alt="Captura de victoria"/><b>${esc(row.mode)} · ${row.status === 'approved' ? 'APROBADA' : row.status === 'rejected' ? 'RECHAZADA' : 'PENDIENTE'}</b>${row.rejection_reason ? `<small>${esc(row.rejection_reason)}</small>` : ''}</article>`).join('') : '<p class="hub-empty">Todavía no has subido capturas.</p>';
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

  async function renderAdmin() {
    if (!state.isStaff) return;
    const [profiles, victories, ranking] = await Promise.all([
      request('/rest/v1/profiles?select=id,display_name,age,country_code,country_name,avatar_path,is_public,created_at&order=display_name.asc'),
      request('/rest/v1/victories?select=id,player_id,mode,evidence_path,status,created_at,rejection_reason&order=created_at.desc'),
      rpc('get_public_ranking', {}, false)
    ]);
    state.directory = new Map((profiles || []).map(row => [row.id, row]));
    const approved = (victories || []).filter(row => row.status === 'approved');
    const byId = new Map((ranking || []).map(row => [row.player_id, row]));
    const ordered = [...state.directory.values()].sort((a, b) => (byId.get(b.id)?.victories_4v4 || 0) - (byId.get(a.id)?.victories_4v4 || 0) || a.display_name.localeCompare(b.display_name, 'es'));
    const mvp = ordered[0];
    if ($('admin-members')) $('admin-members').textContent = profiles.length;
    if ($('admin-wins')) $('admin-wins').textContent = approved.filter(row => row.mode === '4v4').length;
    if ($('admin-mvp')) $('admin-mvp').innerHTML = mvp ? avatarHtml(mvp, 'hub-mvp-avatar') : '<span class="hub-mvp-avatar hub-avatar-empty">★</span>';
    if ($('admin-mvp-name')) $('admin-mvp-name').textContent = mvp?.display_name || 'Aún sin MVP';
    if ($('admin-mvp-detail')) $('admin-mvp-detail').textContent = mvp ? `${byId.get(mvp.id)?.victories_4v4 || 0} victorias 4v4` : 'Registra la primera victoria';
    if ($('admin-ranking')) $('admin-ranking').innerHTML = ordered.map((member, index) => { const stats = byId.get(member.id) || {}; return `<button type="button" class="hub-rank" onclick="window.luxHub.openPlayer('${esc(member.id)}')"><i>#${index + 1}</i>${avatarHtml(member, 'hub-rank-avatar')}<span><strong>${esc(member.display_name)}</strong><small>${stats.victories_4v4 || 0} victorias 4v4 · ${stats.victories_total || 0} total</small></span><b>VER</b></button>`; }).join('') || '<p class="hub-empty">Aún no hay integrantes registrados.</p>';
    renderReviewQueue((victories || []).filter(row => row.status === 'pending'));
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
    target.innerHTML = cards.length ? cards.map(row => { const player = state.directory.get(row.player_id); return `<article class="lux-review-row"><img src="${esc(row.image)}" alt="Captura pendiente"/><div><strong>${esc(player?.display_name || 'Jugador')}</strong><small>${esc(row.mode)} · ${new Date(row.created_at).toLocaleDateString('es-ES')}</small></div><span><button type="button" onclick="window.luxSupabase.reviewVictory('${esc(row.id)}','approved')">APROBAR</button><button type="button" onclick="window.luxSupabase.reviewVictory('${esc(row.id)}','rejected')">RECHAZAR</button></span></article>`; }).join('') : '<p class="hub-empty">No hay victorias pendientes.</p>';
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
    const accepted = victories.filter(row => row.status === 'approved');
    const avatar = member.avatar_path ? publicUrl('lux-avatars', member.avatar_path) : '';
    $('hub-modal-body').innerHTML = `<button class="hub-close" type="button" onclick="window.luxHub.closePlayer()">×</button><header>${avatarHtml(member, 'hub-modal-avatar')}<div><span>FICHA DE INTEGRANTE</span><h2>${esc(member.display_name)}</h2><p>${esc(member.country_name || member.country_code || 'Sin país')} · ${member.age || '—'} años</p>${avatar ? `<button type="button" class="lux-download-avatar" onclick="window.luxSupabase.downloadAvatar('${esc(avatar)}','${esc(member.display_name)}')">DESCARGAR FOTO</button>` : ''}</div></header><section class="hub-modal-stats"><div><b>${accepted.filter(row => row.mode === '4v4').length}</b><small>VICTORIAS 4V4</small></div><div><b>${accepted.length}</b><small>VICTORIAS APROBADAS</small></div><div><b>${victories.filter(row => row.status === 'pending').length}</b><small>PENDIENTES</small></div></section><h3>HISTORIAL PRIVADO DE VICTORIAS</h3><section class="hub-modal-gallery">${signed.length ? signed.map(row => `<figure><img src="${esc(row.image)}" alt="Captura"/><figcaption>${esc(row.mode)} · ${esc(row.status)}<br/>${new Date(row.created_at).toLocaleDateString('es-ES')}${row.status === 'pending' ? `<span><button type="button" onclick="window.luxSupabase.reviewVictory('${esc(row.id)}','approved')">APROBAR</button><button type="button" onclick="window.luxSupabase.reviewVictory('${esc(row.id)}','rejected')">RECHAZAR</button></span>` : ''}</figcaption></figure>`).join('') : '<p class="hub-empty">Aún no hay capturas.</p>'}</section>`;
    $('hub-modal').hidden = false;
    document.body.classList.add('hub-no-scroll');
  }
  function closePlayer() { $('hub-modal').hidden = true; document.body.classList.remove('hub-no-scroll'); }
  function downloadAvatar(url, name) {
    const link = document.createElement('a'); link.href = url; link.download = `${name || 'integrante'}-LUX-CLAN`; link.target = '_blank'; link.rel = 'noopener'; link.click();
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
    target.innerHTML = rows.length ? rows.map((row, index) => `<article class="lux-plate-row"><i>#${index + 1}</i><span class="lux-plate-avatar lux-plate-initial">${initial(row.display_name)}</span><div><strong>${esc(row.display_name)}</strong><small>${row.plate_count} placas</small></div><button type="button" onclick="window.luxPlates.openGallery('${esc(row.player_id)}')">VER</button></article>`).join('') : '<p class="hub-empty">Aún no hay placas registradas.</p>';
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

  function closeLogin() { if ($('lux-login-modal')) $('lux-login-modal').hidden = true; }
  function openLogin(kind = 'member') {
    const modal = $('lux-login-modal'); if (!modal) return;
    modal.innerHTML = `<div class="lux-login-box"><button class="lux-login-close" type="button" onclick="window.luxAccess.closeLogin()">×</button><span class="hub-kicker">${kind === 'leader' ? 'ACCESO DEL EQUIPO' : 'CUENTA DEL CLAN'}</span><h2>Entrar de forma segura</h2><p>Tu sesión queda guardada en este teléfono. Los permisos se validan en el servidor.</p><label>CORREO<input id="lux-auth-email" type="email" autocomplete="email" placeholder="tu@correo.com"/></label><label>CONTRASEÑA<input id="lux-auth-password" type="password" minlength="8" autocomplete="current-password" placeholder="Mínimo 8 caracteres"/></label><div id="lux-auth-name-wrap" hidden><label>NOMBRE DEL CLAN<input id="lux-auth-name" maxlength="24" autocomplete="nickname" placeholder="Tu nombre de jugador"/></label></div><button id="lux-auth-submit" class="lux-login-primary" type="button" onclick="window.luxSupabase.authSubmit()">ENTRAR</button><button class="lux-auth-switch" type="button" onclick="window.luxSupabase.toggleSignup()">CREAR CUENTA</button><button class="lux-auth-resend" type="button" onclick="window.luxSupabase.resendConfirmation()">REENVIAR CONFIRMACIÓN</button><small id="lux-auth-help">No se usa ninguna clave compartida de líder.</small></div>`;
    modal.hidden = false; setTimeout(() => $('lux-auth-email')?.focus(), 20);
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
      // La API REST de Auth devuelve los datos de sesión directamente al
      // iniciar sesión, mientras que algunas respuestas de registro los
      // agrupan dentro de `session`. Aceptamos ambos formatos.
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
      await hydrateAccount(); closeLogin();
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
    writeSession(null); state.user = null; state.profile = null; state.role = 'member'; state.isStaff = false; state.isLeader = false; renderAccountState(); window.luxHub.setScreen('home'); toast('SESIÓN CERRADA');
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
    style.textContent = `.lux-auth-switch,.lux-auth-resend{width:100%;margin-top:9px;border:1px solid #ffffff2b;border-radius:9px;background:#ffffff08;color:#ddd;padding:9px;font:1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px;cursor:pointer}.lux-auth-resend{color:#ffb29f;border-color:#ff674855;background:#ff22000d}.lux-review-queue{margin-top:15px}.lux-review-queue>p{margin:0 0 12px;color:#aaa4aa;font-size:.78rem}.lux-review-row{display:grid;grid-template-columns:82px 1fr auto;gap:10px;align-items:center;margin-top:8px;padding:8px;border:1px solid #ffffff18;border-radius:10px;background:#09090d}.lux-review-row img{width:82px;height:58px;border-radius:6px;object-fit:cover}.lux-review-row div{display:grid;gap:4px}.lux-review-row strong{font:1.15rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.8px}.lux-review-row small{color:#aaa;font-size:.65rem}.lux-review-row span{display:flex;gap:5px}.lux-review-row button,.hub-modal-gallery button,.lux-download-avatar{border:1px solid #ff664d77;border-radius:6px;background:#ff220018;color:#ffab9b;padding:6px 7px;font:.78rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.5px;cursor:pointer}.lux-review-row button:first-child,.hub-modal-gallery button:first-child{border:0;background:#bd2f18;color:#fff}.lux-download-avatar{margin-top:8px}.hub-evidence small{display:block;padding:0 7px 7px;color:#ffab9b;font-size:.62rem}@media(max-width:620px){.lux-review-row{grid-template-columns:65px 1fr}.lux-review-row img{width:65px;height:51px}.lux-review-row span{grid-column:2;justify-content:flex-start}.lux-review-row button{flex:1}}`;
    document.head.appendChild(style);
  }
  function install() {
    installStyles();
    const oldSetScreen = window.luxHub.setScreen;
    window.luxHub = { ...window.luxHub, saveProfile, loadMine, pickAvatar, registerVictory, renderAdmin, openPlayer, closePlayer, openEditor, backFromEditor, backup,
      askAdmin:openLeader, confirmAdmin:openLeader, closeAdminKey:() => {}, setRole:() => toast('ℹ️ LOS PERMISOS SE GESTIONAN EN EL SERVIDOR'), removePlayer:() => toast('ℹ️ LOS PERFILES NO SE ELIMINAN DESDE EL NAVEGADOR') };
    window.luxAccess = { ...window.luxAccess, openPublic:() => { oldSetScreen('public'); renderPublic(); }, openLogin, closeLogin, loginMember:openMember, loginLeader:openLeader, renderPublic, renderMemberTop:() => renderPublic() };
    window.luxPlates = { ...window.luxPlates, show:showPlates, add:addPlate, openGallery:openPlateGallery, closeGallery:closePlateGallery, remove:removePlate, renderSelector:renderPlatesSelector, renderRanking:renderPlatesRanking, renderPublic:renderPublic };
    document.querySelector('.hub-choice.player')?.setAttribute('onclick', 'window.luxAccess.loginMember()');
    document.querySelector('.hub-choice.leader')?.setAttribute('onclick', 'window.luxAccess.loginLeader()');
    document.querySelectorAll('.hub-profile-title .hub-kicker').forEach(node => { node.textContent = 'PERFIL SEGURO'; });
    document.querySelectorAll('.hub-local').forEach(node => { node.textContent = '● DATOS PROTEGIDOS · crea una cuenta para participar'; });
    window.luxSupabase = { authSubmit, resendConfirmation, toggleSignup, logout, reviewVictory, downloadAvatar, openMember, openLeader, renderPublic, renderAdmin };
    hydrateAccount().then(async user => { await renderPublic(); if (user) { if (state.isStaff) await renderAdmin(); else await renderMember(); } }).catch(() => renderPublic());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
