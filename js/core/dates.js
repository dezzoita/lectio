// dates.js — Riconosce come sono scritte le date delle lezioni nel documento
// e scrive le nuove date nello stesso formato.

export const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
export const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const NUM_RE = /(?<![\d/.\-])(\d{1,2})\s?([/.\-])\s?(\d{1,2})(?:\s?\2\s?(\d{4}|\d{2}))?(?![\d/.\-]*\d)/;
const WD = '(lunedi|lunedì|martedi|martedì|mercoledi|mercoledì|giovedi|giovedì|venerdi|venerdì|sabato|domenica)';
const TEXT_RE = new RegExp(`(?:${WD}\\s*,?\\s+)?(\\d{1,2})(?:°)?\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`, 'i');

const MAX_HEADING_LEN = 70;
const MAX_EXTRA_LEN = 32;

function caseOf(s) {
  if (s === s.toUpperCase()) return 'upper';
  if (s[0] === s[0].toUpperCase()) return 'cap';
  return 'lower';
}
function applyCase(s, c) { return c === 'upper' ? s.toUpperCase() : c === 'cap' ? s[0].toUpperCase() + s.slice(1) : s; }

/**
 * Se il paragrafo è un titolo di data (testo breve che contiene una data), restituisce
 * { day, month, year|null, desc } dove desc descrive il formato per riprodurlo.
 */
export function parseDateHeading(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_HEADING_LEN) return null;
  let m = t.match(TEXT_RE);
  if (m) {
    const [whole, wd, d, mon, y] = m;
    const day = +d, month = MONTHS.indexOf(mon.toLowerCase()) + 1;
    if (day < 1 || day > 31) return null;
    const prefix = t.slice(0, m.index), suffix = t.slice(m.index + whole.length);
    if ((prefix + suffix).length > MAX_EXTRA_LEN) return null;
    const sepAfterWd = wd ? whole.slice(wd.length).match(/^\s*,?\s+/)[0] : ' ';
    return {
      day, month, year: y ? +y : null,
      desc: { kind: 'text', weekday: !!wd, weekdayCase: wd ? caseOf(wd) : 'cap', weekdaySep: sepAfterWd,
              monthCase: caseOf(mon), year: !!y, ordinal: whole.includes('°'), prefix, suffix },
    };
  }
  m = t.match(NUM_RE);
  if (m) {
    const [whole, d, sep, mo, y] = m;
    const day = +d, month = +mo;
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    const prefix = t.slice(0, m.index), suffix = t.slice(m.index + whole.length);
    if ((prefix + suffix).length > MAX_EXTRA_LEN) return null;
    // un numero isolato tipo "3.2" in un titolo di paragrafo non è una data: serve anno o separatore '/'
    if (sep === '.' && !y) return null;
    let year = null;
    if (y) year = y.length === 2 ? 2000 + +y : +y;
    return {
      day, month, year,
      desc: { kind: 'num', sep, spaced: /\s/.test(whole), padDay: d.length === 2, padMonth: mo.length === 2,
              yearLen: y ? y.length : 0, prefix, suffix },
    };
  }
  return null;
}

/** Scrive una data nel formato descritto. */
export function formatDate(desc, date) {
  const d = date.getDate(), mo = date.getMonth() + 1, y = date.getFullYear();
  if (desc.kind === 'text') {
    let s = '';
    if (desc.weekday) s += applyCase(WEEKDAYS[date.getDay()], desc.weekdayCase) + (desc.weekdaySep || ' ');
    s += d + (desc.ordinal && d === 1 ? '°' : '') + ' ' + applyCase(MONTHS[mo - 1], desc.monthCase);
    if (desc.year) s += ' ' + y;
    return (desc.prefix || '') + s + (desc.suffix || '');
  }
  const sp = desc.spaced ? ' ' : '';
  const dd = desc.padDay ? String(d).padStart(2, '0') : String(d);
  const mm = desc.padMonth ? String(mo).padStart(2, '0') : String(mo);
  let s = dd + sp + desc.sep + sp + mm;
  if (desc.yearLen) s += sp + desc.sep + sp + (desc.yearLen === 2 ? String(y).slice(2) : y);
  return (desc.prefix || '') + s + (desc.suffix || '');
}

/** Formato da un modello scritto a mano, es. "Lezione del {d} {mese} {yyyy}". */
export function formatTemplate(template, date) {
  const d = date.getDate(), mo = date.getMonth() + 1, y = date.getFullYear();
  return template
    .replace(/\{dd\}/g, String(d).padStart(2, '0')).replace(/\{d\}/g, String(d))
    .replace(/\{mm\}/g, String(mo).padStart(2, '0')).replace(/\{m\}/g, String(mo))
    .replace(/\{yyyy\}/g, String(y)).replace(/\{yy\}/g, String(y).slice(2))
    .replace(/\{Mese\}/g, MONTHS[mo - 1][0].toUpperCase() + MONTHS[mo - 1].slice(1)).replace(/\{mese\}/g, MONTHS[mo - 1])
    .replace(/\{Giorno\}/g, WEEKDAYS[date.getDay()][0].toUpperCase() + WEEKDAYS[date.getDay()].slice(1)).replace(/\{giorno\}/g, WEEKDAYS[date.getDay()]);
}

/** Anno più plausibile per una data scritta senza anno, rispetto a una data di riferimento. */
export function inferYear(day, month, ref) {
  let best = null, bestDiff = Infinity;
  for (const y of [ref.getFullYear() - 1, ref.getFullYear(), ref.getFullYear() + 1]) {
    const diff = Math.abs(new Date(y, month - 1, day) - ref);
    if (diff < bestDiff) { bestDiff = diff; best = y; }
  }
  return best;
}

export function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

/** Descrizione leggibile del formato, per mostrarla nelle impostazioni. */
export function describeFormat(desc) {
  return formatDate(desc, new Date(2026, 10, 11));
}
