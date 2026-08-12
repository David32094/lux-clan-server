/*
  PROTOTIPO LOCAL · Roles de FLUXO
  Los perfiles se guardan solamente en este dispositivo/navegador para probar
  la experiencia antes de añadir usuarios reales y sincronización en línea.
*/
(() => {
  'use strict';

  const MEMBERS_KEY = 'lux_clan_demo_members_v1';
  const MODE_KEY = 'lux_clan_demo_mode_v1';
  // El modo de líder de producción se controla por roles del servidor.
  const LEADER_CODE = null;
  let mode = 'member';

  const roleMeta = {
    'Líder': { className: 'leader', icon: '👑' },
    'Sub-líder': { className: 'subleader', icon: '⚡' },
    'Reclutador': { className: 'recruiter', icon: '📣' },
    'Competitivo': { className: 'competitive', icon: '🎯' },
    'Creador': { className: 'creator', icon: '🎨' },
    'Integrante': { className: 'member', icon: '🛡️' }
  };

  const $ = id => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function getMembers() {
    try {
      const members = JSON.parse(localStorage.getItem(MEMBERS_KEY) || '[]');
      return Array.isArray(members) ? members : [];
    } catch (_) {
      return [];
    }
  }

  function setMembers(members) {
    localStorage.setItem(MEMBERS_KEY, JSON.stringify(members));
  }

  function selectedCountry() {
    const select = $('t-pais-integ');
    const option = select?.options[select.selectedIndex];
    return {
      code: select?.value || '',
      name: option?.dataset?.name || option?.textContent?.trim() || 'SIN PAÍS'
    };
  }

  function makeBannerThumbnail() {
    const source = $('c-integ');
    if (!source) return '';
    const thumb = document.createElement('canvas');
    thumb.width = 170;
    thumb.height = 302;
    const context = thumb.getContext('2d');
    context.drawImage(source, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL('image/jpeg', 0.8);
  }

  function currentProfile() {
    const name = $('t-nombre-integ')?.value.trim() || '';
    const country = selectedCountry();
    return {
      id: name ? name.toLocaleLowerCase('es').replace(/\s+/g, '-').replace(/[^a-z0-9áéíóúñ-]/gi, '') : '',
      name,
      age: $('t-edad-integ')?.value.trim() || '—',
      country,
      role: $('member-role-integ')?.value || 'Integrante',
      thumbnail: makeBannerThumbnail(),
      updatedAt: new Date().toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }),
      status: 'Activo'
    };
  }

  function saveCurrentProfile({ quiet = false } = {}) {
    const profile = currentProfile();
    if (!profile.name) {
      $('t-nombre-integ')?.focus();
      window.showToast?.('⚠️ ESCRIBE TU NOMBRE PARA GUARDAR EL PERFIL');
      return false;
    }

    const members = getMembers();
    const previous = members.find(member => member.id === profile.id);
    if (previous) {
      profile.status = previous.status || profile.status;
      profile.avatar = previous.avatar || '';
      profile.victories = previous.victories || [];
      profile.wins = previous.wins || { total: 0, fourVFour: 0 };
      profile.createdAt = previous.createdAt || profile.updatedAt;
    }
    const index = members.findIndex(member => member.id === profile.id);
    if (index >= 0) members[index] = profile;
    else members.unshift(profile);
    setMembers(members);
    renderLeaderPanel();
    if (!quiet) window.showToast?.(`✅ PERFIL DE ${profile.name.toUpperCase()} GUARDADO`);
    return true;
  }

  function generateMyBanner() {
    if (!saveCurrentProfile({ quiet: true })) return;
    window.doDownloadInteg?.();
    window.showToast?.('✅ BANNER GENERADO Y PERFIL ACTUALIZADO');
  }

  function loadMember(memberId) {
    const member = getMembers().find(item => item.id === memberId);
    if (!member) return;

    $('t-nombre-integ').value = member.name || '';
    $('t-edad-integ').value = member.age === '—' ? '' : member.age || '';
    $('t-pais-integ').value = member.country?.code || '';
    $('member-role-integ').value = member.role || 'Integrante';
    updateRoleDisplay();
    window.onFlagInteg?.();
    window.renderInteg?.();
    setMode('member');
    window.showToast?.(`✏️ EDITANDO PERFIL DE ${member.name.toUpperCase()}`);
  }

  function deleteMember(memberId) {
    const member = getMembers().find(item => item.id === memberId);
    if (!member || !window.confirm(`¿Eliminar a ${member.name} de la galería local?`)) return;
    setMembers(getMembers().filter(item => item.id !== memberId));
    renderLeaderPanel();
    window.showToast?.('🗑 PERFIL ELIMINADO DE LA GALERÍA');
  }

  function updateRoleDisplay() {
    const role = $('member-role-integ')?.value || 'Integrante';
    const display = $('member-role-display');
    if (display) display.value = role;
  }

  function setMemberRole(memberId, role) {
    if (!roleMeta[role]) return;
    const members = getMembers();
    const member = members.find(item => item.id === memberId);
    if (!member) return;
    member.role = role;
    member.updatedAt = new Date().toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
    setMembers(members);
    if (($('t-nombre-integ')?.value || '').toLocaleLowerCase('es').replace(/\s+/g, '-') === memberId) {
      $('member-role-integ').value = role;
      updateRoleDisplay();
    }
    renderLeaderPanel();
    window.showToast?.(`👑 ROL DE ${member.name.toUpperCase()} ACTUALIZADO`);
  }

  function exportMembers() {
    const members = getMembers();
    const file = new Blob([JSON.stringify(members, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'LUX_CLAN_MIEMBROS.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    window.showToast?.('📤 COPIA DE SEGURIDAD DESCARGADA');
  }

  function importMembers(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error('Formato incorrecto');
        const current = getMembers();
        imported.forEach(member => {
          if (!member?.id || !member?.name) return;
          const index = current.findIndex(item => item.id === member.id);
          if (index >= 0) current[index] = member;
          else current.push(member);
        });
        setMembers(current);
        renderLeaderPanel();
        window.showToast?.('✅ GALERÍA DE MIEMBROS IMPORTADA');
      } catch (_) {
        window.showToast?.('⚠️ EL ARCHIVO NO ES UNA COPIA VÁLIDA');
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  }

  function memberCard(member) {
    const meta = roleMeta[member.role] || roleMeta.Integrante;
    const thumbnail = member.thumbnail
      ? `<img class="lux-member-thumb" src="${member.thumbnail}" alt="Banner de ${escapeHtml(member.name)}"/>`
      : `<div class="lux-member-empty">${meta.icon}</div>`;
    return `<article class="lux-member-card">
      <div class="lux-member-art">${thumbnail}</div>
      <div class="lux-member-data">
        <div class="lux-member-name">${escapeHtml(member.name)}</div>
        <span class="lux-role-badge ${meta.className}">${meta.icon} ${escapeHtml(member.role)}</span>
        <div class="lux-member-meta">${escapeHtml(member.country?.name || 'SIN PAÍS')} · ${escapeHtml(member.age || '—')} años</div>
        <label class="lux-role-control">Cambiar rol <select onchange="window.luxLeaderDemo.setMemberRole('${escapeHtml(member.id)}', this.value)">${Object.keys(roleMeta).map(role => `<option${role === member.role ? ' selected' : ''}>${escapeHtml(role)}</option>`).join('')}</select></label>
        <div class="lux-member-date">Actualizado: ${escapeHtml(member.updatedAt || '—')}</div>
        <div class="lux-member-actions">
          <button type="button" onclick="window.luxLeaderDemo.loadMember('${escapeHtml(member.id)}')">EDITAR</button>
          <button type="button" class="danger" onclick="window.luxLeaderDemo.deleteMember('${escapeHtml(member.id)}')">QUITAR</button>
        </div>
      </div>
    </article>`;
  }

  function renderLeaderPanel() {
    const list = $('leader-members-grid');
    const count = $('leader-member-count');
    if (!list || !count) return;
    const query = ($('leader-member-search')?.value || '').trim().toLocaleLowerCase('es');
    const members = getMembers()
      .sort((first, second) => first.name.localeCompare(second.name, 'es'))
      .filter(member => !query || `${member.name} ${member.role} ${member.country?.name || ''}`.toLocaleLowerCase('es').includes(query));
    count.textContent = `${getMembers().length} MIEMBRO${getMembers().length === 1 ? '' : 'S'} GUARDADO${getMembers().length === 1 ? '' : 'S'}`;
    list.innerHTML = members.length
      ? members.map(memberCard).join('')
      : `<div class="lux-empty-state"><strong>Aún no hay perfiles.</strong><span>Prueba el modo integrante: completa tus datos y pulsa “Generar mi banner”.</span></div>`;
  }

  function requestLeaderMode() {
    const code = window.prompt('Clave local de líder (prototipo):');
    if (code === null) return;
    if (code !== LEADER_CODE) {
      window.showToast?.('⛔ CLAVE DE LÍDER INCORRECTA');
      return;
    }
    setMode('leader');
  }

  function setMode(nextMode) {
    mode = nextMode === 'leader' ? 'leader' : 'member';
    document.documentElement.classList.toggle('lux-mode-member', mode === 'member');
    document.documentElement.classList.toggle('lux-mode-leader', mode === 'leader');
    $('leader-panel').hidden = mode !== 'leader';
    $('lux-member-mode-btn').classList.toggle('active', mode === 'member');
    $('lux-leader-mode-btn').classList.toggle('active', mode === 'leader');
    $('lux-mode-label').textContent = mode === 'leader' ? 'PANEL DE LÍDER' : 'MODO INTEGRANTE';
    if (mode === 'member') window.switchTab?.('integrantes');
    try { localStorage.setItem(MODE_KEY, mode); } catch (_) {}
    renderLeaderPanel();
  }

  function injectUi() {
    const header = document.querySelector('header');
    const countryCard = $('t-pais-integ')?.closest('.card');
    if (!header || !countryCard || $('lux-rolebar')) return false;

    header.insertAdjacentHTML('afterend', `
      <section class="lux-rolebar" id="lux-rolebar" aria-label="Modo de acceso">
        <div class="lux-rolebar-inner">
          <div class="lux-mode-copy"><span class="lux-mode-dot"></span><span id="lux-mode-label">MODO INTEGRANTE</span><small>Prueba local</small></div>
          <div class="lux-role-actions">
            <button type="button" id="lux-member-mode-btn" onclick="window.luxLeaderDemo.setMode('member')">👤 MI PERFIL</button>
            <button type="button" id="lux-leader-mode-btn" onclick="window.luxLeaderDemo.requestLeaderMode()">👑 PANEL LÍDER</button>
          </div>
        </div>
      </section>
      <section class="lux-leader-panel" id="leader-panel" hidden>
        <div class="lux-leader-heading">
          <div><span class="lux-kicker">GESTIÓN LOCAL DEL CLAN</span><h2>MIEMBROS FLUXO</h2><p>Los banners generados aparecen como tarjeta. Todo queda guardado solo en este dispositivo durante la prueba.</p></div>
          <div class="lux-leader-tools"><span id="leader-member-count">0 MIEMBROS GUARDADOS</span><button type="button" onclick="window.luxLeaderDemo.exportMembers()">📤 RESPALDAR</button><button type="button" onclick="document.getElementById('leader-import-file').click()">📥 IMPORTAR</button><input id="leader-import-file" type="file" accept="application/json,.json" onchange="window.luxLeaderDemo.importMembers(event)" hidden></div>
        </div>
        <input id="leader-member-search" class="lux-member-search" type="search" placeholder="Buscar por nombre, rol o país" oninput="window.luxLeaderDemo.renderLeaderPanel()" autocomplete="off">
        <div class="lux-members-grid" id="leader-members-grid"></div>
      </section>`);

    countryCard.insertAdjacentHTML('afterend', `
      <div class="card member-profile-card" id="member-profile-card">
        <div class="card-title"><span class="dot"></span>MI PERFIL DE CLAN</div>
        <label class="lux-field-label" for="member-role-display">ROL ASIGNADO POR LA LÍDER</label>
        <input class="inp lux-role-readonly" id="member-role-display" value="Integrante" readonly aria-readonly="true"/>
        <input id="member-role-integ" type="hidden" value="Integrante"/>
        <p class="lux-member-note">Puedes cambiar foto, nombre, edad y país. La líder administra los roles y el diseño oficial queda protegido.</p>
        <div class="lux-profile-actions">
          <button type="button" class="lux-secondary-action" onclick="window.luxLeaderDemo.saveCurrentProfile()">💾 GUARDAR PERFIL</button>
          <button type="button" class="lux-primary-action" onclick="window.luxLeaderDemo.generateMyBanner()">⬇️ GENERAR MI BANNER</button>
        </div>
      </div>`);
    return true;
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .lux-rolebar{background:rgba(8,8,13,.98);border-bottom:1px solid #ff220044;position:sticky;top:64px;z-index:900;padding:8px 18px;backdrop-filter:blur(12px)}
      .lux-rolebar-inner{max-width:1500px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:12px}.lux-mode-copy{display:flex;align-items:center;gap:8px;color:#fff;font-family:'Bebas Neue',Impact,sans-serif;letter-spacing:2px;font-size:1.05rem}.lux-mode-copy small{color:rgba(255,255,255,.5);font:600 .67rem/1 'Segoe UI',sans-serif;letter-spacing:.4px}.lux-mode-dot{height:8px;width:8px;border-radius:50%;background:#ff2200;box-shadow:0 0 9px #ff2200}.lux-role-actions{display:flex;gap:7px}.lux-role-actions button,.lux-leader-tools button{font:1rem/1 'Bebas Neue',Impact,sans-serif;letter-spacing:1.4px;color:#ddd;background:#ffffff0d;border:1px solid #ffffff22;border-radius:9px;padding:7px 11px;cursor:pointer;transition:.18s}.lux-role-actions button.active,.lux-role-actions button:hover,.lux-leader-tools button:hover{color:#ff2200;border-color:#ff2200;background:#ff220020;box-shadow:0 0 12px #ff220044}
      .lux-leader-panel{width:min(1480px,calc(100% - 36px));margin:16px auto 4px;padding:18px;border:1px solid #ff220055;border-radius:16px;background:linear-gradient(135deg,rgba(28,11,11,.96),rgba(13,13,20,.97));box-shadow:0 12px 38px rgba(0,0,0,.32)}.lux-leader-heading{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.lux-kicker{color:#ff2200;font:700 .68rem/1 'Segoe UI',sans-serif;letter-spacing:2px}.lux-leader-heading h2{font:2rem/1 'Bebas Neue',Impact,sans-serif;color:#fff;letter-spacing:3px;margin:4px 0}.lux-leader-heading p{max-width:680px;color:#a6a6b2;font-size:.85rem;line-height:1.45}.lux-leader-tools{display:flex;gap:7px;align-items:center;justify-content:flex-end;flex-wrap:wrap}.lux-leader-tools span{font:1rem/1 'Bebas Neue',Impact,sans-serif;color:#ffb09f;letter-spacing:1.4px;margin-right:4px}.lux-member-search{width:100%;margin:16px 0 12px;background:#0009;color:#fff;border:1px solid #ff220044;border-radius:10px;padding:11px 13px;font:16px 'Segoe UI',sans-serif;outline:none}.lux-member-search:focus{border-color:#ff2200;box-shadow:0 0 14px #ff220033}.lux-members-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:11px}.lux-member-card{display:flex;min-height:156px;overflow:hidden;background:#0a0a0f;border:1px solid #ffffff16;border-radius:12px}.lux-member-art{width:96px;flex:0 0 96px;background:#050506;display:grid;place-items:center;border-right:1px solid #ffffff12}.lux-member-thumb{height:100%;width:100%;object-fit:cover;object-position:center}.lux-member-empty{font-size:2.2rem}.lux-member-data{padding:12px;min-width:0;display:flex;flex:1;flex-direction:column;align-items:flex-start}.lux-member-name{font:1.45rem/1 'Bebas Neue',Impact,sans-serif;letter-spacing:1.5px;color:#fff;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lux-role-badge{margin-top:7px;border-radius:999px;padding:4px 8px;font: .78rem/1 'Segoe UI',sans-serif;font-weight:800}.lux-role-badge.leader{background:#f5bf2450;color:#ffda66}.lux-role-badge.subleader{background:#8a61ff3d;color:#c5b4ff}.lux-role-badge.recruiter{background:#ff7b2f35;color:#ffaf7a}.lux-role-badge.competitive{background:#e34d6638;color:#ff95a5}.lux-role-badge.creator{background:#2cbbad38;color:#8ff5e8}.lux-role-badge.member{background:#ffffff16;color:#e8e8ec}.lux-member-meta{margin-top:9px;color:#d1d1db;font-size:.78rem}.lux-member-date{margin-top:4px;color:#777786;font-size:.68rem}.lux-member-actions{display:flex;gap:6px;margin-top:auto;padding-top:10px}.lux-member-actions button{font: .9rem/1 'Bebas Neue',Impact,sans-serif;letter-spacing:1px;border:1px solid #ff220066;background:#ff220020;color:#ff794f;border-radius:6px;padding:6px 9px;cursor:pointer}.lux-member-actions button.danger{color:#ff7777;border-color:#ff777744;background:#ff000010}.lux-empty-state{grid-column:1/-1;display:flex;flex-direction:column;gap:5px;text-align:center;padding:26px;border:1px dashed #ff220055;border-radius:12px;color:#aaa}.lux-empty-state strong{color:#fff;font:1.35rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px}
      .lux-field-label{display:block;margin-bottom:6px;color:#ff8d70;font:1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.5px}.lux-role-readonly{color:#ffcfbf!important;background:#ff22000e!important;cursor:default}.lux-role-control{margin-top:8px;color:#aaa;font-size:.67rem;display:flex;gap:5px;align-items:center}.lux-role-control select{min-width:105px;padding:4px;background:#111119;color:#fff;border:1px solid #ffffff28;border-radius:5px;font-size:.7rem}.lux-member-note{margin:8px 0 12px;color:#9a9aa5;font-size:.77rem;line-height:1.4}.lux-profile-actions{display:grid;grid-template-columns:1fr;gap:7px}.lux-primary-action,.lux-secondary-action{border-radius:10px;min-height:44px;padding:9px 12px;font:1.05rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.7px;cursor:pointer}.lux-primary-action{color:#fff;border:0;background:linear-gradient(135deg,#ff2200,#a90000);box-shadow:0 0 16px #ff220044}.lux-secondary-action{color:#ff8b6b;border:1px solid #ff220077;background:#ff220016}.lux-mode-member #tab-btn-enfrent,.lux-mode-member #tab-enfrentamientos,.lux-mode-member #tab-integrantes .sidebar-right,.lux-mode-member #tab-integrantes .toolbar,.lux-mode-member #tab-integrantes .text-style-toggle,.lux-mode-member #tab-integrantes .photo-hint{display:none!important}.lux-mode-member #tab-integrantes .workspace{grid-template-columns:minmax(300px,420px) 1fr}.lux-mode-member #c-integ{pointer-events:none}.lux-mode-leader .member-profile-card{display:none!important}
      @media(max-width:900px){.lux-rolebar{top:60px;padding:7px 9px}.lux-rolebar-inner{align-items:flex-start;gap:8px}.lux-mode-copy{font-size:.88rem;letter-spacing:1px}.lux-mode-copy small{display:none}.lux-role-actions button{font-size:.85rem;padding:7px 8px}.lux-leader-panel{width:calc(100% - 16px);margin:9px auto;padding:13px}.lux-leader-heading{flex-direction:column;gap:10px}.lux-leader-heading h2{font-size:1.55rem}.lux-leader-tools{justify-content:flex-start}.lux-members-grid{grid-template-columns:1fr}.lux-member-card{min-height:142px}.lux-mode-member #tab-integrantes .workspace{display:flex!important}.lux-mode-member #tab-integrantes .sidebar-left{display:flex!important}.lux-mode-member .canvas-wrap{order:1!important}.lux-mode-member .sidebar-left{order:2!important}.lux-mode-member #c-integ{max-height:48vh!important}}
    `;
    document.head.appendChild(style);
  }

  function boot() {
    if (!injectUi()) return;
    injectStyles();
    window.luxLeaderDemo = { setMode, requestLeaderMode, saveCurrentProfile, generateMyBanner, loadMember, deleteMember, setMemberRole, exportMembers, importMembers, renderLeaderPanel };
    let stored = 'member';
    try { stored = localStorage.getItem(MODE_KEY) || 'member'; } catch (_) {}
    setMode(stored === 'leader' ? 'leader' : 'member');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
