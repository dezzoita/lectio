// cleaning.js — Pulizia del testo direttamente sul dispositivo, gratuita e senza servizi esterni.
// Fa solo correzioni sicure e meccaniche: niente riassunti, niente riscritture.
// La rielaborazione vera resta all'attività che legge il documento degli appunti.

export function countWords(s) { return (String(s || '').match(/\S+/g) || []).length; }

/**
 * Accumula il testo grezzo e restituisce blocchi di circa `minWords` parole,
 * tagliati alla fine di una frase. Ogni blocco diventa uno o più paragrafi.
 */
export class Segmenter {
  constructor({ minWords = 140, maxWords = 260 } = {}) { this.minWords = minWords; this.maxWords = maxWords; this.buffer = ''; }
  add(text) { const t = String(text || '').trim(); if (t) this.buffer = this.buffer ? this.buffer + ' ' + t : t; }
  /** Blocco pronto, oppure null. Con force restituisce tutto ciò che resta. */
  take(force = false) {
    const words = this.buffer.split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    if (force) { const out = this.buffer.trim(); this.buffer = ''; return out; }
    if (words.length < this.minWords) return null;
    let cut = -1;
    for (let k = Math.min(words.length, this.maxWords) - 1; k >= this.minWords - 1; k--) {
      if (/[.!?…]["»”)]?$/.test(words[k])) { cut = k + 1; break; }
    }
    if (cut === -1) { if (words.length < this.maxWords) return null; cut = this.maxWords; }
    const out = words.slice(0, cut).join(' ');
    this.buffer = words.slice(cut).join(' ');
    return out;
  }
}

// ---------------------------------------------------------------------
// Intercalari e ripetizioni
// ---------------------------------------------------------------------
// Solo suoni di esitazione: parole come "diciamo" o "cioè" restano, perché spesso hanno un senso.
const FILLER = /(^|[\s,;])(e+h+m*|u+h*m+|u+h+|m+h+|m{2,}|e{2,})(?=[\s,;.!?]|$)[,]?/gi;

export function removeFillers(text) {
  return String(text || '')
    .replace(FILLER, '$1')
    .replace(/\s+,/g, ',').replace(/,\s*,+/g, ',').replace(/(^|[.!?]\s+),\s*/g, '$1')
    .replace(/\s{2,}/g, ' ').trim();
}

/** Ripetizioni immediate dovute all'esitazione: "il il", "che che", "la riserva la riserva". */
export function removeRepetitions(text) {
  let t = String(text || '');
  for (let n = 4; n >= 1; n--) {
    const re = new RegExp(`\\b((?:[\\p{L}\\p{N}']+\\s+){${n - 1}}[\\p{L}\\p{N}']+)(?:\\s*,?\\s+\\1\\b)+`, 'giu');
    t = t.replace(re, '$1');
  }
  return t;
}

// ---------------------------------------------------------------------
// Correzione con il glossario
// ---------------------------------------------------------------------
const fold = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Prepara il glossario per la correzione. Per evitare di "correggere" parole italiane
 * normali, un termine si applica solo a frammenti che hanno la stessa iniziale e la stessa
 * lettera finale e differiscono di pochissimo (circa una lettera ogni 6-7).
 */
export function compileGlossary(terms) {
  return (terms || []).map(t => String(t).trim()).filter(Boolean).map(term => {
    const words = term.split(/\s+/);
    const key = fold(term).replace(/[^a-z0-9' ]/g, '');
    return { term, words: words.length, key, initials: words.map(w => fold(w).replace(/^h/, '')[0]).join(''), max: key.length >= 6 ? Math.max(1, Math.floor(key.length / 7)) : 0 };
  }).filter(g => g.key.length >= 3).sort((a, b) => b.words - a.words || b.key.length - a.key.length);
}

/** Corregge grafia e maiuscole dei termini del glossario dentro il testo. */
export function applyGlossary(text, compiled) {
  if (!compiled?.length) return text;
  // tokenizzazione che conserva la punteggiatura attaccata alle parole
  const tokens = String(text).split(/(\s+)/);
  const wordIdx = []; tokens.forEach((t, i) => { if (!/^\s+$/.test(t) && t) wordIdx.push(i); });
  const core = t => t.replace(/^[«"“(\[]+|[»"”)\].,;:!?…]+$/g, '');
  const used = new Set();
  for (const g of compiled) {
   // un termine può arrivare anche spezzato in una parola in più ("grund norm" → "Grundnorm")
   for (const extra of [0, 1]) {
    const n = g.words + extra;
    for (let w = 0; w + n <= wordIdx.length; w++) {
      const span = wordIdx.slice(w, w + n);
      if (span.some(i => used.has(i))) continue;
      const pieces = span.map(i => core(tokens[i]));
      if (pieces.some(p => !p)) continue;
      let cand = fold(pieces.join(' ')).replace(/[^a-z0-9' ]/g, '');
      if (!cand) continue;
      if (extra) { if (g.max === 0) continue; cand = cand.replace(/ /g, ''); if (cand !== g.key.replace(/ /g, '')) continue; }
      let ok = cand === g.key || extra === 1;
      // l'h iniziale del latino non si pronuncia: "ortensia" può essere "Hortensia"
      if (!ok && g.max > 0 && cand.replace(/^h/, '')[0] === g.key.replace(/^h/, '')[0]) {
        // parola singola: stessa iniziale e stessa finale; termine composto: stesse iniziali di ogni parola
        const shape = g.words === 1 ? cand.at(-1) === g.key.at(-1) : pieces.map(p => fold(p).replace(/^h/, '')[0]).join('') === g.initials;
        ok = shape && levenshtein(cand, g.key, g.max) <= g.max;
      }
      if (!ok) continue;
      if (pieces.join(' ') === g.term) { span.forEach(i => used.add(i)); continue; }
      // nomi brevi che sono anche parole comuni ("greco", "gaio"): non si cambiano solo le maiuscole
      if (!extra && g.words === 1 && g.key.length < 6 && pieces[0].toLowerCase() === g.term.toLowerCase()) continue;
      // sostituisce conservando la punteggiatura esterna del primo e dell'ultimo frammento
      const first = tokens[span[0]], last = tokens[span[span.length - 1]];
      const lead = first.match(/^[«"“(\[]*/)[0], trail = last.match(/[»"”)\].,;:!?…]*$/)[0];
      const termWords = g.term.split(/\s+/);
      // se nel testo la parola era maiuscola (es. a inizio frase), resta maiuscola
      if (/^\p{Lu}/u.test(pieces[0])) termWords[0] = termWords[0][0].toUpperCase() + termWords[0].slice(1);
      span.forEach((i, k) => { tokens[i] = (k === 0 ? lead : '') + (termWords[k] ?? '') + (k === span.length - 1 ? trail : ''); used.add(i); });
      // con un frammento in più, l'ultimo token resta vuoto: si toglie anche lo spazio che lo precede
      if (extra) for (let k = termWords.length; k < span.length; k++) { tokens[span[k] - 1] = ''; }
    }
   }
  }
  return tokens.join('').replace(/\s{2,}/g, ' ');
}

// ---------------------------------------------------------------------
// Frasi e paragrafi
// ---------------------------------------------------------------------
export function fixSentences(text) {
  let t = String(text || '').replace(/\s+([.,;:!?…])/g, '$1').replace(/([.!?])(\s*[.,])+(?!\.)/g, '$1').replace(/([.,;:!?])(?=[\p{L}])/gu, '$1 ');
  t = t.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
  if (t && !/[.!?…»"”)]$/.test(t)) t += '.';
  return t.replace(/\s{2,}/g, ' ').trim();
}

/** Divide in paragrafi di circa `target` parole, sempre alla fine di una frase. */
export function paragraphize(text, target = 120) {
  const sentences = String(text || '').match(/[^.!?…]+(?:[.!?…]+["»”)]?|$)/g)?.map(s => s.trim()).filter(Boolean) || [];
  const out = []; let cur = [], n = 0;
  for (const s of sentences) {
    cur.push(s); n += countWords(s);
    if (n >= target) { out.push(cur.join(' ')); cur = []; n = 0; }
  }
  if (cur.length) {
    // un paragrafo finale troppo corto si unisce al precedente
    if (out.length && n < target / 3) out[out.length - 1] += ' ' + cur.join(' ');
    else out.push(cur.join(' '));
  }
  return out;
}

/** Pulizia completa di un blocco. Le opzioni vengono dalle Impostazioni. */
export function localClean(raw, { glossary = [], fillers = true, useGlossary = true, compiled } = {}) {
  let t = String(raw || '');
  if (fillers) t = removeRepetitions(removeFillers(t));
  if (useGlossary) t = applyGlossary(t, compiled || compileGlossary(glossary));
  t = fixSentences(t);
  return paragraphize(t).join('\n\n');
}

export function toParagraphs(text) {
  return String(text || '').split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean);
}
