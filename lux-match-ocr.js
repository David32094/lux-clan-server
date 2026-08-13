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
    if (image.naturalWidth / image.naturalHeight < 1.35) {
      return { full, table:null, columns:[], teamNames:[], teamStats:[], scoreDigits:[] };
    }

    // Free Fire dibuja hasta cuatro filas entre el 42% y el 77% de la imagen.
    // Separamos la columna NOMBRE de K/D/A + DMG antes del OCR: reconocer una
    // mitad completa mezclaba iconos y estadisticas con el nombre del jugador.
    const table = { y:.42, height:.35 }, rowStarts = [.437,.514,.591,.668];
    const columns = [
      { side:'left', names:{ x:.128, width:.155 }, stats:{ x:.282, y:table.y, width:.112, height:table.height } },
      { side:'right', names:{ x:.579, width:.153 }, stats:{ x:.731, y:table.y, width:.112, height:table.height } }
    ];
    return {
      full,
      table,
      columns,
      teamNames:columns.flatMap(column => rowStarts.flatMap((y,rowIndex) => ['color','gray'].map(variant => ({
        side:column.side,kind:'name',rowIndex,variant,
        canvas:prepareRegion(image,{ x:.135 + (column.side === 'right' ? .451 : 0),y,width:.143,height:.047 },900,variant)
      })))),
      teamStats:columns.flatMap(column => ['color','gray'].map(variant => ({
        side:column.side,kind:'stats',variant,
        canvas:prepareRegion(image,column.stats,900,variant)
      }))),
      scoreDigits:[
        { side:'left', canvas:prepareRegion(image, { x:.407, y:.317, width:.042, height:.066 }, 500, 'color') },
        { side:'left', canvas:prepareRegion(image, { x:.407, y:.317, width:.042, height:.066 }, 500, 'gray') },
        { side:'left', canvas:prepareRegion(image, { x:.407, y:.317, width:.042, height:.066 }, 500, 'whiteText') },
        { side:'right', canvas:prepareRegion(image, { x:.520, y:.317, width:.042, height:.066 }, 500, 'color') },
        { side:'right', canvas:prepareRegion(image, { x:.520, y:.317, width:.042, height:.066 }, 500, 'gray') },
        { side:'right', canvas:prepareRegion(image, { x:.520, y:.317, width:.042, height:.066 }, 500, 'whiteText') }
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
    if (slash) {
      const values=[safeNumber(slash[1],999),safeNumber(slash[2],999),safeNumber(slash[3],999),safeNumber(slash[4])];
      if (values.slice(0,3).every(value => value <= 99) && values[3] >= 100) {
        return { kills:values[0], deaths:values[1], assists:values[2], damage:values[3], confirmed:true };
      }
    }
    const numbers = normalized.match(/\b\d{1,7}\b/g)?.map(value => safeNumber(value)) || [];
    if (numbers.length >= 4) {
      const damageIndex = numbers.findIndex((value, index) => index >= 2 && value >= 100);
      if (damageIndex >= 2 && numbers[0] <= 99 && numbers[1] <= 99 && (damageIndex < 3 || numbers[2] <= 99)) {
        return { kills:numbers[0], deaths:numbers[1], assists:damageIndex >= 3 ? numbers[2] : 0, damage:numbers[damageIndex], confirmed:true };
      }
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

  function spatialLines(words, canvasWidth, canvasHeight, region, side, targetHeight) {
    const filtered = words.filter(word => {
      const x=(word.bbox.x0+word.bbox.x1)/2/canvasWidth,y=(word.bbox.y0+word.bbox.y1)/2/canvasHeight;
      return x>=region.x&&x<=region.x+region.width&&y>=region.y&&y<=region.y+region.height;
    }).map(word => ({ ...word,bbox:{ ...word.bbox,
      x0:word.bbox.x0/canvasWidth*1000,x1:word.bbox.x1/canvasWidth*1000,
      y0:(word.bbox.y0/canvasHeight-region.y)/region.height*targetHeight,
      y1:(word.bbox.y1/canvasHeight-region.y)/region.height*targetHeight
    }}));
    return clusterLines(filtered,targetHeight,side);
  }

  function cleanNameColumnText(text) {
    return String(text || '')
      .replace(/\d{1,3}\s*[\/:]\s*\d{1,3}\s*[\/:]\s*\d{1,3}/g, ' ')
      .replace(/\b(?:FLUXO|LUX\s*UP|CLAN)\b/gi, ' ')
      .replace(/\b(?:K\s*D\s*A|DMG|DANO|DAMAGE|NOMBRE|NAME)\b/gi, ' ')
      .replace(/[^\p{L}\p{N}_\-\s]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0,80);
  }

  function nameQuality(value) {
    const name = cleanNameColumnText(value), tokens = name.split(/\s+/).filter(Boolean);
    const normalizedTokens = tokens.map(normalizeName).filter(Boolean);
    if (!name || !/[\p{L}]/u.test(name) || normalizeName(name).length < 3 || tokens.length > 5) return 0;
    if (tokens.length >= 3 && normalizedTokens.every(token => token.length <= 2)) return 0;
    if (/^(?:VS|KDA|DMG|DANO|DAMAGE|NOMBRE|NAME|VICTORIA|DERROTA|BOOYAH)$/i.test(normalizeName(name))) return 0;
    const longTokens = normalizedTokens.filter(token => token.length >= 3).length;
    return Math.min(1, .42 + Math.min(12, normalizeName(name).length) / 30 + longTokens * .1);
  }

  function buildPlayerLines(nameLines, statLines, side, candidates, height) {
    const groups = [];
    nameLines.map(line => ({ ...line, gameName:cleanNameColumnText(line.text) }))
      .filter(line => nameQuality(line.gameName) > 0)
      .sort((a,b) => a.y - b.y)
      .forEach(line => {
        const rowIndex=Number.isInteger(line.rowIndex)
          ? line.rowIndex
          : Math.max(0,Math.min(3,Math.floor(line.y/(height/4))));
        let group=groups.find(item => item.rowIndex === rowIndex);
        if (!group) { group = { y:height*(rowIndex+.5)/4,rowIndex,lines:[] }; groups.push(group); }
        group.lines.push(line);
      });

    const usableStats = statLines.map(line => ({ ...line, stats:lineStats(line.text) })).filter(line => line.stats.confirmed);
    const mapped = groups.map((group,rowIndex) => {
      const options = group.lines.map(line => {
        const match = bestMatch(line.gameName, candidates), quality = nameQuality(line.gameName);
        return { ...line, matchScore:match?.score || 0, rank:(match?.score || 0) * 125 + line.confidence * .32 + quality * 22 };
      }).sort((a,b) => b.rank - a.rank);
      const name = options[0];
      const nearestStat = usableStats.map(line => ({ ...line, distance:Math.abs(line.y - group.y) }))
        .filter(line => line.distance <= height * .105).sort((a,b) => a.distance - b.distance || b.confidence - a.confidence)[0];
      const stats = nearestStat?.stats || { kills:0,deaths:0,assists:0,damage:0,confirmed:false };
      return {
        text:`${name.gameName}${nearestStat ? ` ${nearestStat.text}` : ''}`,
        gameName:name.gameName,
        stats,
        confidence:Math.round((name.confidence * 2 + (nearestStat?.confidence || name.confidence)) / 3),
        y:group.y,side,kind:'player',rowIndex:group.rowIndex ?? rowIndex,matchScore:name.matchScore
      };
    }).filter(line => nameQuality(line.gameName) > 0);
    const byRow=new Map();
    mapped.forEach(line=>{
      const key=Number.isInteger(line.rowIndex)?line.rowIndex:Math.max(0,Math.min(3,Math.floor(line.y/(height/4))));
      const current=byRow.get(key),score=(line.matchScore||0)*150+line.confidence+(line.confirmed?45:0);
      const currentScore=current?(current.matchScore||0)*150+current.confidence+(current.confirmed?45:0):-1;
      if(!current||score>currentScore)byRow.set(key,line);
    });
    return [...byRow.values()].sort((a,b)=>a.y-b.y).slice(0,4);
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
        const name = line.gameName || cleanPlayerText(line.text), match = bestMatch(name, candidates);
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
      const stats = line.stats || lineStats(line.text), gameName = line.gameName || cleanPlayerText(line.text);
      if (nameQuality(gameName) <= 0) return;
      const match = bestMatch(gameName, candidates);
      if (match?.auto) {
        const ocrLength=normalizeName(gameName).length,candidateLength=normalizeName(match.gameName).length;
        const detectedName = match.score >= .92 && ocrLength >= candidateLength * .82 ? gameName : match.gameName;
        const candidate = { playerId:match.playerId, gameName, detectedName, matchedBy:match.source, confidence:Math.round(match.score * 100), ...stats };
        const current = matchedByPlayer.get(match.playerId);
        const candidateQuality = (stats.confirmed ? 200 : 0) + match.score * 100 + line.confidence / 10;
        const currentQuality = current ? (current.confirmed ? 200 : 0) + current.confidence + (current.ocrConfidence || 0) / 10 : -1;
        if (!current || candidateQuality > currentQuality) matchedByPlayer.set(match.playerId, { ...candidate, ocrConfidence:line.confidence });
      } else if (((stats.confirmed && line.kind === 'player' && line.confidence >= 18) || (match?.score || 0) >= .58) && unmatched.length < 4) {
        unmatched.push({ id:`ocr-${index}`, gameName, suggestionId:match?.playerId || '', confidence:Math.round((match?.score || line.confidence / 100) * 100), ...stats });
      }
    });

    // Respaldo para nombres estilizados: si el recorte de la fila pierde un
    // jugador, lo recuperamos de la lectura completa solo cuando coincide con
    // mucha claridad con un integrante o alias conocido. Nunca inventa un
    // nombre nuevo ni usa una fila rival como sugerencia libre.
    const recoveryLines=selectedTeam.side === 'unknown'
      ? lines.filter(line => line.kind === 'player')
      : selectedTeam.lines;
    candidates.forEach(candidate => {
      if (matchedByPlayer.has(candidate.playerId) || matchedByPlayer.size >= 4) return;
      const bestLine = recoveryLines.map(line => {
        const gameName=line.gameName || cleanPlayerText(line.text),score=similarity(gameName,candidate.gameName);
        return { line,gameName,score };
      }).filter(item=>item.score>=.72).sort((a,b)=>b.score-a.score || b.line.confidence-a.line.confidence)[0];
      if (!bestLine) return;
      const stats=bestLine.line.stats || lineStats(bestLine.line.text);
      matchedByPlayer.set(candidate.playerId,{
        playerId:candidate.playerId,gameName:bestLine.gameName,
        detectedName:bestLine.score>=.92 && normalizeName(bestLine.gameName).length>=normalizeName(candidate.gameName).length*.82
          ? bestLine.gameName:candidate.gameName,
        matchedBy:candidate.source,confidence:Math.round(bestLine.score*100),...stats
      });
    });

    let scoreFor = score?.scoreFor ?? (result === 'win' ? 1 : 0);
    let scoreAgainst = score?.scoreAgainst ?? (result === 'loss' ? 1 : 0);
    if (selectedTeam.side === 'right' && score) [scoreFor, scoreAgainst] = [scoreAgainst, scoreFor];
    const uniqueUnmatched = new Map();
    unmatched.forEach(entry => {
      if (entry.suggestionId && matchedByPlayer.has(entry.suggestionId)) return;
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
      await worker.setParameters?.({ preserve_interword_spaces:'1', tessedit_pageseg_mode:'6' });
      const result = await worker.recognize(images.full, {}, { blocks:true, text:true });
      const fullWords = collectWords(result.data), fullLines = clusterLines(fullWords, images.full.height);
      const candidates = candidateDirectory(context), nameLines = { left:[],right:[] }, statLines = { left:[],right:[] };
      const scoreLines = [], scoreDigits = { left:[], right:[] };
      // Una lectura del lienzo completo conserva la alineacion vertical y
      // rescata nombres decorados que se pierden al recortar demasiado.
      ['left','right'].forEach(side => {
        const column=images.columns.find(item=>item.side===side),targetHeight=1400;
        if (!column || !images.table) return;
        nameLines[side].push(...spatialLines(fullWords,images.full.width,images.full.height,
          { x:column.names.x,y:images.table.y,width:column.names.width,height:images.table.height },side,targetHeight)
          .map(line=>({ ...line,variant:'full-spatial' })));
        statLines[side].push(...spatialLines(fullWords,images.full.width,images.full.height,
          { x:column.stats.x,y:images.table.y,width:column.stats.width,height:images.table.height },side,targetHeight)
          .map(line=>({ ...line,variant:'full-spatial' })));
      });
      for (let index = 0; index < images.teamNames.length; index += 1) {
        const region = images.teamNames[index];
        onProgress(40 + index * 4, `Leyendo fila ${region.rowIndex+1} del equipo ${region.side === 'left' ? 'izquierdo' : 'derecho'}`);
        await worker.setParameters?.({ preserve_interword_spaces:'1', tessedit_pageseg_mode:'7', tessedit_char_whitelist:'' });
        const rowResult = await worker.recognize(region.canvas, {}, { blocks:true, text:true });
        nameLines[region.side].push(...clusterLines(collectWords(rowResult.data),region.canvas.height,region.side)
          .map(line=>({ ...line,rowIndex:region.rowIndex,variant:region.variant })));
      }
      for (let index = 0; index < images.teamStats.length; index += 1) {
        const region=images.teamStats[index];
        onProgress(76 + index * 4,`Leyendo estadisticas del equipo ${region.side === 'left' ? 'izquierdo' : 'derecho'}`);
        await worker.setParameters?.({ preserve_interword_spaces:'1',tessedit_pageseg_mode:'6',tessedit_char_whitelist:'0123456789/:' });
        const statResult=await worker.recognize(region.canvas,{}, {blocks:true,text:true});
        statLines[region.side].push(...clusterLines(collectWords(statResult.data),region.canvas.height,region.side)
          .map(line=>({ ...line,y:line.y/region.canvas.height*1400,variant:region.variant })));
      }
      const playerLines = ['left','right'].flatMap(side => {
        return buildPlayerLines(nameLines[side],statLines[side],side,candidates,1400);
      });
      await worker.setParameters?.({ tessedit_pageseg_mode:'10', tessedit_char_whitelist:'0123456789' });
      for (let index = 0; index < (images.scoreDigits || []).length; index += 1) {
        const digitRegion = images.scoreDigits[index];
        onProgress(84 + index * 4, 'Leyendo el marcador');
        const scoreResult = await worker.recognize(digitRegion.canvas, {}, { blocks:true, text:true });
        const digit = String(scoreResult.data?.text || '').match(/\d{1,2}/)?.[0];
        if (digit) scoreDigits[digitRegion.side].push(digit);
      }
      const preferredDigit=values=>[...new Set(values)].map(value=>({ value,count:values.filter(item=>item===value).length }))
        .sort((a,b)=>b.count-a.count)[0]?.value;
      const leftScore=preferredDigit(scoreDigits.left),rightScore=preferredDigit(scoreDigits.right);
      if (leftScore && rightScore) scoreLines.push({ text:`${leftScore} VS ${rightScore}`, confidence:90, y:0, side:'unknown' });
      const lines = playerLines.length ? [...fullLines, ...playerLines, ...scoreLines] : [...fullLines, ...scoreLines];
      const rawText = [result.data?.text, ...playerLines.map(line => line.text), ...scoreLines.map(line => line.text)].filter(Boolean).join('\n');
      onProgress(94, 'Comparando nombres con los integrantes');
      const parsed = parseResult(lines, rawText, context);
      onProgress(100, 'Borrador listo para revisar');
      return parsed;
    } finally {
      await worker?.terminate?.().catch?.(() => {});
    }
  }

  window.luxMatchOCR = Object.freeze({ analyze, parseResult, normalizeName, similarity, nameQuality });
})();
