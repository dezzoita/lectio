// audio.js — Elaborazione audio pura: ricampionamento, livello, divisione in blocchi (VAD),
// filtro delle frasi inventate da Whisper. Nessun audio viene mai salvato: i blocchi
// vengono passati al motore e poi dimenticati.

export function resampleTo16k(input, fromRate) {
  const toRate = 16000;
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = fromRate / toRate;
  let src = input;
  if (ratio > 1.5) {
    // media mobile come filtro anti-aliasing prima di scendere di frequenza
    const w = Math.floor(ratio);
    src = new Float32Array(input.length);
    let acc = 0;
    for (let k = 0; k < input.length; k++) {
      acc += input[k];
      if (k >= w) acc -= input[k - w];
      src[k] = acc / Math.min(k + 1, w);
    }
  }
  const outLen = Math.floor(src.length / ratio);
  const out = new Float32Array(outLen);
  for (let k = 0; k < outLen; k++) {
    const pos = k * ratio, i0 = Math.floor(pos), f = pos - i0;
    const a = src[i0], b = src[Math.min(i0 + 1, src.length - 1)];
    out[k] = a + (b - a) * f;
  }
  return out;
}

export function rms(frame) {
  let s = 0;
  for (let k = 0; k < frame.length; k++) s += frame[k] * frame[k];
  return Math.sqrt(s / (frame.length || 1));
}

/**
 * Divide un flusso a 16 kHz in blocchi per Whisper: taglia nelle pause dopo almeno
 * minSec, o forzatamente a maxSec; scarta i blocchi quasi senza parlato.
 */
export class Chunker {
  constructor({ minSec = 6, maxSec = 24, silenceMs = 600, frameMs = 30, minSpeechRatio = 0.15, onChunk }) {
    Object.assign(this, { minSec, maxSec, silenceMs, frameMs, minSpeechRatio, onChunk });
    this.frameLen = Math.round(16000 * frameMs / 1000);
    this.pending = new Float32Array(0);
    this.frames = [];
    this.speechFrames = 0;
    this.trailingSilence = 0;
    this.noiseFloor = 0.003;
    this.startedAt = 0;
    this.totalSec = 0;
    this.discarded = 0;
  }
  isSpeech(level) {
    if (level < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.9 + level * 0.1;
    else this.noiseFloor = this.noiseFloor * 0.999 + level * 0.001;
    return level > Math.max(this.noiseFloor * 3, 0.004);
  }
  push(samples16k) {
    const buf = new Float32Array(this.pending.length + samples16k.length);
    buf.set(this.pending); buf.set(samples16k, this.pending.length);
    let off = 0;
    while (off + this.frameLen <= buf.length) {
      const frame = buf.subarray(off, off + this.frameLen);
      off += this.frameLen;
      this.totalSec += this.frameMs / 1000;
      const speech = this.isSpeech(rms(frame));
      if (this.frames.length === 0 && !speech) continue;
      if (this.frames.length === 0) this.startedAt = this.totalSec - this.frameMs / 1000;
      this.frames.push(Float32Array.from(frame));
      if (speech) { this.speechFrames++; this.trailingSilence = 0; }
      else this.trailingSilence += this.frameMs;
      const dur = this.frames.length * this.frameMs / 1000;
      if ((dur >= this.minSec && this.trailingSilence >= this.silenceMs) || dur >= this.maxSec) this.flush();
    }
    this.pending = buf.slice(off);
  }
  /** Scarta l'audio in attesa senza emetterlo (pause, materie non trascritte). */
  reset() { this.frames = []; this.speechFrames = 0; this.trailingSilence = 0; this.pending = new Float32Array(0); }
  flush() {
    if (!this.frames.length) return;
    const ratio = this.speechFrames / this.frames.length;
    const audio = new Float32Array(this.frames.length * this.frameLen);
    this.frames.forEach((f, k) => audio.set(f, k * this.frameLen));
    const meta = { startSec: this.startedAt, durSec: audio.length / 16000, speechRatio: ratio };
    this.frames = []; this.speechFrames = 0; this.trailingSilence = 0;
    if (ratio < this.minSpeechRatio) { this.discarded++; return; }
    this.onChunk(audio, meta);
  }
}

const HALLUCINATIONS = [
  /sottotitoli (creati|a cura|e revisione)(.*?amara\.org|[^.]*)\.?/gi,
  /amara\.org/gi,
  /qtss/gi,
  /grazie (a tutti )?per (la visione|l'?attenzione|aver guardato)[.!]?/gi,
  /iscriviti al canale[^.]*\.?/gi,
];
export function cleanHallucinations(text) {
  let t = text || '';
  for (const re of HALLUCINATIONS) t = t.replace(re, ' ');
  t = t.replace(/(\b[^.!?]{8,}?[.!?])(\s*\1){2,}/g, '$1');
  return t.replace(/\s+/g, ' ').trim();
}

/** Prompt per Whisper: glossario della materia (entro ~200 token) e coda del testo precedente. */
export function whisperPrompt(terms, previousText = '', maxChars = 420) {
  const tail = (previousText || '').split(/\s+/).slice(-18).join(' ');
  let out = '';
  for (const t of terms || []) {
    const next = out ? out + ', ' + t : t;
    if (next.length + tail.length > maxChars) break;
    out = next;
  }
  return [out && out + '.', tail].filter(Boolean).join(' ');
}
