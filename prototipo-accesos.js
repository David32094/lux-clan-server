/* Estructura local de LUX CLAN HUB: acceso público, integrante y líderes. */
(() => {
  'use strict';
  const STORAGE='lux_clan_demo_members_v1';
  const SESSION='lux_clan_local_session_v1';
  // El acceso real se instala en prototipo-supabase.js. Nunca guardes
  // contraseñas compartidas ni PINs de líderes dentro de un archivo público.
  const LEADERS=[];
  const $=id=>document.getElementById(id);
  const escape=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const toast=message=>window.showToast?.(message);
  function members(){try{const data=JSON.parse(localStorage.getItem(STORAGE)||'[]');return Array.isArray(data)?data:[]}catch(_){return[]}}
  function ordered(){return members().sort((a,b)=>(b.wins?.four||0)-(a.wins?.four||0)||(b.wins?.total||0)-(a.wins?.total||0)||String(a.name).localeCompare(String(b.name),'es'))}
  function initials(member){return escape(String(member.name||'?').trim().slice(0,1).toUpperCase())}
  function avatar(member,className='lux-access-avatar'){return member.avatar||member.thumbnail?`<img class="${className}" src="${member.avatar||member.thumbnail}" alt="${escape(member.name)}"/>`:`<span class="${className} lux-access-initial">${initials(member)}</span>`}
  function session(){try{return JSON.parse(sessionStorage.getItem(SESSION)||'null')}catch(_){return null}}
  function saveSession(data){sessionStorage.setItem(SESSION,JSON.stringify(data))}
  function closeLogin(){$('lux-login-modal').hidden=true}

  function renderPublic(){
    const all=ordered(), total4=all.reduce((sum,member)=>sum+Number(member.wins?.four||0),0), total=all.reduce((sum,member)=>sum+Number(member.wins?.total||0),0);
    $('lux-public-members').textContent=all.length;
    $('lux-public-wins').textContent=total4;
    $('lux-public-total').textContent=total;
    const podium=$('lux-public-podium');
    podium.innerHTML=all.slice(0,3).map((member,index)=>`<article><i>#${index+1}</i>${avatar(member,'lux-podium-avatar')}<strong>${escape(member.name)}</strong><small>${member.wins?.four||0} victorias 4v4</small></article>`).join('')||'<p class="hub-empty">Todavía no hay resultados confirmados.</p>';
    $('lux-public-ranking').innerHTML=all.length?all.map((member,index)=>`<article class="lux-public-row"><i>#${index+1}</i>${avatar(member)}<div><strong>${escape(member.name)}</strong><small>${escape(member.role||'Integrante')} · ${member.wins?.four||0} 4v4 · ${member.wins?.total||0} total</small></div></article>`).join(''):'<p class="hub-empty">El ranking aparecerá cuando se registren victorias aprobadas.</p>';
  }
  function renderMemberTop(){
    const target=$('lux-member-top'); if(!target)return;
    const all=ordered(), profile=all.find(member=>String(member.name).toLocaleLowerCase('es')===String($('hub-name')?.value||'').trim().toLocaleLowerCase('es'));
    const position=profile?all.findIndex(member=>member.id===profile.id)+1:0;
    target.innerHTML=`<div class="lux-member-top-head"><div><span class="hub-kicker">CLASIFICACIÓN ABIERTA</span><h3>Top del clan</h3></div><button type="button" onclick="window.luxAccess.openPublic()">VER TODO →</button></div><div class="lux-member-top-grid"><article><b>${position?`#${position}`:'—'}</b><small>MI POSICIÓN</small></article><article><b>${profile?.wins?.four||0}</b><small>MIS 4V4</small></article><section>${all.slice(0,5).map((member,index)=>`<p><b>#${index+1}</b><span>${escape(member.name)}</span><em>${member.wins?.four||0} 4v4</em></p>`).join('')||'<p class="lux-no-ranking">Aún no hay victorias aprobadas.</p>'}</section></div>`;
  }
  function renderLeaderSession(){const target=$('lux-leader-session'),data=session();if(target)target.textContent=data?.type==='leader'?`${data.name} · ${data.role}`:'Sesión local';}

  function loginWithGoogle(){
    if(window.luxSupabase?.loginWithGoogle){
      window.luxSupabase.loginWithGoogle();
    } else {
      toast('⚠️ Para iniciar sesión con Google, conecta Supabase en el repositorio de GitHub.');
    }
  }

  function openPublic(){window.luxHub.setScreen('public')}
  function openLogin(kind='member'){
    const modal=$('lux-login-modal');
    const googleSvg=`<svg width="20" height="20" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.74-.06-1.28-.19-1.84H9v3.34h4.96c-.1.83-.64 2.08-1.84 2.92l-.02.12 2.67 2.07.18.02c1.7-1.57 2.69-3.88 2.69-6.63z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.83-2.21c-.76.53-1.78.9-3.13.9-2.38 0-4.41-1.57-5.13-3.72l-.12.01-2.61 2.02-.04.11C2.58 15.93 5.56 18 9 18z"/><path fill="#FBBC05" d="M3.87 10.79c-.19-.58-.3-1.2-.3-1.79s.11-1.21.3-1.79l-.01-.12-2.62-2.03-.09.04C.42 6.55 0 7.72 0 9s.42 2.45 1.15 3.91l2.72-2.12z"/><path fill="#EA4335" d="M9 3.58c1.69 0 2.83.73 3.48 1.34l2.54-2.48C13.45.97 11.43 0 9 0 5.56 0 2.58 2.07 1.15 5.09l2.72 2.12C4.59 5.06 6.62 3.58 9 3.58z"/></svg>`;
    modal.innerHTML=`<div class="lux-login-box">
      <button class="lux-login-close" type="button" onclick="window.luxAccess.closeLogin()">×</button>
      <span class="hub-kicker">CUENTA DEL CLAN</span>
      <h2>Registrarse es gratis</h2>
      <p>Usa tu cuenta de Google para entrar. Sin correo ni contraseña.</p>
      <button class="lux-google-btn lux-google-btn--big" type="button" id="lux-google-fallback-btn" onclick="window.luxAccess.loginWithGoogle()">
        ${googleSvg}<span>CONTINUAR CON GOOGLE</span>
      </button>
      <p class="lux-auth-note">Al continuar aceptas que tu perfil de Google se usará para identificarte en el clan.</p>
    </div>`;
    modal.hidden=false;
    setTimeout(()=>document.getElementById('lux-google-fallback-btn')?.focus(),20);
  }
  function loginMember(){const user=$('lux-member-email')?.value.trim(),pass=$('lux-member-pass')?.value||'';if(!user||pass.length<4){toast('⚠️ ESCRIBE USUARIO Y UNA CLAVE DE 4 CARACTERES');return;}saveSession({type:'member',user});closeLogin();window.luxHub.setScreen('member');toast('✅ SESIÓN LOCAL DE INTEGRANTE ABIERTA');}
  function loginLeader(){const selected=LEADERS.find(item=>item.id===$('lux-leader-select')?.value),pin=$('lux-login-pin')?.value||'';if(!selected||pin!==selected.pin){toast('⛔ CLAVE DE LÍDER INCORRECTA');return;}saveSession({type:'leader',id:selected.id,name:selected.name,role:selected.role});closeLogin();window.luxHub.setScreen('admin');renderLeaderSession();toast(`👑 BIENVENIDA, ${selected.name.toUpperCase()}`);}

  function inject(){
    const hub=$('lux-clan-hub'),home=$('hub-home'),member=$('hub-member'),admin=$('hub-admin');
    if(!hub||!home||!member||!admin||$('lux-public-screen'))return false;
    home.querySelector('.hub-choices')?.insertAdjacentHTML('beforebegin','<button class="lux-public-entry" type="button" onclick="window.luxAccess.openPublic()"><span>🏆</span><div><strong>VER CLASIFICACIÓN</strong><small>Top, MVP y estadísticas públicas del clan</small></div><b>ABRIR →</b></button>');
    home.querySelector('.hub-choice.player')?.setAttribute('onclick',"window.luxAccess.openLogin('member')");
    home.querySelector('.hub-choice.leader')?.setAttribute('onclick',"window.luxAccess.openLogin('leader')");
    hub.insertAdjacentHTML('beforeend','<section id="lux-public-screen" class="lux-public-screen" hidden><nav class="hub-nav"><button type="button" onclick="window.luxHub.setScreen(\'home\')">← INICIO</button><strong>CLASIFICACIÓN PÚBLICA</strong><button type="button" onclick="window.luxAccess.openLogin(\'member\')">MI PERFIL →</button></nav><div class="hub-page"><header class="lux-public-head"><span class="hub-kicker">LUX CLAN · RESULTADOS ABIERTOS</span><h2>El equipo<br/><em>en números.</em></h2><p>Ranking basado solo en victorias registradas y aprobadas. Las capturas privadas no se muestran aquí.</p></header><div class="lux-public-stats"><article><b id="lux-public-members">0</b><small>INTEGRANTES</small></article><article><b id="lux-public-wins">0</b><small>VICTORIAS 4V4</small></article><article><b id="lux-public-total">0</b><small>VICTORIAS TOTALES</small></article></div><section class="lux-public-card"><span class="hub-kicker">TOP 3</span><h3>Jugadores destacados</h3><div id="lux-public-podium" class="lux-public-podium"></div></section><section class="lux-public-card"><span class="hub-kicker">RANKING GENERAL</span><h3>Clasificación del clan</h3><div id="lux-public-ranking" class="lux-public-ranking"></div></section></div></section>');
    member.querySelector('.hub-page')?.insertAdjacentHTML('beforeend','<section id="lux-member-top" class="lux-member-top"></section>');
    admin.querySelector('.hub-nav>strong')?.insertAdjacentHTML('beforeend','<small id="lux-leader-session">Sesión local</small>');
    document.body.insertAdjacentHTML('beforeend','<div id="lux-login-modal" hidden></div>');
    const style=document.createElement('style');
    style.textContent=`body.lux-hub-public>header,body.lux-hub-public>.tab-content,body.lux-hub-public>footer,body.lux-hub-public>#lux-rolebar,body.lux-hub-public>#leader-panel{display:none!important}#lux-public-screen[hidden],#lux-login-modal[hidden]{display:none!important}.lux-public-entry{display:grid;grid-template-columns:40px 1fr auto;align-items:center;gap:11px;width:100%;margin-bottom:12px;padding:14px 17px;border:1px solid #e8b54577;border-radius:15px;background:linear-gradient(135deg,#3a260d,#15100e);color:#fff;text-align:left;cursor:pointer}.lux-public-entry span{font-size:1.55rem}.lux-public-entry strong,.lux-public-entry b{display:block;font:1.2rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.3px}.lux-public-entry small{display:block;margin-top:3px;color:#cbbd9b;font-size:.7rem}.lux-public-entry b{color:#ffdb72;font-size:.85rem}.lux-public-screen{min-height:100vh;background:radial-gradient(circle at 80% 0,#3d2607,transparent 28%),#09090d;color:#f4f1eb}.lux-public-head h2{margin:7px 0 14px;color:#fff;font:clamp(3rem,7vw,5.7rem)/.82 'Bebas Neue',Impact,sans-serif;letter-spacing:3px}.lux-public-head h2 em{color:#ffc445;font-style:normal}.lux-public-head p{max-width:590px;color:#b8b0a8;line-height:1.55}.lux-public-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:24px 0 15px}.lux-public-stats article,.lux-public-card{border:1px solid #ffffff18;border-radius:15px;background:linear-gradient(145deg,#171219,#0d0d12)}.lux-public-stats article{padding:18px 9px;text-align:center}.lux-public-stats b{display:block;color:#ffcf5c;font:2.5rem/.9 'Bebas Neue',Impact,sans-serif}.lux-public-stats small{display:block;margin-top:6px;color:#aaa39b;font-size:.58rem;font-weight:800;letter-spacing:1px}.lux-public-card{margin-top:15px;padding:20px}.lux-public-card h3,.lux-member-top h3{margin:6px 0 13px;color:#fff;font:1.85rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.5px}.lux-public-podium{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.lux-public-podium article{display:grid;justify-items:center;gap:6px;padding:14px 6px;border:1px solid #ffc44844;border-radius:12px;background:#ffc4480d;text-align:center}.lux-public-podium i{color:#ffcf5c;font:1.25rem 'Bebas Neue',Impact,sans-serif}.lux-podium-avatar,.lux-access-avatar{width:45px;height:45px;display:grid;place-items:center;border-radius:50%;object-fit:cover}.lux-podium-avatar{width:57px;height:57px;border:2px solid #ffc445}.lux-access-initial{background:linear-gradient(135deg,#f4b335,#803b09);color:#fff;font:1.3rem 'Bebas Neue',Impact,sans-serif}.lux-public-podium strong{overflow:hidden;max-width:100%;font:1.1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.8px;text-overflow:ellipsis;white-space:nowrap}.lux-public-podium small{color:#d6c79d;font-size:.61rem}.lux-public-row{display:grid;grid-template-columns:34px 45px 1fr;align-items:center;gap:10px;margin-top:7px;padding:9px;border:1px solid #ffffff14;border-radius:10px;background:#ffffff06}.lux-public-row>i{color:#ffcf5c;font:1.25rem 'Bebas Neue',Impact,sans-serif;text-align:center}.lux-public-row div{display:grid;gap:3px}.lux-public-row strong{font:1.15rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.9px}.lux-public-row small{color:#a9a39b;font-size:.64rem}.lux-member-top{margin-top:15px;padding:18px;border:1px solid #e7b63c55;border-radius:16px;background:linear-gradient(145deg,#241b10,#111015)}.lux-member-top-head{display:flex;align-items:center;justify-content:space-between;gap:9px}.lux-member-top-head button{border:1px solid #ffc44566;border-radius:7px;background:#ffc44514;color:#ffda73;padding:7px 9px;font:.88rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.7px;cursor:pointer}.lux-member-top-grid{display:grid;grid-template-columns:95px 95px 1fr;gap:8px;margin-top:12px}.lux-member-top-grid>article{padding:10px 5px;border:1px solid #ffffff15;border-radius:10px;background:#0008;text-align:center}.lux-member-top-grid>article b{display:block;color:#ffcf5c;font:2rem/.9 'Bebas Neue',Impact,sans-serif}.lux-member-top-grid small{display:block;margin-top:6px;color:#aaa49c;font-size:.53rem;font-weight:800;letter-spacing:.8px}.lux-member-top-grid section{padding:3px 8px}.lux-member-top-grid p{display:grid;grid-template-columns:25px 1fr auto;gap:6px;margin:4px 0;color:#eee;font-size:.72rem}.lux-member-top-grid p>b{color:#ffcf5c}.lux-member-top-grid p>em{color:#d5c79f;font-size:.64rem;font-style:normal}.lux-no-ranking{display:block!important;color:#aaa!important}.hub-nav #lux-leader-session{display:block;margin-top:1px;color:#ffb66e;font:600 .56rem 'Segoe UI',sans-serif;letter-spacing:.4px}.hub-nav>strong{display:grid}.hub-nav>strong small{font:600 .56rem 'Segoe UI',sans-serif}.lux-login-close{position:absolute;right:12px;top:7px;border:0;background:transparent;color:#fff;font-size:2rem;cursor:pointer}.lux-login-box{position:relative;width:min(405px,100%);padding:25px;border:1px solid #ff220077;border-radius:17px;background:#121018;box-shadow:0 24px 70px #000}.lux-login-box h2{margin:8px 0;color:#fff;font:2.4rem 'Bebas Neue',Impact,sans-serif;letter-spacing:2px}.lux-login-box p{margin:0 0 15px;color:#aaa4aa;font-size:.82rem;line-height:1.5}.lux-login-box label{display:block;margin-top:10px;color:#ff8b76;font:1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px}.lux-login-box input,.lux-login-box select{display:block;width:100%;height:45px;margin-top:5px;border:1px solid #ff220055;border-radius:9px;background:#050507;color:#fff;padding:8px 11px;font:16px 'Segoe UI',sans-serif}.lux-login-primary{width:100%;margin-top:18px;border:0;border-radius:9px;background:linear-gradient(135deg,#ff3119,#a80000);color:#fff;padding:11px;font:1.1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.5px;cursor:pointer}.lux-google-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:11px;margin-top:12px;border:1px solid #ffffff35;border-radius:9px;background:#ffffff;color:#1a1a1a;font:700 1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.2px;cursor:pointer;box-shadow:0 4px 14px #00000040;transition:transform .15s,background-color .15s}.lux-google-btn:hover{background:#f0f0f0;transform:translateY(-1px)}.lux-google-btn svg{flex-shrink:0}.lux-google-btn--big{padding:14px;font-size:1.1rem}.lux-auth-note{margin-top:12px;color:#827c84;font-size:.66rem;line-height:1.4;text-align:center}.lux-login-box small{display:block;margin-top:12px;color:#827c84;font-size:.66rem}#lux-login-modal{position:fixed;z-index:100001;inset:0;display:grid;place-items:center;padding:18px;background:#000b;backdrop-filter:blur(7px)}@media(max-width:620px){.lux-public-entry{padding:13px}.lux-public-stats{gap:5px}.lux-public-stats article{padding:13px 3px}.lux-public-stats b{font-size:2rem}.lux-public-card{padding:15px}.lux-public-podium{gap:5px}.lux-public-podium article{padding:10px 3px}.lux-public-podium strong{font-size:.95rem}.lux-member-top-grid{grid-template-columns:82px 82px 1fr}.lux-member-top-grid section{padding:2px 0}.hub-nav #lux-leader-session{display:none}}`;
    document.head.appendChild(style);
    document.addEventListener('click',event=>{const text=event.target.closest('button')?.innerText||'';if(/GUARDAR PERFIL|REGISTRAR VICTORIA/i.test(text))setTimeout(()=>{renderMemberTop();renderPublic();},400);});
    return true;
  }
  function install(){
    if(!inject()||!window.luxHub)return;
    const previous=window.luxHub.setScreen;
    window.luxHub.setScreen=name=>{
      const publicScreen=$('lux-public-screen');
      if(name==='public'){
        document.body.classList.remove('lux-hub-home','lux-hub-member','lux-hub-admin','lux-hub-editor');
        document.body.classList.add('lux-hub-public');
        ['hub-home','hub-member','hub-admin'].forEach(id=>$(id).hidden=true);
        publicScreen.hidden=false;renderPublic();return;
      }
      publicScreen.hidden=true;
      document.body.classList.remove('lux-hub-public');
      previous(name);
      if(name==='member')renderMemberTop();
      if(name==='admin')renderLeaderSession();
    };
    window.luxAccess={openPublic,openLogin,closeLogin,loginMember,loginLeader,renderPublic,renderMemberTop};
    renderPublic();renderMemberTop();renderLeaderSession();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
