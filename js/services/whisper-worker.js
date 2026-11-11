// whisper-worker.js — Esegue Whisper nel browser in un Web Worker, così l'interfaccia resta fluida.
// Riceve blocchi di audio a 16 kHz (solo in memoria, mai salvati) e restituisce il testo.
import {
  AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

env.allowLocalModels = false; // i modelli arrivano da Hugging Face e restano nella cache del browser

let processor, tokenizer, model, device;

const DTYPES = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
};

async function load({ modelId, wantDevice }) {
  const t0 = performance.now();
  const progress = p => {
    if (p.status === 'progress' && p.total) {
      self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    }
  };
  let tried = [];
  const order = wantDevice === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'];
  for (const dev of order) {
    if (dev === 'webgpu' && !('gpu' in navigator && await navigator.gpu.requestAdapter().catch(() => null))) {
      tried.push('webgpu: non disponibile in questo browser');
      continue;
    }
    try {
      processor ??= await AutoProcessor.from_pretrained(modelId, { progress_callback: progress });
      tokenizer ??= await AutoTokenizer.from_pretrained(modelId, { progress_callback: progress });
      model = await WhisperForConditionalGeneration.from_pretrained(modelId, {
        device: dev, dtype: DTYPES[dev], progress_callback: progress,
      });
      device = dev;
      // Riscaldamento: la prima inferenza compila gli shader, non va contata nei tempi reali.
      const tw = performance.now();
      await transcribe(new Float32Array(16000), '');
      self.postMessage({ type: 'status', text: 'pronto' });
      const warmMs = performance.now() - tw;
      self.postMessage({ type: 'loaded', device, loadMs: Math.round(performance.now() - t0), warmMs: Math.round(warmMs), tried });
      return;
    } catch (e) {
      tried.push(dev + ': ' + (e?.message || e));
      model = null;
    }
  }
  throw new Error('Impossibile caricare il modello. Tentativi: ' + tried.join(' | '));
}

/** Costruisce i token iniziali del decoder, con il glossario come "testo precedente":
 *  <|startofprev|> glossario <|startoftranscript|> <|it|> <|transcribe|> <|notimestamps|> */
function initTokens(prompt) {
  const gc = model.generation_config;
  const tokens = [];
  if (prompt) {
    const sop = gc.prev_sot_token_id ?? tokenizer.encode('<|startofprev|>', { add_special_tokens: false })[0];
    const ids = tokenizer.encode(' ' + prompt.trim(), { add_special_tokens: false }).slice(-200);
    tokens.push(sop, ...ids);
  }
  tokens.push(gc.decoder_start_token_id, gc.lang_to_id['<|it|>'], gc.task_to_id['transcribe'], gc.no_timestamps_token_id);
  return tokens;
}

async function transcribe(audio, prompt) {
  const inputs = await processor(audio);
  const init = initTokens(prompt);
  const out = await model.generate({
    ...inputs,
    decoder_input_ids: init,
    max_new_tokens: Math.min(440 - init.length, 220),
  });
  const ids = out.tolist()[0].slice(init.length).map(Number);
  return tokenizer.decode(ids, { skip_special_tokens: true }).trim();
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data);
    else if (data.type === 'transcribe') {
      const t0 = performance.now();
      const text = await transcribe(data.audio, data.prompt);
      // Il buffer audio esce di scope qui e viene liberato: nulla viene salvato.
      self.postMessage({ type: 'result', id: data.id, text, ms: Math.round(performance.now() - t0), meta: data.meta });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: data.id, message: e?.message || String(e) });
  }
};
