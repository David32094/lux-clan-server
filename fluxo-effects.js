/* FLUXO FX
 * Efectos visuales progresivos. No lee ni modifica datos de cuentas/clan. */
(() => {
  'use strict';

  const INTRO_KEY = 'fluxo_intro_seen_v1';
  const reduceMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const saveData = () => Boolean(navigator.connection?.saveData);
  const finePointer = () => Boolean(window.matchMedia?.('(hover:hover) and (pointer:fine)').matches);
  const tabSelector = '.lux-member-tabs,.lux-admin-tabs,.lux-context-tabs';
  const tabButtonSelector = '.lux-member-tabs>button,.lux-admin-tabs>button,.lux-context-tabs>button';
  const tiltSelector = '.hub-choice,.hub-card,.lux-public-card,.lux-v3-card,.lux-event-card,.lux-announcement,.lux-ops-card,.card';
  const observedTabs = new WeakSet();
  let statObserver = null;

  function detectPerformanceProfile() {
    const memory = Number(navigator.deviceMemory || 0);
    const cores = Number(navigator.hardwareConcurrency || 0);
    const touchDevice = !finePointer();
    const lite = reduceMotion() || saveData() || touchDevice || (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4);
    document.documentElement.classList.toggle('fluxo-lite', lite);
    document.documentElement.classList.toggle('fluxo-touch', touchDevice);
  }

  function createAmbient() {
    if (document.getElementById('fluxo-ambient')) return;
    const ambient = document.createElement('div');
    ambient.id = 'fluxo-ambient';
    ambient.setAttribute('aria-hidden', 'true');
    ambient.innerHTML = '<div class="fluxo-pointer-aura"></div><i class="fluxo-smoke fluxo-smoke--a"></i><i class="fluxo-smoke fluxo-smoke--b"></i>';
    const fragment = document.createDocumentFragment();
    const particleCount = document.documentElement.classList.contains('fluxo-lite') ? 8 : 18;
    for (let index = 0; index < particleCount; index += 1) {
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
    if (!finePointer() || reduceMotion() || document.documentElement.classList.contains('fluxo-lite')) return;
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
      intro.style.pointerEvents = 'none';
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
    let current = null, currentRect = null, frame = 0, eventX = 0, eventY = 0;
    const reset = () => {
      if (current) {
        current.style.removeProperty('--fluxo-tilt-x');
        current.style.removeProperty('--fluxo-tilt-y');
        current.classList.remove('fluxo-tilt-active');
      }
      current = null;
      currentRect = null;
    };
    document.addEventListener('pointerover', event => {
      const card = event.target.closest?.('.fluxo-interactive-card');
      if (!card || !card.matches(tiltSelector) || card === current) return;
      reset();
      current = card;
      currentRect = card.getBoundingClientRect();
      card.classList.add('fluxo-tilt-active');
    }, { passive:true });
    document.addEventListener('pointermove', event => {
      if (!current || !currentRect) return;
      eventX = event.clientX;
      eventY = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        if (current && currentRect) {
          const x = Math.max(-1, Math.min(1, (eventX - currentRect.left) / Math.max(1, currentRect.width) * 2 - 1));
          const y = Math.max(-1, Math.min(1, (eventY - currentRect.top) / Math.max(1, currentRect.height) * 2 - 1));
          current.style.setProperty('--fluxo-tilt-x', `${(-y * 1.25).toFixed(2)}deg`);
          current.style.setProperty('--fluxo-tilt-y', `${(x * 1.45).toFixed(2)}deg`);
        }
        frame = 0;
      });
    }, { passive:true });
    document.addEventListener('pointerout', event => {
      if (!current || current.contains(event.relatedTarget)) return;
      reset();
    }, { passive:true });
    window.addEventListener('scroll', reset, { passive:true, capture:true });
    window.addEventListener('resize', reset, { passive:true });
  }

  function installRipples() {
    if (!finePointer() || document.documentElement.classList.contains('fluxo-touch')) return;
    document.addEventListener('pointerdown', event => {
      const button = event.target.closest?.('button');
      if (!button || button.disabled || event.button > 0 || event.pointerType === 'touch' || reduceMotion()) return;
      /* Un botón flotante cambiaría de coordenadas si se fuerza a position:relative
         durante el efecto. Los cierres deben permanecer totalmente inmóviles. */
      const buttonPosition = getComputedStyle(button).position;
      if (buttonPosition === 'absolute' || buttonPosition === 'fixed') return;
      button.classList.add('fluxo-ripple-host');
      const rect = button.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 1.8;
      const ripple = document.createElement('i');
      ripple.className = 'fluxo-ripple';
      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
      ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
      button.appendChild(ripple);
      const cleanup = () => {
        ripple.remove();
        if (!button.querySelector(':scope > .fluxo-ripple')) button.classList.remove('fluxo-ripple-host');
      };
      ripple.addEventListener('animationend', cleanup, { once:true });
      setTimeout(cleanup, 650);
    }, { passive:true });
  }

  function syncTabGlider(container) {
    if (!container?.isConnected) return;
    let glider = container.querySelector(':scope > .fluxo-tab-glider');
    if (!glider) {
      glider = document.createElement('i');
      glider.className = 'fluxo-tab-glider';
      glider.setAttribute('aria-hidden', 'true');
      container.appendChild(glider);
      container.classList.add('fluxo-tabs-ready');
    }
    const active = container.querySelector(':scope > button.active');
    if (!active || container.hidden || container.closest('[hidden]')) {
      glider.style.opacity = '0';
      return;
    }
    glider.style.width = `${active.offsetWidth}px`;
    glider.style.transform = `translate3d(${active.offsetLeft}px,0,0)`;
    glider.style.opacity = '1';
  }

  function discoverTabs(root = document) {
    const containers = [];
    if (root instanceof Element) {
      if (root.matches(tabSelector)) containers.push(root);
      root.querySelectorAll?.(tabSelector).forEach(container => containers.push(container));
      const parent = root.closest?.(tabSelector);
      if (parent) containers.push(parent);
    } else root.querySelectorAll?.(tabSelector).forEach(container => containers.push(container));
    [...new Set(containers)].forEach(container => {
      syncTabGlider(container);
      if (observedTabs.has(container)) return;
      observedTabs.add(container);
      if ('ResizeObserver' in window) new ResizeObserver(() => syncTabGlider(container)).observe(container);
    });
  }

  function syncAllTabGliders() {
    document.querySelectorAll(tabSelector).forEach(syncTabGlider);
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
    if (root instanceof Element && root.closest('.lux-public-ranking')) containers.push(root.closest('.lux-public-ranking'));
    root.querySelectorAll?.('.lux-public-ranking').forEach(item => containers.push(item));
    [...new Set(containers)].forEach(container => {
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
    const selector = '.lux-profile-key-stats b,.lux-player-stats b,.lux-advanced-stats b,.hub-modal-stats b';
    const targets = [];
    if (root instanceof Element && root.matches(selector)) targets.push(root);
    root.querySelectorAll?.(selector).forEach(element => targets.push(element));
    targets.forEach(element => {
      if (statObserver) statObserver.observe(element);
      else animateNumber(element);
    });
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

  function optimizeImages(root = document) {
    const images = [];
    if (root instanceof HTMLImageElement) images.push(root);
    root.querySelectorAll?.('img').forEach(image => images.push(image));
    images.forEach(image => {
      image.decoding = 'async';
      if (!image.matches('.fluxo-home-logo,.fluxo-intro-logo,.hdr-brand img') && !image.closest('.lux-player-hero')) image.loading = 'lazy';
    });
  }

  function prepareDynamicNode(node) {
    if (!(node instanceof Element) || node.matches('.fluxo-ripple,.fluxo-confetti')) return;
    decorateCards(node);
    decorateRankings(node);
    discoverTabs(node);
    animateVisibleStats(node);
    optimizeImages(node);
  }

  function observeDynamicUi() {
    statObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        statObserver.unobserve(entry.target);
        animateNumber(entry.target);
      });
    }, { rootMargin:'30px' }) : null;

    let frame = 0;
    const pendingNodes = new Set();
    const pendingTabs = new Set();
    let refreshMvp = false;
    let refreshScanner = false;
    const flush = () => {
      frame = 0;
      pendingNodes.forEach(prepareDynamicNode);
      pendingTabs.forEach(syncTabGlider);
      pendingNodes.clear();
      pendingTabs.clear();
      if (refreshMvp) decorateMvp();
      if (refreshScanner) syncScanner();
      refreshMvp = false;
      refreshScanner = false;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(flush); };
    new MutationObserver(records => {
      records.forEach(record => {
        if (record.type === 'childList') {
          record.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) pendingNodes.add(node);
          });
          if (record.target.closest?.('#admin-mvp,.hub-mvp')) refreshMvp = true;
          if (record.target.closest?.('#lux-match-preview,#lux-match-ocr-progress')) refreshScanner = true;
        } else if (record.type === 'attributes') {
          const target = record.target;
          if (target.matches?.(tabButtonSelector) || target.matches?.(tabSelector)) pendingTabs.add(target.closest(tabSelector) || target);
          if (record.attributeName === 'hidden') {
            discoverTabs(target);
            animateVisibleStats(target);
          }
          if (target.matches?.('#lux-match-preview,#lux-match-ocr-progress')) refreshScanner = true;
        }
      });
      schedule();
    }).observe(document.body, {
      subtree:true,
      childList:true,
      attributes:true,
      attributeFilter:['hidden','class']
    });

    decorateCards();
    decorateRankings();
    decorateMvp();
    discoverTabs();
    animateVisibleStats();
    optimizeImages();
    syncScanner();
  }

  function installEvents() {
    document.addEventListener('fluxo:scan-progress', event => syncScanner(Number(event.detail?.percent || 0)));
    document.addEventListener('fluxo:scan-preview', () => syncScanner(1));
    document.addEventListener('fluxo:victory-approved', event => celebrateVictory(event.detail || {}));
    document.addEventListener('fluxo:navigation-end', () => requestAnimationFrame(syncAllTabGliders));
    document.addEventListener('click', event => {
      if (event.target.closest?.(tabButtonSelector)) requestAnimationFrame(syncAllTabGliders);
    }, { passive:true });
    document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('fluxo-paused', document.hidden));
    window.addEventListener('orientationchange', () => requestAnimationFrame(syncAllTabGliders), { passive:true });
  }

  function install() {
    detectPerformanceProfile();
    createAmbient();
    showIntro();
    installPointerAura();
    decorateCards();
    decorateRankings();
    decorateMvp();
    installCardTilt();
    installRipples();
    installEvents();
    observeDynamicUi();
  }

  window.fluxoEffects = { celebrateVictory, decorateRankings, decorateCards };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
  else install();
})();
