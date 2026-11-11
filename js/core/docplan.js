// docplan.js — Calcola le modifiche da fare al Google Doc (richieste batchUpdate)
// per inserire una trascrizione sotto la data giusta nella scheda della materia.
// Regole: non modificare né cancellare mai il contenuto esistente; non duplicare.

import { parseDateHeading, formatDate, formatTemplate, inferYear, sameDay } from './dates.js';

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Tutte le schede del documento, comprese quelle annidate, come elenco piatto. */
export function flattenTabs(doc) {
  const out = [];
  const walk = (tabs, depth) => {
    for (const t of tabs || []) {
      out.push({ tabId: t.tabProperties?.tabId, title: t.tabProperties?.title || '', depth, body: t.documentTab?.body?.content || [] });
      walk(t.childTabs, depth + 1);
    }
  };
  if (doc.tabs) walk(doc.tabs, 0);
  else out.push({ tabId: null, title: doc.title || '', depth: 0, body: doc.body?.content || [] });
  return out;
}

/** Scheda per id (se configurato) oppure per titolo: esatto, contenuto, o con più parole in comune. */
export function findTab(tabs, { tabId, tabTitle, name }) {
  if (tabId) { const t = tabs.find(x => x.tabId === tabId); if (t) return t; }
  for (const want of [tabTitle, name].filter(Boolean).map(norm)) {
    const exact = tabs.find(t => norm(t.title) === want); if (exact) return exact;
    const contains = tabs.find(t => norm(t.title).includes(want) || (norm(t.title) && want.includes(norm(t.title)))); if (contains) return contains;
  }
  const words = new Set(norm(tabTitle || name).split(' ').filter(w => w.length > 3));
  let best = null, bestScore = 0;
  for (const t of tabs) {
    const tw = norm(t.title).split(' ').filter(w => w.length > 3);
    const score = tw.filter(w => words.has(w)).length / Math.max(1, Math.min(words.size, tw.length));
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore >= 0.5 ? best : null;
}

/** Paragrafi di primo livello con indici, testo e stile del primo frammento di testo. */
export function paragraphsOf(body) {
  const paras = [];
  for (const el of body) {
    if (el.paragraph) {
      const runs = el.paragraph.elements || [];
      const text = runs.map(r => r.textRun?.content || '').join('').replace(/\n$/, '');
      const firstRun = runs.find(r => r.textRun && r.textRun.content.trim());
      paras.push({
        start: el.startIndex ?? 0, end: el.endIndex, text,
        namedStyle: el.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT',
        bullet: !!el.paragraph.bullet,
        textStyle: firstRun?.textRun?.textStyle || {},
      });
    } else if (el.table || el.sectionBreak || el.tableOfContents) {
      paras.push({ start: el.startIndex ?? 0, end: el.endIndex, text: '', namedStyle: 'BLOCK', block: true, textStyle: {} });
    }
  }
  return paras;
}

function looksLikeHeading(p) {
  if (p.block || p.bullet) return false;
  if (p.namedStyle && p.namedStyle !== 'NORMAL_TEXT') return true;
  if (p.textStyle?.bold) return true;
  return p.text.trim().length <= 28; // una riga corta da sola, es. "11/11"
}

/** Titoli di data presenti nella scheda, con la data completa ricostruita. */
export function dateHeadings(paras, refDate) {
  const out = [];
  paras.forEach((p, idx) => {
    if (!looksLikeHeading(p)) return;
    const r = parseDateHeading(p.text);
    if (!r) return;
    const year = r.year ?? inferYear(r.day, r.month, refDate);
    const date = new Date(year, r.month - 1, r.day);
    if (date.getMonth() !== r.month - 1) return; // 31/02 e simili
    out.push({ idx, date, desc: r.desc, para: p });
  });
  return out;
}

/** Il primo paragrafo di testo normale non vuoto: fa da modello per carattere e dimensione. */
function referenceBodyStyle(paras) {
  const p = paras.find(x => !x.block && x.namedStyle === 'NORMAL_TEXT' && !x.textStyle?.bold && x.text.trim().length > 40);
  return p?.textStyle || null;
}

const TEXT_FIELDS = ['bold', 'italic', 'underline', 'strikethrough', 'smallCaps', 'fontSize', 'weightedFontFamily', 'foregroundColor', 'backgroundColor', 'link', 'baselineOffset'];

function copyTextStyle(src) {
  const style = {};
  for (const f of ['bold', 'italic', 'underline', 'fontSize', 'weightedFontFamily', 'foregroundColor']) if (src && src[f] !== undefined) style[f] = src[f];
  return style;
}

/** Impronta per riconoscere un testo già inserito (idempotenza). */
export function fingerprint(text) {
  return norm(text).split(' ').slice(0, 14).join(' ');
}

/**
 * Pianifica l'inserimento.
 * @param {object} p
 * @param {object} p.tab        scheda (da flattenTabs)
 * @param {Date}   p.date       data della lezione
 * @param {string[]} p.paragraphs  paragrafi del testo pulito
 * @param {string} [p.label]    riga di intestazione del blocco (es. "Trascrizione automatica · 10:40–12:20")
 * @param {object} p.dateFormat configurazione { mode, template, headingStyle }
 * @param {Date}   [p.now]      riferimento per gli anni mancanti
 * @returns {{requests: object[], alreadyPresent: boolean, createdHeading: string|null, headingText: string, insertAt: number}}
 */
export function planInsertion({ tab, date, paragraphs, label, dateFormat, now = new Date() }) {
  const paras = paragraphsOf(tab.body);
  const heads = dateHeadings(paras, now);
  const tabId = tab.tabId;
  const loc = index => (tabId ? { index, tabId } : { index });
  const rng = (startIndex, endIndex) => (tabId ? { startIndex, endIndex, tabId } : { startIndex, endIndex });
  const clean = paragraphs.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) throw new Error('Testo vuoto: niente da inserire.');

  const existing = heads.find(h => sameDay(h.date, date));
  const template = existing || heads[heads.length - 1] || null;
  let headingText;
  if (existing) headingText = existing.para.text.trim();
  else if (dateFormat?.mode === 'custom' || !template) headingText = formatTemplate(dateFormat?.template || '{dd}/{mm}/{yyyy}', date);
  else headingText = formatDate(template.desc, date);

  // Sezione della data: dal titolo al titolo di data successivo (qualsiasi data) o alla fine.
  const lastPara = paras[paras.length - 1];
  const bodyEnd = lastPara ? lastPara.end : 2;
  let insertBeforeIdx = null; // indice del paragrafo davanti a cui inserire, o null = in fondo
  if (existing) {
    const next = heads.find(h => h.idx > existing.idx);
    insertBeforeIdx = next ? next.idx : null;
    // Idempotenza: il testo è già nella sezione?
    const from = existing.idx + 1, to = next ? next.idx : paras.length;
    const sectionText = norm(paras.slice(from, to).map(p => p.text).join(' '));
    if (sectionText.includes(fingerprint(clean[0]))) return { requests: [], alreadyPresent: true, createdHeading: null, headingText, insertAt: -1 };
  } else {
    // Ordine cronologico: prima del primo titolo con data successiva.
    const later = heads.find(h => h.date > date);
    insertBeforeIdx = later ? later.idx : null;
  }

  const lines = [];
  if (!existing) lines.push({ kind: 'heading', text: headingText });
  if (label) lines.push({ kind: 'label', text: label });
  for (const c of clean) lines.push({ kind: 'body', text: c });

  let insertAt, text, firstLineStart;
  if (insertBeforeIdx !== null) {
    // "riga1\nriga2\n" davanti al titolo successivo
    insertAt = paras[insertBeforeIdx].start;
    text = lines.map(l => l.text).join('\n') + '\n';
    firstLineStart = insertAt;
  } else {
    // in fondo: "\nriga1\nriga2" prima dell'ultimo a capo; se l'ultimo paragrafo è vuoto lo si riusa
    const lastEmpty = lastPara && !lastPara.block && lastPara.text.trim() === '';
    insertAt = bodyEnd - 1;
    text = (lastEmpty ? '' : '\n') + lines.map(l => l.text).join('\n');
    firstLineStart = insertAt + (lastEmpty ? 0 : 1);
  }

  const requests = [{ insertText: { location: loc(insertAt), text } }];
  // Posizioni di ogni riga inserita (indici UTF-16 = lunghezza JS)
  let pos = firstLineStart;
  const spans = lines.map(l => { const s = { ...l, start: pos, end: pos + l.text.length }; pos += l.text.length + 1; return s; });
  const all = rng(spans[0].start, spans[spans.length - 1].end);

  // 1) azzera elenchi puntati e stile ereditati dal punto di inserimento
  requests.push({ deleteParagraphBullets: { range: all } });
  requests.push({ updateParagraphStyle: { range: all, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
    fields: 'namedStyleType,indentStart,indentFirstLine,alignment,borderLeft,borderTop,borderBottom,shading,pageBreakBefore' } });
  const bodyStyle = copyTextStyle(referenceBodyStyle(paras));
  requests.push({ updateTextStyle: { range: all, textStyle: { ...bodyStyle, bold: false, italic: false, underline: false }, fields: TEXT_FIELDS.join(',') } });

  // 2) titolo di data nello stesso stile degli altri titoli
  const h = spans.find(s => s.kind === 'heading');
  if (h) {
    const named = template?.para.namedStyle && template.para.namedStyle !== 'NORMAL_TEXT' ? template.para.namedStyle
      : (template ? 'NORMAL_TEXT' : (dateFormat?.headingStyle || 'HEADING_2'));
    requests.push({ updateParagraphStyle: { range: rng(h.start, h.end + 1), paragraphStyle: { namedStyleType: named }, fields: 'namedStyleType' } });
    // Tutti i campi: quelli non copiati dal modello tornano allo stile del titolo (es. Titolo 2).
    const ts = template ? copyTextStyle(template.para.textStyle) : {};
    if (named === 'NORMAL_TEXT' && !ts.bold) ts.bold = true;
    if (h.end > h.start) requests.push({ updateTextStyle: { range: rng(h.start, h.end), textStyle: ts, fields: TEXT_FIELDS.join(',') } });
  }
  // 3) riga di intestazione del blocco in corsivo grigio
  const lb = spans.find(s => s.kind === 'label');
  if (lb && lb.end > lb.start) {
    requests.push({ updateTextStyle: { range: rng(lb.start, lb.end),
      textStyle: { italic: true, foregroundColor: { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.48 } } } }, fields: 'italic,foregroundColor' } });
  }
  return { requests, alreadyPresent: false, createdHeading: existing ? null : headingText, headingText, insertAt };
}

/** Riepilogo del formato data rilevato in una scheda, per la configurazione guidata. */
export function detectFormat(tab, now = new Date()) {
  const heads = dateHeadings(paragraphsOf(tab.body), now);
  if (!heads.length) return null;
  const last = heads[heads.length - 1];
  return { count: heads.length, example: last.para.text.trim(), desc: last.desc, namedStyle: last.para.namedStyle, sample: formatDate(last.desc, now) };
}
