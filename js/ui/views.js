// views.js — Le schermate: Lezione, Da inviare, Impostazioni, configurazione guidata.

import { h, icon, toast, sheet, confirmButton, fmtDur, fmtDateIt, readFileText, download } from './dom.js';
import { activeSemester, subjectById, uid, DAYS, WHISPER_MODELS, newSemester, exportConfig, importConfig, parseGlossary, defaultConfig } from '../core/config.js';
import { validateTimetable, slotsOfDay, isoDate } from '../core/schedule.js';
import { toParagraphs, countWords } from '../core/cleaning.js';
import { flattenTabs, findTab, detectFormat } from '../core/docplan.js';
import { formatTemplate, describeFormat } from '../core/dates.js';
import { slotProgress } from '../services/pipeline.js';
import { signIn, signOut, currentToken, getDocument, parseDocId, redirectUri } from '../services/google.js';

const STATUS = {
  recording: ['In registrazione', 'rec'], closing: ['In chiusura', 'warn'], cleaning: ['In pulizia', 'warn'],
  review: ['Da rivedere', 'ok'], queued: ['In coda di invio', 'warn'], sent: ['Inviata', ''], empty: ['Vuota', ''],
};
const statusPill = s => { const [t, c] = STATUS[s.status] || [s.status, '']; return h('span', { class: 'pill ' + c }, t); };

// =====================================================================
// Caricamento del modello (condiviso tra schermate)
// =====================================================================
const loadState = { files: new Map(), active: false, error: null };
function bindLoadProgress(ctx) {
  if (ctx._loadBound) return; ctx._loadBound = true;
  ctx.engine.addEventListener('progress', e => {
    loadState.active = true; loadState.files.set(e.detail.file, e.detail);
    const tot = [...loadState.files.values()].reduce((a, f) => a + f.total, 0), got = [...loadState.files.values()].reduce((a, f) => a + f.loaded, 0);
    const pct = tot ? Math.round(100 * got / tot) : 0;
    document.querySelectorAll('[data-loadpct]').forEach(el => { el.textContent = `Scarico Whisper… ${pct}%`; });
  });
  ctx.engine.addEventListener('loaded', () => { loadState.active = false; loadState.files.clear(); });
}
async function loadModel(ctx) {
  bindLoadProgress(ctx);
  try { const info = await ctx.engine.load(ctx.cfg.whisper.model, ctx.cfg.whisper.device); return info; }
  catch (e) { loadState.active = false; throw e; }
}

// =====================================================================
// LEZIONE
// =====================================================================
export async function renderLesson(ctx) {
  bindLoadProgress(ctx);
  const p = ctx.pipeline, cfg = ctx.cfg, sem = activeSemester(cfg);
  const st = p.status();
  const running = !!p.mode;
  const out = h('div', {});

  out.append(h('header', { class: 'top' }, h('div', { class: 'brand' }, 'Lectio', h('small', {}, sem.name)),
    running ? h('span', { class: 'pill rec' }, h('i', { class: 'dot pulse' }), 'In ascolto') : null));

  if (!cfg.setupDone) out.append(h('div', { class: 'banner info' }, 'Completa la configurazione per iniziare.', h('br'),
    h('button', { class: 'btn', onClick: () => openWizard(ctx, 0) }, 'Configura Lectio')));
  if (ctx.micWarning && running) out.append(h('div', { class: 'banner bad' }, ctx.micWarning, h('br'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onClick: async () => { await restartMic(ctx); } }, 'Riattiva microfono'),
      h('button', { class: 'btn ghost', onClick: () => { ctx.micWarning = null; ctx.render(); } }, 'Ok'))));
  if (running && ctx.engine.speed() > 1) out.append(h('div', { class: 'banner warn' },
    'Whisper è più lento della lezione e sta accumulando ritardo. Il testo arriverà comunque, ma più tardi. Se succede spesso, scegli "Whisper base" nelle Impostazioni.'));

  // --- che lezione è adesso
  const now = h('div', { class: 'card now' });
  if (st.kind === 'lesson' && st.subject) {
    now.append(h('div', { class: 'small muted' }, st.overridden ? 'Scelta manuale' : `Adesso · ${st.slot.start}–${st.slot.end}`),
      h('div', { class: 'subject' }, st.subject.name),
      h('div', { class: 'row' }, st.transcribe ? h('span', { class: 'pill ok' }, 'Si trascrive') : h('span', { class: 'pill' }, 'Non si trascrive: la scrivi tu')),
      st.slot ? h('div', { class: 'progress' }, h('div', { style: { width: Math.round(100 * slotProgress(st.slot)) + '%' } })) : null);
  } else if (st.kind === 'break' || st.kind === 'before') {
    now.append(h('div', { class: 'small muted' }, st.kind === 'break' ? 'Pausa' : 'Le lezioni non sono ancora iniziate'),
      h('div', { class: 'subject' }, `${st.nextSubject?.name || 'Lezione'} alle ${st.nextSlot.start}`),
      h('div', { class: 'small muted' }, st.nextSubject?.transcribe ? 'Verrà trascritta in automatico.' : 'Non si trascrive: la scrivi tu.'));
  } else {
    now.append(h('div', { class: 'small muted' }, 'Fuori orario'), h('div', { class: 'subject' }, 'Nessuna lezione adesso'),
      h('div', { class: 'small muted' }, 'Puoi comunque registrare scegliendo la materia.'));
  }
  now.append(h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn link', onClick: () => pickSubject(ctx) }, running ? 'Cambia materia' : 'Registra un\'altra materia')));
  out.append(now);

  // --- comando principale
  const ctrl = h('div', { class: 'card center' });
  if (!running) {
    const label = loadState.active ? h('span', { 'data-loadpct': '' }, 'Scarico Whisper…') : 'Avvia';
    const btn = h('button', { class: 'recbtn', 'aria-label': 'Avvia la trascrizione', onClick: async () => {
      btn.disabled = true;
      if (st.kind === 'outside') { btn.disabled = false; return pickSubject(ctx); }
      await startRecording(ctx, { mode: 'morning' });
      btn.disabled = false;
    } }, h('div', {}, icon('mic'), label));
    ctrl.append(btn,
      h('p', { class: 'small muted' }, st.kind === 'outside' ? 'Scegli la materia da registrare.' :
        'Modalità mattinata: Lectio segue l\'orario, cambia materia da sola, salta le pause e le materie che scrivi a mano.'));
  } else {
    const cur = p.current;
    const btn = h('button', { class: 'recbtn on', 'aria-label': 'Termina la trascrizione', onClick: async () => {
      btn.disabled = true; await p.stop(); ctx.releaseWake(); ctx.micWarning = null; toast('Registrazione terminata. Trovi le lezioni in "Da inviare".');
    } }, h('div', {}, icon('stop'), 'Termina'));
    const speed = ctx.engine.speed();
    ctrl.append(btn,
      h('div', { class: 'elapsed', id: 'elapsed' }, fmtDur(Date.now() - (ctx.startedAt || Date.now()))),
      h('div', { class: 'small muted' }, cur ? `Trascrivo: ${cur.subjectName}` : (st.kind === 'lesson' && !st.transcribe ? 'Questa materia non si trascrive: microfono in attesa.' : 'In pausa: riprendo alla prossima lezione.')),
      h('div', { class: 'chips' },
        h('span', { class: 'pill' }, 'Microfono ', h('span', { class: 'meter' }, h('div', { id: 'lvl' }))),
        h('span', { class: 'pill ' + (speed == null ? '' : speed < 0.8 ? 'ok' : speed < 1 ? 'warn' : 'bad'), id: 'spd' }, speedLabel(speed)),
        h('span', { class: 'pill', id: 'q' }, 'Coda ' + (ctx.engine.queue.length + (ctx.engine.busy ? 1 : 0)))));
  }
  out.append(ctrl);

  // --- testo in tempo reale
  if (p.current) {
    const live = h('div', { class: 'live', id: 'live' });
    fillLive(live, p.current);
    out.append(h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', {}, 'Testo della lezione'), h('span', { class: 'tiny muted', id: 'words' }, `${p.current.words} parole`)), live));
    requestAnimationFrame(() => { live.scrollTop = live.scrollHeight; });
  }

  // --- lezioni di oggi
  const today = (await p.list()).filter(s => s.date === isoDate(new Date()) && s !== p.current);
  if (today.length) {
    out.append(h('h2', {}, 'Oggi'), h('div', { class: 'card' }, today.map(s => h('div', { class: 'item' },
      h('div', {}, h('div', { class: 'title' }, s.subjectName), h('div', { class: 'small muted' }, `${s.slotLabel || ''} · ${s.words} parole`)),
      statusPill(s)))), h('button', { class: 'btn ghost block', onClick: () => ctx.go('inbox') }, 'Vai a "Da inviare"'));
  }

  // aggiornamenti continui (tempo, livello, velocità)
  clearInterval(ctx._tick);
  if (running) {
    ctx._tick = setInterval(() => {
      const el = document.getElementById('elapsed'); if (el) el.textContent = fmtDur(Date.now() - ctx.startedAt);
      const q = document.getElementById('q'); if (q) q.textContent = 'Coda ' + (ctx.engine.queue.length + (ctx.engine.busy ? 1 : 0));
      const sp = document.getElementById('spd'); const v = ctx.engine.speed();
      if (sp) { sp.textContent = speedLabel(v); sp.className = 'pill ' + (v == null ? '' : v < 0.8 ? 'ok' : v < 1 ? 'warn' : 'bad'); }
    }, 1000);
    if (!ctx._lvlBound) { ctx._lvlBound = true; ctx.engine.addEventListener('level', e => { const l = document.getElementById('lvl'); if (l) l.style.width = Math.min(100, e.detail * 700) + '%'; }); }
  }
  return out;
}

function speedLabel(v) { return v == null ? 'Whisper: in avvio' : v < 1 ? 'Whisper: tiene il passo' : 'Whisper: in ritardo'; }

export function updateLive(ctx, { session }) {
  const live = document.getElementById('live');
  if (!live || !session || session !== ctx.pipeline.current) return;
  const atBottom = live.scrollHeight - live.scrollTop - live.clientHeight < 40;
  fillLive(live, session);
  if (atBottom) live.scrollTop = live.scrollHeight;
  const w = document.getElementById('words'); if (w) w.textContent = `${session.words} parole`;
}

function fillLive(live, session) {
  live.replaceChildren(
    ...session.blocks.flatMap(b => toParagraphs(b.cleaned ?? b.raw).map(t => h('p', { class: b.cleaned ? '' : 'raw' }, t))),
    session.rawPending ? h('p', { class: 'raw' }, session.rawPending) : '',
    !session.blocks.length && !session.rawPending ? h('p', { class: 'raw' }, 'Il testo compare qui dopo le prime frasi del docente (con qualche secondo di ritardo).') : '');
}

async function startRecording(ctx, opts) {
  try {
    ctx.render();
    await loadModel(ctx);
    await ctx.pipeline.start(opts);
    ctx.startedAt = Date.now(); ctx.micWarning = null;
    await ctx.holdWake();
  } catch (e) {
    console.error(e);
    toast(e.name === 'NotAllowedError' ? 'Permesso del microfono negato: abilitalo nelle impostazioni del browser.' : 'Avvio non riuscito: ' + e.message, 6000);
    try { await ctx.engine.stopListening(); } catch {}
    ctx.pipeline.mode = null;
  }
  ctx.render();
}

async function restartMic(ctx) {
  try {
    if (!(await ctx.engine.resume())) {
      const feeding = ctx.engine.feeding, glossary = ctx.engine.glossary;
      await ctx.engine.stopListening(); await ctx.engine.startListening(); ctx.engine.setFeeding(feeding, glossary);
    }
    ctx.micWarning = null; await ctx.holdWake(); toast('Microfono riattivato.');
  } catch (e) { toast('Non riesco a riattivare il microfono: ' + e.message, 5000); }
  ctx.render();
}

function pickSubject(ctx) {
  const sem = activeSemester(ctx.cfg), running = !!ctx.pipeline.mode;
  sheet(close => h('div', {},
    h('h2', { style: { marginTop: 0 } }, running ? 'Cambia materia' : 'Quale lezione registri?'),
    h('p', { class: 'small muted' }, running ? 'Vale fino alla fine della fascia oraria in corso, poi Lectio torna a seguire l\'orario.' : 'Registra solo questa materia, finché non premi Termina.'),
    sem.subjects.map(s => h('button', { class: 'btn ghost block', style: { margin: '6px 0', justifyContent: 'flex-start' }, onClick: async () => {
      close();
      if (running) { await ctx.pipeline.switchSubject(s.id); }
      else await startRecording(ctx, { mode: 'manual', subjectId: s.id });
    } }, s.name)),
    h('button', { class: 'btn link block', onClick: close }, 'Annulla')));
}

// =====================================================================
// DA INVIARE
// =====================================================================
export async function renderInbox(ctx, list) {
  const p = ctx.pipeline;
  const out = h('div', {}, h('header', { class: 'top' }, h('div', { class: 'brand' }, 'Da inviare')));
  const needsLogin = list.some(s => s.status === 'queued' && s.needsLogin) || (list.some(s => s.status === 'queued') && !currentToken());
  if (needsLogin) out.append(h('div', { class: 'banner warn' }, 'Per inserire le lezioni negli appunti serve l\'accesso a Google (dura circa un\'ora).', h('br'),
    h('button', { class: 'btn', onClick: () => tryLogin(ctx, 'sendall') }, 'Accedi a Google e invia')));

  const groups = [
    ['Da rivedere', list.filter(s => s.status === 'review'), 'Controlla il testo e invialo agli appunti.'],
    ['In coda di invio', list.filter(s => s.status === 'queued'), null],
    ['In lavorazione', list.filter(s => ['recording', 'closing', 'cleaning'].includes(s.status)), null],
    ['Inviate di recente', list.filter(s => s.status === 'sent').slice(0, 12), 'Il testo resta qui per 30 giorni come copia di sicurezza.'],
    ['Vuote', list.filter(s => s.status === 'empty'), 'Nessun parlato riconosciuto.'],
  ];
  let any = false;
  for (const [title, items, hint] of groups) {
    if (!items.length) continue; any = true;
    out.append(h('h2', {}, title), hint ? h('p', { class: 'small muted', style: { margin: '-4px 2px 6px' } }, hint) : null,
      h('div', { class: 'card' }, items.map(s => sessionRow(ctx, s))));
  }
  if (!any) out.append(h('div', { class: 'card center muted' }, h('p', {}, 'Nessuna lezione per ora.'), h('p', { class: 'small' }, 'Le lezioni trascritte compaiono qui, pronte da inviare agli appunti.')));
  return out;
}

function sessionRow(ctx, s) {
  const detail = [fmtDateIt(s.date), s.slotLabel, `${s.words} parole`].filter(Boolean).join(' · ');
  const actions = h('div', { class: 'row' });
  if (['review', 'queued', 'sent'].includes(s.status)) actions.append(h('button', { class: 'btn soft', onClick: () => openReview(ctx, s.id) }, s.status === 'sent' ? 'Apri' : 'Rivedi'));
  if (s.status === 'review' || (s.status === 'queued' && !s.sending)) actions.append(h('button', { class: 'btn', onClick: () => sendNow(ctx, s.id) }, s.status === 'queued' ? 'Riprova' : 'Invia'));
  if (s.status === 'empty') actions.append(confirmButton('Elimina', 'Conferma', () => ctx.pipeline.remove(s.id)));
  return h('div', { class: 'item' },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, s.subjectName), h('div', { class: 'small muted' }, detail),
      s.status === 'sent' && s.sentTo ? h('div', { class: 'tiny muted' }, `In "${s.sentTo.tab}" sotto ${s.sentTo.heading}${s.sentTo.already ? ' (era già presente)' : ''}`) : null,
      s.error ? h('div', { class: 'tiny', style: { color: 'var(--bad)' } }, s.error) : null,
      s.note ? h('div', { class: 'tiny muted' }, s.note) : null),
    statusPill(s), h('div', { style: { gridColumn: '1 / -1' } }, actions));
}

async function sendNow(ctx, id) {
  if (!currentToken()) return tryLogin(ctx, 'send:' + id);
  try { await ctx.pipeline.send(id); }
  catch (e) { if (e.needsLogin) return tryLogin(ctx, 'send:' + id); toast(e.message, 6000); }
}
function tryLogin(ctx, after) {
  if (!ctx.cfg.google.clientId) { toast('Prima inserisci il Client ID di Google nelle Impostazioni.', 5000); ctx.go('settings'); return; }
  if (ctx.pipeline.mode) { toast('Termina prima la registrazione: l\'accesso a Google ricarica la pagina.', 5000); return; }
  signIn(ctx.cfg.google.clientId, { after });
}

function openReview(ctx, id) {
  const p = ctx.pipeline;
  sheet((close, rerender) => {
    const s = p.cache.get(id);
    if (!s) { close(); return h('div'); }
    const text = p.fullText(s);
    const ta = h('textarea', { class: 'reader', value: text, readOnly: s.status === 'sent', 'aria-label': 'Testo della lezione' });
    const raws = s.blocks.filter(b => b.note);
    return h('div', {},
      h('div', { class: 'row between' }, h('div', {}, h('h2', { style: { margin: 0 } }, s.subjectName), h('div', { class: 'small muted' }, `${fmtDateIt(s.date)} ${s.slotLabel ? '· ' + s.slotLabel : ''} · ${countWords(text)} parole`)), statusPill(s)),
      raws.length ? h('div', { class: 'banner warn' }, raws.map(b => b.note).join(' ')) : null,
      h('p', { class: 'tiny muted' }, s.status === 'sent' ? 'Già inserita negli appunti.' : 'Puoi correggere il testo qui prima di inviarlo. La rielaborazione completa la farà la tua attività sugli appunti.'),
      ta,
      h('div', { class: 'row', style: { marginTop: '12px' } },
        s.status !== 'sent' ? h('button', { class: 'btn', onClick: async () => {
          if (ta.value !== text) await p.saveEdit(id, ta.value);
          close(); await sendNow(ctx, id);
        } }, 'Invia agli appunti') : null,
        s.status !== 'sent' ? h('button', { class: 'btn ghost', onClick: async () => { await p.saveEdit(id, ta.value); toast('Modifiche salvate.'); } }, 'Salva') : null,
        h('button', { class: 'btn ghost', onClick: async () => { try { await navigator.clipboard.writeText(ta.value); toast('Testo copiato.'); } catch { ta.select(); } } }, 'Copia'),
        h('span', { class: 'grow' }),
        confirmButton('Elimina', 'Conferma eliminazione', async () => { await p.remove(id); close(); toast('Lezione eliminata dal dispositivo.'); })),
      h('button', { class: 'btn link block', style: { marginTop: '8px' }, onClick: close }, 'Chiudi'));
  });
}

// =====================================================================
// IMPOSTAZIONI
// =====================================================================
export async function renderSettings(ctx) {
  const cfg = ctx.cfg, sem = activeSemester(cfg);
  const save = () => ctx.save();
  const out = h('div', {}, h('header', { class: 'top' }, h('div', { class: 'brand' }, 'Impostazioni')));
  const sec = (title, body, open = false) => h('details', { class: 'sec', open }, h('summary', {}, title), h('div', { class: 'body' }, body));

  // --- Documento
  const docInfo = h('div', { class: 'small' });
  const prev = h('div', { class: 'tiny muted' }, 'Esempio: ' + formatTemplate(cfg.dateFormat.template, new Date()));
  out.append(sec('Documento degli appunti', [
    h('label', { class: 'f', for: 'docid' }, 'Link o ID del Google Doc'),
    h('input', { id: 'docid', type: 'text', value: cfg.doc.id, onChange: e => { cfg.doc.id = parseDocId(e.target.value); e.target.value = cfg.doc.id; save(); } }),
    h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn soft', onClick: () => inspectDoc(ctx, docInfo) }, 'Leggi il documento e verifica le schede')),
    docInfo,
    h('label', { class: 'f' }, 'Formato delle date'),
    h('select', { onChange: e => { cfg.dateFormat.mode = e.target.value; save(); ctx.rerenderSettings(); } },
      h('option', { value: 'auto', selected: cfg.dateFormat.mode === 'auto' }, 'Automatico: uguale alle date già scritte nella scheda'),
      h('option', { value: 'custom', selected: cfg.dateFormat.mode === 'custom' }, 'Personalizzato')),
    h('label', { class: 'f' }, cfg.dateFormat.mode === 'custom' ? 'Modello' : 'Modello per le schede ancora senza date'),
    h('input', { type: 'text', value: cfg.dateFormat.template, onInput: e => { cfg.dateFormat.template = e.target.value; prev.textContent = 'Esempio: ' + formatTemplate(e.target.value, new Date()); save(); } }),
    prev,
    h('div', { class: 'tiny muted' }, 'Segnaposto: {d} {dd} giorno, {m} {mm} mese, {mese} {Mese} nome del mese, {yyyy} {yy} anno, {giorno} {Giorno} giorno della settimana.'),
  ], !cfg.setupDone));

  // --- Materie
  const subjBox = h('div', {});
  const drawSubjects = () => subjBox.replaceChildren(...sem.subjects.map(s => subjectEditor(ctx, s, drawSubjects)),
    h('button', { class: 'btn ghost block', onClick: () => { sem.subjects.push({ id: uid('sub'), name: 'Nuova materia', tabTitle: '', tabId: '', transcribe: true, glossary: [], support: [] }); save(); drawSubjects(); } }, icon('plus'), 'Aggiungi materia'));
  drawSubjects();
  out.append(sec(`Materie · ${sem.name}`, subjBox));

  // --- Orario
  const ttBox = h('div', {});
  const drawTT = () => {
    const issues = validateTimetable(sem);
    ttBox.replaceChildren(
      h('p', { class: 'small muted' }, 'Lectio usa l\'orario per capire che materia stai ascoltando. Le fasce senza lezione sono pause.'),
      ...[1, 2, 3, 4, 5, 6].map(day => {
        const slots = slotsOfDay(sem, day);
        return h('div', { style: { margin: '12px 0' } }, h('div', { class: 'row between' }, h('strong', {}, DAYS[day]),
          h('button', { class: 'btn link', onClick: () => { const last = slots[slots.length - 1]; sem.timetable.push({ id: uid('slot'), day, start: last ? last.end : '08:45', end: last ? addMin(last.end, 100) : '10:25', subjectId: sem.subjects[0]?.id }); save(); drawTT(); } }, '+ fascia')),
          slots.map(sl => h('div', { class: 'slot' },
            h('input', { type: 'time', value: sl.start, 'aria-label': 'inizio', onChange: e => { sl.start = e.target.value; save(); drawTT(); } }),
            h('input', { type: 'time', value: sl.end, 'aria-label': 'fine', onChange: e => { sl.end = e.target.value; save(); drawTT(); } }),
            h('select', { 'aria-label': 'materia', onChange: e => { sl.subjectId = e.target.value; save(); } }, sem.subjects.map(m => h('option', { value: m.id, selected: m.id === sl.subjectId }, m.name))),
            h('button', { class: 'iconbtn', 'aria-label': 'Elimina fascia', onClick: () => { sem.timetable = sem.timetable.filter(x => x !== sl); save(); drawTT(); } }, icon('trash')))));
      }),
      issues.length ? h('div', { class: 'banner warn' }, issues.join(' ')) : null);
  };
  drawTT();
  out.append(sec('Orario settimanale', ttBox));

  // --- Semestri
  out.append(sec('Semestri', [
    h('label', { class: 'f' }, 'Nome del semestre attivo'),
    h('input', { type: 'text', value: sem.name, onChange: e => { sem.name = e.target.value; save(); } }),
    h('p', { class: 'small muted' }, 'A ogni nuovo semestre crea un semestre nuovo: quello attuale viene archiviato e resta recuperabile.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn soft', onClick: () => { newSemester(cfg, 'Nuovo semestre', { copySubjects: false }); save(); ctx.rerenderSettings(); toast('Semestre creato: aggiungi materie e orario.'); } }, 'Nuovo semestre vuoto'),
      h('button', { class: 'btn ghost', onClick: () => { newSemester(cfg, 'Nuovo semestre', { copySubjects: true }); save(); ctx.rerenderSettings(); toast('Semestre creato copiando le materie.'); } }, 'Nuovo, copiando le materie')),
    cfg.semesters.length > 1 ? [h('label', { class: 'f' }, 'Semestre in uso'),
      h('select', { onChange: e => { cfg.activeSemesterId = e.target.value; cfg.semesters.forEach(s => { s.archived = s.id !== e.target.value; }); save(); ctx.rerenderSettings(); } },
        cfg.semesters.map(s => h('option', { value: s.id, selected: s.id === cfg.activeSemesterId }, s.name + (s.archived ? ' (archiviato)' : ''))))] : null,
  ]));

  // --- Pulizia
  out.append(sec('Pulizia del testo', [
    h('p', { class: 'small muted' }, 'Avviene sul telefono, gratis e senza inviare nulla. Fa solo correzioni sicure: niente riassunti né riscritture. La rielaborazione vera la fa la tua attività che legge gli appunti.'),
    h('label', { class: 'switch' }, h('span', {}, h('strong', {}, 'Togli esitazioni e ripetizioni'), h('br'), h('span', { class: 'small muted' }, '"ehm", "uhm", "il il", "la riserva la riserva".')),
      h('input', { type: 'checkbox', checked: cfg.cleaning.fillers, onChange: e => { cfg.cleaning.fillers = e.target.checked; save(); } })),
    h('label', { class: 'switch' }, h('span', {}, h('strong', {}, 'Correggi con il glossario'), h('br'), h('span', { class: 'small muted' }, 'Es. "comizia centuriata" → "comitia centuriata", "lex ortensia" → "lex Hortensia".')),
      h('input', { type: 'checkbox', checked: cfg.cleaning.glossary, onChange: e => { cfg.cleaning.glossary = e.target.checked; save(); } })),
  ]));

  // --- Google
  out.append(sec('Accesso a Google', [
    h('p', { class: 'small muted' }, 'Serve per scrivere nel documento. Il Client ID è gratuito: la guida è nel file LEGGIMI.'),
    h('label', { class: 'f', for: 'gcid' }, 'Client ID OAuth'),
    h('input', { id: 'gcid', type: 'text', placeholder: '…apps.googleusercontent.com', value: cfg.google.clientId, onChange: e => { cfg.google.clientId = e.target.value.trim(); save(); } }),
    h('label', { class: 'f' }, 'Indirizzo da registrare su Google Cloud (origine e URI di reindirizzamento)'),
    h('div', { class: 'mono' }, location.origin), h('div', { class: 'mono' }, redirectUri()),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      currentToken() ? h('span', { class: 'pill ok' }, 'Accesso attivo') : h('span', { class: 'pill' }, 'Non collegato'),
      h('button', { class: 'btn soft', onClick: () => tryLogin(ctx, 'settings') }, currentToken() ? 'Rinnova accesso' : 'Accedi a Google'),
      currentToken() ? h('button', { class: 'btn ghost', onClick: () => { signOut(); ctx.rerenderSettings(); } }, 'Esci') : null),
  ]));

  // --- Trascrizione
  const wMsg = h('div', { class: 'small' });
  out.append(sec('Trascrizione · Whisper', [
    h('label', { class: 'f' }, 'Modello'),
    h('select', { onChange: e => { cfg.whisper.model = e.target.value; save(); } }, WHISPER_MODELS.map(m => h('option', { value: m.id, selected: cfg.whisper.model === m.id }, m.label))),
    h('label', { class: 'f' }, 'Calcolo'),
    h('select', { onChange: e => { cfg.whisper.device = e.target.value; save(); } },
      h('option', { value: 'webgpu', selected: cfg.whisper.device === 'webgpu' }, 'GPU (WebGPU) se disponibile — più veloce'),
      h('option', { value: 'wasm', selected: cfg.whisper.device === 'wasm' }, 'Solo processore — più compatibile')),
    h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn soft', onClick: async () => {
      wMsg.replaceChildren(h('span', { 'data-loadpct': '' }, 'Preparazione…'));
      try { const i = await loadModel(ctx); wMsg.replaceChildren(h('span', { style: { color: 'var(--ok)' } }, `Pronto su ${i.device === 'webgpu' ? 'GPU' : 'processore'} (${Math.round(i.loadMs / 1000)} s).`)); }
      catch (e) { wMsg.replaceChildren(h('span', { style: { color: 'var(--bad)' } }, e.message)); }
    } }, 'Scarica e prova il modello')), wMsg,
    h('p', { class: 'tiny muted' }, 'Il modello si scarica una volta (col Wi-Fi) e resta sul dispositivo. L\'audio non viene mai salvato né inviato: Whisper lavora sul telefono.'),
  ]));

  // --- Invio
  out.append(sec('Invio agli appunti', [
    h('label', { class: 'switch' }, h('span', {}, h('strong', {}, 'Invio automatico'), h('br'), h('span', { class: 'small muted' }, 'A fine lezione inserisce il testo senza passare dalla revisione.')),
      h('input', { type: 'checkbox', checked: cfg.sending.auto, onChange: e => { cfg.sending.auto = e.target.checked; save(); } })),
    h('label', { class: 'switch' }, h('span', {}, h('strong', {}, 'Riga di intestazione'), h('br'), h('span', { class: 'small muted' }, '"Trascrizione automatica · orario" sopra il testo, in corsivo grigio.')),
      h('input', { type: 'checkbox', checked: cfg.sending.label, onChange: e => { cfg.sending.label = e.target.checked; save(); } })),
  ]));

  // --- Backup
  out.append(sec('Esporta, importa, azzera', [
    h('p', { class: 'small muted' }, 'La configurazione (materie, glossari, orario) si può salvare e importare su un altro dispositivo. Chiavi e accessi non vengono esportati.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn soft', onClick: () => download('lectio-configurazione.json', exportConfig(cfg)) }, 'Esporta'),
      h('label', { class: 'btn ghost' }, 'Importa', h('input', { type: 'file', accept: '.json,application/json', class: 'sr', onChange: async e => {
        try { const next = importConfig(await readFileText(e.target.files[0])); Object.keys(ctx.cfg).forEach(k => delete ctx.cfg[k]); Object.assign(ctx.cfg, next); save(); ctx.rerenderSettings(); toast('Configurazione importata.'); }
        catch (err) { toast('File non valido: ' + err.message, 5000); }
      } }))),
    h('div', { class: 'row', style: { marginTop: '12px' } },
      h('button', { class: 'btn ghost', onClick: () => openWizard(ctx, 0) }, 'Rifai la configurazione guidata'),
      confirmButton('Ripristina impostazioni iniziali', 'Tocca di nuovo per confermare', () => { const d = defaultConfig(); Object.keys(ctx.cfg).forEach(k => delete ctx.cfg[k]); Object.assign(ctx.cfg, d); save(); ctx.rerenderSettings(); toast('Impostazioni ripristinate.'); })),
  ]));
  out.append(h('p', { class: 'tiny muted center', style: { marginTop: '18px' } }, 'Lectio · prototipo 0.2 · l\'audio non viene mai salvato'));
  return out;
}

function addMin(hm, n) { const [a, b] = hm.split(':').map(Number); const t = Math.min(23 * 60 + 59, a * 60 + b + n); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); }

function subjectEditor(ctx, s, redraw) {
  const save = () => ctx.save();
  const sem = activeSemester(ctx.cfg);
  const tabOptions = ctx.docTabs || [];
  return h('div', { class: 'subj' },
    h('label', { class: 'f', style: { marginTop: 0 } }, 'Nome'),
    h('input', { type: 'text', value: s.name, onChange: e => { s.name = e.target.value; save(); } }),
    h('label', { class: 'f' }, 'Scheda del documento'),
    tabOptions.length
      ? h('select', { onChange: e => { const t = tabOptions.find(x => x.tabId === e.target.value); s.tabId = t?.tabId || ''; s.tabTitle = t?.title || ''; save(); } },
          h('option', { value: '' }, '— scegli —'), tabOptions.map(t => h('option', { value: t.tabId, selected: s.tabId ? s.tabId === t.tabId : t.title === s.tabTitle }, '  '.repeat(t.depth) + t.title)))
      : h('input', { type: 'text', value: s.tabTitle, placeholder: 'Titolo della scheda', onChange: e => { s.tabTitle = e.target.value; s.tabId = ''; save(); } }),
    !tabOptions.length ? h('div', { class: 'tiny muted' }, 'Suggerimento: in "Documento degli appunti" premi "Leggi il documento" per scegliere la scheda da un elenco.') : null,
    h('label', { class: 'switch' }, h('span', {}, 'Trascrivi questa materia'), h('input', { type: 'checkbox', checked: s.transcribe, onChange: e => { s.transcribe = e.target.checked; save(); } })),
    h('label', { class: 'f' }, `Glossario (${s.glossary.length} termini, uno per riga)`),
    h('textarea', { value: s.glossary.join('\n'), onChange: e => { s.glossary = parseGlossary(e.target.value); save(); } }),
    h('div', { class: 'row' }, h('label', { class: 'btn link' }, 'Importa termini da file .txt/.csv', h('input', { type: 'file', accept: '.txt,.csv,text/plain', class: 'sr', onChange: async e => {
      const add = parseGlossary(await readFileText(e.target.files[0])); s.glossary = [...new Set([...s.glossary, ...add])]; save(); redraw(); toast(`${add.length} termini importati.`);
    } }))),
    h('div', { class: 'tiny muted' }, 'Il glossario aiuta sia Whisper a riconoscere i termini sia la correzione automatica: metti nomi di autori, istituti e termini latini del corso.'),
    h('div', { class: 'row', style: { marginTop: '8px' } }, confirmButton('Elimina materia', 'Conferma', () => {
      sem.subjects = sem.subjects.filter(x => x !== s); sem.timetable = sem.timetable.filter(t => t.subjectId !== s.id); save(); ctx.rerenderSettings();
    }, 'btn link')));
}

/** Legge il documento, elenca le schede, abbina le materie e mostra il formato delle date. */
async function inspectDoc(ctx, box) {
  if (!currentToken()) { box.replaceChildren(h('div', { class: 'banner warn' }, 'Serve l\'accesso a Google.', h('br'), h('button', { class: 'btn', onClick: () => tryLogin(ctx, 'settings') }, 'Accedi a Google'))); return; }
  box.replaceChildren(h('p', { class: 'muted' }, 'Lettura del documento…'));
  try {
    const doc = await getDocument(ctx.cfg.doc.id);
    const tabs = flattenTabs(doc);
    ctx.docTabs = tabs.map(t => ({ tabId: t.tabId, title: t.title, depth: t.depth }));
    ctx.cfg.doc.title = doc.title;
    const sem = activeSemester(ctx.cfg);
    for (const s of sem.subjects) { const t = findTab(tabs, s); if (t && !s.tabId) { s.tabId = t.tabId; s.tabTitle = t.title; } }
    ctx.save();
    box.replaceChildren(h('p', {}, h('strong', {}, doc.title), ` · ${tabs.length} schede`),
      h('ul', { class: 'list-plain' }, sem.subjects.map(s => {
        const t = findTab(tabs, s); const f = t ? detectFormat(t) : null;
        return h('li', {}, h('strong', {}, s.name), ' → ', t ? `"${t.title}"` : h('span', { style: { color: 'var(--bad)' } }, 'scheda non trovata'),
          t ? h('div', { class: 'tiny muted' }, f ? `Date trovate: ${f.count}, ultima "${f.example}". La prossima sarà scritta così: "${f.sample}".` : `Nessuna data trovata: userò il modello "${formatTemplate(ctx.cfg.dateFormat.template, new Date())}".`) : null);
      })),
      h('p', { class: 'tiny muted' }, 'Se un abbinamento è sbagliato, correggilo nella sezione Materie (ora le schede si scelgono da un elenco).'));
    return { doc, tabs };
  } catch (e) {
    box.replaceChildren(h('div', { class: 'banner bad' }, e.message));
    if (e.needsLogin) box.append(h('button', { class: 'btn', onClick: () => tryLogin(ctx, 'settings') }, 'Accedi a Google'));
  }
}

// =====================================================================
// CONFIGURAZIONE GUIDATA
// =====================================================================
export function openWizard(ctx, start = 0) {
  let step = start;
  const N = 5;
  sheet((close, rerender) => {
    const next = () => { step++; rerender(); }, back = () => { step--; rerender(); };
    const finish = () => { ctx.cfg.setupDone = true; ctx.save(); close(); ctx.go('lesson'); toast('Configurazione completata.'); };
    const nav = (canSkip = true, nextLabel = 'Avanti', onNext = next) => h('div', { class: 'row', style: { marginTop: '16px' } },
      step > 0 ? h('button', { class: 'btn ghost', onClick: back }, 'Indietro') : null, h('span', { class: 'grow' }),
      canSkip && step < N - 1 ? h('button', { class: 'btn link', onClick: next }, 'Salta') : null,
      h('button', { class: 'btn', onClick: onNext }, nextLabel));
    const head = (t, sub) => [h('div', { class: 'steps' }, Array.from({ length: N }, (_, i) => h('i', { class: i <= step ? 'on' : '' }))), h('h2', { style: { marginTop: 0 } }, t), sub ? h('p', { class: 'small muted' }, sub) : null];
    const cfg = ctx.cfg;

    if (step === 0) return h('div', {}, ...head('Benvenuto in Lectio', 'Trascrive le lezioni in diretta sul telefono, ripulisce il testo e lo inserisce nel tuo documento degli appunti, sotto la data giusta. Tutto gratuito.'),
      h('ul', { class: 'list-plain small' },
        h('li', {}, 'L\'audio non viene mai salvato: Whisper lo trascrive sul telefono e lo scarta.'),
        h('li', {}, 'Il testo viene ripulito sul telefono e va solo nel tuo documento Google.'),
        h('li', {}, 'Durante la lezione tieni il telefono sul banco con Lectio aperta e lo schermo acceso.')),
      h('p', { class: 'small muted' }, 'Servono circa 5 minuti. Puoi saltare un passaggio e completarlo dopo in Impostazioni.'), nav(false, 'Iniziamo'));

    if (step === 1) {
      const cid = h('input', { type: 'text', placeholder: '…apps.googleusercontent.com', value: cfg.google.clientId });
      return h('div', {}, ...head('Accesso a Google', 'Per scrivere nel documento serve un "Client ID" gratuito di Google Cloud. La guida passo-passo è nel file LEGGIMI (circa 10 minuti, una volta sola).'),
        h('label', { class: 'f' }, 'Client ID'), cid,
        h('label', { class: 'f' }, 'Indirizzi da registrare su Google Cloud'), h('div', { class: 'mono' }, location.origin), h('div', { class: 'mono' }, redirectUri()),
        h('div', { class: 'row', style: { marginTop: '12px' } },
          currentToken() ? h('span', { class: 'pill ok' }, 'Accesso attivo') : null,
          h('button', { class: 'btn soft', onClick: () => { cfg.google.clientId = cid.value.trim(); ctx.save(); if (!cfg.google.clientId) return toast('Inserisci il Client ID.'); signIn(cfg.google.clientId, { after: 'wizard:2' }); } }, currentToken() ? 'Rinnova accesso' : 'Accedi a Google')),
        nav(true, 'Avanti', () => { cfg.google.clientId = cid.value.trim(); ctx.save(); next(); }));
    }

    if (step === 2) {
      const box = h('div', { class: 'small' });
      const did = h('input', { type: 'text', value: cfg.doc.id, onChange: e => { cfg.doc.id = parseDocId(e.target.value); e.target.value = cfg.doc.id; ctx.save(); } });
      queueMicrotask(() => { if (currentToken()) inspectDoc(ctx, box); else box.replaceChildren(h('div', { class: 'banner warn' }, 'Senza accesso a Google non posso leggere il documento: puoi farlo più tardi da Impostazioni.')); });
      return h('div', {}, ...head('Documento degli appunti', 'Controllo le schede e come sono scritte le date, così le nuove lezioni vanno nel posto giusto.'),
        h('label', { class: 'f' }, 'Link o ID del documento'), did,
        h('button', { class: 'btn soft', style: { marginTop: '10px' }, onClick: () => inspectDoc(ctx, box) }, 'Rileggi'), box, nav());
    }

    if (step === 3) {
      const sem = activeSemester(cfg);
      return h('div', {}, ...head('Materie e orario', 'Ho preparato il tuo orario. Controlla le fasce esatte: si modificano in Impostazioni → Orario.'),
        h('div', { class: 'card', style: { margin: '6px 0' } }, [1, 2, 3, 4, 5, 6].map(d => slotsOfDay(sem, d)).some(x => x.length)
          ? [1, 2, 3, 4, 5, 6].filter(d => slotsOfDay(sem, d).length).map(d => h('div', { class: 'small', style: { margin: '4px 0' } }, h('strong', {}, DAYS[d] + ': '),
              slotsOfDay(sem, d).map(sl => { const m = subjectById(cfg, sl.subjectId); return `${sl.start}–${sl.end} ${m?.name || '?'}${m && !m.transcribe ? ' (a mano)' : ''}`; }).join(' · ')))
          : h('p', { class: 'muted' }, 'Nessuna fascia oraria.')),
        h('p', { class: 'tiny muted' }, 'Le materie segnate "a mano" non vengono trascritte. Ogni materia ha già un glossario di partenza, modificabile in Impostazioni → Materie.'), nav());
    }

    const msg = h('div', { class: 'small' });
    return h('div', {}, ...head('Scarica Whisper', 'Il modello di trascrizione si scarica una volta sola (meglio col Wi-Fi) e poi lavora senza internet.'),
      h('select', { onChange: e => { cfg.whisper.model = e.target.value; ctx.save(); } }, WHISPER_MODELS.map(m => h('option', { value: m.id, selected: cfg.whisper.model === m.id }, m.label))),
      h('button', { class: 'btn soft', style: { marginTop: '10px' }, onClick: async () => {
        msg.replaceChildren(h('span', { 'data-loadpct': '' }, 'Preparazione…'));
        try { const i = await loadModel(ctx); msg.replaceChildren(h('span', { style: { color: 'var(--ok)' } }, `Pronto (${i.device === 'webgpu' ? 'GPU' : 'processore'}).`)); }
        catch (e) { msg.replaceChildren(h('span', { style: { color: 'var(--bad)' } }, e.message)); }
      } }, 'Scarica ora'), msg, nav(false, 'Fine', finish));
  });
}
