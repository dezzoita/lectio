// google.js — Accesso a Google (OAuth 2.0 per app web, con reindirizzamento) e Google Docs API.
// Il reindirizzamento funziona anche nell'app installata su iPhone, dove le finestre popup sono inaffidabili.
// Il token dura circa un'ora e resta solo sul dispositivo.

import { getSecrets, setSecret } from './store.js';

const SCOPE = 'https://www.googleapis.com/auth/documents';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const DOCS = 'https://docs.googleapis.com/v1/documents/';

export class GoogleError extends Error {
  constructor(message, { status = 0, needsLogin = false, retryable = false, conflict = false } = {}) { super(message); Object.assign(this, { status, needsLogin, retryable, conflict }); }
}

export function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }

/** Da chiamare all'avvio: se si torna da Google con il token nell'indirizzo, lo salva e pulisce l'indirizzo. */
export function captureRedirect() {
  if (!location.hash.includes('access_token=') && !location.hash.includes('error=')) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  const expected = sessionStorage.getItem('lectio.oauthState');
  history.replaceState(null, '', location.pathname + location.search);
  if (p.get('error')) return { error: p.get('error') };
  if (!expected || p.get('state') !== expected) return { error: 'state_mismatch' };
  sessionStorage.removeItem('lectio.oauthState');
  const exp = Date.now() + (Number(p.get('expires_in') || 3600) - 120) * 1000;
  setSecret('googleToken', { token: p.get('access_token'), exp });
  const after = sessionStorage.getItem('lectio.afterLogin'); sessionStorage.removeItem('lectio.afterLogin');
  return { ok: true, after };
}

export function currentToken() {
  const t = getSecrets().googleToken;
  return t && t.exp > Date.now() ? t.token : null;
}
export function signOut() { setSecret('googleToken', null); }

/** Avvia l'accesso: la pagina viene sostituita da quella di Google e poi riaperta. */
export function signIn(clientId, { after = '' } = {}) {
  if (!clientId) throw new GoogleError('Manca il Client ID di Google (Impostazioni → Google).');
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  sessionStorage.setItem('lectio.oauthState', state);
  if (after) sessionStorage.setItem('lectio.afterLogin', after);
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE,
    include_granted_scopes: 'true', state, prompt: '',
  });
  if (!q.get('prompt')) q.delete('prompt');
  location.assign(AUTH + '?' + q.toString());
}

async function api(path, { method = 'GET', body } = {}) {
  const token = currentToken();
  if (!token) throw new GoogleError('Accesso a Google scaduto: tocca "Accedi a Google".', { needsLogin: true });
  let res;
  try {
    res = await fetch(DOCS + path, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new GoogleError('Connessione assente: il testo resta in coda e verrà inviato appena possibile.', { retryable: true }); }
  let data = null; try { data = await res.json(); } catch {}
  if (res.ok) return data;
  const msg = data?.error?.message || res.statusText;
  if (res.status === 401) { signOut(); throw new GoogleError('Accesso a Google scaduto.', { status: 401, needsLogin: true }); }
  if (res.status === 403) throw new GoogleError('Google nega l\'accesso al documento: ' + msg, { status: 403 });
  if (res.status === 404) throw new GoogleError('Documento non trovato: controlla l\'ID in Impostazioni.', { status: 404 });
  if (res.status === 400 && /revision/i.test(msg)) throw new GoogleError('Il documento è cambiato nel frattempo.', { status: 400, conflict: true });
  if (res.status === 429 || res.status >= 500) throw new GoogleError(`Google temporaneamente non disponibile (${res.status}).`, { status: res.status, retryable: true });
  throw new GoogleError(`Richiesta rifiutata da Google (${res.status}): ${msg}`, { status: res.status });
}

export function getDocument(docId) { return api(encodeURIComponent(docId) + '?includeTabsContent=true'); }
export function batchUpdate(docId, requests, revisionId) {
  return api(encodeURIComponent(docId) + ':batchUpdate', { method: 'POST', body: { requests, ...(revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {}) } });
}

/** Estrae l'ID da un link di Google Docs o lo restituisce com'è. */
export function parseDocId(input) {
  const m = String(input || '').match(/\/document\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : String(input || '').trim();
}
