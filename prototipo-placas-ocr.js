/* Reconocimiento asistido del panel de actividad de Free Fire.
 * El OCR propone datos; una líder siempre confirma la identidad antes de guardar. */
(() => {
  'use strict';

  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
  const MAX_FILE = 10 * 1024 * 1024;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const toast = message => window.showToast?.(message);
  const localDate = () => {
    const date = new Date(), offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
  };
  const state = { file:null, hash:'', objectUrl:'', canvas:null, rows:[], members:[], aliases:new Map(), ready:false, busy:false };
  let scriptPromise = null;

  const LOOKALIKE_CHARS = {
    'Ø':'O','ø':'o','Ł':'L','ł':'l','Đ':'D','đ':'d','Ð':'D','ð':'d','Þ':'TH','þ':'th','Æ':'AE','æ':'ae','Œ':'OE','œ':'oe','ß':'ss',
    'А':'A','а':'a','В':'B','в':'b','Е':'E','е':'e','К':'K','к':'k','М':'M','м':'m','Н':'H','н':'h','О':'O','о':'o',
    'Р':'P','р':'p','С':'C','с':'c','Т':'T','т':'t','Х':'X','х':'x','У':'Y','у':'y',
    'Α':'A','α':'a','Β':'B','β':'b','Ε':'E','ε':'e','Ζ':'Z','Η':'H','η':'h','Ι':'I','ι':'i','Κ':'K','κ':'k','Μ':'M','μ':'m','Ν':'N','ν':'v','Ο':'O','ο':'o','Ρ':'P','ρ':'p','Τ':'T','τ':'t','Χ':'X','χ':'x'
  };
  function transliterateName(value) {
    return [...String(value || '')].map(char => LOOKALIKE_CHARS[char] ?? char).join('');
  }
  function normalizeName(value) {
    return transliterateName(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleUpperCase('es').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 80);
  }
  function nameVariants(value) {
    const spaced = transliterateName(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleUpperCase('es')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    const variants = new Set();
    const add = candidate => {
      const normalized = normalizeName(candidate);
      if (normalized.length >= 2) variants.add(normalized);
    };
    add(spaced);
    add(spaced.replace(/\s+\d{1,3}$/u, ''));
    const tokens = spaced.split(' ').filter(Boolean);
    if (tokens.length > 1 && /^(?:LX|LUX|GPA|IAM|TEAM|CLAN)$/u.test(tokens[0])) add(tokens.slice(1).join(' '));
    [...variants].forEach(candidate => {
      add(candidate.replace(/\d{1,3}$/u, ''));
      add(candidate.replace(/^(?:LX|LUX|GPA|IAM|TEAM|CLAN)/u, ''));
      add(candidate.replace(/^X{1,3}(?=[A-Z])|X{1,3}$/gu, ''));
    });
    return [...variants];
  }
  function safeNumber(value) {
    const parsed = Number(String(value ?? '').replace(/[^0-9]/g, ''));
    return Number.isFinite(parsed) ? Math.min(100000000, Math.max(0, Math.round(parsed))) : 0;
  }
  function memberId(member) { return member?.id || member?.player_id || ''; }
  function memberName(member) { return member?.display_name || member?.name || 'Jugador'; }

  function setDirectory(members) {
    if (!Array.isArray(members)) return;
    state.members = members.filter(member => memberId(member)).sort((a, b) => memberName(a).localeCompare(memberName(b), 'es'));
  }

  function progress(percent, message) {
    const box = $('lux-activity-progress');
    if (!box) return;
    box.hidden = false;
    box.style.setProperty('--ocr-progress', `${Math.max(5, Math.min(100, percent))}%`);
    const label = box.querySelector('span');
    if (label) label.textContent = message;
  }
  function hideProgress() { if ($('lux-activity-progress')) $('lux-activity-progress').hidden = true; }
  function setBusy(value) {
    state.busy = Boolean(value);
    [$('lux-activity-analyze'), $('lux-activity-save'), $('lux-activity-add-row'), $('lux-activity-reset')].filter(Boolean).forEach(button => { button.disabled = state.busy; });
  }

  function hashFile(file) {
    return file.arrayBuffer().then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(digest => [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''));
  }
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d', { alpha:false }).drawImage(image, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo abrir la captura')); };
      image.src = url;
    });
  }
  function ocrCanvas(source) {
    const scale = Math.max(1, Math.min(2.2, 2000 / source.width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    const context = canvas.getContext('2d', { willReadFrequently:true });
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = image.data;
    for (let index = 0; index < data.length; index += 4) {
      const gray = data[index] * .299 + data[index + 1] * .587 + data[index + 2] * .114;
      const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.55 + 138));
      // Tesseract reconoce con más precisión texto oscuro sobre fondo claro.
      data[index] = data[index + 1] = data[index + 2] = 255 - contrasted;
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }
  function cropRow(source, topRatio, bottomRatio) {
    const x = Math.round(source.width * .045);
    const y = Math.max(0, Math.round(source.height * topRatio));
    const width = Math.round(source.width * .30);
    const height = Math.max(1, Math.round(source.height * (bottomRatio - topRatio)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(260, width * 2);
    canvas.height = Math.max(80, height * 2);
    canvas.getContext('2d').drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .86);
  }
  function cropNameLine(source, topRatio, bottomRatio, binary = false) {
    const rowTop = source.height * topRatio;
    const rowHeight = source.height * (bottomRatio - topRatio);
    const x = Math.round(source.width * .135);
    const y = Math.max(0, Math.round(rowTop + rowHeight * .18));
    const width = Math.round(source.width * .155);
    const height = Math.max(18, Math.round(rowHeight * .46));
    const scale = Math.max(2.5, Math.min(5, 150 / height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(420, Math.round(width * scale));
    canvas.height = Math.max(105, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha:false, willReadFrequently:true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < image.data.length; index += 4) {
      const gray = image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114;
      const contrasted = Math.max(0, Math.min(255, (gray - 112) * 2.25 + 130));
      const value = binary ? (gray >= 118 ? 0 : 255) : 255 - contrasted;
      image.data[index] = image.data[index + 1] = image.data[index + 2] = value;
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }
  function cropMetrics(source) {
    const x = Math.round(source.width * .30), y = Math.round(source.height * .08);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * .55);
    canvas.height = Math.round(source.height * .90);
    const context = canvas.getContext('2d', { alpha:false, willReadFrequently:true });
    context.drawImage(source, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < image.data.length; index += 4) {
      const value = image.data[index] < 150 ? 0 : 255;
      image.data[index] = image.data[index + 1] = image.data[index + 2] = value;
    }
    context.putImageData(image, 0, 0);
    return { canvas, offsetX:x, offsetY:y };
  }

  function loadTesseract() {
    if (window.Tesseract?.createWorker) return Promise.resolve(window.Tesseract);
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESSERACT_URL;
      script.crossOrigin = 'anonymous';
      script.onload = () => window.Tesseract?.createWorker ? resolve(window.Tesseract) : reject(new Error('El lector visual no inició'));
      script.onerror = () => reject(new Error('No se pudo descargar el lector visual'));
      document.head.appendChild(script);
    });
    return scriptPromise;
  }
  function collectWords(data) {
    const words = [];
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.words)) {
        node.words.forEach(word => {
          if (word?.text && word?.bbox) words.push({ text:String(word.text).trim(), confidence:Number(word.confidence || 0), bbox:word.bbox });
        });
        return;
      }
      ['blocks','paragraphs','lines'].forEach(key => Array.isArray(node[key]) && node[key].forEach(walk));
    };
    walk(data);
    if (!words.length && Array.isArray(data?.words)) data.words.forEach(word => word?.text && word?.bbox && words.push(word));
    const seen = new Set();
    return words.filter(word => {
      if (!word.text) return false;
      const key = `${word.text}|${word.bbox.x0}|${word.bbox.y0}|${word.bbox.x1}|${word.bbox.y1}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function center(word) {
    return { x:(word.bbox.x0 + word.bbox.x1) / 2, y:(word.bbox.y0 + word.bbox.y1) / 2 };
  }
  function metricValue(text) {
    const compact = String(text || '').replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[^0-9]/g, '');
    return compact ? Number(compact) : null;
  }

  function clusterMetrics(words, width, height) {
    const numeric = words.map(word => ({ ...word, value:metricValue(word.text), ...center(word) }))
      .filter(word => word.value !== null && word.x > width * .30 && word.x < width * .84 && word.y > height * .09);
    const tolerance = Math.max(18, height * .034);
    const groups = [];
    numeric.sort((a, b) => a.y - b.y).forEach(word => {
      let group = groups.find(item => Math.abs(item.y - word.y) <= tolerance);
      if (!group) { group = { y:word.y, words:[] }; groups.push(group); }
      group.words.push(word);
      group.y = group.words.reduce((sum, item) => sum + item.y, 0) / group.words.length;
    });
    return groups.filter(group => group.words.length >= 1).sort((a, b) => a.y - b.y).slice(0, 60);
  }
  function completeMetricGroups(groups, height) {
    if (groups.length < 2) return groups;
    const differences = groups.slice(1).map((group, index) => group.y - groups[index].y).filter(value => value > height * .09 && value < height * .24).sort((a, b) => a - b);
    const spacing = differences.length ? differences[Math.floor(differences.length / 2)] : height * .177;
    const completed = [...groups];
    while (completed[0].y - spacing > height * .105) completed.unshift({ y:completed[0].y - spacing, words:[], synthetic:true });
    while (completed[completed.length - 1].y + spacing < height * .965) completed.push({ y:completed[completed.length - 1].y + spacing, words:[], synthetic:true });
    return completed.slice(0, 60);
  }
  function closestMetric(group, target, width) {
    const candidate = group.words.reduce((best, word) => Math.abs(word.x - width * target) < Math.abs((best?.x ?? Infinity) - width * target) ? word : best, null);
    return candidate && Math.abs(candidate.x - width * target) < width * .075 ? candidate.value : 0;
  }
  function extractName(words, rowY, width, height) {
    const tolerance = Math.max(23, height * .042);
    const candidates = words.map(word => ({ ...word, ...center(word) }))
      .filter(word => word.x > width * .065 && word.x < width * .345 && Math.abs(word.y - rowY) < tolerance)
      .filter(word => !/^(N[VW][L1]?|MIEMBROS|ESTA|SEMANA|TOTAL|ESTADO|HACE|MINUTOS?|HORAS?)$/i.test(word.text))
      .filter(word => metricValue(word.text) === null || /\p{L}/u.test(word.text));
    candidates.sort((a, b) => a.x - b.x);
    const tokens = candidates.map(word => word.text.replace(/^[_.,:;]+|[_.,:;]+$/g, ''))
      .filter(token => (token.match(/[\p{L}\p{N}]/gu) || []).length >= 2)
      .filter((token, index, all) => index === 0 || token.toLocaleUpperCase('es') !== all[index - 1].toLocaleUpperCase('es'));
    return tokens.join(' ').replace(/\s+/g, ' ').replace(/\bN[vw][l1]?\.?\s*\d+.*$/i, '').trim().slice(0, 80);
  }
  function editSimilarity(a, b) {
    if (!a || !b) return 0;
    const previous = Array(b.length + 1).fill(0).map((_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let diagonal = previous[0]; previous[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const old = previous[j];
        previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = old;
      }
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
  }
  function similarity(first, second) {
    const firstVariants = nameVariants(first), secondVariants = nameVariants(second);
    let best = 0;
    firstVariants.forEach(a => secondVariants.forEach(b => {
      if (a === b) { best = 1; return; }
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length > b.length ? a : b;
      let score = editSimilarity(a, b);
      if (shorter.length >= 4 && longer.includes(shorter)) score = Math.max(score, .78 + .18 * (shorter.length / longer.length));
      best = Math.max(best, score);
    }));
    return best;
  }
  function bestCandidates(row) {
    const candidates = new Map();
    const add = (playerId, displayName, score, source) => {
      if (!playerId) return;
      const current = candidates.get(playerId);
      if (!current || score > current.score) candidates.set(playerId, { playerId, displayName, score, source });
    };
    [...new Set(state.aliases.values())].forEach(alias => add(alias.player_id, alias.game_name, similarity(row.gameName, alias.game_name || alias.alias_key), 'alias'));
    state.members.forEach(member => add(memberId(member), memberName(member), similarity(row.gameName, memberName(member)), 'profile'));
    return [...candidates.values()].sort((a, b) => b.score - a.score);
  }
  function matchRow(row) {
    if (/^Jugador\s+\d+$/i.test(String(row.gameName || '').trim())) return { ...row, playerId:'', matchedBy:'', suggestionId:'' };
    const variants = nameVariants(row.gameName);
    const alias = variants.map(key => state.aliases.get(key)).find(Boolean);
    if (alias) return { ...row, playerId:alias.player_id, matchedBy:'alias', suggestionId:'' };
    const exact = state.members.find(member => nameVariants(memberName(member)).some(key => variants.includes(key)));
    if (exact) return { ...row, playerId:memberId(exact), matchedBy:'profile', suggestionId:'' };
    const candidates = bestCandidates(row), best = candidates[0], second = candidates[1];
    const safeAutoMatch = best?.score >= .96 && best.score - (second?.score || 0) >= .08;
    if (safeAutoMatch) return { ...row, playerId:best.playerId, matchedBy:best.source, suggestionId:'', matchScore:best.score };
    return { ...row, playerId:'', matchedBy:'', suggestionId:best?.score >= .50 ? best.playerId : '', matchScore:best?.score || 0 };
  }
  function extractRows(words, canvas) {
    const width = canvas.width, height = canvas.height;
    const groups = completeMetricGroups(clusterMetrics(words, width, height), height);
    return groups.map((group, index) => {
      const previous = groups[index - 1]?.y ?? Math.max(height * .08, group.y - height * .08);
      const next = groups[index + 1]?.y ?? Math.min(height, group.y + height * .08);
      const top = index ? (previous + group.y) / 2 : Math.max(height * .07, group.y - (next - group.y) / 2);
      const bottom = index < groups.length - 1 ? (group.y + next) / 2 : Math.min(height, group.y + (group.y - previous) / 2);
      return {
        id:crypto.randomUUID?.() || `${Date.now()}-${index}`,
        gameName:extractName(words, group.y, width, height) || `Jugador ${index + 1}`,
        gloryWeek:closestMetric(group, .407, width),
        gloryTotal:closestMetric(group, .522, width),
        platesWeek:closestMetric(group, .648, width),
        platesTotal:closestMetric(group, .758, width),
        crop:cropRow(state.canvas, top / height, bottom / height),
        confidence:Math.round(group.words.reduce((sum, word) => sum + Number(word.confidence || 0), 0) / Math.max(1, group.words.length)),
        topRatio:top / height,
        bottomRatio:bottom / height
      };
    });
  }
  function cleanRecognizedName(value) {
    return String(value || '')
      .replace(/[|!{}\[\]"'`~]+/g, ' ')
      .replace(/[^\p{L}\p{N}_ .\-\u00d7]+/gu, ' ')
      .replace(/\b(?:N[VW]L?|LVL)\.?\s*\d+.*$/iu, '')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  async function recognizeRowNames(worker, Tesseract, rows) {
    await worker.setParameters({
      tessedit_char_whitelist:'',
      tessedit_pageseg_mode:Tesseract.PSM?.SINGLE_LINE || '7',
      preserve_interword_spaces:'1',
      user_defined_dpi:'300'
    });
    for (let index = 0; index < rows.length; index += 1) {
      state.ocrStage = { start:72 + (index / rows.length) * 18, span:18 / rows.length, label:`Leyendo nombre ${index + 1} de ${rows.length}` };
      progress(72 + Math.round(((index + 1) / rows.length) * 18), `Leyendo nombre ${index + 1} de ${rows.length}\u2026`);
      try {
        const candidates = [{ name:rows[index].gameName, confidence:Math.max(5, rows[index].confidence / 3) }];
        for (const binary of [false, true]) {
          const line = cropNameLine(state.canvas, rows[index].topRatio, rows[index].bottomRatio, binary);
          const result = await worker.recognize(line, {}, { blocks:true, text:true });
          const candidate = cleanRecognizedName(result.data?.text || collectWords(result.data).map(word => word.text).join(' '));
          if (normalizeName(candidate).length >= 3 && !/^(?:MIEMBROS|ESTADO|TOTAL|SEMANA)$/i.test(candidate)) {
            candidates.push({ name:candidate, confidence:Number(result.data?.confidence || 0) });
          }
        }
        const scored = candidates.map(candidate => {
          const knownScore = bestCandidates({ gameName:candidate.name })[0]?.score || 0;
          const cleanLength = Math.min(18, normalizeName(candidate.name).length);
          return { ...candidate, score:knownScore * 100 + candidate.confidence * .30 + cleanLength * .35 };
        }).sort((a, b) => b.score - a.score);
        rows[index].gameName = scored[0]?.name || rows[index].gameName;
        rows[index].nameConfidence = Math.round(Number(scored[0]?.confidence || 0));
      } catch (_) {
        rows[index].nameConfidence = 0;
      }
    }
    return rows.map(matchRow);
  }

  function memberOptions(row) {
    const options = state.members.map(member => {
      const id = memberId(member), suggested = id === row.suggestionId && !row.playerId;
      return `<option value="${esc(id)}"${id === row.playerId ? ' selected' : ''}>${suggested ? '⭐ POSIBLE: ' : ''}${esc(memberName(member))}</option>`;
    }).join('');
    return `<option value=""${row.playerId ? '' : ' selected'}>— ¿QUIÉN ES ESTA PERSONA? —</option>${options}`;
  }
  function renderRows() {
    const target = $('lux-activity-rows');
    const review = $('lux-activity-review');
    if (!target || !review) return;
    review.hidden = false;
    target.innerHTML = state.rows.length ? state.rows.map((row, index) => `<article class="lux-activity-row${row.playerId ? '' : ' is-unmatched'}" data-row-id="${esc(row.id)}">
      <div class="lux-activity-account">${row.crop ? `<img class="lux-activity-crop" src="${row.crop}" alt="Fila ${index + 1} detectada"/>` : '<span class="lux-activity-crop"></span>'}<label>NOMBRE EN EL JUEGO<input data-field="gameName" maxlength="80" value="${esc(row.gameName)}"/></label></div>
      <div class="lux-activity-numbers"><input data-field="gloryWeek" inputmode="numeric" min="0" max="100000000" value="${row.gloryWeek}" aria-label="Gloria esta semana"/><input data-field="gloryTotal" inputmode="numeric" min="0" max="100000000" value="${row.gloryTotal}" aria-label="Gloria total"/></div>
      <div class="lux-activity-numbers"><input data-field="platesWeek" inputmode="numeric" min="0" max="100000000" value="${row.platesWeek}" aria-label="Placas esta semana"/><input data-field="platesTotal" inputmode="numeric" min="0" max="100000000" value="${row.platesTotal}" aria-label="Placas total"/></div>
      <div class="lux-activity-assign"><label>${row.playerId ? 'ASIGNADO A' : '¿QUIÉN ES ESTA PERSONA?'}<select data-field="playerId">${memberOptions(row)}</select></label><small>${row.matchedBy === 'alias' ? '✓ Cuenta reconocida de una captura anterior.' : row.matchedBy === 'profile' ? '✓ Coincide exactamente con el nombre web.' : row.playerId ? 'Se recordará esta cuenta para la próxima vez.' : 'Confirma el integrante antes de guardar.'}</small></div>
      <button class="lux-activity-remove" type="button" data-remove="${esc(row.id)}" aria-label="Eliminar fila">×</button>
    </article>`).join('') : '<p class="hub-empty">No hay filas. Agrégalas manualmente o prueba otra captura.</p>';
  }

  function addRow() {
    if (state.busy) return;
    state.rows.push(matchRow({ id:crypto.randomUUID?.() || String(Date.now()), gameName:'', gloryWeek:0, gloryTotal:0, platesWeek:0, platesTotal:0, crop:'', confidence:0 }));
    renderRows();
  }
  function updateRow(event) {
    const field = event.target?.dataset?.field;
    if (!field) return;
    const card = event.target.closest('[data-row-id]');
    const row = state.rows.find(item => item.id === card?.dataset?.rowId);
    if (!row) return;
    if (['gloryWeek','gloryTotal','platesWeek','platesTotal'].includes(field)) row[field] = safeNumber(event.target.value);
    else row[field] = event.target.value;
    if (field === 'playerId') { row.matchedBy = row.playerId ? 'manual' : ''; renderRows(); }
    else if (field === 'gameName' && event.type === 'change' && row.matchedBy !== 'manual') {
      Object.assign(row, matchRow({ ...row, playerId:'', matchedBy:'', suggestionId:'' }));
      renderRows();
    }
  }
  function removeRow(event) {
    const id = event.target.closest('[data-remove]')?.dataset?.remove;
    if (!id || state.busy) return;
    state.rows = state.rows.filter(row => row.id !== id);
    renderRows();
  }

  function reset(clearFile = true) {
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.file = null; state.hash = ''; state.objectUrl = ''; state.canvas = null; state.rows = [];
    if (clearFile && $('lux-activity-file')) $('lux-activity-file').value = '';
    if ($('lux-activity-preview')) { $('lux-activity-preview').hidden = true; $('lux-activity-preview').innerHTML = ''; }
    if ($('lux-activity-review')) $('lux-activity-review').hidden = true;
    if ($('lux-activity-rows')) $('lux-activity-rows').innerHTML = '';
    hideProgress(); setBusy(false);
  }
  function previewFile(file) {
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    const target = $('lux-activity-preview');
    if (target) { target.innerHTML = `<img src="${state.objectUrl}" alt="Captura seleccionada"/><small>Vista previa · ${Math.round(file.size / 1024)} KB</small>`; target.hidden = false; }
  }

  async function prepare() {
    const api = window.luxPlateActivityApi;
    if (!api) return;
    try {
      const context = await api.getContext();
      setDirectory(context.members);
      state.aliases = new Map();
      (context.aliases || []).forEach(alias => {
        [alias.alias_key, ...nameVariants(alias.game_name)].filter(Boolean).forEach(key => state.aliases.set(key, alias));
      });
      state.ready = true;
      const today = localDate();
      if ($('lux-activity-date')) { $('lux-activity-date').max = today; $('lux-activity-date').value ||= today; }
    } catch (error) {
      state.ready = false;
      toast(`⚠️ ${String(error?.message || 'No se cargó el panel de placas').toUpperCase()}`);
    }
  }

  async function analyze() {
    if (state.busy) return;
    const file = $('lux-activity-file')?.files?.[0];
    if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size <= 0 || file.size > MAX_FILE) {
      toast('⚠️ ELIGE UNA CAPTURA JPG, PNG O WEBP DE HASTA 10 MB'); return;
    }
    if (!state.ready) await prepare();
    if (!state.ready) return;
    setBusy(true); reset(false); state.file = file; setBusy(true); previewFile(file);
    let worker = null;
    try {
      progress(8, 'Comprobando que la captura no esté repetida…');
      state.hash = await hashFile(file);
      if (await window.luxPlateActivityApi.exists(state.hash)) throw new Error('Esta misma captura ya fue importada');
      progress(14, 'Preparando la imagen…');
      state.canvas = await loadImage(file);
      const prepared = ocrCanvas(state.canvas);
      const Tesseract = await loadTesseract();
      state.ocrStage = { start:20, span:36, label:'Leyendo la tabla' };
      worker = await Tesseract.createWorker('eng', 1, {
        logger: message => {
          if (message.status === 'recognizing text') {
            const stage = state.ocrStage || { start:20, span:60, label:'Leyendo la captura' };
            progress(stage.start + Math.round((message.progress || 0) * stage.span), `${stage.label}\u2026 ${Math.round((message.progress || 0) * 100)}%`);
          }
        }
      });
      const result = await worker.recognize(prepared, {}, { blocks:true, text:true });
      const words = collectWords(result.data);
      state.ocrStage = { start:58, span:13, label:'Comprobando los cuatro contadores' };
      progress(58, 'Comprobando los cuatro contadores…');
      const metricsCrop = cropMetrics(prepared);
      await worker.setParameters({
        tessedit_char_whitelist:'0123456789',
        tessedit_pageseg_mode:Tesseract.PSM?.SINGLE_BLOCK || '6',
        preserve_interword_spaces:'1'
      });
      const metricResult = await worker.recognize(metricsCrop.canvas, {}, { blocks:true, text:true });
      const metricWords = collectWords(metricResult.data).map(word => ({
        ...word,
        bbox:{
          x0:word.bbox.x0 + metricsCrop.offsetX, x1:word.bbox.x1 + metricsCrop.offsetX,
          y0:word.bbox.y0 + metricsCrop.offsetY, y1:word.bbox.y1 + metricsCrop.offsetY
        }
      }));
      const extractedRows = extractRows(words.filter(word => metricValue(word.text) === null).concat(metricWords.length >= 4 ? metricWords : words), prepared);
      state.rows = extractedRows.length ? await recognizeRowNames(worker, Tesseract, extractedRows) : [];
      if (!state.rows.length) {
        addRow();
        toast('ℹ️ NO SE LEYERON LAS FILAS. PUEDES COMPLETARLAS MANUALMENTE');
      } else {
        renderRows();
        const unknown = state.rows.filter(row => !row.playerId).length;
        toast(unknown ? `⚠️ FALTAN ${unknown} ${unknown === 1 ? 'CUENTA POR IDENTIFICAR' : 'CUENTAS POR IDENTIFICAR'}` : `✅ ${state.rows.length} FILAS LEÍDAS; REVISA ANTES DE GUARDAR`);
      }
      progress(100, `${state.rows.length} filas listas para revisar.`);
      setTimeout(hideProgress, 900);
    } catch (error) {
      const duplicate = /ya fue importada|misma captura/i.test(String(error?.message || ''));
      if (!duplicate && state.canvas) { addRow(); toast('⚠️ EL LECTOR AUTOMÁTICO FALLÓ; PUEDES COMPLETAR LA FILA MANUALMENTE'); }
      else toast(`⚠️ ${String(error?.message || 'No se pudo leer la captura').toUpperCase()}`);
      hideProgress();
    } finally {
      await worker?.terminate?.().catch?.(() => {});
      setBusy(false);
    }
  }

  async function save() {
    if (state.busy || !state.file || !state.hash || !state.rows.length) { toast('⚠️ PRIMERO LEE UNA CAPTURA'); return; }
    const date = $('lux-activity-date')?.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { toast('⚠️ REVISA LA FECHA DE LA CAPTURA'); return; }
    const unassigned = state.rows.filter(row => !row.playerId);
    if (unassigned.length) { toast(`⚠️ IDENTIFICA ${unassigned.length === 1 ? 'LA CUENTA PENDIENTE' : `LAS ${unassigned.length} CUENTAS PENDIENTES`}`); return; }
    const duplicatePlayers = state.rows.filter((row, index, all) => all.findIndex(item => item.playerId === row.playerId) !== index);
    if (duplicatePlayers.length) { toast('⚠️ UN MISMO INTEGRANTE ESTÁ ASIGNADO A DOS FILAS'); return; }
    if (state.rows.some(row => !normalizeName(row.gameName) || /^Jugador\s+\d+$/i.test(String(row.gameName || '').trim()))) { toast('⚠️ ESCRIBE EL NOMBRE REAL DEL JUEGO EN LAS FILAS NO RECONOCIDAS'); return; }
    if (state.rows.some(row => safeNumber(row.gloryTotal) < safeNumber(row.gloryWeek) || safeNumber(row.platesTotal) < safeNumber(row.platesWeek))) {
      toast('⚠️ EN UNA FILA EL TOTAL ES MENOR QUE EL VALOR SEMANAL'); return;
    }
    const payload = state.rows.map((row, index) => ({
      player_id:row.playerId,
      game_name:String(row.gameName).trim().slice(0, 80),
      alias_key:normalizeName(row.gameName),
      glory_week:safeNumber(row.gloryWeek), glory_total:safeNumber(row.gloryTotal),
      plates_week:safeNumber(row.platesWeek), plates_total:safeNumber(row.platesTotal),
      row_index:index
    }));
    setBusy(true); progress(30, 'Guardando captura y contadores de forma segura…');
    try {
      await window.luxPlateActivityApi.submit(state.file, state.hash, date, payload);
      progress(100, 'Lectura guardada. El ranking ya está actualizado.');
      toast('✅ ACTIVIDAD GUARDADA SIN DUPLICAR CONTADORES');
      reset(true);
      await prepare();
    } catch (error) {
      hideProgress();
      toast(`⚠️ ${String(error?.message || 'No se pudo guardar la lectura').toUpperCase()}`);
    } finally { setBusy(false); }
  }

  function install() {
    const file = $('lux-activity-file');
    file?.addEventListener('change', () => {
      const selected = file.files?.[0];
      if (!selected) return;
      reset(false); state.file = selected; previewFile(selected);
    });
    $('lux-activity-analyze')?.addEventListener('click', analyze);
    $('lux-activity-add-row')?.addEventListener('click', addRow);
    $('lux-activity-reset')?.addEventListener('click', () => reset(true));
    $('lux-activity-save')?.addEventListener('click', save);
    $('lux-activity-rows')?.addEventListener('input', updateRow);
    $('lux-activity-rows')?.addEventListener('change', updateRow);
    $('lux-activity-rows')?.addEventListener('click', removeRow);
    window.luxPlateImport = { prepare, setDirectory, reset, analyze, save, normalizeName };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
