/* Lectura asistida de capturas de partida.
 * El OCR solo prepara un borrador: el jugador y una lider confirman los datos. */
(() => {
  'use strict';

  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
  let scriptPromise = null;

  const LOOKALIKE_CHARS = {
    'Ø':'O','ø':'o','Ł':'L','ł':'l','Đ':'D','đ':'d','Ð':'D','ð':'d','Þ':'TH','þ':'th','Æ':'AE','æ':'ae','Œ':'OE','œ':'oe','ß':'ss',
    'А':'A','а':'a','В':'B','в':'b','Е':'E','е':'e','К':'K','к':'k','М':'M','м':'m','Н':'H','н':'h','О':'O','о':'o',
    'Р':'P','р':'p','С':'C','с':'c','Т':'T','т':'t','Х':'X','х':'x','У':'Y','у':'y',
    'Α':'A','α':'a','Β':'B','β':'b','Ε':'E','ε':'e','Ζ':'Z','Η':'H','η':'h','Ι':'I','ι':'i','Κ':'K','κ':'k','Μ':'M','μ':'m','Ν':'N','ν':'v','Ο':'O','ο':'o','Ρ':'P','ρ':'p','Τ':'T','τ':'t','Χ':'X','χ':'x'
  };

  function transliterate(value) {
    return [...String(value || '')].map(char => LOOKALIKE_CHARS[char] ?? char).join('');
  }

  function normalizeName(value) {
    return transliterate(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleUpperCase('es')
      .replace(/[^\p{L}\p{N}]/gu, '').slice(0, 80);
  }

  function nameVariants(value) {
    const spaced = transliterate(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleUpperCase('es')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    const variants = new Set();
    const add = candidate => {
      const normalized = normalizeName(candidate);
      if (normalized.length >= 2) variants.add(normalized);
    };
    add(spaced);
    add(spaced.replace(/\s+\d{1,3}$/u, ''));
    const tokens = spaced.split(' ').filter(Boolean);
    tokens.filter(token => token.length >= 4).forEach(add);
    if (tokens.length > 1 && /^(?:LX|LUX|GPA|IAM|TEAM|CLAN)$/u.test(tokens[0])) add(tokens.slice(1).join(' '));
    [...variants].forEach(candidate => {
      add(candidate.replace(/\d{1,3}$/u, ''));
      add(candidate.replace(/^(?:LX|LUX|GPA|IAM|TEAM|CLAN)/u, ''));
      add(candidate.replace(/^X{1,3}(?=[A-Z])|X{1,3}$/gu, ''));
    });
    return [...variants];
  }

  function editSimilarity(first, second) {
    if (!first || !second) return 0;
    const previous = Array(second.length + 1).fill(0).map((_, index) => index);
    for (let i = 1; i <= first.length; i += 1) {
      let diagonal = previous[0]; previous[0] = i;
      for (let j = 1; j <= second.length; j += 1) {
        const old = previous[j];
        previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (first[i - 1] === second[j - 1] ? 0 : 1));
        diagonal = old;
      }
    }
    return 1 - previous[second.length] / Math.max(first.length, second.length);
  }

  function similarity(first, second) {
    let best = 0;
    nameVariants(first).forEach(a => nameVariants(second).forEach(b => {
      if (a === b) { best = 1; return; }
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length > b.length ? a : b;
      let score = editSimilarity(a, b);
      if (shorter.length >= 4 && longer.includes(shorter)) score = Math.max(score, .78 + .18 * (shorter.length / longer.length));
      best = Math.max(best, score);
    }));
    return best;
  }

  function loadTesseract() {
    if (window.Tesseract?.createWorker) return Promise.resolve(window.Tesseract);
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESSERACT_URL;
      script.crossOrigin = 'anonymous';
      script.onload = () => window.Tesseract?.createWorker ? resolve(window.Tesseract) : reject(new Error('El lector visual no inicio'));
      script.onerror = () => reject(new Error('No se pudo cargar el lector visual. Revisa tu conexion e intentalo otra vez'));
      document.head.appendChild(script);
    });
    return scriptPromise;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo abrir la captura')); };
      image.src = url;
    });
  }

  function prepareRegion(image, region={ x:0, y:0, width:1, height:1 }, targetWidth=1900, treatment='inverted') {
    const sourceX = Math.round(image.naturalWidth * region.x);
    const sourceY = Math.round(image.naturalHeight * region.y);
    const sourceWidth = Math.max(1, Math.round(image.naturalWidth * region.width));
    const sourceHeight = Math.max(1, Math.round(image.naturalHeight * region.height));
    const scale = Math.min(3.2, Math.max(1, targetWidth / sourceWidth));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    if (treatment === 'color') return canvas;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const gray = pixels.data[index] * .299 + pixels.data[index + 1] * .587 + pixels.data[index + 2] * .114;
      if (treatment === 'whiteText') {
        const value = gray >= 185 ? 0 : 255;
        pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value;
        continue;
      }
      const contrasted = Math.max(0, Math.min(255, (gray - 112) * 2.05 + 136));
      const value = treatment === 'gray' ? contrasted : 255 - contrasted;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  }

  async function prepareImages(file) {
    const image = await loadImage(file);
    const full = prepareRegion(image, { x:0, y:0, width:1, height:1 }, 2000);
    if (image.naturalWidth / image.naturalHeight < 1.35) return { full, teams:[] };

    // En la pantalla final de Free Fire las filas de ambos equipos aparecen
    // en la franja central. Leer cada mitad por separado evita que Tesseract
    // mezcle el nombre de un aliado con las cifras de un rival situado en la
    // misma línea horizontal.
    const table = { y:.405, height:.205 };
    const left = { x:.045, y:table.y, width:.445, height:table.height };
    const right = { x:.505, y:table.y, width:.445, height:table.height };
    return {
      full,
      teams:[
        { side:'left', variant:'color', canvas:prepareRegion(image, left, 1750, 'color') },
        { side:'left', variant:'inverted', canvas:prepareRegion(image, left, 1750, 'inverted') },
        { side:'right', variant:'color', canvas:prepareRegion(image, right, 1750, 'color') },
        { side:'right', variant:'inverted', canvas:prepareRegion(image, right, 1750, 'inverted') }
      ],
      scoreDigits:[
        { side:'left', canvas:prepareRegion(image, { x:.405, y:.285, width:.06, height:.105 }, 650, 'whiteText') },
        { side:'right', canvas:prepareRegion(image, { x:.515, y:.285, width:.06, height:.105 }, 650, 'whiteText') }
      ]
    };
  }

  function collectWords(data) {
    const words = [], seen = new Set();
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.words)) node.words.forEach(word => {
        if (!word?.text || !word?.bbox) return;
        const key = `${word.text}|${word.bbox.x0}|${word.bbox.y0}|${word.bbox.x1}|${word.bbox.y1}`;
        if (!seen.has(key)) { seen.add(key); words.push({ text:String(word.text).trim(), confidence:Number(word.confidence || 0), bbox:word.bbox }); }
      });
      ['blocks','paragraphs','lines'].forEach(key => Array.isArray(node[key]) && node[key].forEach(walk));
    };
    walk(data);
    return words;
  }

  function clusterLines(words, height, side='unknown') {
    const tolerance = Math.max(14, height * .018), groups = [];
    words.map(word => ({ ...word, x:(word.bbox.x0 + word.bbox.x1) / 2, y:(word.bbox.y0 + word.bbox.y1) / 2 }))
      .sort((a, b) => a.y - b.y || a.x - b.x).forEach(word => {
        let group = groups.find(item => Math.abs(item.y - word.y) <= tolerance);
        if (!group) { group = { y:word.y, words:[] }; groups.push(group); }
        group.words.push(word);
        group.y = group.words.reduce((sum, item) => sum + item.y, 0) / group.words.length;
      });
    return groups.map(group => {
      group.words.sort((a, b) => a.x - b.x);
      return {
        text:group.words.map(word => word.text).join(' ').replace(/\s+/g, ' ').trim(),
        confidence:Math.round(group.words.reduce((sum, word) => sum + word.confidence, 0) / Math.max(1, group.words.length)),
        y:group.y,
        side
      };
    }).filter(line => line.text.length >= 2);
  }

  function safeNumber(value, maximum=10000000) {
    const parsed = Number(String(value ?? '').replace(/[^0-9]/g, ''));
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(0, Math.round(parsed))) : 0;
  }

  function lineStats(text) {
    const normalized = String(text || '').replace(/[|Il]/g, '1').replace(/[Oo]/g, '0');
    const slash = normalized.match(/(?:^|\s)(\d{1,3})\s*[\/:]\s*(\d{1,3})\s*[\/:]\s*(\d{1,3})(?:\s+|.*?\s)(\d{2,7})(?:\s|$)/);
    if (slash) return { kills:safeNumber(slash[1],999), deaths:safeNumber(slash[2],999), assists:safeNumber(slash[3],999), damage:safeNumber(slash[4]), confirmed:true };
    const numbers = normalized.match(/\b\d{1,7}\b/g)?.map(value => safeNumber(value)) || [];
    if (numbers.length >= 4) {
      const damageIndex = numbers.findIndex((value, index) => index >= 2 && value >= 100);
      if (damageIndex >= 2) return { kills:numbers[0], deaths:numbers[1], assists:damageIndex >= 3 ? numbers[2] : 0, damage:numbers[damageIndex], confirmed:true };
    }
    return { kills:0, deaths:0, assists:0, damage:0, confirmed:false };
  }

  function cleanPlayerText(text) {
    return String(text || '')
      .replace(/\d{1,3}\s*[\/:]\s*\d{1,3}\s*[\/:]\s*\d{1,3}/g, ' ')
      .replace(/\b\d{1,7}\b/g, ' ')
      .replace(/\b(?:KDA|DMG|DANO|DAMAGE|BAJAS|KILLS|MUERTES|ASSISTS?|NOMBRE|NAME|VICTORIA|DERROTA|BOOYAH|VS)\b/gi, ' ')
      .replace(/[^\p{L}\p{N}_\-\s]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function candidateDirectory(context) {
    const members = Array.isArray(context?.members) ? context.members : [];
    const aliases = Array.isArray(context?.aliases) ? context.aliases : [];
    const candidates = [];
    members.forEach(member => candidates.push({ playerId:member.id || member.player_id, gameName:member.display_name || member.name, source:'profile' }));
    aliases.forEach(alias => candidates.push({ playerId:alias.player_id, gameName:alias.game_name || alias.alias_key, source:'alias' }));
    return candidates.filter(item => item.playerId && item.gameName);
  }

  function bestMatch(gameName, candidates) {
    const byPlayer = new Map();
    candidates.forEach(candidate => {
      const score = similarity(gameName, candidate.gameName);
      const current = byPlayer.get(candidate.playerId);
      if (!current || score > current.score) byPlayer.set(candidate.playerId, { ...candidate, score });
    });
    const ordered = [...byPlayer.values()].sort((a, b) => b.score - a.score);
    const best = ordered[0], second = ordered[1];
    if (!best) return null;
    return { ...best, auto:best.score >= .72 && best.score - (second?.score || 0) >= .07 };
  }

  function selectClanSide(lines, candidates, currentPlayerId='') {
    const sides = ['left','right'].map(side => {
      const sideLines = lines.filter(line => line.side === side);
      let recognized = 0, strong = 0, clanMarks = 0;
      sideLines.forEach(line => {
        const name = cleanPlayerText(line.text), match = bestMatch(name, candidates);
        if ((match?.score || 0) >= .5) recognized += match.score;
        if (match?.auto) strong += 1;
        if (match?.playerId === currentPlayerId && match.score >= .58) recognized += 6;
        if (/\b(?:LUX|LX)[ _-]?(?:UP)?\b/i.test(line.text)) clanMarks += 1;
      });
      return { side, lines:sideLines, score:strong * 3 + recognized * 2 + clanMarks * .35 };
    });
    const ordered = sides.sort((a,b) => b.score - a.score);
    if (!ordered[0]?.lines.length || ordered[0].score < .9) return { side:'unknown', lines };
    return ordered[0];
  }

  function detectScore(text) {
    const match = String(text || '').replace(/[Oo]/g, '0').match(/(?:^|\s)(\d{1,2})\s*(?:VS|V5|X|[-–])\s*(\d{1,2})(?:\s|$)/i);
    return match ? { scoreFor:safeNumber(match[1],999), scoreAgainst:safeNumber(match[2],999), confidence:82 } : null;
  }

  function parseResult(lines, rawText, context) {
    const upper = String(rawText || '').toLocaleUpperCase('es');
    const result = /VICTORIA|BOOYAH/.test(upper) ? 'win' : /DERROTA|DEFEAT/.test(upper) ? 'loss' : /EMPATE|DRAW/.test(upper) ? 'draw' : (context?.result || 'win');
    const score = lines.map(line => detectScore(line.text)).find(Boolean);
    const detectedMode = ['4v4','3v3','2v2','1v1'].find(mode => new RegExp(mode.replace('v','\\s*[vVxX]\\s*')).test(rawText));
    const candidates = candidateDirectory(context), matchedByPlayer = new Map(), unmatched = [];
    const selectedTeam = selectClanSide(lines, candidates, context?.currentPlayerId);
    const playerLines = selectedTeam.lines.length ? selectedTeam.lines : lines;

    playerLines.forEach((line, index) => {
      const stats = lineStats(line.text), gameName = cleanPlayerText(line.text);
      if (gameName.length < 2) return;
      const match = bestMatch(gameName, candidates);
      if (match?.auto) {
        const detectedName = match.score >= .92 ? gameName : match.gameName;
        const candidate = { playerId:match.playerId, gameName, detectedName, matchedBy:match.source, confidence:Math.round(match.score * 100), ...stats };
        const current = matchedByPlayer.get(match.playerId);
        const candidateQuality = (stats.confirmed ? 200 : 0) + match.score * 100 + line.confidence / 10;
        const currentQuality = current ? (current.confirmed ? 200 : 0) + current.confidence + (current.ocrConfidence || 0) / 10 : -1;
        if (!current || candidateQuality > currentQuality) matchedByPlayer.set(match.playerId, { ...candidate, ocrConfidence:line.confidence });
      } else if ((stats.confirmed || (match?.score || 0) >= .58) && unmatched.length < 4) {
        unmatched.push({ id:`ocr-${index}`, gameName, suggestionId:match?.playerId || '', confidence:Math.round((match?.score || line.confidence / 100) * 100), ...stats });
      }
    });

    let scoreFor = score?.scoreFor ?? (result === 'win' ? 1 : 0);
    let scoreAgainst = score?.scoreAgainst ?? (result === 'loss' ? 1 : 0);
    if (selectedTeam.side === 'right' && score) [scoreFor, scoreAgainst] = [scoreAgainst, scoreFor];
    const uniqueUnmatched = new Map();
    unmatched.forEach(entry => {
      const key = entry.suggestionId
        ? `suggestion:${entry.suggestionId}:${entry.kills}:${entry.deaths}:${entry.damage}`
        : `name:${normalizeName(entry.gameName)}:${entry.kills}:${entry.deaths}:${entry.damage}`;
      const current = uniqueUnmatched.get(key);
      if (!current || Number(entry.confidence || 0) > Number(current.confidence || 0)) uniqueUnmatched.set(key, entry);
    });

    return {
      rawText:String(rawText || '').slice(0, 8000), confidence:Math.round(lines.reduce((sum, line) => sum + line.confidence, 0) / Math.max(1, lines.length)),
      mode:detectedMode || context?.mode || '4v4', result,
      scoreFor, scoreAgainst,
      scoreConfidence:score?.confidence || 0, teamSide:selectedTeam.side,
      matched:[...matchedByPlayer.values()].slice(0, 4).map(({ ocrConfidence, ...entry }) => entry),
      unmatched:[...uniqueUnmatched.values()].slice(0, 4)
    };
  }

  async function analyze(file, context={}, onProgress=()=>{}) {
    if (!(file instanceof Blob)) throw new Error('Selecciona una captura primero');
    let worker;
    try {
      onProgress(5, 'Preparando la captura');
      const [Tesseract, images] = await Promise.all([loadTesseract(), prepareImages(file)]);
      worker = await Tesseract.createWorker('eng', 1, { logger:message => {
        if (message.status === 'recognizing text') onProgress(20 + Math.round((message.progress || 0) * 25), `Leyendo la pantalla ${Math.round((message.progress || 0) * 100)}%`);
      }});
      await worker.setParameters?.({ preserve_interword_spaces:'1' });
      const result = await worker.recognize(images.full, {}, { blocks:true, text:true });
      const fullWords = collectWords(result.data), fullLines = clusterLines(fullWords, images.full.height);
      const teamLines = [], scoreLines = [], scoreDigits = { left:[], right:[] };
      for (let index = 0; index < images.teams.length; index += 1) {
        const region = images.teams[index];
        onProgress(44 + index * 10, `Separando ${region.side === 'left' ? 'el equipo izquierdo' : 'el equipo derecho'}`);
        const teamResult = await worker.recognize(region.canvas, {}, { blocks:true, text:true });
        teamLines.push(...clusterLines(collectWords(teamResult.data), region.canvas.height, region.side));
      }
      await worker.setParameters?.({ tessedit_pageseg_mode:'10', tessedit_char_whitelist:'0123456789' });
      for (let index = 0; index < (images.scoreDigits || []).length; index += 1) {
        const digitRegion = images.scoreDigits[index];
        onProgress(84 + index * 4, 'Leyendo el marcador');
        const scoreResult = await worker.recognize(digitRegion.canvas, {}, { blocks:true, text:true });
        const digit = String(scoreResult.data?.text || '').match(/\d{1,2}/)?.[0];
        if (digit) scoreDigits[digitRegion.side].push(digit);
      }
      if (scoreDigits.left[0] && scoreDigits.right[0]) scoreLines.push({ text:`${scoreDigits.left[0]} VS ${scoreDigits.right[0]}`, confidence:90, y:0, side:'unknown' });
      const lines = teamLines.length ? [...fullLines, ...teamLines, ...scoreLines] : [...fullLines, ...scoreLines];
      const rawText = [result.data?.text, ...teamLines.map(line => line.text), ...scoreLines.map(line => line.text)].filter(Boolean).join('\n');
      onProgress(94, 'Comparando nombres con los integrantes');
      const parsed = parseResult(lines, rawText, context);
      onProgress(100, 'Borrador listo para revisar');
      return parsed;
    } finally {
      await worker?.terminate?.().catch?.(() => {});
    }
  }

  window.luxMatchOCR = Object.freeze({ analyze, parseResult, normalizeName, similarity });
})();
