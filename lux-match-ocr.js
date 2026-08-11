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

  async function prepareImage(file) {
    const image = await loadImage(file);
    const scale = Math.min(2, Math.max(1, 1900 / image.naturalWidth));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const gray = pixels.data[index] * .299 + pixels.data[index + 1] * .587 + pixels.data[index + 2] * .114;
      const contrasted = Math.max(0, Math.min(255, (gray - 118) * 1.85 + 132));
      const value = 255 - contrasted;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
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

  function clusterLines(words, height) {
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
        y:group.y
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

  function detectScore(text) {
    const match = String(text || '').replace(/[Oo]/g, '0').match(/(?:^|\s)(\d{1,2})\s*(?:VS|V5|X|[-–])\s*(\d{1,2})(?:\s|$)/i);
    return match ? { scoreFor:safeNumber(match[1],999), scoreAgainst:safeNumber(match[2],999), confidence:82 } : null;
  }

  function parseResult(lines, rawText, context) {
    const upper = String(rawText || '').toLocaleUpperCase('es');
    const result = /VICTORIA|BOOYAH/.test(upper) ? 'win' : /DERROTA|DEFEAT/.test(upper) ? 'loss' : /EMPATE|DRAW/.test(upper) ? 'draw' : (context?.result || 'win');
    const score = lines.map(line => detectScore(line.text)).find(Boolean);
    const detectedMode = ['4v4','3v3','2v2','1v1'].find(mode => new RegExp(mode.replace('v','\\s*[vVxX]\\s*')).test(rawText));
    const candidates = candidateDirectory(context), used = new Set(), matched = [], unmatched = [];

    lines.forEach((line, index) => {
      const stats = lineStats(line.text), gameName = cleanPlayerText(line.text);
      if (gameName.length < 2) return;
      const match = bestMatch(gameName, candidates);
      if (match?.auto && !used.has(match.playerId)) {
        used.add(match.playerId);
        matched.push({ playerId:match.playerId, gameName:match.gameName, detectedName:gameName, matchedBy:match.source, confidence:Math.round(match.score * 100), ...stats });
      } else if ((stats.confirmed || (match?.score || 0) >= .5) && unmatched.length < 8) {
        unmatched.push({ id:`ocr-${index}`, gameName, suggestionId:match?.playerId || '', confidence:Math.round((match?.score || line.confidence / 100) * 100), ...stats });
      }
    });

    return {
      rawText:String(rawText || '').slice(0, 8000), confidence:Math.round(lines.reduce((sum, line) => sum + line.confidence, 0) / Math.max(1, lines.length)),
      mode:detectedMode || context?.mode || '4v4', result,
      scoreFor:score?.scoreFor ?? (result === 'win' ? 1 : 0), scoreAgainst:score?.scoreAgainst ?? (result === 'loss' ? 1 : 0),
      scoreConfidence:score?.confidence || 0, matched:matched.slice(0, 4), unmatched
    };
  }

  async function analyze(file, context={}, onProgress=()=>{}) {
    if (!(file instanceof Blob)) throw new Error('Selecciona una captura primero');
    let worker;
    try {
      onProgress(5, 'Preparando la captura');
      const [Tesseract, image] = await Promise.all([loadTesseract(), prepareImage(file)]);
      worker = await Tesseract.createWorker('eng', 1, { logger:message => {
        if (message.status === 'recognizing text') onProgress(22 + Math.round((message.progress || 0) * 67), `Leyendo marcador, nombres y numeros ${Math.round((message.progress || 0) * 100)}%`);
      }});
      const result = await worker.recognize(image, {}, { blocks:true, text:true });
      const words = collectWords(result.data), lines = clusterLines(words, image.height);
      const rawText = result.data?.text || lines.map(line => line.text).join('\n');
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
