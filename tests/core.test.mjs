import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocSim } from './docsim.mjs';
import { parseDateHeading, formatDate, formatTemplate, inferYear } from '../js/core/dates.js';
import { planInsertion, findTab, flattenTabs, detectFormat, paragraphsOf, dateHeadings } from '../js/core/docplan.js';
import { resolveAt, validateTimetable, isoDate } from '../js/core/schedule.js';
import { defaultConfig, normalizeConfig, activeSemester, importConfig, exportConfig, newSemester, parseGlossary } from '../js/core/config.js';
import { Segmenter, toParagraphs, countWords, localClean, compileGlossary, applyGlossary, removeFillers, removeRepetitions, paragraphize } from '../js/core/cleaning.js';
import { Chunker, whisperPrompt, cleanHallucinations, resampleTo16k } from '../js/core/audio.js';

const NOV11 = new Date(2026, 10, 11, 12, 0);
const DF = { mode: 'auto', template: '{dd}/{mm}/{yyyy}', headingStyle: 'HEADING_2' };

// ---------------- Date ----------------
test('date: formati numerici riconosciuti e riprodotti', () => {
  for (const [txt, out] of [['11/11/2026', '12/11/2026'], ['3/11', '12/11'], ['Lezione 05.11.2026', 'Lezione 12.11.2026'], ['[11/11]', '[12/11]'], ['11-11-26', '12-11-26']]) {
    const r = parseDateHeading(txt);
    assert.ok(r, 'riconosce ' + txt);
    assert.equal(formatDate(r.desc, new Date(2026, 10, 12)), out, txt);
  }
  assert.equal(formatDate(parseDateHeading('03/11/2026').desc, new Date(2026, 0, 5)), '05/01/2027'.replace('2027', '2026'));
});
test('date: formati testuali con giorno della settimana', () => {
  const r = parseDateHeading('Lunedì 10 novembre');
  assert.equal(r.day, 10); assert.equal(r.month, 11); assert.equal(r.year, null);
  assert.equal(formatDate(r.desc, new Date(2026, 10, 11)), 'Mercoledì 11 novembre');
  const r2 = parseDateHeading('Lezione del 4 Novembre 2026');
  assert.equal(formatDate(r2.desc, new Date(2026, 10, 11)), 'Lezione del 11 Novembre 2026');
});
test('date: non scambia numeri di paragrafo o articoli per date', () => {
  for (const t of ['3.2 Il Senato', 'Art. 11 Cost.', '51.1 Sottoparagrafo', 'Capitolo 4', 'La lex Hortensia del 287 a.C. stabilì che i plebisciti vincolassero tutti i cittadini romani senza eccezione']) {
    assert.equal(parseDateHeading(t), null, t);
  }
});
test('date: anno dedotto vicino al riferimento', () => {
  assert.equal(inferYear(15, 12, NOV11), 2026);
  assert.equal(inferYear(10, 1, NOV11), 2027);
  assert.equal(inferYear(20, 9, new Date(2027, 0, 10)), 2026);
  assert.equal(formatTemplate('Lezione del {Giorno} {d} {mese} {yyyy}', new Date(2026, 10, 11)), 'Lezione del Mercoledì 11 novembre 2026');
});

// ---------------- Inserimento nel documento ----------------
function romano() {
  return new DocSim([
    { text: 'Storia del diritto romano', named: 'TITLE' },
    { text: '04/11/2026', named: 'HEADING_2', ts: { bold: true } },
    { text: 'Appunti del 4 novembre sull\'età monarchica.' },
    { text: '10/11/2026', named: 'HEADING_2', ts: { bold: true } },
    { text: 'La res publica e le magistrature', bullet: true },
  ]);
}
const P = ['Il populus Romanus si riuniva nei comitia centuriata.', 'Con la lex Hortensia i plebiscita divennero vincolanti.'];

test('inserimento: data nuova in fondo, stesso formato e stile, senza elenco puntato ereditato', () => {
  const doc = romano();
  const plan = planInsertion({ tab: doc.tab(), date: NOV11, paragraphs: P, label: 'Trascrizione automatica · 12:35–14:15', dateFormat: DF, now: NOV11 });
  assert.equal(plan.createdHeading, '11/11/2026');
  doc.apply(plan.requests);
  assert.deepEqual(doc.texts().slice(-4), ['11/11/2026', 'Trascrizione automatica · 12:35–14:15', P[0], P[1]]);
  const [h, l, b1] = doc.paras.slice(-4);
  assert.equal(h.named, 'HEADING_2'); assert.equal(h.ts.bold, true); assert.equal(h.bullet, false);
  assert.equal(l.ts.italic, true);
  assert.equal(b1.named, 'NORMAL_TEXT'); assert.equal(b1.bullet, false); assert.equal(b1.ts.bold, false);
  assert.equal(doc.texts()[4], 'La res publica e le magistrature', 'contenuto esistente intatto');
  assert.equal(doc.paras[4].bullet, true, 'elenco esistente intatto');
});

test('inserimento: idempotente — un secondo invio non duplica', () => {
  const doc = romano();
  doc.apply(planInsertion({ tab: doc.tab(), date: NOV11, paragraphs: P, dateFormat: DF, now: NOV11 }).requests);
  const n = doc.paras.length;
  const again = planInsertion({ tab: doc.tab(), date: NOV11, paragraphs: P, dateFormat: DF, now: NOV11 });
  assert.equal(again.alreadyPresent, true); assert.equal(again.requests.length, 0);
  assert.equal(doc.paras.length, n);
});

test('inserimento: data già presente in mezzo → il testo va in fondo alla sua sezione', () => {
  const doc = romano();
  const plan = planInsertion({ tab: doc.tab(), date: new Date(2026, 10, 4), paragraphs: P, dateFormat: DF, now: NOV11 });
  assert.equal(plan.createdHeading, null);
  doc.apply(plan.requests);
  assert.deepEqual(doc.texts(), ['Storia del diritto romano', '04/11/2026', 'Appunti del 4 novembre sull\'età monarchica.', P[0], P[1], '10/11/2026', 'La res publica e le magistrature']);
  assert.equal(doc.paras[5].named, 'HEADING_2', 'il titolo successivo resta un titolo');
  assert.equal(doc.paras[3].named, 'NORMAL_TEXT');
});

test('inserimento: data mancante tra due date → nuovo titolo in ordine cronologico', () => {
  const doc = romano();
  doc.apply(planInsertion({ tab: doc.tab(), date: new Date(2026, 10, 5), paragraphs: P, dateFormat: DF, now: NOV11 }).requests);
  assert.deepEqual(doc.texts().slice(1, 7), ['04/11/2026', 'Appunti del 4 novembre sull\'età monarchica.', '05/11/2026', P[0], P[1], '10/11/2026']);
  assert.equal(doc.paras[3].named, 'HEADING_2');
});

test('inserimento: scheda vuota → titolo col modello di configurazione', () => {
  const doc = new DocSim([{ text: '' }]);
  const plan = planInsertion({ tab: doc.tab(), date: NOV11, paragraphs: P, dateFormat: DF, now: NOV11 });
  doc.apply(plan.requests);
  assert.deepEqual(doc.texts(), ['11/11/2026', P[0], P[1]]);
  assert.equal(doc.paras[0].named, 'HEADING_2');
});

test('inserimento: modello personalizzato e date testuali', () => {
  const doc = new DocSim([{ text: 'Filosofia' }, { text: 'Lunedì 10 novembre', ts: { bold: true } }, { text: 'Appunti sui sofisti, Protagora e il relativismo etico.' }]);
  doc.apply(planInsertion({ tab: doc.tab(), date: NOV11, paragraphs: P, dateFormat: DF, now: NOV11 }).requests);
  assert.equal(doc.texts()[3], 'Mercoledì 11 novembre');
  assert.equal(doc.paras[3].ts.bold, true);
  const doc2 = new DocSim([{ text: 'x' }]);
  doc2.apply(planInsertion({ tab: doc2.tab(), date: NOV11, paragraphs: P, dateFormat: { mode: 'custom', template: 'Lezione {d}/{m}' }, now: NOV11 }).requests);
  assert.equal(doc2.texts()[1], 'Lezione 11/11');
});

test('inserimento: indici con caratteri speciali (accenti, emoji, simboli)', () => {
  const doc = new DocSim([{ text: '⁃ Il diritto è una scienza sociale 📘' }, { text: '10/11/2026', named: 'HEADING_2' }, { text: 'però' }]);
  doc.apply(planInsertion({ tab: doc.tab(), date: NOV11, paragraphs: ['Città, libertà, perché.'], dateFormat: DF, now: NOV11 }).requests);
  assert.deepEqual(doc.texts(), ['⁃ Il diritto è una scienza sociale 📘', '10/11/2026', 'però', '11/11/2026', 'Città, libertà, perché.']);
});

test('schede: ricerca per titolo, id e somiglianza; schede annidate', () => {
  const doc = { tabs: [
    { tabProperties: { tabId: 'a', title: 'Diritto Costituzionale I' }, documentTab: { body: { content: [] } } },
    { tabProperties: { tabId: 'b', title: 'Diritto romano' }, documentTab: { body: { content: [] } },
      childTabs: [{ tabProperties: { tabId: 'b2', title: 'Fotocopie' }, documentTab: { body: { content: [] } } }] },
    { tabProperties: { tabId: 'c', title: 'Filosofia del diritto' }, documentTab: { body: { content: [] } } },
  ] };
  const tabs = flattenTabs(doc);
  assert.equal(tabs.length, 4);
  assert.equal(findTab(tabs, { tabTitle: 'diritto romano' }).tabId, 'b');
  assert.equal(findTab(tabs, { tabTitle: '', name: 'Storia del diritto romano' }).tabId, 'b');
  assert.equal(findTab(tabs, { tabTitle: 'Diritto costituzionale' }).tabId, 'a');
  assert.equal(findTab(tabs, { tabId: 'c', tabTitle: 'zzz' }).tabId, 'c');
  assert.equal(findTab(tabs, { tabTitle: 'Economia politica' }), null);
});

test('rilevamento del formato per la configurazione guidata', () => {
  const f = detectFormat(romano().tab(), NOV11);
  assert.equal(f.count, 2); assert.equal(f.example, '10/11/2026'); assert.equal(f.sample, '11/11/2026'); assert.equal(f.namedStyle, 'HEADING_2');
  assert.equal(detectFormat(new DocSim([{ text: 'niente date qui' }]).tab(), NOV11), null);
  // una riga corta in grassetto con un numero non deve diventare una data
  assert.equal(dateHeadings(paragraphsOf(new DocSim([{ text: '31/02', ts: { bold: true } }]).body()), NOV11).length, 0);
});

// ---------------- Orario ----------------
test('orario: materia del momento, pause, prima e dopo', () => {
  const sem = activeSemester(defaultConfig());
  const at = (h, m) => resolveAt(sem, new Date(2026, 10, 11, h, m)); // mercoledì
  assert.equal(at(9, 0).subject.name, 'Diritto costituzionale I'); assert.equal(at(9, 0).transcribe, false);
  assert.equal(at(10, 30).kind, 'break'); assert.equal(at(10, 30).nextSubject.name, 'Filosofia del diritto');
  assert.equal(at(11, 0).subject.name, 'Filosofia del diritto'); assert.equal(at(11, 0).transcribe, true);
  assert.equal(at(11, 0).endsAt.getHours(), 12); assert.equal(at(11, 0).endsAt.getMinutes(), 20);
  assert.equal(at(13, 0).subject.name, 'Storia del diritto romano');
  assert.equal(at(8, 0).kind, 'before'); assert.equal(at(15, 0).kind, 'outside');
  assert.equal(resolveAt(sem, new Date(2026, 10, 13, 11, 0)).kind, 'outside', 'venerdì senza lezioni');
  assert.deepEqual(validateTimetable(sem), []);
  assert.equal(isoDate(NOV11), '2026-11-11');
});
test('orario: segnala sovrapposizioni', () => {
  const cfg = defaultConfig(); const sem = activeSemester(cfg);
  sem.timetable.push({ id: 'x', day: 1, start: '10:00', end: '11:00', subjectId: 'sub-filo' });
  assert.ok(validateTimetable(sem).some(s => s.includes('sovrapposte')));
});

// ---------------- Configurazione ----------------
test('configurazione: normalizzazione, esportazione/importazione, nuovo semestre, glossari', () => {
  const cfg = defaultConfig();
  const back = importConfig(exportConfig(cfg));
  assert.deepEqual(back, normalizeConfig(cfg));
  assert.throws(() => importConfig('{"app":"altro"}'));
  const partial = normalizeConfig({ semesters: [{ name: 'S', subjects: [{ name: 'Privato' }], timetable: [{ day: 2, start: '9:00', end: 'x' }] }] });
  assert.equal(partial.semesters[0].timetable.length, 0); assert.equal(partial.semesters[0].subjects[0].transcribe, true);
  newSemester(cfg, 'II semestre', { copySubjects: false });
  assert.equal(activeSemester(cfg).name, 'II semestre'); assert.equal(cfg.semesters[0].archived, true);
  assert.deepEqual(parseGlossary('ius civile\nlex Hortensia\n\nius civile'), ['ius civile', 'lex Hortensia']);
  assert.deepEqual(parseGlossary('a; b; c'), ['a', 'b', 'c']);
  assert.deepEqual(parseGlossary('Kelsen, Hart, Ross'), ['Kelsen', 'Hart', 'Ross']);
});

// ---------------- Pulizia ----------------
test('segmentazione: blocchi alla fine di una frase, nulla perso', () => {
  const s = new Segmenter({ minWords: 10, maxWords: 20 });
  const sentence = 'uno due tre quattro cinque sei sette otto. ';
  s.add(sentence.repeat(2)); s.add('nove dieci undici');
  const b1 = s.take();
  assert.ok(b1.endsWith('otto.'), b1); assert.equal(countWords(b1), 16);
  assert.equal(s.take(), null);
  assert.equal(s.take(true), 'nove dieci undici'); assert.equal(s.take(true), null);
  const hard = new Segmenter({ minWords: 5, maxWords: 8 }); hard.add('a b c d e f g h i l');
  assert.equal(countWords(hard.take()), 8, 'taglio duro senza punto');
});
test('pulizia locale: intercalari e ripetizioni', () => {
  assert.equal(removeFillers('Eh, il pretore, ehm, decide. Uhm poi'), 'il pretore, decide. poi');
  assert.equal(removeFillers('Il termine ehmmm e la parola eh sono esitazioni; "ehi" e "che" no.'), 'Il termine e la parola sono esitazioni; "ehi" e "che" no.');
  assert.equal(removeRepetitions('il il senato e la riserva la riserva di legge'), 'il senato e la riserva di legge');
  assert.equal(removeRepetitions('le leggi leggi e le norme'), 'le leggi e le norme');
  assert.equal(removeRepetitions('molto molto importante'), 'molto importante');
});
test('pulizia locale: correzione col glossario prudente', () => {
  const g = compileGlossary(['comitia centuriata', 'lex Hortensia', 'Kelsen', 'Grundnorm', 'consul', 'senatus consultum', 'Hobbes', 'Greco', 'praetor peregrinus']);
  assert.equal(applyGlossary('i comizia centuriata votavano', g), 'i comitia centuriata votavano');
  assert.equal(applyGlossary('con la lex ortensia del', g), 'con la lex Hortensia del');
  assert.equal(applyGlossary('kelson e la grund norm.', g), 'Kelsen e la Grundnorm.');
  assert.equal(applyGlossary('il senatus consulto ultimo', g), 'il senatus consultum ultimo');
  assert.equal(applyGlossary('secondo obbes, lo stato', g), 'secondo Hobbes, lo stato');
  assert.equal(applyGlossary('il praetor pellegrinus.', g), 'il praetor peregrinus.');
  // parole italiane comuni restano intatte
  assert.equal(applyGlossary('il console e il consolato; il diritto greco; la legge', g), 'il console e il consolato; il diritto greco; la legge');
  assert.equal(applyGlossary('(comizia centuriata)', g), '(comitia centuriata)');
});
test('pulizia locale: frasi, paragrafi, nessuna parola persa', () => {
  const raw = Array.from({ length: 30 }, (_, i) => `frase numero ${i} sul diritto romano e le sue istituzioni pubbliche.`).join(' ');
  const out = localClean(raw, { compiled: compileGlossary([]) });
  const paras = toParagraphs(out);
  assert.ok(paras.length >= 2, 'diviso in paragrafi');
  assert.ok(paras.every(p => /^[A-Z]/.test(p) && /\.$/.test(p)), 'maiuscola iniziale e punto finale');
  assert.equal(countWords(out), countWords(raw), 'nessuna parola persa');
  assert.deepEqual(paragraphize('Uno. Due.', 120), ['Uno. Due.']);
  assert.equal(localClean('ehm la lex ortensia', { glossary: ['lex Hortensia'] }), 'La lex Hortensia.');
  assert.equal(localClean('ehm la lex ortensia', { glossary: ['lex Hortensia'], fillers: false, useGlossary: false }), 'Ehm la lex ortensia.');
});

// ---------------- Audio ----------------
test('audio: prompt per Whisper con glossario e continuità', () => {
  const p = whisperPrompt(['ius civile', 'lex Hortensia'], 'il pretore urbano amministrava la giustizia tra i cittadini romani');
  assert.ok(p.startsWith('ius civile, lex Hortensia.'));
  assert.ok(p.endsWith('cittadini romani'));
  assert.ok(whisperPrompt(Array(200).fill('terminelungo'), '').length <= 420);
  assert.equal(cleanHallucinations('Sottotitoli creati dalla comunità Amara.org'), '');
});
test('audio: blocchi e ricampionamento', () => {
  const speech = s => new Float32Array(s * 16000).map((_, k) => 0.1 * Math.sin(k / 3) * (1 + Math.sin(k / 400)));
  const silence = s => new Float32Array(s * 16000).map(() => (Math.random() - 0.5) * 0.001);
  const out = []; const c = new Chunker({ onChunk: (a, m) => out.push(m) });
  c.push(silence(1)); c.push(speech(8)); c.push(silence(1)); c.push(speech(7)); c.push(silence(1)); c.flush();
  assert.equal(out.length, 2);
  c.push(speech(3)); c.reset(); c.flush(); assert.equal(out.length, 2, 'reset scarta l\'audio in attesa');
  assert.equal(resampleTo16k(new Float32Array(48000), 48000).length, 16000);
});
