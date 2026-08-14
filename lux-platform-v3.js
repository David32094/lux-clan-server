/* FLUXO PLATFORM V3
 * Capa modular para admisiones, partidos, temporadas, convocatorias,
 * comunicaciones, operaciones y respaldo. Todas las decisiones sensibles
 * terminan en RPC protegidas por RLS; el navegador nunca posee service_role. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const nowLocalInput = () => {
    const date = new Date(), offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
  };
  const fmtDate = value => value ? new Date(value).toLocaleString('es-ES', { dateStyle:'short', timeStyle:'short' }) : '—';
  const activeStatuses = new Set(['active','trial','reserve']);
  const gameRoles = ['','IGL','Rusher','Soporte','Francotirador','Flexible','Suplente'];
  const roleOptions = selected => gameRoles.map(role => `<option value="${esc(role)}"${role === (selected || '') ? ' selected' : ''}>${role || 'SIN DEFINIR'}</option>`).join('');
  const state = {
    core:null, selectedPlayers:new Set(), notificationTimer:null, currentSharePlayer:null, backupBusy:false,
    matchAliases:[], matchDetected:new Map(), matchUnmatched:[], matchOcrResult:null, matchPreviewUrl:'', matchOcrFileKey:'', matchOcrPromise:null,
    pendingMatches:new Map(), selectedMatches:new Set()
  };

  function core() { return state.core || window.luxSupabase?._core; }
  function appState() { return core()?.state || {}; }
  function toast(message) { core()?.toast?.(message); }
  function errorText(error, fallback='No se pudo completar la operación') { return core()?.errorMessage?.(error, fallback) || error?.message || fallback; }
  function profileId(row) { return row?.player_id || row?.id || ''; }
  function profileName(row) { return row?.display_name || row?.name || 'Integrante'; }
  function avatar(row, className='lux-v3-row-avatar') {
    const url = row?.avatar_path ? core().publicUrl('lux-avatars', row.avatar_path) : '';
    return url ? `<img class="${className}" src="${esc(url)}" alt="${esc(profileName(row))}" loading="lazy"/>` : `<span class="${className}">${esc(profileName(row).slice(0,1).toUpperCase())}</span>`;
  }
  function statusLabel(status) {
    return ({pending:'Pendiente',active:'Activo',trial:'En prueba',reserve:'Reserva',inactive:'Inactivo',expelled:'Expulsado',alumni:'Exintegrante',approved:'Aprobado',rejected:'Rechazado',available:'Disponible',maybe:'Tal vez',unavailable:'No disponible',win:'Victoria',loss:'Derrota',draw:'Empate'})[status] || status || 'Sin estado';
  }
  function statusBadge(status) { return `<span class="lux-v3-status ${esc(status)}">${esc(statusLabel(status))}</span>`; }

  function ensureProfileFields() {
    const form = document.querySelector('#hub-member .hub-profile .hub-form');
    if (!form || $('lux-primary-role')) return;
    form.insertAdjacentHTML('beforeend', `<label class="wide">ROL PRINCIPAL EN PARTIDA<select id="lux-primary-role">${roleOptions('')}</select></label>
      <label class="wide">ROL SECUNDARIO<select id="lux-secondary-role">${roleOptions('')}</select></label>
      <label class="wide">EXPERIENCIA<select id="lux-experience-level"><option value="">SIN DEFINIR</option><option>Nuevo</option><option>Intermedio</option><option>Competitivo</option><option>Veterano</option></select></label>`);
    ['lux-primary-role','lux-secondary-role','lux-experience-level'].forEach(id => {
      $(id)?.addEventListener('change', () => { appState().profileDraftDirty = true; });
    });
  }

  function syncProfileFields() {
    ensureProfileFields();
    if (appState().profileDraftDirty) return;
    const profile = appState().profile || {};
    if ($('lux-primary-role')) $('lux-primary-role').value = profile.primary_game_role || '';
    if ($('lux-secondary-role')) $('lux-secondary-role').value = profile.secondary_game_role || '';
    if ($('lux-experience-level')) $('lux-experience-level').value = profile.experience_level || '';
  }

  function ensurePanels() {
    ensureProfileFields();
    const memberPage = document.querySelector('#hub-member .hub-page');
    if (memberPage && !$('lux-v3-member-gate')) {
      memberPage.insertAdjacentHTML('beforeend', `<div id="lux-v3-member-gate" class="lux-v3-gate" hidden></div>
        <section id="lux-v3-member-matches" class="lux-v3-panel" hidden></section>
        <section id="lux-v3-member-events" class="lux-v3-panel" hidden></section>
        <section id="lux-v3-member-announcements" class="lux-v3-panel" hidden></section>`);
    }
    const adminPage = document.querySelector('#hub-admin .hub-page');
    if (adminPage && !$('lux-v3-admin-requests')) {
      adminPage.insertAdjacentHTML('beforeend', `<section id="lux-v3-admin-requests" class="lux-v3-panel" hidden></section>
        <section id="lux-v3-admin-matches" class="lux-v3-panel" hidden></section>
        <section id="lux-v3-admin-events" class="lux-v3-panel" hidden></section>
        <section id="lux-v3-admin-announcements" class="lux-v3-panel" hidden></section>
        <section id="lux-v3-admin-operations" class="lux-v3-panel" hidden></section>`);
    }
  }

  function showOnlyMember(panel, section) {
    ensurePanels();
    const page = document.querySelector('#hub-member .hub-page');
    if (!page || !panel) return;
    if (!panel.childElementCount) panel.innerHTML = '<div class="lux-v3-loading" aria-live="polite"><i></i><span>Preparando esta sección…</span></div>';
    if (!core().showPageChildren?.(page,panel,['lux-member-tabs'])) {
      [...page.children].forEach(child => { child.hidden = child.id !== 'lux-member-tabs' && child !== panel; });
      panel.hidden = false;
    }
    $('lux-member-tabs')?.querySelectorAll('[data-member-section]').forEach(button => button.classList.toggle('active', button.dataset.memberSection === section));
    core().revealActiveTab?.($('lux-member-tabs'));
    core().scrollTopNow?.();
  }

  function showOnlyAdmin(panel, section) {
    ensurePanels();
    const page = document.querySelector('#hub-admin .hub-page');
    if (!page || !panel) return;
    if (!panel.childElementCount) panel.innerHTML = '<div class="lux-v3-loading" aria-live="polite"><i></i><span>Preparando esta sección…</span></div>';
    if (!core().showPageChildren?.(page,panel,['lux-admin-tabs'])) {
      [...page.children].forEach(child => { child.hidden = child.id !== 'lux-admin-tabs' && child !== panel; });
      panel.hidden = false;
    }
    core().setAdminSection(section);
    core().scrollTopNow?.();
  }

  function setMemberTabsLocked(locked) {
    $('lux-member-tabs')?.querySelectorAll('button').forEach(button => {
      button.disabled = locked && button.dataset.memberSection !== 'profile';
      button.title = button.disabled ? 'Completa y activa tu perfil primero' : '';
    });
  }

  async function guardMember(requestedSection='home') {
    ensurePanels();
    syncProfileFields();
    const profile = appState().profile;
    if (!profile) return false;
    const existingCallout = $('lux-onboarding-callout');
    if (!profile.onboarding_complete) {
      setMemberTabsLocked(true);
      if (!existingCallout) {
        document.querySelector('#hub-member .hub-intro')?.insertAdjacentHTML('afterend', `<section id="lux-onboarding-callout" class="lux-onboarding-callout"><strong>PRIMER PASO: COMPLETA TU FICHA</strong><p>Nombre, edad y país son obligatorios. La foto es opcional. Al guardar, la líder recibirá tu solicitud.</p></section>`);
      }
      core().showMemberSection('profile');
      document.querySelector('#hub-member .hub-intro .hub-kicker')?.classList.add('lux-onboarding-required');
      return true;
    }
    existingCallout?.remove();
    const status = profile.membership_status || 'active';
    if (!activeStatuses.has(status)) {
      setMemberTabsLocked(true);
      const gate = $('lux-v3-member-gate');
      const pending = status === 'pending';
      gate.innerHTML = `<section><span class="lux-v3-gate-icon">${pending ? '⏳' : status === 'expelled' ? '⛔' : 'ℹ️'}</span>
        <span class="hub-kicker">ESTADO DE TU CUENTA</span><h2>${pending ? 'Tu solicitud está en revisión' : statusLabel(status)}</h2>
        <p>${pending ? 'Tus datos ya están guardados. Una líder debe aceptarte antes de que tu ficha aparezca públicamente y puedas registrar partidos.' : esc(profile.status_reason || 'Consulta con la administración del clan para conocer los detalles.')}</p>
        <ol><li><b>✓</b> Cuenta de Google conectada</li><li><b>✓</b> Perfil obligatorio completado</li><li><b>${pending ? '3' : '!'}</b> ${pending ? 'Esperando aprobación del clan' : `Estado actual: ${esc(statusLabel(status))}`}</li></ol>
        <div class="lux-v3-actions"><button type="button" onclick="window.luxSupabase.logout()">CERRAR SESIÓN</button>${pending ? '<button class="gold" type="button" onclick="window.luxPlatformV3.showProfileWhilePending()">CORREGIR MIS DATOS</button>' : ''}</div></section>`;
      if(pending&&gate.querySelector('p'))gate.querySelector('p').textContent=appState().accessMode==='invite_only'
        ? 'El clan esta restringido. Abre un link de invitacion enviado por el owner y vuelve a guardar tu perfil.'
        : appState().accessMode==='open'
          ? 'Tu perfil esta completo. Actualiza la pagina para activar el acceso general.'
          : 'Tus datos ya estan guardados. Una lider debe aceptar tu solicitud para activar tu cuenta.';
      showOnlyMember(gate, 'pending');
      return true;
    }
    setMemberTabsLocked(false);
    return false;
  }

  function showProfileWhilePending() {
    setMemberTabsLocked(false);
    core().showMemberSection('profile');
    setTimeout(() => setMemberTabsLocked(true), 0);
  }

  async function afterProfileSaved() {
    await core().loadProfile();
    syncProfileFields();
    const status = appState().profile?.membership_status || 'pending';
    if (!activeStatuses.has(status)) {
      toast('✅ DATOS GUARDADOS · TU SOLICITUD QUEDÓ PENDIENTE');
      await guardMember('pending');
    }
  }

  function currentRoster() {
    const rows = [...appState().publicDirectory.values()];
    const mine = appState().profile;
    if (mine && !rows.some(row => profileId(row) === mine.id)) rows.unshift({ ...mine, player_id:mine.id });
    return rows.sort((a,b) => profileName(a).localeCompare(profileName(b),'es'));
  }

  function memberOptions(selected='') {
    return `<option value="">NO ES DEL CLAN / IGNORAR</option>${currentRoster().map(row => {
      const id=profileId(row);return `<option value="${esc(id)}"${id===selected?' selected':''}>${esc(profileName(row))}</option>`;
    }).join('')}`;
  }

  function reviewMemberOptions(selected='') {
    return `<option value="">SELECCIONA UN INTEGRANTE</option><option value="__ignore__">NO ES DEL CLAN / IGNORAR</option>${currentRoster().map(row => {
      const id=profileId(row);return `<option value="${esc(id)}"${id===selected?' selected':''}>${esc(profileName(row))}</option>`;
    }).join('')}`;
  }

  function normalizedGameName(value='') {
    return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es').replace(/[^a-z0-9]/g,'');
  }

  function safeAutoValue(value,max=80) {
    return encodeURIComponent(String(value || '').replace(/[;|~]/g,' ').trim().slice(0,max));
  }

  function encodeMatchAutoDraft(result) {
    if (!result) return '';
    const unknown=(result.unmatched || []).slice(0,4).map(row => [
      safeAutoValue(row.gameName || 'Nombre no legible',60),Number(row.kills||0),Number(row.deaths||0),
      Number(row.assists||0),Number(row.damage||0),Number(row.confidence||0),row.confirmed?1:0
    ].join('~')).join('|');
    return `@AUTO1;map=${safeAutoValue(result.map,30)};type=${safeAutoValue(result.gameType,40)};tf=${safeAutoValue(result.teamFor,50)};ta=${safeAutoValue(result.teamAgainst,50)};conf=${Number(result.confidence||0)};u=${unknown}`.slice(0,600);
  }

  function decodeMatchAutoDraft(notes='') {
    const marker=String(notes || '').indexOf('@AUTO1;');
    if(marker<0)return {map:'',gameType:'',teamFor:'FLUXO',teamAgainst:'',confidence:0,unmatched:[]};
    const data={};String(notes).slice(marker+7).split(';').forEach(part=>{const at=part.indexOf('=');if(at>0)data[part.slice(0,at)]=part.slice(at+1);});
    const decode=value=>{try{return decodeURIComponent(value||'');}catch(_){return value||'';}};
    return {
      map:decode(data.map),gameType:decode(data.type),teamFor:decode(data.tf)||'FLUXO',teamAgainst:decode(data.ta),confidence:Number(data.conf||0),
      unmatched:String(data.u||'').split('|').filter(Boolean).map((part,index)=>{const [name,kills,deaths,assists,damage,confidence,confirmed]=part.split('~');return {
        id:`pending-${index}`,gameName:decode(name),kills:Number(kills||0),deaths:Number(deaths||0),assists:Number(assists||0),damage:Number(damage||0),confidence:Number(confidence||0),confirmed:confirmed==='1'
      };})
    };
  }

  function unresolvedMatchPlayers(match) {
    const knownNames=new Set((match.players||[]).map(row=>normalizedGameName(row.game_name)).filter(Boolean));
    return (match.autoDraft?.unmatched||[]).filter(row=>!knownNames.has(normalizedGameName(row.gameName)));
  }

  function setMatchOcrProgress(percent,message) {
    const progress=$('lux-match-ocr-progress');if(!progress)return;
    progress.hidden=false;progress.style.setProperty('--match-ocr-progress',`${Math.max(4,Math.min(100,Number(percent)||0))}%`);
    const label=progress.querySelector('span');if(label)label.textContent=message;
    document.dispatchEvent(new CustomEvent('fluxo:scan-progress',{detail:{percent:Number(percent)||0,message}}));
  }

  function previewMatchFile() {
    const file=$('lux-match-file')?.files?.[0],preview=$('lux-match-preview');
    if(state.matchPreviewUrl){URL.revokeObjectURL(state.matchPreviewUrl);state.matchPreviewUrl='';}
    state.matchOcrResult=null;state.matchDetected.clear();state.matchUnmatched=[];state.matchOcrFileKey='';state.matchOcrPromise=null;
    if(!file||!preview){if(preview)preview.hidden=true;return;}
    state.matchPreviewUrl=URL.createObjectURL(file);
    preview.innerHTML=`<img src="${esc(state.matchPreviewUrl)}" alt="Captura que se enviará como evidencia"/><div><strong>CAPTURA LISTA</strong><small>Ya puedes enviarla. La líder recibirá la imagen y un resumen preparado automáticamente.</small></div>`;
    preview.hidden=false;
    document.dispatchEvent(new CustomEvent('fluxo:scan-preview'));
    const progress=$('lux-match-ocr-progress');if(progress)progress.hidden=true;
  }

  function renderMatchOcrSummary() {
    const target=$('lux-match-ocr-summary');if(!target)return;
    const result=state.matchOcrResult;
    if(!result){target.innerHTML='<p class="lux-v3-empty compact">El análisis es opcional. Si no lo usas, solo envía la captura y el modo; la líder podrá corregir lo demás.</p>';return;}
    const matched=[...state.matchDetected.entries()].map(([id,row])=>{const member=currentRoster().find(item=>profileId(item)===id)||{display_name:'Integrante'};return `<article class="lux-ocr-person is-matched">${avatar(member)}<div><strong>${esc(profileName(member))}</strong><small>Leído como ${esc(row.detectedName||row.gameName||profileName(member))} · ${Number(row.confidence||0)}% confianza${row.confirmed?` · K/D/A: ${row.kills}/${row.deaths}/${row.assists} · DAÑO: ${row.damage}`:' · K/D/A y daño por revisar'}</small></div><b>✓</b></article>`;}).join('');
    const unmatched=state.matchUnmatched.map((row,index)=>`<article class="lux-ocr-person is-unmatched"><span class="lux-v3-row-avatar">?</span><div><strong>${esc(row.gameName||'Nombre no legible')}</strong><small>${row.confirmed?`K/D/A: ${row.kills}/${row.deaths}/${row.assists} · DAÑO: ${row.damage} · `:''}${Number(row.confidence||0)}% confianza</small><label>¿QUÉ INTEGRANTE ES?<select onchange="window.luxPlatformV3.assignMatchOcrPlayer(${index},this.value)">${memberOptions(row.suggestionId||'')}</select></label></div><button type="button" onclick="window.luxPlatformV3.ignoreMatchOcrPlayer(${index})">IGNORAR</button></article>`).join('');
    const facts=[['RESULTADO',statusLabel(result.result)],['MARCADOR',`${Number(result.scoreFor||0)} - ${Number(result.scoreAgainst||0)}`],['MODO',result.mode||'Por confirmar'],['MAPA',result.map||'No visible'],['TIPO',result.gameType||'Partida'],['LADO RIVAL',result.teamAgainst||'No legible']];
    target.innerHTML=`<div class="lux-ocr-result-head"><span class="lux-v3-status ${result.confidence>=65?'approved':'pending'}">OCR ${Number(result.confidence||0)}%</span><p>Comprueba los datos marcados. Nada se suma hasta que una líder apruebe la captura.</p></div><div class="lux-ocr-facts">${facts.map(([label,value])=>`<span><small>${esc(label)}</small><strong>${esc(value)}</strong></span>`).join('')}</div>${matched||'<p class="lux-v3-empty compact">No se reconoció automáticamente a otro integrante. Tu cuenta permanece seleccionada.</p>'}${unmatched?`<h4>NOMBRES POR CONFIRMAR</h4>${unmatched}`:''}`;
  }

  function assignMatchOcrPlayer(index,playerId) {
    const row=state.matchUnmatched[index];if(!row)return;
    row.suggestionId=playerId;
    if(playerId){
      if(state.selectedPlayers.size>=4&&!state.selectedPlayers.has(playerId)){toast('⚠️ EL PARTIDO SOLO PUEDE TENER 4 INTEGRANTES DEL CLAN');renderMatchOcrSummary();return;}
      state.matchDetected.set(playerId,{...row,playerId,detectedName:row.gameName,matchedBy:'manual'});state.selectedPlayers.add(playerId);state.matchUnmatched.splice(index,1);
    }
    renderMatchOcrSummary();renderParticipantInputs();
  }

  function ignoreMatchOcrPlayer(index){state.matchUnmatched.splice(index,1);renderMatchOcrSummary();}

  async function analyzeMatchCapture({silent=false}={}) {
    const file=$('lux-match-file')?.files?.[0],button=$('lux-analyze-match');
    if(!core().isImage(file,8*1024*1024)){toast('⚠️ USA JPG, PNG O WEBP DE HASTA 8 MB');return;}
    if(!window.luxMatchOCR?.analyze){if(!silent)toast('⚠️ EL LECTOR VISUAL NO ESTÁ DISPONIBLE');return;}
    const fileKey=`${file.name}:${file.size}:${file.lastModified}`;
    if(state.matchOcrFileKey===fileKey&&state.matchOcrResult)return state.matchOcrResult;
    if(state.matchOcrFileKey===fileKey&&state.matchOcrPromise)return state.matchOcrPromise;
    if(button){button.disabled=true;button.textContent='PREPARANDO RESUMEN…';}
    const run=(async()=>{try{
      if(!state.matchAliases.length)state.matchAliases=await core().rpc('get_active_game_aliases',{},false).catch(()=>[]);
      const result=await window.luxMatchOCR.analyze(file,{members:currentRoster(),aliases:state.matchAliases,currentPlayerId:appState().user?.id||'',mode:$('lux-match-mode')?.value,result:$('lux-match-result')?.value},setMatchOcrProgress);
      state.matchOcrResult=result;state.matchDetected.clear();state.matchUnmatched=result.unmatched||[];
      (result.matched||[]).forEach(row=>{if(state.selectedPlayers.size<4||state.selectedPlayers.has(row.playerId)){state.matchDetected.set(row.playerId,row);state.selectedPlayers.add(row.playerId);}});
      if($('lux-match-mode'))$('lux-match-mode').value=result.mode||$('lux-match-mode').value;
      if($('lux-match-result'))$('lux-match-result').value=result.result||$('lux-match-result').value;
      if($('lux-match-score-for'))$('lux-match-score-for').value=Number(result.scoreFor||0);
      if($('lux-match-score-against'))$('lux-match-score-against').value=Number(result.scoreAgainst||0);
      if($('lux-match-map'))$('lux-match-map').value=result.map||'';
      if($('lux-match-opponent'))$('lux-match-opponent').value=result.teamAgainst||'';
      return result;
    }catch(error){if(!silent)toast(`⚠️ ${errorText(error,'No se pudo preparar el resumen').toUpperCase()} · PUEDES ENVIARLA IGUAL`);return null;}
    finally{state.matchOcrPromise=null;if(button){button.disabled=false;button.textContent='PREPARAR RESUMEN';}}})();
    state.matchOcrFileKey=fileKey;state.matchOcrPromise=run;
    return run;
  }

  function renderParticipantInputs() {
    const target = $('lux-match-participant-stats');
    if (!target) return;
    const byId = new Map(currentRoster().map(row => [profileId(row),row]));
    target.innerHTML = [...state.selectedPlayers].map(id => {
      const row = byId.get(id) || { player_id:id, display_name:'Integrante' };
      const detected=state.matchDetected.get(id)||{};
      return `<article class="lux-match-participant${detected.confidence&&detected.confidence<70?' lux-confidence-low':''}" data-player-id="${esc(id)}" data-team-role="${esc(row.primary_game_role||'')}"><div class="lux-participant-name">${avatar(row)}<span><strong>${esc(profileName(row))}</strong><small>${detected.matchedBy?`Detectado · ${Number(detected.confidence||0)}%`:'Seleccionado manualmente'}</small></span></div>
        <label>NOMBRE EN FREE FIRE<input data-stat="game_name" maxlength="80" value="${esc(detected.detectedName||detected.gameName||profileName(row))}"/></label>
        <label>BAJAS <em>OPCIONAL</em><input data-stat="kills" type="number" inputmode="numeric" min="0" max="999" value="${Number(detected.kills||0)}"/></label>
        <label>MUERTES <em>OPCIONAL</em><input data-stat="deaths" type="number" inputmode="numeric" min="0" max="999" value="${Number(detected.deaths||0)}"/></label>
        <label>ASIST. <em>OPCIONAL</em><input data-stat="assists" type="number" inputmode="numeric" min="0" max="999" value="${Number(detected.assists||0)}"/></label>
        <label>DAÑO <em>OPCIONAL</em><input data-stat="damage" type="number" inputmode="numeric" min="0" max="10000000" value="${Number(detected.damage||0)}"/></label></article>`;
    }).join('');
  }

  function toggleMatchPlayer(id, checked) {
    if (checked) {
      if (state.selectedPlayers.size >= 4) { toast('⚠️ MÁXIMO 4 INTEGRANTES DEL CLAN'); renderMemberMatches(); return; }
      state.selectedPlayers.add(id);
    } else if (id !== appState().user?.id) state.selectedPlayers.delete(id);
    renderParticipantInputs();
    document.querySelectorAll('[data-match-player]').forEach(input => { input.checked = state.selectedPlayers.has(input.dataset.matchPlayer); });
  }

  async function renderMemberMatches() {
    const panel = $('lux-v3-member-matches');
    if (!panel) return;
    if (!appState().publicDirectory.size) await core().renderPublic();
    if (!state.selectedPlayers.size && appState().user?.id) state.selectedPlayers.add(appState().user.id);
    const mine = appState().user?.id;
    const matches = await core().request(`/rest/v1/matches?submitted_by=eq.${encodeURIComponent(mine)}&select=id,mode,played_at,opponent,result,score_for,score_against,status,rejection_reason,created_at&order=played_at.desc&limit=20`).catch(() => []);
    panel.innerHTML = `<section class="lux-v3-card lux-capture-first lux-member-simple-upload"><header><div><span class="hub-kicker">SUBIR PARTIDA</span><h2>Envía la captura y listo.</h2><p>Selecciona la imagen final de la partida. La web preparará el resumen para la líder; tú no tienes que leer ni corregir estadísticas.</p></div></header>
      <div class="lux-capture-required"><label class="lux-v3-field">CAPTURA FINAL<input id="lux-match-file" type="file" accept="image/jpeg,image/png,image/webp"/></label></div>
      <div id="lux-match-preview" class="lux-match-preview" hidden></div>
      <div id="lux-match-ocr-progress" class="lux-match-ocr-progress" hidden><i></i><span>Preparando el lector…</span></div>
      <input id="lux-match-mode" type="hidden" value="4v4"/><input id="lux-match-date" type="hidden" value="${nowLocalInput()}"/><input id="lux-match-result" type="hidden" value="win"/><input id="lux-match-opponent" type="hidden" value=""/><input id="lux-match-map" type="hidden" value=""/><input id="lux-match-score-for" type="hidden" value="1"/><input id="lux-match-score-against" type="hidden" value="0"/><input id="lux-match-notes" type="hidden" value=""/>
      <div class="lux-v3-actions lux-capture-actions"><button id="lux-submit-match" class="primary" type="button" onclick="window.luxPlatformV3.submitMatch()">ENVIAR A LA LÍDER</button></div>
      <p class="lux-capture-safety">🔒 No suma estadísticas por sí sola. La líder verá la captura, confirmará los integrantes y decidirá si la aprueba.</p></section>
      <section class="lux-v3-card"><header><div><span class="hub-kicker">HISTORIAL</span><h2>Mis envíos recientes</h2></div></header><div class="lux-v3-list">${matches.length ? matches.map(match => `<article class="lux-v3-row"><span class="lux-v3-row-avatar">🎮</span><div><strong>${esc(match.mode)} · ${esc(statusLabel(match.result))}</strong><small>${fmtDate(match.played_at)}${match.opponent?` · vs ${esc(match.opponent)}`:''}${match.rejection_reason?` · ${esc(match.rejection_reason)}`:''}</small></div>${statusBadge(match.status)}</article>`).join('') : '<p class="lux-v3-empty">Todavía no has enviado partidos con el sistema nuevo.</p>'}</div></section>`;
    $('lux-match-file')?.addEventListener('change',previewMatchFile);
  }

  async function submitMatch() {
    const button = $('lux-submit-match');
    const file = $('lux-match-file')?.files?.[0];
    if (!core().isImage(file, 8*1024*1024)) { toast('⚠️ USA JPG, PNG O WEBP DE HASTA 8 MB'); return; }
    let path = '';
    if (button) { button.disabled=true; button.textContent='PREPARANDO RESUMEN…'; }
    try {
      await analyzeMatchCapture({silent:true});
      if(button)button.textContent='COMPROBANDO Y ENVIANDO…';
      const mine=appState().profile||{id:appState().user.id,display_name:'Integrante'};
      const detected=state.matchDetected.get(appState().user.id)||{};
      const rosterById=new Map(currentRoster().map(row=>[profileId(row),row]));
      const automatic=[...state.matchDetected.entries()].slice(0,4).map(([playerId,row])=>{const member=rosterById.get(playerId)||{};return {player_id:playerId,team_role:member.primary_game_role||null,game_name:row.detectedName||row.gameName||profileName(member),kills:Number(row.kills||0),deaths:Number(row.deaths||0),assists:Number(row.assists||0),damage:Number(row.damage||0),is_mvp:false,stats_confirmed:Boolean(row.confirmed)};});
      const participants=automatic.some(row=>row.player_id===appState().user.id)?automatic:[{player_id:appState().user.id,team_role:mine.primary_game_role||null,game_name:detected.detectedName||detected.gameName||profileName(mine),kills:Number(detected.kills||0),deaths:Number(detected.deaths||0),assists:Number(detected.assists||0),damage:Number(detected.damage||0),is_mvp:false,stats_confirmed:Boolean(detected.confirmed)},...automatic].slice(0,4);
      const [hash,visualHashes] = await Promise.all([core().sha256(file),core().imageVisualHashes(file)]);
      path = `${appState().user.id}/matches/${core().randomId()}.${core().extension(file)}`;
      await core().upload('lux-evidence',path,file);
      await core().rpc('submit_match_secure',{
        p_mode:$('lux-match-mode').value,p_played_at:new Date($('lux-match-date').value).toISOString(),
        p_opponent:$('lux-match-opponent').value.trim()||null,p_result:$('lux-match-result').value,
        p_score_for:Number($('lux-match-score-for').value||0),p_score_against:Number($('lux-match-score-against').value||0),
        p_evidence_path:path,p_evidence_sha256:hash,p_evidence_dhash:visualHashes[0],p_visual_hashes:visualHashes,p_participants:participants,
        p_notes:encodeMatchAutoDraft(state.matchOcrResult)||null,p_season_id:null
      });
      toast('✅ CAPTURA ENVIADA · LA LÍDER RECIBIÓ EL RESUMEN PARA REVISAR');
      state.selectedPlayers=new Set([appState().user.id]);state.matchDetected.clear();state.matchUnmatched=[];state.matchOcrResult=null;state.matchOcrFileKey='';state.matchOcrPromise=null;
      await renderMemberMatches();
    } catch(error) {
      if(path) await core().request(`/storage/v1/object/lux-evidence/${path.split('/').map(encodeURIComponent).join('/')}`,{method:'DELETE'}).catch(()=>{});
      toast(`⚠️ ${errorText(error).toUpperCase()}`);
    } finally { if(button){button.disabled=false;button.textContent='ENVIAR A LA LÍDER';} }
  }

  async function renderAdminRequests() {
    const panel = $('lux-v3-admin-requests');
    if (!panel) return;
    const [profiles,requests,managed] = await Promise.all([
      core().request('/rest/v1/profiles?onboarding_complete=eq.true&membership_status=eq.pending&merged_into=is.null&select=id,display_name,age,country_code,country_name,avatar_path,created_at&order=created_at.asc'),
      core().request('/rest/v1/membership_requests?status=eq.pending&select=user_id,message,created_at&order=created_at.asc').catch(()=>[]),
      core().request('/rest/v1/profiles?onboarding_complete=eq.true&membership_status=in.(active,trial,reserve,inactive,alumni)&merged_into=is.null&select=id,display_name,avatar_path,membership_status,status_reason&order=display_name.asc').catch(()=>[])
    ]);
    const requestByUser = new Map(requests.map(row=>[row.user_id,row]));
    panel.innerHTML = `<section class="lux-v3-card"><header><div><span class="hub-kicker">ADMISIONES</span><h2>Solicitudes pendientes</h2><p>Nadie aparece como integrante hasta completar nombre, edad y país y recibir una decisión.</p></div><b>${profiles.length}</b></header>
      <div class="lux-v3-list">${profiles.length ? profiles.map(profile=>{const request=requestByUser.get(profile.id)||{};return `<article class="lux-v3-row">${avatar(profile)}<div><strong>${esc(profile.display_name)}</strong><small>${esc(profile.country_name||profile.country_code)} · ${profile.age} años · solicitó ${fmtDate(request.created_at||profile.created_at)}${request.message?`<br/>${esc(request.message)}`:''}</small></div><span class="lux-v3-row-actions"><button class="approve" onclick="window.luxPlatformV3.reviewMembership('${esc(profile.id)}','active')">ACEPTAR</button><button onclick="window.luxPlatformV3.reviewMembership('${esc(profile.id)}','trial')">PONER A PRUEBA</button><button class="reject" onclick="window.luxPlatformV3.reviewMembership('${esc(profile.id)}','expelled')">RECHAZAR</button></span></article>`;}).join('') : '<p class="lux-v3-empty">No hay solicitudes esperando aprobación.</p>'}</div></section>
      <section class="lux-v3-card"><header><div><span class="hub-kicker">ESTADOS DEL EQUIPO</span><h2>Activos, reserva e inactivos</h2><p>Cambia el estado sin borrar el historial. Las cuentas inactivas dejan de aparecer en rankings hasta ser reactivadas.</p></div></header><div class="lux-v3-list">${managed.map(profile=>`<article class="lux-v3-row">${avatar(profile)}<div><strong>${esc(profile.display_name)}</strong><small>${esc(profile.status_reason||statusLabel(profile.membership_status))}</small></div><span class="lux-v3-row-actions"><select id="lux-member-status-${esc(profile.id)}"><option value="active"${profile.membership_status==='active'?' selected':''}>ACTIVO</option><option value="trial"${profile.membership_status==='trial'?' selected':''}>EN PRUEBA</option><option value="reserve"${profile.membership_status==='reserve'?' selected':''}>RESERVA</option><option value="inactive"${profile.membership_status==='inactive'?' selected':''}>INACTIVO</option><option value="alumni"${profile.membership_status==='alumni'?' selected':''}>EXINTEGRANTE</option></select><button onclick="window.luxPlatformV3.saveMembershipStatus('${esc(profile.id)}')">GUARDAR</button></span></article>`).join('')||'<p class="lux-v3-empty">No hay perfiles para administrar.</p>'}</div></section>`;
  }

  async function reviewMembership(userId,status) {
    const reason = ['expelled','inactive','alumni'].includes(status) ? (window.prompt('Motivo breve para registrar en el historial:')||'Solicitud no aceptada') : null;
    try {
      await core().rpc('staff_review_membership',{p_user_id:userId,p_status:status,p_reason:reason});
      toast(`✅ ESTADO ACTUALIZADO: ${statusLabel(status).toUpperCase()}`);
      await Promise.all([core().renderAdmin(),core().renderPublic(),renderAdminRequests()]);
    } catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function saveMembershipStatus(userId){
    const status=$(`lux-member-status-${userId}`)?.value;if(!status)return;
    const reason=['inactive','alumni'].includes(status)?(window.prompt('Motivo breve (queda en el historial):')||`Cambio a ${statusLabel(status)}`):null;
    try{await core().rpc('staff_review_membership',{p_user_id:userId,p_status:status,p_reason:reason});toast(`✅ ESTADO ACTUALIZADO: ${statusLabel(status).toUpperCase()}`);await Promise.all([core().renderAdmin(),core().renderPublic(),renderAdminRequests()]);}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function renderAdminMatches() {
    const panel=$('lux-v3-admin-matches'); if(!panel)return;
    const [matches,seasons]=await Promise.all([
      core().request('/rest/v1/matches?status=eq.pending&select=*&order=played_at.asc'),
      core().request('/rest/v1/seasons?select=*&order=starts_on.desc',{},false).catch(()=>[])
    ]);
    const ids=matches.map(row=>row.id);
    const participants=ids.length?await core().request(`/rest/v1/match_participants?match_id=in.(${ids.join(',')})&select=match_id,player_id,game_name,team_role,kills,deaths,assists,damage,is_mvp,stats_confirmed`).catch(()=>[]):[];
    const byMatch=new Map();participants.forEach(row=>{if(!byMatch.has(row.match_id))byMatch.set(row.match_id,[]);byMatch.get(row.match_id).push(row);});
    const cards=await Promise.all(matches.map(async match=>{const card={...match,image:await core().signedEvidence(match.evidence_path).catch(()=>''),players:byMatch.get(match.id)||[]};card.autoDraft=decodeMatchAutoDraft(match.notes);return card;}));
    state.pendingMatches=new Map(cards.map(match=>[match.id,match]));state.selectedMatches=new Set([...state.selectedMatches].filter(id=>state.pendingMatches.has(id)));
    panel.innerHTML=`<section class="lux-v3-card"><header><div><span class="hub-kicker">REVISIÓN VISUAL</span><h2>Partidos pendientes</h2><p>Cada ficha resume la captura como el tablero del juego. Confirma únicamente los nombres dudosos y decide.</p></div>${statusBadge(cards.length?'pending':'approved')}</header>
      ${cards.length?`<div class="lux-review-toolbar"><label><input type="checkbox" onchange="window.luxPlatformV3.selectAllPendingMatches(this.checked)"/> SELECCIONAR SIN RIESGO</label><button id="lux-approve-selected" class="lux-v3-button primary" type="button" onclick="window.luxPlatformV3.approveSelectedMatches()" ${state.selectedMatches.size?'':'disabled'}>APROBAR SELECCIONADAS (${state.selectedMatches.size})</button></div>`:''}
      <div class="lux-v3-list">${cards.length?cards.map(renderAdminMatchCard).join(''):'<p class="lux-v3-empty">No hay partidos pendientes.</p>'}</div></section>
      <section class="lux-v3-card"><header><div><span class="hub-kicker">TEMPORADAS</span><h2>Clasificación por etapas</h2><p>Archiva periodos sin borrar el historial general.</p></div></header><div class="lux-v3-grid three"><label class="lux-v3-field">NOMBRE<input id="lux-season-name" maxlength="80" placeholder="Ej.: Agosto competitivo"/></label><label class="lux-v3-field">INICIO<input id="lux-season-start" type="date" value="${new Date().toISOString().slice(0,10)}"/></label><label class="lux-v3-field">FIN OPCIONAL<input id="lux-season-end" type="date"/></label></div><div class="lux-v3-actions"><button class="gold" onclick="window.luxPlatformV3.createSeason()">CREAR Y ACTIVAR TEMPORADA</button></div><div class="lux-v3-list">${seasons.map(season=>`<article class="lux-v3-row"><span class="lux-v3-row-avatar">🏁</span><div><strong>${esc(season.name)}</strong><small>${season.starts_on} → ${season.ends_on||'sin fecha final'}</small></div><span class="lux-v3-row-actions">${statusBadge(season.is_current?'active':season.is_archived?'inactive':'reserve')}${!season.is_current?`<button onclick="window.luxPlatformV3.setSeasonState('${esc(season.id)}','activate')">ACTIVAR</button>`:''}${!season.is_archived?`<button class="reject" onclick="window.luxPlatformV3.setSeasonState('${esc(season.id)}','archive')">ARCHIVAR</button>`:''}</span></article>`).join('')}</div></section>`;
  }

  function renderAdminMatchCard(match) {
    const unknown=unresolvedMatchPlayers(match),score=`${Number(match.score_for||0)} - ${Number(match.score_against||0)}`;
    const facts=[['RESULTADO',statusLabel(match.result)],['MARCADOR',score],['MODO',match.mode||'4v4'],['MAPA',match.autoDraft?.map||'Por confirmar']];
    const players=(match.players||[]).map(player=>{const member=appState().directory.get(player.player_id)||appState().publicDirectory.get(player.player_id)||{display_name:'Integrante'};return `<article class="lux-review-player">${avatar(member,'lux-review-player-avatar')}<div><strong>${esc(profileName(member))}</strong><small>${esc(player.game_name||profileName(member))}</small></div><dl><div><dt>K/D/A</dt><dd>${Number(player.kills||0)}/${Number(player.deaths||0)}/${Number(player.assists||0)}</dd></div><div><dt>DAÑO</dt><dd>${Number(player.damage||0)}</dd></div></dl></article>`;}).join('');
    const questions=unknown.map((row,index)=>`<article class="lux-review-unknown" data-unresolved-match="${esc(match.id)}" data-unresolved-index="${index}"><span class="lux-review-player-avatar">?</span><div><strong>${esc(row.gameName||'Nombre no legible')}</strong><small>K/D/A ${Number(row.kills||0)}/${Number(row.deaths||0)}/${Number(row.assists||0)} · ${Number(row.damage||0)} daño</small><label>¿QUÉ INTEGRANTE ES?<select onchange="window.luxPlatformV3.resolvePendingMatchPlayer('${esc(match.id)}',${index},this.value)">${reviewMemberOptions('')}</select></label></div></article>`).join('');
    return `<article class="lux-v3-card lux-review-match lux-scoreboard${match.duplicate_risk?' has-risk':''}${unknown.length?' needs-names':''}"><header><label class="lux-review-check"><input type="checkbox" data-review-match="${esc(match.id)}" ${state.selectedMatches.has(match.id)?'checked':''} onchange="window.luxPlatformV3.toggleReviewMatch('${esc(match.id)}',this.checked)" ${unknown.length||match.duplicate_risk?'disabled':''}/><span>SELECCIONAR</span></label><div><span class="hub-kicker">${esc(match.autoDraft?.gameType||'PARTIDA DEL CLAN')}${match.duplicate_risk?'<span class="lux-risk-flag">IMAGEN PARECIDA</span>':''}</span><h3>${esc(match.autoDraft?.teamFor||'FLUXO')} <b>${score}</b> ${esc(match.autoDraft?.teamAgainst||match.opponent||'RIVAL')}</h3><p>${fmtDate(match.played_at)} · ${esc(match.mode||'4v4')}</p></div></header>
      ${match.image?`<button class="lux-review-evidence" onclick="window.luxSupabase.openEvidence('${esc(match.image)}','Partido ${esc(match.mode)}')"><img src="${esc(match.image)}" alt="Captura del partido pendiente" loading="lazy"/><span>AMPLIAR CAPTURA</span></button>`:''}<div class="lux-review-facts">${facts.map(([label,value])=>`<span><small>${esc(label)}</small><strong>${esc(value)}</strong></span>`).join('')}</div><div class="lux-review-team"><div class="lux-review-team-head"><strong>JUGADORES DEL CLAN</strong><span>K/D/A · DAÑO</span></div>${players||'<p class="lux-v3-empty compact">No se relacionó ningún jugador todavía.</p>'}</div>${questions?`<section class="lux-review-questions"><header><div><span class="hub-kicker">CONFIRMACIÓN NECESARIA</span><h3>¿Quién es este jugador?</h3><p>Selecciona su perfil o indica que no pertenece al clan. Al aprobar, el nombre quedará aprendido como alias.</p></div></header>${questions}</section>`:''}
      <div class="lux-v3-actions"><button class="gold" onclick="window.luxPlatformV3.openMatchCorrection('${esc(match.id)}')">MODIFICAR RESUMEN</button><button class="primary" onclick="window.luxPlatformV3.reviewMatch('${esc(match.id)}','approved')">APROBAR</button><button class="danger" onclick="window.luxPlatformV3.reviewMatch('${esc(match.id)}','rejected')">RECHAZAR</button></div></article>`;
  }

  function resolvePendingMatchPlayer(matchId,index,value) {
    const match=state.pendingMatches.get(matchId),row=unresolvedMatchPlayers(match)[index];if(!match||!row)return;
    row.resolvedPlayerId=value==='__ignore__'?'':value;row.ignored=value==='__ignore__';
    const card=document.querySelector(`[data-unresolved-match="${CSS.escape(matchId)}"][data-unresolved-index="${index}"]`);card?.classList.toggle('is-resolved',Boolean(value));
  }

  async function prepareMatchForApproval(id) {
    const match=state.pendingMatches.get(id);if(!match)return;
    const questions=unresolvedMatchPlayers(match),pending=questions.filter(row=>!row.resolvedPlayerId&&!row.ignored);
    if(pending.length){const select=document.querySelector(`[data-unresolved-match="${CSS.escape(id)}"] select`);select?.focus();select?.scrollIntoView({behavior:'smooth',block:'center'});throw new Error(`Falta indicar quién es ${pending[0].gameName || 'un jugador detectado'}`);}
    if(!questions.length)return;
    const participants=(match.players||[]).map(row=>({...row,stats_confirmed:true}));
    questions.filter(row=>row.resolvedPlayerId).forEach(row=>{const existing=participants.find(player=>player.player_id===row.resolvedPlayerId),stats={game_name:row.gameName,kills:Number(row.kills||0),deaths:Number(row.deaths||0),assists:Number(row.assists||0),damage:Number(row.damage||0),stats_confirmed:true};if(existing)Object.assign(existing,stats);else participants.push({player_id:row.resolvedPlayerId,team_role:null,is_mvp:false,...stats});});
    if(!participants.length||participants.length>4)throw new Error('El equipo debe tener entre 1 y 4 integrantes');
    if(new Set(participants.map(row=>row.player_id)).size!==participants.length)throw new Error('Un integrante está asignado dos veces');
    await core().rpc('staff_update_pending_match',{p_match_id:id,p_mode:match.mode,p_result:match.result,p_score_for:Number(match.score_for||0),p_score_against:Number(match.score_against||0),p_opponent:match.opponent||match.autoDraft?.teamAgainst||null,p_participants:participants});
    match.players=participants;
  }

  async function reviewMatch(id,status){
    const reason=status==='rejected'?(window.prompt('Motivo del rechazo:')||null):null;
    try{if(status==='approved')await prepareMatchForApproval(id);await core().rpc('review_match',{p_match_id:id,p_status:status,p_reason:reason});toast(status==='approved'?'✅ PARTIDO APROBADO PARA TODO EL EQUIPO':'↩️ PARTIDO RECHAZADO');if(status==='approved')document.dispatchEvent(new CustomEvent('fluxo:victory-approved',{detail:{count:1}}));await Promise.all([renderAdminMatches(),core().renderAdmin(),core().renderPublic()]);}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  function toggleReviewMatch(id,checked){if(checked)state.selectedMatches.add(id);else state.selectedMatches.delete(id);const button=$('lux-approve-selected');if(button){button.disabled=!state.selectedMatches.size;button.textContent=`APROBAR SELECCIONADAS (${state.selectedMatches.size})`;}}

  function selectAllPendingMatches(checked){
    state.selectedMatches=new Set(checked?[...state.pendingMatches.values()].filter(match=>!match.duplicate_risk&&!unresolvedMatchPlayers(match).length).map(match=>match.id):[]);
    document.querySelectorAll('[data-review-match]').forEach(input=>{input.checked=state.selectedMatches.has(input.dataset.reviewMatch);});
    toggleReviewMatch('',false);
  }

  async function approveSelectedMatches(){
    const ids=[...state.selectedMatches].filter(id=>state.pendingMatches.has(id));if(!ids.length){toast('⚠️ SELECCIONA AL MENOS UN PARTIDO');return;}
    if(ids.some(id=>unresolvedMatchPlayers(state.pendingMatches.get(id)).length)){toast('⚠️ CONFIRMA LOS NOMBRES DUDOSOS ANTES DE APROBAR EN LOTE');return;}
    const button=$('lux-approve-selected');if(button){button.disabled=true;button.textContent='APROBANDO…';}
    try{const count=await core().rpc('staff_bulk_review_matches',{p_match_ids:ids,p_status:'approved',p_reason:null});state.selectedMatches.clear();toast(`✅ ${Number(count||ids.length)} PARTIDO(S) APROBADO(S)`);document.dispatchEvent(new CustomEvent('fluxo:victory-approved',{detail:{count:Number(count||ids.length)}}));await Promise.all([renderAdminMatches(),core().renderAdmin(),core().renderPublic()]);}
    catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);if(button){button.disabled=false;button.textContent=`APROBAR SELECCIONADAS (${ids.length})`;}}
  }

  function correctionParticipantRow(player,index){
    const member=appState().directory.get(player.player_id)||appState().publicDirectory.get(player.player_id)||{display_name:'Integrante'};
    return `<article class="lux-match-correction-player" data-correction-player="${index}">${avatar(member)}<label>INTEGRANTE<select data-field="player_id">${memberOptions(player.player_id)}</select></label><label>NOMBRE FREE FIRE<input data-field="game_name" maxlength="80" value="${esc(player.game_name||profileName(member))}"/></label><label>BAJAS<input data-field="kills" type="number" min="0" max="999" value="${Number(player.kills||0)}"/></label><label>MUERTES<input data-field="deaths" type="number" min="0" max="999" value="${Number(player.deaths||0)}"/></label><label>ASIST.<input data-field="assists" type="number" min="0" max="999" value="${Number(player.assists||0)}"/></label><label>DAÑO<input data-field="damage" type="number" min="0" max="10000000" value="${Number(player.damage||0)}"/></label></article>`;
  }

  function openMatchCorrection(id){
    const match=state.pendingMatches.get(id);if(!match)return;
    showDialog('CORREGIR PARTIDO',`<p>Compara estos campos con la captura. Al guardar, la ficha seguirá pendiente hasta que pulses Aprobar.</p><div class="lux-v3-grid three"><label class="lux-v3-field">MODO<select id="lux-correct-mode">${['1v1','2v2','3v3','4v4','Otro'].map(mode=>`<option${mode===match.mode?' selected':''}>${mode}</option>`).join('')}</select></label><label class="lux-v3-field">RESULTADO<select id="lux-correct-result"><option value="win"${match.result==='win'?' selected':''}>VICTORIA</option><option value="loss"${match.result==='loss'?' selected':''}>DERROTA</option><option value="draw"${match.result==='draw'?' selected':''}>EMPATE</option></select></label><label class="lux-v3-field">RIVAL<input id="lux-correct-opponent" maxlength="80" value="${esc(match.opponent||match.autoDraft?.teamAgainst||'')}"/></label><label class="lux-v3-field">MARCADOR FLUXO<input id="lux-correct-score-for" type="number" min="0" max="999" value="${Number(match.score_for||0)}"/></label><label class="lux-v3-field">MARCADOR RIVAL<input id="lux-correct-score-against" type="number" min="0" max="999" value="${Number(match.score_against||0)}"/></label></div><div class="lux-v3-section-head"><h3>INTEGRANTES Y ESTADÍSTICAS</h3><button class="lux-v3-button gold" onclick="window.luxPlatformV3.addCorrectionParticipant()">AÑADIR INTEGRANTE</button></div><div id="lux-match-correction-players" class="lux-match-correction-players">${match.players.map(correctionParticipantRow).join('')}</div><div class="lux-v3-actions"><button class="primary" onclick="window.luxPlatformV3.saveMatchCorrection('${esc(id)}')">GUARDAR CORRECCIÓN</button></div>`);
  }

  function addCorrectionParticipant(){const target=$('lux-match-correction-players');if(!target)return;if(target.children.length>=4){toast('⚠️ MÁXIMO 4 INTEGRANTES');return;}target.insertAdjacentHTML('beforeend',correctionParticipantRow({player_id:'',game_name:'',kills:0,deaths:0,assists:0,damage:0},target.children.length));}

  async function saveMatchCorrection(id){
    const rows=[...document.querySelectorAll('[data-correction-player]')],participants=rows.map(row=>({player_id:row.querySelector('[data-field="player_id"]')?.value,game_name:row.querySelector('[data-field="game_name"]')?.value.trim()||null,team_role:null,kills:Number(row.querySelector('[data-field="kills"]')?.value||0),deaths:Number(row.querySelector('[data-field="deaths"]')?.value||0),assists:Number(row.querySelector('[data-field="assists"]')?.value||0),damage:Number(row.querySelector('[data-field="damage"]')?.value||0),is_mvp:false,stats_confirmed:true}));
    if(participants.some(row=>!row.player_id)||new Set(participants.map(row=>row.player_id)).size!==participants.length){toast('⚠️ REVISA LOS INTEGRANTES REPETIDOS O VACÍOS');return;}
    try{await core().rpc('staff_update_pending_match',{p_match_id:id,p_mode:$('lux-correct-mode').value,p_result:$('lux-correct-result').value,p_score_for:Number($('lux-correct-score-for').value||0),p_score_against:Number($('lux-correct-score-against').value||0),p_opponent:$('lux-correct-opponent').value.trim()||null,p_participants:participants});$('lux-v3-dialog')?.remove();toast('✅ CORRECCIÓN GUARDADA · LISTA PARA APROBAR');await renderAdminMatches();}
    catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function createSeason(){
    const name=$('lux-season-name')?.value.trim(),start=$('lux-season-start')?.value,end=$('lux-season-end')?.value||null;
    if(!name||!start){toast('⚠️ ESCRIBE EL NOMBRE Y LA FECHA DE INICIO');return;}
    try{await core().rpc('staff_create_season',{p_name:name,p_starts_on:start,p_ends_on:end,p_make_current:true});toast('✅ NUEVA TEMPORADA ACTIVA');await renderAdminMatches();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function setSeasonState(id,action){
    if(action==='archive'&&!confirm('¿Cerrar y archivar esta temporada? El historial se conservará.'))return;
    try{await core().rpc('staff_set_season_state',{p_season_id:id,p_action:action,p_ends_on:action==='archive'?new Date().toISOString().slice(0,10):null});toast(action==='archive'?'✅ TEMPORADA ARCHIVADA':'✅ TEMPORADA ACTIVADA');await renderAdminMatches();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function renderMemberEvents(){
    const panel=$('lux-v3-member-events');if(!panel)return;
    const [events,responses,roster]=await Promise.all([
      core().request('/rest/v1/clan_events?status=eq.open&scheduled_at=gte.now()&select=*&order=scheduled_at.asc'),
      core().request(`/rest/v1/event_responses?user_id=eq.${encodeURIComponent(appState().user.id)}&select=*`).catch(()=>[]),
      core().request(`/rest/v1/event_roster?user_id=eq.${encodeURIComponent(appState().user.id)}&select=*`).catch(()=>[])
    ]);
    const mine=new Map(responses.map(row=>[row.event_id,row]));
    const selected=new Map(roster.map(row=>[row.event_id,row]));
    panel.innerHTML=`<section class="lux-v3-card"><header><div><span class="hub-kicker">AGENDA DEL CLAN</span><h2>Convocatorias</h2><p>Confirma tu disponibilidad para que las líderes armen el equipo sin escribir a cada persona.</p></div></header><div class="lux-v3-list">${events.length?events.map(event=>{const response=mine.get(event.id),assignment=selected.get(event.id);return `<article class="lux-event-card"><header><div><span class="hub-kicker">${esc(event.mode)}</span><h3>${esc(event.title)}</h3></div>${response?statusBadge(response.response):statusBadge('pending')}</header>${assignment?`<div class="lux-event-assignment"><b>${assignment.is_substitute?'SUPLENTE':'TITULAR'}</b><span>Rol asignado: ${esc(assignment.assigned_role||'Flexible')}</span></div>`:''}<p>${esc(event.description||'Sin descripción adicional.')}</p><div class="lux-event-meta"><span>📅 ${fmtDate(event.scheduled_at)}</span><span>👥 ${event.slots} lugares</span></div><label class="lux-v3-field">ROL QUE PREFIERES<select id="lux-event-role-${esc(event.id)}">${roleOptions(response?.preferred_role||appState().profile?.primary_game_role||'')}</select></label><div class="lux-event-responses"><button class="available" onclick="window.luxPlatformV3.respondEvent('${esc(event.id)}','available')">✓ PUEDO JUGAR</button><button class="maybe" onclick="window.luxPlatformV3.respondEvent('${esc(event.id)}','maybe')">? TAL VEZ</button><button class="unavailable" onclick="window.luxPlatformV3.respondEvent('${esc(event.id)}','unavailable')">× NO PUEDO</button></div></article>`;}).join(''):'<p class="lux-v3-empty">No hay convocatorias abiertas.</p>'}</div></section>`;
  }

  async function respondEvent(id,response){
    try{await core().rpc('respond_to_event',{p_event_id:id,p_response:response,p_preferred_role:$(`lux-event-role-${id}`)?.value||null,p_note:null});toast('✅ DISPONIBILIDAD GUARDADA');await renderMemberEvents();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function renderAdminEvents(){
    const panel=$('lux-v3-admin-events');if(!panel)return;
    const events=await core().request('/rest/v1/clan_events?select=*&order=scheduled_at.desc&limit=30');
    const ids=events.map(row=>row.id);
    const responses=ids.length?await core().request(`/rest/v1/event_responses?event_id=in.(${ids.join(',')})&select=*`).catch(()=>[]):[];
    const byEvent=new Map();responses.forEach(row=>{if(!byEvent.has(row.event_id))byEvent.set(row.event_id,[]);byEvent.get(row.event_id).push(row);});
    panel.innerHTML=`<section class="lux-v3-card"><header><div><span class="hub-kicker">NUEVA LLAMADA</span><h2>Crear convocatoria</h2><p>Publica día, hora y modo. Después consulta quién está disponible y genera un equipo recomendado.</p></div></header><div class="lux-v3-grid three"><label class="lux-v3-field">TÍTULO<input id="lux-event-title" maxlength="100" placeholder="Ej.: Sala 4v4 del viernes"/></label><label class="lux-v3-field">MODO<select id="lux-event-mode"><option>1v1</option><option>2v2</option><option>3v3</option><option selected>4v4</option><option>Entrenamiento</option><option>Otro</option></select></label><label class="lux-v3-field">FECHA Y HORA<input id="lux-event-date" type="datetime-local" value="${nowLocalInput()}"/></label><label class="lux-v3-field">LUGARES<input id="lux-event-slots" type="number" min="1" max="20" value="4"/></label><label class="lux-v3-field lux-v3-span">DESCRIPCIÓN<textarea id="lux-event-description" maxlength="1200" placeholder="Rival, reglas, requisitos…"></textarea></label></div><div class="lux-v3-actions"><button class="primary" onclick="window.luxPlatformV3.createEvent()">PUBLICAR CONVOCATORIA</button></div></section>
      <section class="lux-v3-card"><header><div><span class="hub-kicker">RESPUESTAS</span><h2>Convocatorias recientes</h2></div></header><div class="lux-v3-list">${events.length?events.map(event=>{const rows=byEvent.get(event.id)||[];const available=rows.filter(row=>row.response==='available').length;return `<article class="lux-v3-row"><span class="lux-v3-row-avatar">📅</span><div><strong>${esc(event.title)}</strong><small>${fmtDate(event.scheduled_at)} · ${available} disponibles · ${rows.length} respuestas · ${esc(statusLabel(event.status))}</small></div><span class="lux-v3-row-actions"><button onclick="window.luxPlatformV3.showRecommendedTeam('${esc(event.id)}')">RECOMENDAR EQUIPO</button><button onclick="window.luxPlatformV3.closeEvent('${esc(event.id)}')">CERRAR</button></span></article>`;}).join(''):'<p class="lux-v3-empty">Todavía no hay convocatorias.</p>'}</div></section>`;
  }

  async function createEvent(){
    const title=$('lux-event-title')?.value.trim(),date=$('lux-event-date')?.value;
    if(!title||!date){toast('⚠️ ESCRIBE TÍTULO, FECHA Y HORA');return;}
    try{await core().request('/rest/v1/clan_events',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({title,description:$('lux-event-description').value.trim()||null,mode:$('lux-event-mode').value,scheduled_at:new Date(date).toISOString(),slots:Number($('lux-event-slots').value||4),status:'open',created_by:appState().user.id})});toast('✅ CONVOCATORIA PUBLICADA');await renderAdminEvents();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function closeEvent(id){try{await core().request(`/rest/v1/clan_events?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'closed'})});toast('✅ CONVOCATORIA CERRADA');await renderAdminEvents();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}

  async function showRecommendedTeam(id){
    try{const rows=await core().rpc('recommend_event_team',{p_event_id:id});showDialog('EQUIPO RECOMENDADO',rows.length?`<div class="lux-v3-list">${rows.map((row,index)=>`<article class="lux-v3-row"><b>#${index+1}</b>${avatar(row)}<div><strong>${esc(row.display_name)}</strong><small>${esc(row.preferred_role||row.primary_game_role||'Flexible')} · ${row.wins}/${row.matches_played} victorias · ${row.win_rate}% · puntuación ${row.recommendation_score}</small></div></article>`).join('')}</div><div class="lux-v3-actions"><button class="primary" onclick="window.luxPlatformV3.saveRecommendedTeam('${esc(id)}')">GUARDAR TITULARES Y SUPLENTES</button></div>`:'<p class="lux-v3-empty">Aún nadie confirmó que puede jugar.</p>');}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function saveRecommendedTeam(id){try{const count=await core().rpc('staff_save_recommended_team',{p_event_id:id});$('lux-v3-dialog')?.remove();toast(`✅ EQUIPO GUARDADO · ${count} CONVOCADOS`);}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}

  async function renderAnnouncements(targetId,admin=false){
    const panel=$(targetId);if(!panel)return;
    const rows=await core().request('/rest/v1/announcements?is_active=eq.true&select=*&order=is_pinned.desc,created_at.desc').catch(()=>[]);
    panel.innerHTML=`${admin?`<section class="lux-v3-card"><header><div><span class="hub-kicker">COMUNICACIÓN INTERNA</span><h2>Publicar un aviso</h2><p>El aviso aparecerá para todos los integrantes activos dentro de la web.</p></div></header><div class="lux-v3-grid"><label class="lux-v3-field">TÍTULO<input id="lux-announcement-title" maxlength="100"/></label><label class="lux-v3-field">DESTACAR<select id="lux-announcement-pinned"><option value="false">NORMAL</option><option value="true">FIJAR ARRIBA</option></select></label><label class="lux-v3-field lux-v3-span">MENSAJE<textarea id="lux-announcement-body" maxlength="2000"></textarea></label></div><div class="lux-v3-actions"><button class="primary" onclick="window.luxPlatformV3.createAnnouncement()">PUBLICAR AVISO</button></div></section>`:''}<section class="lux-v3-card"><header><div><span class="hub-kicker">TABLÓN DEL CLAN</span><h2>Avisos recientes</h2></div></header><div class="lux-v3-list">${rows.length?rows.map(row=>`<article class="lux-announcement ${row.is_pinned?'pinned':''}">${row.is_pinned?'<span class="lux-announcement-pin">📌 DESTACADO</span>':''}<h3>${esc(row.title)}</h3><p>${esc(row.body)}</p><time>${fmtDate(row.created_at)}</time>${admin?`<div class="lux-v3-actions"><button class="danger" onclick="window.luxPlatformV3.archiveAnnouncement('${esc(row.id)}')">ARCHIVAR</button></div>`:''}</article>`).join(''):'<p class="lux-v3-empty">Todavía no hay avisos publicados.</p>'}</div></section>`;
  }

  async function createAnnouncement(){
    const title=$('lux-announcement-title')?.value.trim(),body=$('lux-announcement-body')?.value.trim();if(!title||!body){toast('⚠️ ESCRIBE TÍTULO Y MENSAJE');return;}
    try{await core().request('/rest/v1/announcements',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,body,is_pinned:$('lux-announcement-pinned').value==='true',is_active:true,created_by:appState().user.id})});toast('✅ AVISO PUBLICADO');await renderAnnouncements('lux-v3-admin-announcements',true);}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function archiveAnnouncement(id){try{await core().request(`/rest/v1/announcements?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_active:false})});toast('✅ AVISO ARCHIVADO');await renderAnnouncements('lux-v3-admin-announcements',true);}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}

  async function refreshAdminSummary(){
    if(!appState().isStaff)return;
    try{
      const summary=await core().rpc('get_admin_dashboard_summary');
      appState().pendingRequests=Number(summary.pending_members||0);
      appState().pendingMatches=Number(summary.pending_matches||0);
      appState().pendingReviews=Number(summary.pending_victories||0);
      core().renderNavigation();
      const menu=$('lux-admin-menu');
      if(menu&&!$('lux-v3-summary'))menu.insertAdjacentHTML('afterbegin','<section id="lux-v3-summary" class="lux-v3-summary"></section>');
      if($('lux-v3-summary'))$('lux-v3-summary').innerHTML=`<article><b>${summary.active_members||0}</b><small>ACTIVOS</small></article><article><b>${summary.active_this_week||0}</b><small>ACTIVOS ESTA SEMANA</small></article><article><b>${summary.pending_members||0}</b><small>SOLICITUDES</small></article><article><b>${summary.incomplete_profiles||0}</b><small>PERFILES INCOMPLETOS</small></article><article><b>${summary.pending_victories||0}</b><small>CAPTURAS</small></article><article><b>${summary.pending_matches||0}</b><small>PARTIDOS</small></article><article><b>${summary.inactive_30_days||0}</b><small>INACTIVOS 30 DÍAS</small></article><article><b>${summary.open_events||0}</b><small>CONVOCATORIAS</small></article>`;
      let insight=$('lux-v3-admin-insight');
      if(menu&&!insight){menu.insertAdjacentHTML('beforeend','<section id="lux-v3-admin-insight" class="lux-v3-admin-insight"></section>');insight=$('lux-v3-admin-insight');}
      if(insight){const delta=Number(summary.joined_this_week||0)-Number(summary.joined_previous_week||0),next=summary.next_event;insight.innerHTML=`<div><span class="hub-kicker">COMPARACIÓN SEMANAL</span><strong>${delta>=0?'+':''}${delta} integrantes</strong><small>${Number(summary.joined_this_week||0)} altas esta semana · ${Number(summary.joined_previous_week||0)} la anterior</small></div><div><span class="hub-kicker">PRÓXIMA CONVOCATORIA</span><strong>${next?esc(next.title):'Sin convocatoria'}</strong><small>${next?`${esc(next.mode)} · ${fmtDate(next.scheduled_at)}`:'Publica una cuando el equipo tenga que jugar.'}</small></div>`;}
      updateNotificationBell(Number(summary.unread_notifications||0));
    }catch(_){/* La interfaz anterior sigue funcionando si V3 aun no fue aplicada. */}
  }

  function operationProfileOptions(includeRemoved=false){
    return [...appState().directory.values()].filter(row=>includeRemoved||!row.removed_at).map(row=>`<option value="${esc(row.id)}">${esc(row.display_name)} · ${esc(statusLabel(row.membership_status||'active'))}</option>`).join('');
  }

  function generalJoinUrl(){return new URL('./',location.href).href;}

  async function copyGeneralJoinLink(){
    const url=generalJoinUrl();
    try{await navigator.clipboard.writeText(url);toast('✅ LINK GENERAL COPIADO');}
    catch(_){window.prompt('Copia este enlace:',url);}
  }

  async function renderAccessControl(){
    const panel=$('lux-v3-admin-operations');if(!panel||!appState().isOwner)return;
    const settings=await core().rpc('get_clan_access_settings',{},false).catch(()=>[{access_mode:appState().accessMode||'approval'}]);
    const mode=settings?.[0]?.access_mode||settings?.access_mode||'approval';appState().accessMode=mode;
    $('lux-access-control')?.remove();
    panel.insertAdjacentHTML('afterbegin',`<section id="lux-access-control" class="lux-v3-card lux-access-control"><header><div><span class="hub-kicker">ENTRADA AL CLAN</span><h2>Control de acceso</h2><p>El enlace general siempre es el mismo. Tu decides que ocurre cuando llega una cuenta nueva.</p></div><span class="lux-access-state ${esc(mode)}">${mode==='open'?'ABIERTO':mode==='approval'?'CON APROBACION':'SOLO INVITACION'}</span></header><div class="lux-access-grid"><article><h3>Link general</h3><p>Este es el enlace corto que puedes enviar al grupo completo.</p><code>${esc(generalJoinUrl())}</code><button class="lux-v3-button gold" onclick="window.luxPlatformV3.copyGeneralJoinLink()">COPIAR LINK GENERAL</button></article><article><label class="lux-v3-field">QUIEN PUEDE UNIRSE<select id="lux-access-mode"><option value="open"${mode==='open'?' selected':''}>TODOS CON EL LINK</option><option value="approval"${mode==='approval'?' selected':''}>REGISTRO CON APROBACION</option><option value="invite_only"${mode==='invite_only'?' selected':''}>SOLO LINKS DE INVITACION</option></select></label><p class="lux-access-help"><b>TODOS:</b> se activa al completar el perfil.<br/><b>APROBACION:</b> una lider acepta la solicitud.<br/><b>INVITACION:</b> solo entra con un link temporal.</p><button class="lux-v3-button primary" onclick="window.luxPlatformV3.saveAccessMode()">GUARDAR ACCESO</button></article></div></section>`);
  }

  async function saveAccessMode(){
    const mode=$('lux-access-mode')?.value;if(!mode||!appState().isOwner)return;
    try{await core().rpc('owner_set_clan_access_mode',{p_mode:mode});appState().accessMode=mode;toast('✅ ACCESO DEL CLAN ACTUALIZADO');await Promise.all([renderAccessControl(),core().renderPublic()]);}
    catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  async function renderOperations(){
    const panel=$('lux-v3-admin-operations');if(!panel||!appState().isOwner)return;
    const accessObserver=new MutationObserver(()=>{if(panel.childElementCount){accessObserver.disconnect();renderAccessControl();}});
    accessObserver.observe(panel,{childList:true});
    if(!appState().directory.size)await core().renderAdmin();
    const [trash,aliases,audit]=await Promise.all([
      core().rpc('owner_list_removed_users').catch(()=>core().rpc('owner_list_clan_users').then(rows=>rows.filter(row=>row.removed_at&&!row.merged_into)).catch(()=>[])),core().rpc('staff_list_alias_conflicts').catch(()=>[]),
      core().request('/rest/v1/audit_log?select=*&order=created_at.desc&limit=40').catch(()=>[])
    ]);
    panel.innerHTML=`<section class="lux-v3-card"><header><div><span class="hub-kicker">CONTROL DEL OWNER</span><h2>Operaciones seguras</h2><p>Invitaciones, papelera, fusión de duplicados, alias, respaldo y auditoría en un solo lugar.</p></div>🔒</header><div class="lux-ops-grid">
      <article class="lux-ops-card"><h3>Invitación temporal</h3><p>Crea un enlace que acepta automáticamente a quien complete su perfil. El token vence y puede limitarse a un solo uso.</p><div class="lux-v3-grid"><label class="lux-v3-field">HORAS<input id="lux-invite-hours" type="number" min="1" max="720" value="72"/></label><label class="lux-v3-field">USOS<input id="lux-invite-uses" type="number" min="1" max="100" value="1"/></label></div><div class="lux-v3-actions"><button class="gold" onclick="window.luxPlatformV3.createInvite()">CREAR ENLACE</button></div><div id="lux-invite-output" class="lux-ops-output">Todavía no se creó una invitación.</div></article>
      <article class="lux-ops-card"><h3>Respaldo completo</h3><p>Incluye registros, roles, partidos, placas, alias, eventos, auditoría y copias de todas las imágenes de Storage.</p><div class="lux-backup-progress"><i id="lux-backup-bar"></i></div><div class="lux-v3-actions"><button class="primary" onclick="window.luxPlatformV3.downloadFullBackup()">DESCARGAR TODO</button><label class="lux-v3-button">RESTAURAR<input id="lux-restore-file" type="file" accept="application/json" hidden onchange="window.luxPlatformV3.restoreFullBackup(event)"/></label></div><div id="lux-backup-output" class="lux-ops-output">Listo para crear un respaldo.</div></article>
      <article class="lux-ops-card"><h3>Fusionar cuentas duplicadas</h3><p>Los datos de origen pasan al destino; la ficha origen queda bloqueada y no vuelve a aparecer.</p><label class="lux-v3-field">ORIGEN<select id="lux-merge-source"><option value="">SELECCIONAR</option>${operationProfileOptions()}</select></label><label class="lux-v3-field">DESTINO<select id="lux-merge-target"><option value="">SELECCIONAR</option>${operationProfileOptions()}</select></label><div class="lux-v3-actions"><button class="danger" onclick="window.luxPlatformV3.mergeProfiles()">FUSIONAR CON CONFIRMACIÓN</button></div></article>
      <article class="lux-ops-card"><h3>Papelera de 30 días</h3><p>Solo después del plazo se permite el borrado físico.</p><div class="lux-v3-list">${trash.length?trash.map(row=>`<article class="lux-v3-row"><span class="lux-v3-row-avatar">🗑</span><div><strong>${esc(row.display_name)}</strong><small>${esc(row.email)} · borrar desde ${fmtDate(row.purge_after)}</small></div><span class="lux-v3-row-actions"><button class="approve" onclick="window.luxPlatformV3.restoreMember('${esc(row.user_id)}')">RESTAURAR</button><button class="reject" onclick="window.luxPlatformV3.purgeMember('${esc(row.user_id)}')" ${new Date(row.purge_after)>new Date()?'disabled':''}>BORRAR DEFINITIVO</button></span></article>`).join(''):'<p class="lux-v3-empty">La papelera está vacía.</p>'}</div></article>
      <article class="lux-ops-card lux-v3-span"><h3>Alias de Free Fire</h3><p>Un integrante puede tener varios nombres históricos. Desactiva un alias incorrecto sin borrar sus lecturas anteriores.</p><div class="lux-v3-grid three"><label class="lux-v3-field">INTEGRANTE<select id="lux-alias-player"><option value="">SELECCIONAR</option>${operationProfileOptions()}</select></label><label class="lux-v3-field">NOMBRE EN EL JUEGO<input id="lux-alias-name" maxlength="80"/></label><div class="lux-v3-actions"><button class="gold" onclick="window.luxPlatformV3.saveAlias()">GUARDAR ALIAS</button></div></div><div class="lux-v3-list">${aliases.slice(0,30).map(row=>`<article class="lux-v3-row"><span class="lux-v3-row-avatar">A</span><div><strong>${esc(row.game_name)}</strong><small>${esc(row.display_name)} · visto ${fmtDate(row.last_seen_at)} · confianza ${row.match_confidence??'—'}%</small></div><span class="lux-v3-row-actions">${statusBadge(row.is_active?'active':'inactive')}<button class="reject" onclick="window.luxPlatformV3.disableAlias('${esc(row.alias_id)}')">DESACTIVAR</button></span></article>`).join('')}</div></article>
      </div></section><section class="lux-v3-card"><header><div><span class="hub-kicker">TRAZABILIDAD</span><h2>Actividad administrativa</h2><p>Cada aprobación, expulsión, cambio de estado, importación y fusión deja registro.</p></div></header><div class="lux-v3-list">${audit.length?audit.map(row=>`<article class="lux-audit-row"><strong>${esc(row.action)}</strong><small>${fmtDate(row.created_at)} · ${esc(row.target_type)} ${esc(row.target_id||'')}</small><code>${esc(JSON.stringify(row.details||{}))}</code></article>`).join(''):'<p class="lux-v3-empty">Aún no hay actividad registrada en V3.</p>'}</div></section>`;
  }

  async function createInvite(){try{const rows=await core().rpc('owner_create_invite',{p_label:'Invitación FLUXO',p_hours:Number($('lux-invite-hours').value||72),p_max_uses:Number($('lux-invite-uses').value||1)});const row=Array.isArray(rows)?rows[0]:rows;const url=new URL(`${location.origin}${location.pathname}`);url.searchParams.set('invite',row.invite_token);$('lux-invite-output').textContent=`Vence: ${fmtDate(row.expires_at)}\n${url.href}`;await navigator.clipboard?.writeText(url.href).catch(()=>{});toast('✅ ENLACE CREADO Y COPIADO');}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}

  async function mergeProfiles(){const source=$('lux-merge-source').value,target=$('lux-merge-target').value;if(!source||!target||source===target){toast('⚠️ ELIGE DOS CUENTAS DIFERENTES');return;}if(!confirm('¿Fusionar todos los datos del origen dentro del destino? La ficha origen quedará bloqueada.'))return;try{await core().rpc('owner_merge_member_profiles',{p_source_id:source,p_target_id:target,p_reason:'Fusión confirmada desde operaciones'});toast('✅ CUENTAS FUSIONADAS');await core().renderAdmin();await renderOperations();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}
  async function restoreMember(id){try{await core().rpc('owner_restore_member',{p_user_id:id});toast('✅ CUENTA RESTAURADA');await core().renderAdmin();await renderOperations();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}
  async function purgeMember(id){if(!confirm('Este borrado es definitivo y ya pasó el plazo de recuperación. ¿Continuar?'))return;try{await core().rpc('owner_purge_member',{p_user_id:id});toast('✅ CUENTA BORRADA DEFINITIVAMENTE');await renderOperations();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}
  async function saveAlias(){const player=$('lux-alias-player').value,name=$('lux-alias-name').value.trim();if(!player||!name){toast('⚠️ ELIGE INTEGRANTE Y ESCRIBE EL NOMBRE');return;}try{await core().rpc('staff_set_game_alias',{p_player_id:player,p_game_name:name,p_notes:'Asignado manualmente',p_confidence:100});toast('✅ ALIAS GUARDADO');await renderOperations();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}
  async function disableAlias(id){try{await core().rpc('staff_disable_game_alias',{p_alias_id:id});toast('✅ ALIAS DESACTIVADO');await renderOperations();}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}

  function bytesToBase64(bytes){let binary='';const chunk=0x8000;for(let index=0;index<bytes.length;index+=chunk)binary+=String.fromCharCode(...bytes.subarray(index,index+chunk));return btoa(binary);}
  function base64ToBytes(value){const binary=atob(value),bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return bytes;}
  function setBackupProgress(done,total,message){const percent=total?Math.round(done*100/total):0;if($('lux-backup-bar'))$('lux-backup-bar').style.setProperty('--progress',`${percent}%`);if($('lux-backup-output'))$('lux-backup-output').textContent=`${message}\n${done}/${total} · ${percent}%`;}
  async function storageDownloadUrl(file){
    const data=await core().request(`/storage/v1/object/sign/${encodeURIComponent(file.bucket)}/${String(file.name).split('/').map(encodeURIComponent).join('/')}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:900})});
    const origin=new URL(core().publicUrl('lux-avatars','placeholder')).origin;
    return data?.signedURL?`${origin}/storage/v1${data.signedURL}`:'';
  }

  async function downloadFullBackup(){
    if(state.backupBusy||!appState().isOwner)return;state.backupBusy=true;
    try{
      const backup=await core().rpc('owner_export_platform_backup');
      const manifest=Array.isArray(backup.storage_manifest)?backup.storage_manifest:[];
      backup.storage_files=[];
      setBackupProgress(0,manifest.length,'Preparando archivos del clan…');
      for(let index=0;index<manifest.length;index++){
        const file=manifest[index];
        try{
          const url=await storageDownloadUrl(file),response=await fetch(url);
          if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const blob=await response.blob(),bytes=new Uint8Array(await blob.arrayBuffer());
          backup.storage_files.push({bucket:file.bucket,name:file.name,content_type:blob.type||file.mimetype||'application/octet-stream',content_base64:bytesToBase64(bytes)});
        }catch(error){backup.storage_files.push({bucket:file.bucket,name:file.name,error:errorText(error)});}
        setBackupProgress(index+1,manifest.length,`Copiando ${file.name}`);
      }
      const payload=new Blob([JSON.stringify(backup)],{type:'application/json'}),url=URL.createObjectURL(payload),link=document.createElement('a');
      link.href=url;link.download=`LUX_CLAN_RESPALDO_COMPLETO_${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
      if($('lux-backup-output'))$('lux-backup-output').textContent=`Respaldo completo descargado: ${backup.storage_files.filter(file=>!file.error).length}/${manifest.length} archivos.`;
      toast('✅ RESPALDO COMPLETO DESCARGADO');
    }catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);if($('lux-backup-output'))$('lux-backup-output').textContent=errorText(error);}finally{state.backupBusy=false;}
  }

  async function restoreFullBackup(event){
    const file=event?.target?.files?.[0];if(!file||!appState().isOwner)return;
    if(!confirm('La restauración actualizará datos existentes y repondrá archivos. No crea cuentas de Google. ¿Continuar con una validación?')){event.target.value='';return;}
    state.backupBusy=true;
    try{
      const backup=JSON.parse(await file.text());
      const validation=await core().rpc('owner_validate_platform_backup',{p_backup:backup});
      if(Number(validation.missing_accounts||0)>0&&!confirm(`Faltan ${validation.missing_accounts} cuentas Auth. Sus datos no podrán restaurarse hasta que esas personas vuelvan a iniciar sesión. ¿Restaurar las demás?`))return;
      const files=Array.isArray(backup.storage_files)?backup.storage_files.filter(item=>item.content_base64):[];
      setBackupProgress(0,files.length,'Restaurando imágenes…');
      for(let index=0;index<files.length;index++){
        const stored=files[index],bytes=base64ToBytes(stored.content_base64);
        await core().request(`/storage/v1/object/${encodeURIComponent(stored.bucket)}/${String(stored.name).split('/').map(encodeURIComponent).join('/')}`,{method:'POST',headers:{'Content-Type':stored.content_type||'application/octet-stream','x-upsert':'true'},body:new Blob([bytes],{type:stored.content_type})});
        setBackupProgress(index+1,files.length,`Restaurando ${stored.name}`);
      }
      const result=await core().rpc('owner_restore_platform_backup',{p_backup:backup});
      if($('lux-backup-output'))$('lux-backup-output').textContent=`Restauración terminada. Perfiles: ${result.profiles}. Registros: ${result.records}. Cuentas faltantes: ${result.missing_accounts}.`;
      toast('✅ RESPALDO RESTAURADO');await core().renderAdmin();
    }catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);if($('lux-backup-output'))$('lux-backup-output').textContent=errorText(error);}finally{state.backupBusy=false;if(event?.target)event.target.value='';}
  }

  function ensureNotificationBell(){
    if(!appState().user)return;
    document.querySelectorAll('#hub-member .lux-nav-actions,#hub-admin .lux-nav-actions,#lux-public-screen .lux-nav-actions').forEach(actions=>{
      if(actions.querySelector('.lux-notification-bell'))return;
      actions.insertAdjacentHTML('afterbegin','<button class="lux-notification-bell" type="button" onclick="window.luxPlatformV3.toggleNotifications()" aria-label="Notificaciones">🔔<b hidden>0</b></button>');
    });
  }
  function updateNotificationBell(count){ensureNotificationBell();document.querySelectorAll('.lux-notification-bell b').forEach(badge=>{badge.textContent=String(count);badge.hidden=!count;});}

  async function toggleNotifications(){
    let drawer=$('lux-notification-drawer');
    if(drawer){drawer.remove();return;}
    document.body.insertAdjacentHTML('beforeend','<aside id="lux-notification-drawer" class="lux-notification-drawer"><div class="lux-v3-section-head"><div><span class="hub-kicker">MI CUENTA</span><h3>Notificaciones</h3></div><button class="lux-v3-button" onclick="window.luxPlatformV3.markNotificationsRead()">MARCAR LEÍDAS</button></div><div id="lux-notification-list"><p class="lux-v3-empty">Cargando…</p></div></aside>');
    const rows=await core().request('/rest/v1/notifications?select=*&order=created_at.desc&limit=30').catch(()=>[]);
    const unread=rows.filter(row=>!row.read_at&&row.user_id).length;updateNotificationBell(unread);
    $('lux-notification-list').innerHTML=rows.length?rows.map(row=>`<article class="lux-notification-item ${!row.read_at?'unread':''}"><strong>${esc(row.title)}</strong><p>${esc(row.body)}</p><small>${fmtDate(row.created_at)}</small></article>`).join(''):'<p class="lux-v3-empty">No tienes notificaciones.</p>';
  }
  async function markNotificationsRead(){try{await core().rpc('mark_my_notifications_read',{p_ids:null});updateNotificationBell(0);$('lux-notification-drawer')?.remove();toast('✅ NOTIFICACIONES MARCADAS COMO LEÍDAS');}catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}}

  function showDialog(title,content){
    $('lux-v3-dialog')?.remove();document.body.insertAdjacentHTML('beforeend',`<div id="lux-v3-dialog" class="lux-v3-dialog" role="dialog" aria-modal="true"><section><div class="lux-v3-section-head"><div><span class="hub-kicker">FLUXO</span><h2>${esc(title)}</h2></div><button class="lux-v3-button" onclick="document.getElementById('lux-v3-dialog').remove()">CERRAR</button></div>${content}</section></div>`);
  }

  function injectShareAction(playerId){
    const modal=$('hub-modal-body');if(!modal||modal.querySelector('.lux-share-actions'))return;
    const member=appState().publicDirectory.get(playerId);if(!member)return;
    state.currentSharePlayer=member;
    const played=Number(member.matches_played||0),damage=Number(member.damage||0);
    modal.querySelector('.lux-public-player-stats')?.insertAdjacentHTML('afterend',`<section class="lux-advanced-stats"><article><b>${played}</b><small>PARTIDAS</small></article><article><b>${Number(member.win_rate||0)}%</b><small>VICTORIAS</small></article><article><b>${Number(member.kd||0)}</b><small>K/D</small></article><article><b>${Number(member.kills||0)}</b><small>BAJAS</small></article><article><b>${played?Math.round(damage/played):0}</b><small>DAÑO PROMEDIO</small></article><article><b>${Number(member.current_streak||0)}</b><small>RACHA</small></article></section><p class="lux-player-roles">${member.primary_game_role?`ROL PRINCIPAL: <b>${esc(member.primary_game_role)}</b>`:'ROL PRINCIPAL SIN DEFINIR'}${member.secondary_game_role?` · SECUNDARIO: <b>${esc(member.secondary_game_role)}</b>`:''}</p>`);
    modal.querySelector('.lux-public-profile-note')?.insertAdjacentHTML('beforeend','<div class="lux-share-actions"><button onclick="window.luxPlatformV3.shareCurrentProfile()">COMPARTIR PERFIL</button><button onclick="window.luxPlatformV3.copyCurrentProfile()">COPIAR ENLACE</button><button onclick="window.luxPlatformV3.showProfileQr()">MOSTRAR QR</button></div>');
  }
  function currentProfileUrl(){const member=state.currentSharePlayer;const url=new URL(`${location.origin}${location.pathname}`);url.searchParams.set('player',member?.public_slug||profileId(member));url.hash='ranking';return url.href;}
  async function copyCurrentProfile(){try{await navigator.clipboard.writeText(currentProfileUrl());toast('✅ ENLACE DEL PERFIL COPIADO');}catch(_){window.prompt('Copia este enlace:',currentProfileUrl());}}
  async function shareCurrentProfile(){const member=state.currentSharePlayer,url=currentProfileUrl();if(navigator.share){try{await navigator.share({title:`${profileName(member)} · FLUXO`,text:'Perfil competitivo de FLUXO',url});return;}catch(_){}}await copyCurrentProfile();}

  function showProfileQr(){
    const url=currentProfileUrl(),member=state.currentSharePlayer;
    if(typeof window.qrcode==='function'){
      const qr=window.qrcode(0,'M');qr.addData(url);qr.make();
      showDialog(`QR DE ${profileName(member).toUpperCase()}`,`<div class="lux-qr-card"><img src="${qr.createDataURL(6,12)}" alt="Código QR del perfil de ${esc(profileName(member))}"/><p>Escanea para abrir el perfil público.</p><button class="lux-v3-button gold" onclick="window.luxPlatformV3.copyCurrentProfile()">COPIAR ENLACE</button></div>`);
      return;
    }
    showDialog(`PERFIL DE ${profileName(member).toUpperCase()}`,`<div class="lux-qr-card"><p>Enlace público:</p><code>${esc(url)}</code><button class="lux-v3-button gold" onclick="window.luxPlatformV3.copyCurrentProfile()">COPIAR ENLACE</button></div>`);
  }

  function rankingStatsLine(row){
    const played=Number(row.matches_played||0),wins=Number(row.victories_total||0);
    return `${wins} victorias · ${Number(row.victories_4v4||0)} en 4v4 · ${played} partidas`;
  }

  async function ensureContextRankingPanel(context){
    ensurePanels();
    const page=document.querySelector(`#hub-${context} .hub-page`),id=`lux-${context}-ranking-panel`;
    if(!page)return null;
    let panel=$(id);
    if(panel)return panel;
    const seasons=await core().request('/rest/v1/seasons?select=id,name,is_current,starts_on&order=starts_on.desc',{},false).catch(()=>[]);
    const options=seasons.map(season=>`<option value="season:${esc(season.id)}">${season.is_current?'ACTUAL · ':''}${esc(season.name)}</option>`).join('');
    page.insertAdjacentHTML('beforeend',`<section id="${id}" class="lux-v3-panel lux-context-ranking-panel" hidden><section class="lux-v3-card"><header><div><span class="hub-kicker">CLASIFICACION OFICIAL</span><h2>Ranking del clan</h2><p>Una sola lista, basada unicamente en partidas aprobadas.</p></div></header><div class="lux-ranking-toolbar"><label>PERIODO<select id="lux-${context}-ranking-period" onchange="window.luxPlatformV3.renderPeriodRanking(this.value,'lux-${context}-ranking')"><option value="all">HISTORICO</option><option value="week">ESTA SEMANA</option><option value="month">ESTE MES</option><option value="current">TEMPORADA ACTUAL</option>${options}</select></label><p>Primero se ordena por victorias confirmadas.</p></div><div id="lux-${context}-ranking" class="lux-public-ranking"><p class="hub-empty lux-loading-placeholder">Cargando jugadores...</p></div></section></section>`);
    return $(id);
  }

  async function openContextRanking(context){
    if(context==='admin'&&!appState().isStaff)return false;
    const navigationToken=core().beginNavigation?.(`${context}:ranking`);
    try{
      window.luxHub?.setScreen?.(context);appState().navigationContext=context;core().renderNavigation?.();
      if(context==='member'&&await guardMember('ranking'))return true;
      const panel=await ensureContextRankingPanel(context);
      if(context==='admin')showOnlyAdmin(panel,'ranking');else showOnlyMember(panel,'ranking');
      await renderPeriodRanking($(`lux-${context}-ranking-period`)?.value||'all',`lux-${context}-ranking`);
      return true;
    }finally{
      const page=document.querySelector(`#hub-${context} .hub-page`),visible=[...(page?.children||[])].find(child=>!child.hidden&&!['lux-member-tabs','lux-admin-tabs'].includes(child.id));
      if(navigationToken!=null)core().endNavigation?.(navigationToken,visible);
    }
  }

  async function ensureRankingFilters(){
    const list=$('lux-public-ranking');if(!list)return;
    const card=list.closest('.lux-public-card');if(!card||$('lux-ranking-period'))return;
    const seasons=await core().request('/rest/v1/seasons?select=id,name,is_current,is_archived,starts_on,ends_on&order=starts_on.desc',{},false).catch(()=>[]);
    const options=seasons.map(season=>`<option value="season:${esc(season.id)}">${season.is_current?'ACTUAL · ':''}${esc(season.name)}</option>`).join('');
    list.insertAdjacentHTML('beforebegin',`<div class="lux-ranking-toolbar"><label>PERIODO<select id="lux-ranking-period" onchange="window.luxPlatformV3.renderPeriodRanking(this.value)"><option value="all">HISTÓRICO</option><option value="week">ESTA SEMANA</option><option value="month">ESTE MES</option><option value="current">TEMPORADA ACTUAL</option>${options}</select></label><p>Las estadísticas solo incluyen evidencias aprobadas.</p></div>`);
  }

  async function renderPeriodRanking(value='all',targetId='lux-public-ranking'){
    const list=$(targetId);if(!list)return;
    const [period,seasonId]=String(value||'all').split(':');
    if(!list.childElementCount)list.innerHTML='<p class="hub-empty lux-loading-placeholder">Calculando clasificación…</p>';
    list.classList.add('lux-list-refreshing');list.setAttribute('aria-busy','true');
    try{
      const rows=await core().rpc('get_period_ranking',{p_period:period==='season'?'season':period,p_season_id:seasonId||null},false);
      if($('lux-public-members'))$('lux-public-members').textContent=rows.length;
      if($('lux-public-wins'))$('lux-public-wins').textContent=rows.reduce((total,row)=>total+Number(row.victories_4v4||0),0);
      if($('lux-public-total'))$('lux-public-total').textContent=rows.reduce((total,row)=>total+Number(row.victories_total||0),0);
      list.innerHTML=rows.length?rows.map((row,index)=>`<button type="button" class="lux-public-row lux-period-row" data-fluxo-kd="${Number(row.kd||0)}" data-fluxo-damage="${Number(row.damage||0)}" data-fluxo-streak="${Number(row.current_streak||0)}" data-fluxo-matches="${Number(row.matches_played||0)}" onclick="window.luxSupabase.openPublicPlayer('${esc(row.player_id)}')"><i>#${index+1}</i>${avatar(row)}<div><strong>${esc(row.display_name)}</strong><small>${rankingStatsLine(row)}</small></div></button>`).join(''):'<p class="hub-empty">No hay resultados aprobados en este periodo.</p>';
    }catch(_){if(targetId==='lux-public-ranking'){await core().renderPublic();await ensureRankingFilters();}else list.innerHTML='<p class="hub-empty">No se pudo cargar el ranking. Intenta de nuevo.</p>';}
    finally{list.classList.remove('lux-list-refreshing');list.removeAttribute('aria-busy');}
  }

  async function showMemberSection(section){
    if(!appState().user){window.luxAccess?.openLogin?.('member');return true;}
    const navigationToken=core().beginNavigation?.(`member:${section}`);
    let handled=false;
    try{
      window.luxHub?.setScreen?.('member');
      appState().navigationContext='member';
      core().renderNavigation?.();
      if(await guardMember(section)){handled=true;return true;}
      ensurePanels();
      if(section==='matches'){const panel=$('lux-v3-member-matches');showOnlyMember(panel,'matches');await renderMemberMatches();handled=true;return true;}
      if(section==='events'){const panel=$('lux-v3-member-events');showOnlyMember(panel,'events');await renderMemberEvents();handled=true;return true;}
      if(section==='announcements'){const panel=$('lux-v3-member-announcements');showOnlyMember(panel,'announcements');await renderAnnouncements('lux-v3-member-announcements',false);handled=true;return true;}
      return false;
    }finally{
      const page=document.querySelector('#hub-member .hub-page');
      const visible=[...(page?.children||[])].find(child=>!child.hidden&&child.id!=='lux-member-tabs');
      if(navigationToken!=null)core().endNavigation?.(navigationToken,visible);
      if(!handled)core().animateView?.(visible);
    }
  }

  async function navigateAdmin(section){
    if(!appState().isStaff)return true;
    const navigationToken=core().beginNavigation?.(`admin:${section}`);
    try{
      window.luxHub?.setScreen?.('admin');appState().navigationContext='admin';ensurePanels();core().renderNavigation();
      if(section==='requests'){showOnlyAdmin($('lux-v3-admin-requests'),'requests');await renderAdminRequests();return true;}
      if(section==='matches'){showOnlyAdmin($('lux-v3-admin-matches'),'matches');await renderAdminMatches();return true;}
      if(section==='events'){showOnlyAdmin($('lux-v3-admin-events'),'events');await renderAdminEvents();return true;}
      if(section==='announcements'){showOnlyAdmin($('lux-v3-admin-announcements'),'announcements');await renderAnnouncements('lux-v3-admin-announcements',true);return true;}
      if(section==='operations'&&appState().isOwner){showOnlyAdmin($('lux-v3-admin-operations'),'operations');await renderOperations();return true;}
      return false;
    }finally{
      const page=document.querySelector('#hub-admin .hub-page');
      const visible=[...(page?.children||[])].find(child=>!child.hidden&&child.id!=='lux-admin-tabs');
      if(navigationToken!=null)core().endNavigation?.(navigationToken,visible);
    }
  }

  async function openDeepLinkedProfile(){
    const requested=new URLSearchParams(location.search).get('player');if(!requested)return;
    try{
      await core().renderPublic();
      const member=[...appState().publicDirectory.values()].find(row=>row.public_slug===requested||profileId(row)===requested);
      if(member){await window.luxSupabase.openRanking(null);await window.luxSupabase.openPublicPlayer(profileId(member));}
    }catch(_){/* El enlace puede reintentarse tras iniciar sesión. */}
  }

  async function createInviteLink(){
    try{
      const rows=await core().rpc('owner_create_invite',{p_label:'Invitacion FLUXO',p_hours:Number($('lux-invite-hours').value||72),p_max_uses:Number($('lux-invite-uses').value||1)});
      const row=Array.isArray(rows)?rows[0]:rows,url=new URL('./',location.href);url.searchParams.set('invite',row.invite_token);
      $('lux-invite-output').textContent=`Vence: ${fmtDate(row.expires_at)}\n${url.href}`;
      await navigator.clipboard?.writeText(url.href).catch(()=>{});toast('✅ ENLACE CREADO Y COPIADO');
    }catch(error){toast(`⚠️ ${errorText(error).toUpperCase()}`);}
  }

  function install(){
    state.core=window.luxSupabase?._core;if(!state.core)return;
    ensurePanels();syncProfileFields();
    const originalPublicPlayer=window.luxSupabase.openPublicPlayer;
    window.luxSupabase.openPublicPlayer=async playerId=>{await originalPublicPlayer(playerId);injectShareAction(playerId);};
    const originalOpenRanking=window.luxSupabase.openRanking;
    window.luxSupabase.openRanking=async context=>{
      if(context==='member'||context==='admin')return openContextRanking(context);
      await originalOpenRanking(null);await ensureRankingFilters();await renderPeriodRanking($('lux-ranking-period')?.value||'all');
    };
    let notificationFrame=0;
    const observer=new MutationObserver(()=>{if(notificationFrame)return;notificationFrame=requestAnimationFrame(()=>{notificationFrame=0;ensureNotificationBell();});});
    observer.observe(document.body,{subtree:true,childList:true});ensureNotificationBell();
    refreshAdminSummary();
    if(appState().user){
      core().request('/rest/v1/notifications?select=id&read_at=is.null&limit=100').then(rows=>updateNotificationBell(rows.length)).catch(()=>{});
      state.notificationTimer=setInterval(()=>core().request('/rest/v1/notifications?select=id&read_at=is.null&limit=100').then(rows=>updateNotificationBell(rows.length)).catch(()=>{}),90000);
    }
    setTimeout(openDeepLinkedProfile,500);
  }

  window.luxPlatformV3={guardMember,afterProfileSaved,showProfileWhilePending,showMemberSection,navigateAdmin,toggleMatchPlayer,submitMatch,
    analyzeMatchCapture,assignMatchOcrPlayer,ignoreMatchOcrPlayer,resolvePendingMatchPlayer,reviewMembership,saveMembershipStatus,reviewMatch,toggleReviewMatch,selectAllPendingMatches,approveSelectedMatches,openMatchCorrection,addCorrectionParticipant,saveMatchCorrection,createSeason,setSeasonState,respondEvent,createEvent,closeEvent,showRecommendedTeam,saveRecommendedTeam,createAnnouncement,archiveAnnouncement,
    refreshAdminSummary,createInvite:createInviteLink,copyGeneralJoinLink,saveAccessMode,mergeProfiles,restoreMember,purgeMember,saveAlias,disableAlias,downloadFullBackup,restoreFullBackup,
    toggleNotifications,markNotificationsRead,shareCurrentProfile,copyCurrentProfile,showProfileQr,renderPeriodRanking};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
