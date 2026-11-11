// engine.js — Motore di trascrizione: microfono → blocchi audio → Whisper (nel worker) → testo.
// L'audio esiste solo in memoria per pochi secondi; nessun file viene mai creato.

import { resampleTo16k, rms, Chunker, cleanHallucinations, whisperPrompt } from '../core/audio.js';

const WORKLET = `class Tap extends AudioWorkletProcessor {
  constructor(){ super(); this.buf = []; this.n = 0; }
  process(inputs){ const ch = inputs[0] && inputs[0][0]; if (ch) { this.buf.push(new Float32Array(ch)); this.n += ch.length;
    if (this.n >= 4096) { const out = new Float32Array(this.n); let o = 0; for (const b of this.buf) { out.set(b, o); o += b.length; }
      this.port.postMessage(out, [out.buffer]); this.buf = []; this.n = 0; } } return true; } }
registerProcessor('tap', Tap);`;

export class WhisperEngine extends EventTarget {
  constructor() {
    super();
    this.worker = null; this.loaded = null; this.loading = null;
    this.queue = []; this.busy = false; this.reqId = 0; this.pending = new Map();
    this.listening = false; this.feeding = false;
    this.rtf = []; this.lastText = '';
    this.glossary = [];
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** Carica (o riusa) il modello. */
  load(modelId, device) {
    const key = modelId + '|' + device;
    if (this.loaded?.key === key) return Promise.resolve(this.loaded);
    if (this.loading?.key === key) return this.loading.promise;
    this.worker?.terminate(); this.worker = null; this.loaded = null;
    const w = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    this.worker = w;
    const promise = new Promise((resolve, reject) => {
      w.onmessage = ({ data }) => {
        if (data.type === 'progress') this.emit('progress', data);
        else if (data.type === 'loaded') { this.loaded = { key, ...data }; this.loading = null; this.emit('loaded', this.loaded); resolve(this.loaded); }
        else if (data.type === 'error' && data.id == null) { this.loading = null; reject(new Error(data.message)); }
        else if (data.type === 'result' || data.type === 'error') { this.pending.get(data.id)?.(data); this.pending.delete(data.id); }
      };
      w.onerror = e => { this.loading = null; reject(new Error(e.message || 'Errore nel motore Whisper')); };
      w.postMessage({ type: 'load', modelId, wantDevice: device });
    });
    this.loading = { key, promise };
    return promise;
  }

  _transcribe(audio, meta, prompt) {
    const id = ++this.reqId;
    return new Promise(res => { this.pending.set(id, res); this.worker.postMessage({ type: 'transcribe', id, audio, prompt, meta }, [audio.buffer]); });
  }

  /** Apre il microfono. `feeding` decide se l'audio va trascritto (false nelle pause). */
  async startListening() {
    if (this.listening) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'tap');
    this.chunker = new Chunker({ onChunk: (a, m) => this._enqueue(a, m) });
    this.node.port.onmessage = ({ data }) => {
      this.emit('level', rms(data));
      if (this.feeding) this.chunker.push(resampleTo16k(data, this.ctx.sampleRate));
    };
    src.connect(this.node);
    this.stream.getAudioTracks()[0].addEventListener('ended', () => this.emit('mic-lost'));
    this.listening = true;
    this.emit('state', 'listening');
  }
  setFeeding(on, glossary) {
    if (glossary) this.glossary = glossary;
    if (this.feeding && !on) { this.chunker?.flush(); }
    if (!this.feeding && on) { this.chunker?.reset(); this.lastText = ''; }
    this.feeding = on;
  }
  /** Chiude il blocco in corso (fine lezione) senza spegnere il microfono. */
  flush() { this.chunker?.flush(); }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch {} }
    const track = this.stream?.getAudioTracks()[0];
    return !!track && track.readyState === 'live' && this.ctx?.state === 'running';
  }
  async stopListening() {
    this.feeding = false;
    this.chunker?.flush();
    try { this.node?.disconnect(); this.stream?.getTracks().forEach(t => t.stop()); await this.ctx?.close(); } catch {}
    this.listening = false; this.ctx = null; this.stream = null;
    this.emit('state', 'stopped');
  }
  /** Attende che la coda di trascrizione sia vuota. */
  async drain() { while (this.busy || this.queue.length) await new Promise(r => setTimeout(r, 200)); }

  _enqueue(audio, meta) {
    meta.tag = this.tag; // a quale lezione appartiene il blocco
    this.queue.push({ audio, meta });
    this.emit('queue', this.queue.length);
    this._pump();
  }
  async _pump() {
    if (this.busy || !this.queue.length || !this.worker) return;
    this.busy = true;
    const { audio, meta } = this.queue.shift();
    const prompt = whisperPrompt(this.glossary, this.lastText);
    const r = await this._transcribe(audio, meta, prompt);
    this.busy = false;
    if (r.type === 'error') this.emit('error', r.message);
    else {
      this.rtf.push(r.ms / 1000 / meta.durSec); if (this.rtf.length > 20) this.rtf.shift();
      const text = cleanHallucinations(r.text);
      if (text) { this.lastText = text; this.emit('text', { text, tag: meta.tag, durSec: meta.durSec }); }
    }
    this.emit('queue', this.queue.length);
    this._pump();
  }
  /** Velocità recente: < 1 significa che il motore tiene il passo. */
  speed() {
    if (this.rtf.length < 3) return null;
    const s = [...this.rtf].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.9)] ?? s[s.length - 1];
  }
}
