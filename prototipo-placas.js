/* Panel de actividad del clan. La logica segura y el OCR viven en los modulos
 * de Supabase y prototipo-placas-ocr.js. Este archivo solo crea la interfaz. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const localDate = () => {
    const date = new Date(), offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
  };

  function inject() {
    const admin = $('hub-admin');
    const page = admin?.querySelector('.hub-page');
    const nav = admin?.querySelector('.hub-nav>span');
    if (!admin || !page || !nav || $('lux-plates-panel')) return false;

    nav.insertAdjacentHTML('afterbegin', '<button type="button" onclick="window.luxPlates.show()">PLACAS</button>');
    page.insertAdjacentHTML('beforeend', `
      <section id="lux-plates-panel" class="lux-plates-panel" hidden>
        <header class="lux-plates-head">
          <div>
            <span class="hub-kicker">ACTIVIDAD DE FREE FIRE</span>
            <h2>Placas del clan</h2>
            <p>Sube una captura del panel de miembros. El sistema lee los nombres y contadores; tú solo confirmas a quién pertenece cada cuenta.</p>
          </div>
          <button type="button" onclick="window.luxPlates.back()">← RESUMEN</button>
        </header>

        <section class="lux-plates-guide" aria-label="Cómo funciona el ranking de placas">
          <article><b>🛡️ GLORIA</b><span>Puntos de actividad del clan.</span></article>
          <article><b>🏷️ PLACAS</b><span>Contador de placas del jugador.</span></article>
          <article><b>ESTA SEMANA</b><span>Se reemplaza con la lectura más alta de la semana.</span></article>
          <article><b>TOTAL</b><span>Guarda el valor más alto observado; nunca suma la misma captura dos veces.</span></article>
        </section>

        <div class="lux-plates-workspace">
          <section class="lux-activity-import">
            <div class="lux-section-title">
              <div><span class="hub-kicker">NUEVA LECTURA</span><h3>Importar captura</h3></div>
              <span class="lux-activity-step">1</span>
            </div>
            <p class="lux-muted">Usa una captura completa y nítida del listado de integrantes. No recortes los nombres ni las cuatro columnas.</p>
            <div class="lux-activity-fields">
              <label>FECHA DE LA CAPTURA<input id="lux-activity-date" type="date"/></label>
              <label class="lux-activity-upload">CAPTURA DEL PANEL<input id="lux-activity-file" type="file" accept="image/jpeg,image/png,image/webp"/></label>
            </div>
            <button id="lux-activity-analyze" class="lux-primary-action" type="button">🔎 LEER CAPTURA</button>
            <div id="lux-activity-progress" class="lux-activity-progress" hidden aria-live="polite"><i></i><span>Preparando reconocimiento…</span></div>
            <div id="lux-activity-preview" class="lux-activity-preview" hidden></div>
          </section>

          <section id="lux-activity-review" class="lux-activity-review" hidden>
            <div class="lux-section-title">
              <div><span class="hub-kicker">CONFIRMACIÓN</span><h3>Revisar jugadores</h3></div>
              <span class="lux-activity-step">2</span>
            </div>
            <p class="lux-muted">Corrige cualquier lectura. Si el nombre del juego no coincide, responde “¿Quién es?” una sola vez: quedará recordado para las próximas capturas.</p>
            <div class="lux-activity-table-head" aria-hidden="true"><span>FILA / CUENTA</span><span>GLORIA<br/>SEM. · TOTAL</span><span>PLACAS<br/>SEM. · TOTAL</span><span>INTEGRANTE</span></div>
            <div id="lux-activity-rows" class="lux-activity-rows"></div>
            <div class="lux-activity-review-actions">
              <button id="lux-activity-add-row" type="button">+ AGREGAR FILA</button>
              <button id="lux-activity-reset" type="button">CANCELAR</button>
              <button id="lux-activity-save" class="lux-primary-action" type="button">✓ GUARDAR LECTURA</button>
            </div>
          </section>

          <section class="lux-plates-rank">
            <div class="lux-section-title"><div><span class="hub-kicker">CLASIFICACIÓN</span><h3>Ranking de actividad</h3></div></div>
            <p class="lux-muted">Ordenado por placas de esta semana y después por el total. Pulsa un jugador para ver su historial.</p>
            <div id="lux-plates-ranking"></div>
          </section>
        </div>
      </section>`);

    document.body.insertAdjacentHTML('beforeend', '<div id="lux-plates-modal" hidden></div>');
    const style = document.createElement('style');
    style.textContent = `
      #lux-plates-panel[hidden],#lux-plates-modal[hidden],#lux-activity-review[hidden],#lux-activity-preview[hidden],#lux-activity-progress[hidden]{display:none!important}
      .lux-plates-panel{--plate-gold:#ffc846;--plate-red:#ff4936;--plate-line:#ffffff16;color:#fff}
      .lux-plates-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:16px;padding:4px 2px}
      .lux-plates-head h2{margin:5px 0 6px;font:clamp(2.6rem,5vw,4.8rem)/.9 'Bebas Neue',Impact,sans-serif;letter-spacing:2px}
      .lux-plates-head p{max-width:720px;margin:0;color:#aaa4ad;line-height:1.5}
      .lux-plates-head>button,.lux-activity-review-actions>button{border:1px solid #ffffff2c;border-radius:9px;background:#ffffff09;color:#ddd;padding:10px 13px;font:1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px;cursor:pointer}
      .lux-plates-guide{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
      .lux-plates-guide article{display:grid;gap:4px;padding:12px 13px;border:1px solid var(--plate-line);border-radius:12px;background:linear-gradient(145deg,#171219,#0d0c11)}
      .lux-plates-guide b{color:var(--plate-gold);font:1.05rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px}
      .lux-plates-guide span,.lux-muted{color:#9f99a2;font-size:.75rem;line-height:1.45}
      .lux-plates-workspace{display:grid;gap:12px}
      .lux-activity-import,.lux-activity-review,.lux-plates-rank{padding:20px;border:1px solid var(--plate-line);border-radius:16px;background:linear-gradient(145deg,#171219,#0d0c12)}
      .lux-section-title{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .lux-section-title h3{margin:4px 0;color:#fff;font:2rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.5px}
      .lux-activity-step{display:grid;place-items:center;width:37px;height:37px;border:1px solid #ffc84666;border-radius:50%;background:#ffc84612;color:var(--plate-gold);font:1.3rem 'Bebas Neue',Impact,sans-serif}
      .lux-activity-fields{display:grid;grid-template-columns:minmax(180px,.38fr) minmax(260px,1fr);gap:10px;margin-top:15px}
      .lux-activity-fields label{color:#ff9b86;font:1rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px}
      .lux-activity-fields input{box-sizing:border-box;display:block;width:100%;min-width:0;max-width:100%;min-height:47px;margin-top:5px;border:1px solid #ff3a295c;border-radius:10px;background:#050507;color:#fff;padding:9px 11px;font:16px 'Segoe UI',sans-serif}
      .lux-activity-upload{padding:0}
      .lux-primary-action{border:0!important;border-radius:10px!important;background:linear-gradient(135deg,#ff3826,#bd130a)!important;color:#fff!important;box-shadow:0 8px 25px #ff1d101d;padding:12px 16px!important;font:1.15rem 'Bebas Neue',Impact,sans-serif!important;letter-spacing:1.3px!important;cursor:pointer}
      #lux-activity-analyze{width:100%;margin-top:13px}
      .lux-primary-action:disabled,#lux-activity-analyze:disabled{filter:grayscale(.65);opacity:.6;cursor:wait}
      .lux-activity-progress{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-top:12px;color:#ddd;font-size:.75rem}
      .lux-activity-progress i{grid-column:1/-1;display:block;height:5px;overflow:hidden;border-radius:10px;background:#ffffff12}
      .lux-activity-progress i::after{content:'';display:block;width:var(--ocr-progress,8%);height:100%;border-radius:inherit;background:linear-gradient(90deg,#ff3725,#ffc846);transition:width .2s ease}
      .lux-activity-preview{margin-top:12px;overflow:hidden;border:1px solid #ffffff18;border-radius:12px;background:#050507;text-align:center}
      .lux-activity-preview img{display:block;width:100%;max-height:390px;object-fit:contain}
      .lux-activity-preview small{display:block;padding:8px;color:#938d96}
      .lux-activity-table-head{display:grid;grid-template-columns:minmax(250px,1.2fr) minmax(145px,.7fr) minmax(145px,.7fr) minmax(190px,1fr);gap:9px;margin:15px 43px 6px 0;color:#8d8790;font:.75rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.8px;text-align:center}
      .lux-activity-rows{display:grid;gap:8px}
      .lux-activity-row{display:grid;grid-template-columns:minmax(250px,1.2fr) minmax(145px,.7fr) minmax(145px,.7fr) minmax(190px,1fr) 34px;gap:9px;align-items:center;padding:9px;border:1px solid #ffffff13;border-radius:12px;background:#ffffff05}
      .lux-activity-row.is-unmatched{border-color:#ffc84665;background:#ffc84608}
      .lux-activity-account{display:grid;grid-template-columns:112px minmax(0,1fr);gap:9px;align-items:center}
      .lux-activity-crop{width:112px;height:56px;border:1px solid #ffffff18;border-radius:7px;background:#050507;object-fit:cover}
      .lux-activity-account label,.lux-activity-assign label{display:grid;gap:4px;color:#a49da5;font-size:.61rem}
      .lux-activity-row input,.lux-activity-row select{width:100%;min-width:0;height:40px;border:1px solid #ffffff1e;border-radius:8px;background:#050507;color:#fff;padding:7px 8px;font:14px 'Segoe UI',sans-serif}
      .lux-activity-numbers{display:grid;grid-template-columns:1fr 1fr;gap:5px}
      .lux-activity-numbers input{text-align:center;font-weight:700}
      .lux-activity-assign small{display:block;margin-top:4px;color:#ffc65c;font-size:.59rem;line-height:1.25}
      .lux-activity-remove{display:grid;place-items:center;width:32px;height:32px;border:1px solid #ff4e4360;border-radius:8px;background:#ff160c12;color:#ff8179;cursor:pointer}
      .lux-activity-review-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:13px}
      .lux-activity-review-actions #lux-activity-add-row{margin-right:auto}
      .lux-plates-rank>.lux-muted{margin-top:0}
      #lux-plates-ranking{display:grid;gap:7px;margin-top:12px}
      .lux-plate-row{display:grid;grid-template-columns:38px 52px minmax(150px,1fr) repeat(4,minmax(80px,.45fr));align-items:center;gap:9px;width:100%;padding:10px;border:1px solid #ffffff14;border-radius:11px;background:#ffffff05;color:#fff;text-align:left;cursor:pointer}
      .lux-plate-row:hover{border-color:#ffc84666;background:#ffc84608}
      .lux-plate-row>i{color:var(--plate-gold);font:1.45rem 'Bebas Neue',Impact,sans-serif;text-align:center}
      .lux-plate-avatar{width:52px;height:52px;display:grid;place-items:center;border-radius:50%;object-fit:cover}
      .lux-access-initial.lux-plate-avatar{background:linear-gradient(135deg,#dc9419,#714000);font:1.25rem 'Bebas Neue',Impact,sans-serif}
      .lux-plate-player{display:grid;gap:3px;min-width:0}.lux-plate-player strong{overflow:hidden;font:1.2rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1px;text-overflow:ellipsis;white-space:nowrap}.lux-plate-player small{color:#958f98;font-size:.62rem}
      .lux-plate-stat{display:grid;gap:2px;text-align:center}.lux-plate-stat b{color:#fff;font:1.35rem 'Bebas Neue',Impact,sans-serif}.lux-plate-stat small{color:#938c96;font-size:.52rem;letter-spacing:.5px}.lux-plate-stat.week b{color:var(--plate-gold)}
      .lux-public-plates>p{color:#9c959e}.lux-public-plates #lux-public-plates-ranking{display:grid;gap:7px}.lux-public-plate-row{display:grid;grid-template-columns:30px 42px minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;padding:8px;border:1px solid #ffffff14;border-radius:10px;background:#ffffff05;color:#fff;text-align:left;cursor:pointer}.lux-public-plate-row:hover{border-color:#ffc84666;background:#ffc84608}.lux-public-plate-row>b{color:#ffc846;font:1.15rem 'Bebas Neue',Impact,sans-serif;text-align:center}.lux-public-plate-avatar{width:42px;height:42px;display:grid;place-items:center;border-radius:50%;object-fit:cover}.lux-public-plate-row>span{display:grid;gap:2px;font:1.05rem 'Bebas Neue',Impact,sans-serif;letter-spacing:.7px}.lux-public-plate-row small{color:#969099;font:600 .57rem 'Segoe UI',sans-serif;letter-spacing:0}.lux-public-plate-row em{color:#ffd878;font:.85rem 'Bebas Neue',Impact,sans-serif;font-style:normal}.lux-plates-public-empty{color:#9c959e!important}
      #lux-plates-modal{position:fixed;z-index:100002;inset:0;overflow:auto;padding:18px;background:#000c;backdrop-filter:blur(7px)}
      .lux-plates-modal-box{position:relative;width:min(850px,100%);margin:25px auto;padding:24px;border:1px solid #ffc84670;border-radius:17px;background:#121018;color:#fff}
      .lux-plates-close{position:absolute;right:12px;top:10px;width:38px;height:38px;border:1px solid #ffffff28;border-radius:50%;background:#070709;color:#fff;font-size:1.6rem;cursor:pointer}
      .lux-plates-modal-box h2{margin:5px 45px 5px 0;font:2.5rem 'Bebas Neue',Impact,sans-serif;letter-spacing:1.5px}.lux-plates-modal-box>p{color:#9b949d}
      .lux-plate-history{display:grid;gap:8px;margin-top:14px}.lux-plate-history article{display:grid;grid-template-columns:minmax(110px,1fr) repeat(4,minmax(80px,.6fr));align-items:center;gap:7px;padding:11px;border:1px solid #ffffff14;border-radius:10px;background:#ffffff05}.lux-plate-history strong{font:1.1rem 'Bebas Neue',Impact,sans-serif}.lux-plate-history span{display:grid;text-align:center}.lux-plate-history b{font:1.2rem 'Bebas Neue',Impact,sans-serif}.lux-plate-history small{color:#958f97;font-size:.55rem}
      .lux-legacy-plates{margin-top:16px;border-top:1px solid #ffffff14;padding-top:12px}.lux-legacy-plates summary{color:#aaa3ac;cursor:pointer}.lux-legacy-plates>section{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:10px}.lux-legacy-plates figure{overflow:hidden;margin:0;border:1px solid #ffffff14;border-radius:9px;background:#08080a}.lux-legacy-plates img{display:block;width:100%;height:120px;object-fit:cover}.lux-legacy-plates figcaption{padding:7px;color:#aaa;font-size:.7rem}
      @media(max-width:900px){.lux-plates-guide{grid-template-columns:1fr 1fr}.lux-activity-table-head{display:none}.lux-activity-row{grid-template-columns:1fr 1fr 34px}.lux-activity-account,.lux-activity-assign{grid-column:1/-1}.lux-activity-remove{grid-column:3;grid-row:2}.lux-plate-row{grid-template-columns:32px 46px minmax(130px,1fr) repeat(2,minmax(70px,.5fr))}.lux-plate-avatar{width:46px;height:46px}.lux-plate-stat.glory{display:none}}
      @media(max-width:620px){.lux-plates-head{display:grid;align-items:start}.lux-plates-head>button{justify-self:start}.lux-plates-guide{grid-template-columns:1fr}.lux-activity-import,.lux-activity-review,.lux-plates-rank{padding:15px 11px}.lux-activity-fields{grid-template-columns:1fr}.lux-activity-upload input{font-size:12px;padding:9px 6px}.lux-activity-row{grid-template-columns:1fr 1fr 31px;padding:7px}.lux-activity-account{grid-template-columns:88px minmax(0,1fr)}.lux-activity-crop{width:88px;height:50px}.lux-activity-review-actions{display:grid;grid-template-columns:1fr 1fr}.lux-activity-review-actions #lux-activity-add-row{margin:0}.lux-activity-review-actions #lux-activity-save{grid-column:1/-1}.lux-plate-row{grid-template-columns:29px 43px minmax(0,1fr) 67px;padding:8px;gap:7px}.lux-plate-avatar{width:43px;height:43px}.lux-plate-stat.total-plates{display:none}.lux-plate-stat.week-plates{display:grid}.lux-plate-stat.week-plates small{font-size:.48rem}.lux-plate-history article{grid-template-columns:1fr 1fr}.lux-plate-history article>strong{grid-column:1/-1}.lux-plates-modal-box{margin:4px auto;padding:20px 13px}}
    `;
    document.head.appendChild(style);
    return true;
  }

  function fallbackShow() {
    const page = $('hub-admin')?.querySelector('.hub-page');
    const panel = $('lux-plates-panel');
    if (!page || !panel) return;
    [...page.children].forEach(child => { child.hidden = child !== panel; });
    panel.hidden = false;
    window.luxPlateImport?.prepare?.();
  }

  function install() {
    if (!inject()) return;
    window.luxPlates = {
      ...(window.luxPlates || {}),
      show:fallbackShow,
      back:() => window.luxHub?.showAdminSummary?.(),
      closeGallery:() => { const modal = $('lux-plates-modal'); if (modal) modal.hidden = true; document.body.classList.remove('hub-no-scroll'); }
    };
    const date = $('lux-activity-date');
    if (date) date.value = localDate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
