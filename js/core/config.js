// config.js — Configurazione dell'app: semestri, materie, orario, documento.
// Tutto ciò che cambia da un semestre all'altro sta qui, non nel codice.

export const CONFIG_VERSION = 1;
export const DAYS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

export const DEFAULT_MODELS = {
  whisper: 'onnx-community/whisper-small',
};
export const WHISPER_MODELS = [
  { id: 'onnx-community/whisper-base', label: 'Whisper base — leggero, meno preciso' },
  { id: 'onnx-community/whisper-small', label: 'Whisper small — consigliato per iPhone' },
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'Whisper large-v3-turbo — il più preciso, per PC potenti' },
];

export function uid(prefix = 'id') {
  return prefix + '-' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

const GLOSSARY_ROMANO = [
  'rex', 'interrex', 'senatus', 'patres', 'auctoritas patrum', 'comitia curiata', 'comitia centuriata', 'comitia tributa',
  'concilia plebis', 'plebiscitum', 'lex Hortensia', 'provocatio ad populum', 'consul', 'praetor', 'praetor peregrinus',
  'dictator', 'magister equitum', 'censor', 'tribunus plebis', 'intercessio', 'imperium', 'potestas', 'auspicia',
  'senatus consultum', 'senatus consultum ultimum', 'res publica', 'princeps', 'quaestiones perpetuae', 'iudicium populi',
  'cognitio extra ordinem', 'civitas', 'municipium', 'colonia', 'ius Latii', 'foedus', 'deditio', 'provincia',
  'Constitutio Antoniniana', 'XII Tavole', 'decemviri', 'Gaio', 'Pomponio', 'Digesto', 'Giustiniano', 'Petrucci',
  'Venturini', 'Damnatio iudicum',
];
const GLOSSARY_FILOSOFIA = [
  'sofisti', 'Protagora', 'Antigone', 'Platone', 'Aristotele', 'epieikeia', 'Cicerone', 'lex naturalis', 'lex aeterna',
  'Agostino', "Tommaso d'Aquino", 'Grozio', 'Hobbes', 'Leviatano', 'Locke', 'Rousseau', 'Kant', 'Bentham', 'Austin',
  'giusnaturalismo', 'giuspositivismo', 'Kelsen', 'Grundnorm', 'Dottrina pura del diritto', 'Hart', 'norma di riconoscimento',
  'giusrealismo', 'Holmes', 'Alf Ross', 'Olivecrona', 'neocostituzionalismo', 'Dworkin', 'Alexy', 'Ferrajoli', 'Schmitt',
  'bellum iustum', 'ius ad bellum', 'ius in bello', 'Greco', 'Critica della ragione bellica', 'Belloni',
];
const GLOSSARY_COSTITUZIONALE = [
  'Romboli', 'Dal Canto', 'riserva di legge', 'Corte costituzionale', 'decreto-legge', 'decreto legislativo', 'legge delega',
  'art. 138 Cost.', 'revisione costituzionale', 'fonti del diritto', 'gerarchia delle fonti', 'erga omnes', 'Parlamento',
  'Presidente della Repubblica', 'Consiglio superiore della magistratura', 'autonomia differenziata', 'Unione europea',
];

export function defaultConfig() {
  const cost = { id: 'sub-cost', name: 'Diritto costituzionale I', tabTitle: 'Diritto costituzionale', tabId: '', transcribe: false, glossary: GLOSSARY_COSTITUZIONALE, support: [] };
  const filo = { id: 'sub-filo', name: 'Filosofia del diritto', tabTitle: 'Filosofia del diritto', tabId: '', transcribe: true, glossary: GLOSSARY_FILOSOFIA, support: [] };
  const rom = { id: 'sub-rom', name: 'Storia del diritto romano', tabTitle: 'Diritto romano', tabId: '', transcribe: true, glossary: GLOSSARY_ROMANO, support: [] };
  const timetable = [];
  for (const day of [1, 2, 3]) {
    timetable.push({ id: uid('slot'), day, start: '08:45', end: '10:25', subjectId: cost.id });
    timetable.push({ id: uid('slot'), day, start: '10:40', end: '12:20', subjectId: filo.id });
    timetable.push({ id: uid('slot'), day, start: '12:35', end: '14:15', subjectId: rom.id });
  }
  const sem = { id: 'sem-2026-1', name: 'Primo anno · I semestre 2026/27', subjects: [cost, filo, rom], timetable, archived: false };
  return {
    version: CONFIG_VERSION,
    activeSemesterId: sem.id,
    semesters: [sem],
    doc: { id: '1LzgRMbm0dYJ1fl4Tg5ZG4yb0nEd5wFqxlsu-ZJXkhMM', title: 'Appunti lezione (Giurisprudenza)' },
    dateFormat: { mode: 'auto', template: '{dd}/{mm}/{yyyy}', headingStyle: 'HEADING_2' },
    cleaning: { fillers: true, glossary: true },
    whisper: { model: DEFAULT_MODELS.whisper, device: 'webgpu' },
    google: { clientId: '' },
    sending: { auto: false, label: true },
    setupDone: false,
  };
}

/** Rende valida una configurazione (anche importata), completando i campi mancanti. */
export function normalizeConfig(cfg) {
  const d = defaultConfig();
  if (!cfg || typeof cfg !== 'object') return d;
  const out = { ...d, ...cfg };
  for (const k of ['doc', 'dateFormat', 'cleaning', 'whisper', 'google', 'sending']) out[k] = { ...d[k], ...(cfg[k] || {}) };
  if (!Array.isArray(out.semesters) || !out.semesters.length) out.semesters = d.semesters;
  out.semesters = out.semesters.map(s => ({
    id: s.id || uid('sem'), name: s.name || 'Semestre', archived: !!s.archived,
    subjects: (s.subjects || []).map(m => ({
      id: m.id || uid('sub'), name: m.name || 'Materia', tabTitle: m.tabTitle ?? m.name ?? '', tabId: m.tabId || '',
      transcribe: m.transcribe !== false, glossary: Array.isArray(m.glossary) ? m.glossary.filter(Boolean) : [],
      support: Array.isArray(m.support) ? m.support.filter(f => f && f.text) : [],
    })),
    timetable: (s.timetable || []).filter(t => /^\d{1,2}:\d{2}$/.test(t.start) && /^\d{1,2}:\d{2}$/.test(t.end))
      .map(t => ({ id: t.id || uid('slot'), day: +t.day, start: t.start, end: t.end, subjectId: t.subjectId })),
  }));
  if (!out.semesters.some(s => s.id === out.activeSemesterId)) out.activeSemesterId = out.semesters[0].id;
  delete out.claude; // versioni precedenti
  out.version = CONFIG_VERSION;
  return out;
}

export function activeSemester(cfg) { return cfg.semesters.find(s => s.id === cfg.activeSemesterId) || cfg.semesters[0]; }
export function subjectById(cfg, id) { return activeSemester(cfg).subjects.find(s => s.id === id) || null; }

/** Nuovo semestre: vuoto, oppure copiando le materie (senza orario) come base. */
export function newSemester(cfg, name, { copySubjects = false } = {}) {
  const prev = activeSemester(cfg);
  const subjects = copySubjects ? prev.subjects.map(s => ({ ...s, id: uid('sub'), tabId: '' })) : [];
  const sem = { id: uid('sem'), name, subjects, timetable: [], archived: false };
  prev.archived = true;
  cfg.semesters.push(sem);
  cfg.activeSemesterId = sem.id;
  return sem;
}

/** Esportazione: la configurazione senza segreti (chiavi e token stanno altrove). */
export function exportConfig(cfg) { return JSON.stringify({ app: 'lectio', ...cfg }, null, 2); }
export function importConfig(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  if (obj.app && obj.app !== 'lectio') throw new Error('Il file non è una configurazione di Lectio.');
  delete obj.app;
  return normalizeConfig(obj);
}

/** Glossario da testo libero o CSV: una voce per riga o separata da ; o , (le virgole dentro le voci vanno evitate). */
export function parseGlossary(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    const parts = line.includes(';') ? line.split(';') : (lines.length === 1 ? line.split(',') : [line]);
    for (const p of parts) { const t = p.trim().replace(/^"|"$/g, ''); if (t && !items.includes(t)) items.push(t); }
  }
  return items;
}
