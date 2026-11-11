// pipeline.js — Regia di una mattinata di lezioni:
// trascrizione → testo salvato in locale → pulizia sul dispositivo → revisione → invio al Google Doc.

import { activeSemester, subjectById, uid } from '../core/config.js';
import { resolveAt, isoDate, hmToMin } from '../core/schedule.js';
import { Segmenter, localClean, compileGlossary, toParagraphs, countWords } from '../core/cleaning.js';
import { flattenTabs, findTab, planInsertion } from '../core/docplan.js';
import { sessions as db } from './store.js';
import { getDocument, batchUpdate, GoogleError, currentToken } from './google.js';

const fmtTime = d => new Date(d).toTimeString().slice(0, 5);

export class Pipeline extends EventTarget {
  constructor(engine, getConfig) {
    super();
    this.engine = engine; this.getConfig = getConfig;
    this.mode = null;            // null | 'manual' | 'morning'
    this.current = null;         // sessione in registrazione
    this.override = null;        // { subjectId, until } scelta manuale durante la mattinata
    this.segmenters = new Map(); // id sessione → Segmenter
    this.cache = new Map();      // id sessione → oggetto sessione
    this.timer = null;
    engine.addEventListener('text', e => this._onText(e.detail));
    window.addEventListener('online', () => this.retryQueued());
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  changed() { this.emit('change'); }

  // ---------- avvio e arresto ----------
  async init() {
    // Recupero dopo chiusura o crash: le sessioni rimaste "in registrazione" vengono chiuse.
    for (const s of await db.all()) {
      this.cache.set(s.id, s);
      if (s.status === 'recording' || s.status === 'closing') { s.endedAt ||= Date.now(); await this._closeSession(s, { recovered: true }); }
      else if (s.blocks?.some(b => b.status === 'pending')) { s.blocks.forEach(b => { if (b.status === 'pending') this._clean(s, b); }); s.status = 'cleaning'; this._maybeReady(s); await db.put(s); }
    }
    this.retryQueued();
    this.changed();
  }

  async list() { return (await db.all()).map(s => this.cache.get(s.id) || s); }

  /** Avvio manuale su una materia, oppure modalità mattinata (materia dall'orario). */
  async start({ mode, subjectId }) {
    const cfg = this.getConfig();
    await this.engine.load(cfg.whisper.model, cfg.whisper.device);
    await this.engine.startListening();
    this.mode = mode;
    if (mode === 'manual') await this._openSession(subjectId, null);
    else await this._tick();
    clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), 3000);
    this.changed();
  }

  async stop() {
    clearInterval(this.timer); this.timer = null;
    const s = this.current;
    this.engine.setFeeding(false);
    await this.engine.stopListening();
    this.mode = null; this.override = null;
    if (s) await this._finish(s);
    this.changed();
  }

  /** Durante la mattinata: cambia materia per la fascia in corso. */
  async switchSubject(subjectId) {
    const now = new Date();
    const st = resolveAt(activeSemester(this.getConfig()), now);
    this.override = { subjectId, until: st.endsAt ? st.endsAt.getTime() : now.getTime() + 100 * 60000 };
    if (this.mode === 'manual') { if (this.current) await this._finish(this.current); await this._openSession(subjectId, null); }
    else await this._tick();
    this.changed();
  }

  /** Stato attuale secondo l'orario, con l'eventuale scelta manuale. */
  status(now = new Date()) {
    const cfg = this.getConfig();
    const st = resolveAt(activeSemester(cfg), now);
    if (this.override && this.override.until > now.getTime()) {
      const subject = subjectById(cfg, this.override.subjectId);
      return { ...st, kind: 'lesson', subject, transcribe: true, overridden: true, endsAt: new Date(this.override.until) };
    }
    return st;
  }

  async _tick() {
    if (this.mode !== 'morning') return;
    if (this.override && this.override.until <= Date.now()) this.override = null;
    const st = this.status();
    const want = st.kind === 'lesson' && st.transcribe && st.subject ? st : null;
    const key = want ? `${want.subject.id}|${want.slot ? want.slot.start : 'override'}|${isoDate(new Date())}` : null;
    if (this.current && this.current.key !== key) {
      // chiude la lezione precedente in background, così l'inizio della successiva non si perde
      const old = this.current; this.engine.setFeeding(false); this.current = null;
      this._finish(old).catch(e => this.emit('notice', e.message));
    }
    if (want && !this.current) await this._openSession(want.subject.id, want.slot, key);
    if (st.kind === 'outside' && !this.current) {
      // fine della mattinata: si spegne il microfono da solo
      await this.stop(); this.emit('notice', 'Lezioni finite: registrazione chiusa automaticamente.'); return;
    }
    this.changed();
  }

  async _openSession(subjectId, slot, key) {
    const cfg = this.getConfig();
    const subject = subjectById(cfg, subjectId);
    if (!subject) throw new Error('Materia non trovata.');
    const now = new Date();
    const s = {
      id: uid('les'), key: key || `${subjectId}|manual|${now.getTime()}`, subjectId, subjectName: subject.name,
      date: isoDate(now), startedAt: now.getTime(), endedAt: null,
      slotLabel: slot ? `${slot.start}–${slot.end}` : null, status: 'recording',
      rawPending: '', words: 0, blocks: [], error: null, sentAt: null, edited: null,
    };
    this.current = s; this.cache.set(s.id, s);
    this.segmenters.set(s.id, new Segmenter());
    this.engine.tag = s.id;
    this.engine.setFeeding(true, subject.glossary);
    await db.put(s);
    this.emit('notice', `Trascrizione avviata: ${subject.name}`);
  }

  async _finish(s) {
    if (this.current === s) { this.engine.setFeeding(false); this.current = null; }
    s.endedAt = Date.now(); s.status = 'closing';
    await db.put(s); this.changed();
    // aspetta che Whisper abbia finito i blocchi già registrati di questa lezione
    await this.engine.drain();
    await this._closeSession(s);
  }

  async _closeSession(s, { recovered = false } = {}) {
    const seg = this.segmenters.get(s.id) || new Segmenter();
    if (!this.segmenters.has(s.id)) seg.add(s.rawPending || '');
    const last = seg.take(true);
    if (last) s.blocks.push(this._clean(s, { raw: last }));
    s.rawPending = '';
    this.segmenters.delete(s.id);
    s.status = s.blocks.length ? 'cleaning' : 'empty';
    if (recovered) s.note = 'Lezione recuperata dopo una chiusura imprevista dell\'app.';
    this._maybeReady(s);
    await db.put(s); this.changed();
  }

  // ---------- testo in arrivo ----------
  async _onText({ text, tag }) {
    const s = this.cache.get(tag);
    if (!s || !['recording', 'closing'].includes(s.status)) return;
    const seg = this.segmenters.get(s.id) || (this.segmenters.set(s.id, new Segmenter()), this.segmenters.get(s.id));
    seg.add(text);
    s.words += countWords(text);
    let block;
    while ((block = seg.take())) s.blocks.push(this._clean(s, { raw: block }));
    s.rawPending = seg.buffer;
    s.lastText = text;
    await db.put(s);
    this.emit('text', { session: s, text });
  }

  /** Pulizia sul dispositivo: intercalari, ripetizioni, termini del glossario, frasi e paragrafi. */
  _clean(s, block) {
    const cfg = this.getConfig();
    const subject = subjectById(cfg, s.subjectId);
    if (!this._glossCache || this._glossCache.id !== s.subjectId || this._glossCache.src !== subject?.glossary) {
      this._glossCache = { id: s.subjectId, src: subject?.glossary, compiled: compileGlossary(subject?.glossary || []) };
    }
    try {
      block.cleaned = localClean(block.raw, { compiled: this._glossCache.compiled, fillers: cfg.cleaning.fillers, useGlossary: cfg.cleaning.glossary });
      block.status = 'done';
    } catch (e) { block.cleaned = block.raw; block.status = 'raw'; block.note = 'Pulizia non riuscita: testo lasciato com\'è.'; }
    return block;
  }

  /** Quando tutti i blocchi sono puliti, la lezione passa in revisione (o in coda se l'invio è automatico). */
  _maybeReady(s) {
    if (s.status !== 'cleaning' || !s.blocks.every(x => x.status === 'done' || x.status === 'raw')) return;
    s.status = this.getConfig().sending.auto ? 'queued' : 'review';
    s.error = null;
    if (s.status === 'queued') setTimeout(() => this.send(s.id).catch(() => {}), 0);
  }

  // ---------- revisione e invio ----------
  fullText(s) {
    if (s.edited != null) return s.edited;
    return s.blocks.map(b => b.cleaned ?? b.raw).join('\n\n');
  }
  async saveEdit(id, text) { const s = this.cache.get(id); s.edited = text; await db.put(s); this.changed(); }
  async remove(id) { this.cache.delete(id); await db.remove(id); this.changed(); }

  async retryQueued() {
    if (!currentToken()) return;
    for (const s of this.cache.values()) if (s.status === 'queued') await this.send(s.id).catch(() => {});
  }

  /** Inserisce la lezione nel documento. Idempotente: se il testo è già presente non lo ripete. */
  async send(id) {
    const cfg = this.getConfig();
    const s = this.cache.get(id);
    if (!s || s.status === 'sent' || s.sending) return;
    s.sending = true; s.status = 'queued'; s.error = null; this.changed();
    try {
      const subject = subjectById(cfg, s.subjectId) || { name: s.subjectName, tabTitle: s.subjectName };
      const paragraphs = toParagraphs(this.fullText(s));
      const label = cfg.sending.label ? `Trascrizione automatica${s.slotLabel ? ' · ' + s.slotLabel : ' · ' + fmtTime(s.startedAt) + '–' + fmtTime(s.endedAt || Date.now())}` : null;
      let result;
      for (let attempt = 1; ; attempt++) {
        const doc = await getDocument(cfg.doc.id);
        const tab = findTab(flattenTabs(doc), { tabId: subject.tabId, tabTitle: subject.tabTitle, name: subject.name });
        if (!tab) throw new GoogleError(`Nel documento non trovo la scheda per "${subject.name}". Controlla Impostazioni → Materie.`);
        const [y, m, d] = s.date.split('-').map(Number);
        const plan = planInsertion({ tab, date: new Date(y, m - 1, d), paragraphs, label, dateFormat: cfg.dateFormat, now: new Date(y, m - 1, d) });
        result = { ...plan, tabTitle: tab.title };
        if (plan.alreadyPresent) break;
        try { await batchUpdate(cfg.doc.id, plan.requests, doc.revisionId); break; }
        catch (e) { if (!(e instanceof GoogleError && e.conflict) || attempt >= 4) throw e; }
      }
      s.status = 'sent'; s.sentAt = Date.now(); s.sentTo = { tab: result.tabTitle, heading: result.headingText, already: result.alreadyPresent };
      this.emit('notice', `Inserita in "${result.tabTitle}" sotto ${result.headingText}.`);
    } catch (e) {
      s.status = e.needsLogin || e.retryable ? 'queued' : 'review';
      s.error = e.message; s.needsLogin = !!e.needsLogin;
      throw e;
    } finally {
      s.sending = false; await db.put(s); this.changed();
    }
  }
}

/** Minuti trascorsi da una fascia, per la barra di avanzamento. */
export function slotProgress(slot, now = new Date()) {
  if (!slot) return null;
  const m = now.getHours() * 60 + now.getMinutes();
  const a = hmToMin(slot.start), b = hmToMin(slot.end);
  return Math.max(0, Math.min(1, (m - a) / (b - a)));
}
