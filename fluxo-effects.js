/* FLUXO FX
 * Efectos visuales progresivos. No lee ni modifica datos de cuentas/clan. */
(() => {
  'use strict';

  const INTRO_KEY = 'fluxo_intro_seen_v1';
  const reduceMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const saveData = () => Boolean(navigator.connection?.saveData);
  const finePointer = () => Boolean(window.matchMedia?.('(hover:hover) and (pointer:fine)').matches);

  function createAmbient() {
    if (document.getElementById('fluxo-ambient')) return;
    const ambient = document.createElement('div');
    ambient.id = 'fluxo-ambient';
    ambient.setAttribute('aria-hidden', 'true');
    ambient.innerHTML = '<div class="fluxo-pointer-aura"></div><i class="fluxo-smoke fluxo-smoke--a"></i><i class="fluxo-smoke fluxo-smoke--b"></i>';
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 18; index += 1) {
      const particle = document.createElement('i');
      particle.className = 'fluxo-particle';
      particle.style.setProperty('--fx-x', `${(index * 37 + 11) % 98}%`);
      particle.style.setProperty('--fx-y', `${(index * 53 + 17) % 96}%`);
      particle.style.setProperty('--fx-size', `${2 + (index % 4)}px`);
      particle.style.setProperty('--fx-duration', `${12 + (index % 7) * 1.7}s`);
      particle.style.setProperty('--fx-delay', `${-(index % 9) * 1.2}s`);
      fragment.appendChild(particle);
    }
    ambient.appendChild(fragment);
    document.body.prepend(ambient);
  }

  function installPointerAura() {
    if (!finePointer() || reduceMotion()) return;
    let frame = 0, nextX = 0, nextY = 0;
    document.addEventListener('pointermove', event => {
      nextX = event.clientX;
      nextY = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--fluxo-pointer-x', `${nextX}px`);
        document.documentElement.style.setProperty('--fluxo-pointer-y', `${nextY}px`);
        frame = 0;
      });
    }, { passive:true });
  }

  function shouldShowIntro() {
    if (reduceMotion() || saveData()) return false;
    try { return localStorage.getItem(INTRO_KEY) !== '1'; } catch (_) { return false; }
  }

  function showIntro() {
    if (!shouldShowIntro() || document.getElementById('fluxo-cinematic-intro')) return;
    try { localStorage.setItem(INTRO_KEY, '1'); } catch (_) {}
    const intro = document.createElement('div');
    intro.id = 'fluxo-cinematic-intro';
    intro.setAttribute('role', 'presentation');
    intro.innerHTML = `<div class="fluxo-intro-core"><img class="fluxo-intro-logo" src="./ICONOS/FLUXO_LOGO.png" alt=""/><strong>FLUXO</strong><small>CENTRO COMPETITIVO DEL CLAN</small></div><span class="fluxo-intro-skip">TOCA PARA OMITIR</span>`;
    document.body.classList.add('fluxo-intro-running');
    document.body.appendChild(intro);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      intro.classList.add('fluxo-intro-leaving');
      document.body.classList.remove('fluxo-intro-running');
      setTimeout(() => intro.remove(), 380);
    };
    intro.addEventListener('click', close, { once:true });
    setTimeout(close, 2050);
  }

  const cardSelector = [
    '.hub-choice','.hub-card','.hub-member-row','.hub-rank','.lux-public-card',
    '.lux-public-row','.lux-member-public-row','.lux-v3-card','.lux-v3-row',
    '.lux-event-card','.lux-announcement','.lux-ops-card','.lux-admin-focus',
    '.lux-simple-actions>button','.lux-admin-actions>button','.card'
  ].join(',');

  function decorateCards(root = document) {
    const targets = [];
    if (root instanceof Element && root.matches(cardSelector)) targets.push(root);
    root.querySelectorAll?.(cardSelector).forEach(card => targets.push(card));
    targets.forEach(card => card.classList.add('fluxo-interactive-card'));
  }

  function installCardTilt() {
    if (!finePointer() || reduceMotion()) return;
    let current = null, frame = 0, eventX = 0, eventY = 0;
    document.addEventListener('pointermove', event => {
      const card = event.target.closest?.('.fluxo-interactive-card');
      if (!card) {
        if (current) {
          current.style.removeProperty('--fluxo-tilt-x');
          current.style.removeProperty('--fluxo-tilt-y');
          current = null;
        }
        return;
      }
      current = card;
      eventX = event.clientX;
      eventY = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        if (current) {
          const rect = current.getBoundingClientRect();
          const x = Math.max(-1, Math.min(1, (eventX - rect.left) / Math.max(1, rect.width) * 2 - 1));
          const y = Math.max(-1, Math.min(1, (eventY - rect.top) / Math.max(1, rect.height) * 2 - 1));
          current.style.setProperty('--fluxo-tilt-x', `${(-y * 1.25).toFixed(2)}deg`);
          current.style.setProperty('--fluxo-tilt-y', `${(x * 1.45).toFixed(2)}deg`);
        }
        frame = 0;
      });
    }, { passive:true });
    document.addEventListener('pointerout', event => {
      const card = event.target.closest?.('.fluxo-interactive-card');
      if (!card || card.contains(event.relatedTarget)) return;
      card.style.removeProperty('--fluxo-tilt-x');
      card.style.removeProperty('--fluxo-tilt-y');
      if (current === card) current = null;
    }, { passive:true });
  }

  const numeric = (row, name) => Number(row.dataset[`fluxo${name}`] || 0);

  function awardsFor(rows, row) {
    const definitions = [
      ['Kd','MEJOR K/D'],
      ['Damage','MÁS DAÑO'],
      ['Streak','MAYOR RACHA'],
      ['Matches','MÁS ACTIVO']
    ];
    return definitions.filter(([key]) => {
      const value = numeric(row, key);
      if (!(value > 0)) return false;
      return value === Math.max(...rows.map(candidate => numeric(candidate, key)));
    }).map(([, label]) => label);
  }

  function createPodium(container, rows) {
    const signature = rows.slice(0, 3).map(row => row.textContent.replace(/\s+/g, ' ').trim()).join('|');
    const existing = container.querySelector(':scope > .fluxo-podium');
    if (existing && container.dataset.fluxoPodiumSignature === signature) return;
    existing?.remove();
    rows.forEach(row => row.classList.remove('fluxo-podium-source'));
    const podium = document.createElement('section');
    podium.className = 'fluxo-podium';
    podium.setAttribute('aria-label', 'Podio del ranking');
    const labels = ['🥇','🥈','🥉'];
    const order = rows.length > 1 ? [1,0,2] : [0];
    order.filter(index => rows[index]).forEach(index => {
      const source = rows[index];
      const clone = source.cloneNode(true);
      clone.removeAttribute('id');
      clone.className = `fluxo-podium-player fluxo-podium-${['first','second','third'][index]}`;
      clone.querySelectorAll('.fluxo-awards,.fluxo-rank-medal').forEach(node => node.remove());
      const medal = document.createElement('span');
      medal.className = 'fluxo-rank-medal';
      medal.textContent = labels[index];
      clone.appendChild(medal);
      const awards = awardsFor(rows, source);
      if (index === 0) awards.unshift('MVP ACTUAL');
      if (awards.length) {
        const awardList = document.createElement('span');
        awardList.className = 'fluxo-awards';
        awardList.innerHTML = [...new Set(awards)].slice(0, 3).map(label => `<b class="fluxo-award">${label}</b>`).join('');
        clone.appendChild(awardList);
      }
      podium.appendChild(clone);
      source.classList.add('fluxo-podium-source');
    });
    container.prepend(podium);
    container.dataset.fluxoPodiumSignature = signature;
  }

  function decorateRankings(root = document) {
    const containers = [];
    if (root instanceof Element && root.matches('.lux-public-ranking')) containers.push(root);
    root.querySelectorAll?.('.lux-public-ranking').forEach(item => containers.push(item));
    containers.forEach(container => {
      const rows = [...container.children].filter(child => child.matches?.('button.lux-public-row,button.lux-period-row'));
      if (!rows.length) return;
      createPodium(container, rows);
    });
  }

  function decorateMvp() {
    const card = document.getElementById('admin-mvp')?.closest('.hub-mvp');
    const name = document.getElementById('admin-mvp-name')?.textContent?.trim();
    if (card) card.classList.toggle('fluxo-mvp-live', Boolean(name && !/sin mvp/i.test(name)));
  }

  function animateNumber(element) {
    if (reduceMotion() || element.dataset.fluxoCounted === '1') return;
    const raw = element.textContent.trim();
    const match = raw.match(/^([+-]?\d+(?:[.,]\d+)?)(%?)$/);
    if (!match) return;
    const target = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(target) || target <= 0) return;
    element.dataset.fluxoCounted = '1';
    const decimals = match[1].includes('.') || match[1].includes(',') ? 1 : 0;
    const suffix = match[2];
    const start = performance.now(), duration = 620;
    const tick = now => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = `${(target * eased).toFixed(decimals)}${suffix}`;
      if (progress < 1) requestAnimationFrame(tick);
      else element.textContent = raw;
    };
    requestAnimationFrame(tick);
  }

  function animateVisibleStats(root = document) {
    root.querySelectorAll?.('.lux-profile-key-stats b,.lux-player-stats b,.lux-advanced-stats b,.hub-modal-stats b').forEach(animateNumber);
  }

  function syncScanner(progress = null) {
    const preview = document.getElementById('lux-match-preview');
    if (!preview) return;
    const progressBar = document.getElementById('lux-match-ocr-progress');
    const active = progress != null ? progress < 100 : Boolean(progressBar && !progressBar.hidden);
    preview.classList.toggle('fluxo-scan-active', active && !preview.hidden);
    if (progress >= 100) setTimeout(() => preview.classList.remove('fluxo-scan-active'), 420);
  }

  function celebrateVictory({ count = 1, mvp = false } = {}) {
    if (reduceMotion()) return;
    document.getElementById('fluxo-victory-celebration')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'fluxo-victory-celebration';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `<div class="fluxo-victory-core"><img src="./ICONOS/FLUXO_LOGO.png" alt=""/><span>${mvp ? 'NUEVO MVP FLUXO' : 'RESULTADO CONFIRMADO'}</span><strong>${count > 1 ? `${count} VICTORIAS APROBADAS` : 'VICTORIA APROBADA'}</strong><small>El ranking y las estadísticas ya fueron actualizados.</small></div>`;
    const colors = ['#a8ff00','#d9ff73','#ffffff','#69ffbc'];
    for (let index = 0; index < 26; index += 1) {
      const confetti = document.createElement('i');
      confetti.className = 'fluxo-confetti';
      const angle = Math.PI * 2 * index / 26;
      const distance = 115 + (index % 6) * 22;
      confetti.style.setProperty('--confetti-color', colors[index % colors.length]);
      confetti.style.setProperty('--confetti-x', `${Math.cos(angle) * distance}px`);
      confetti.style.setProperty('--confetti-y', `${Math.sin(angle) * distance}px`);
      confetti.style.setProperty('--confetti-rotate', `${180 + index * 39}deg`);
      confetti.style.setProperty('--confetti-delay', `${(index % 5) * .025}s`);
      overlay.appendChild(confetti);
    }
    document.body.appendChild(overlay);
    navigator.vibrate?.([35,35,70]);
    setTimeout(() => overlay.remove(), 1800);
  }

  function observeDynamicUi() {
    let scheduled = false;
    const refresh = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        decorateCards();
        decorateRankings();
        decorateMvp();
        animateVisibleStats();
        syncScanner();
        scheduled = false;
      });
    };
    new MutationObserver(refresh).observe(document.body, {
      subtree:true,
      childList:true,
      attributes:true,
      attributeFilter:['hidden','class']
    });
    refresh();
  }

  function installEvents() {
    document.addEventListener('fluxo:scan-progress', event => syncScanner(Number(event.detail?.percent || 0)));
    document.addEventListener('fluxo:scan-preview', () => syncScanner(1));
    document.addEventListener('fluxo:victory-approved', event => celebrateVictory(event.detail || {}));
  }

  function install() {
    createAmbient();
    showIntro();
    installPointerAura();
    decorateCards();
    decorateRankings();
    decorateMvp();
    installCardTilt();
    installEvents();
    observeDynamicUi();
  }

  window.fluxoEffects = { celebrateVictory, decorateRankings, decorateCards };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
  else install();
})();

