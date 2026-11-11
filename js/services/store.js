// store.js — Archivio locale sul dispositivo.
// Configurazione in localStorage; chiavi e token separati; sessioni (solo testo) in IndexedDB.

import { normalizeConfig, defaultConfig } from '../core/config.js';

const CFG_KEY = 'lectio.config';
const SECRET_KEY = 'lectio.secrets';

export function loadConfig() {
  try { const raw = localStorage.getItem(CFG_KEY); return raw ? normalizeConfig(JSON.parse(raw)) : defaultConfig(); }
  catch { return defaultConfig(); }
}
export function saveConfig(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

export function getSecrets() { try { return JSON.parse(localStorage.getItem(SECRET_KEY) || '{}'); } catch { return {}; } }
export function setSecret(name, value) {
  const s = getSecrets();
  if (value == null || value === '') delete s[name]; else s[name] = value;
  localStorage.setItem(SECRET_KEY, JSON.stringify(s));
}

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('lectio', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('sessions')) {
        const s = d.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('status', 'status');
        s.createIndex('startedAt', 'startedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction('sessions', mode);
    const store = t.objectStore('sessions');
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const sessions = {
  put: s => tx('readwrite', st => reqP(st.put(JSON.parse(JSON.stringify(s))))),
  get: id => tx('readonly', st => reqP(st.get(id))),
  all: () => tx('readonly', st => reqP(st.getAll())).then(list => list.sort((a, b) => b.startedAt - a.startedAt)),
  remove: id => tx('readwrite', st => reqP(st.delete(id))),
};

/** Elimina le sessioni inviate più vecchie di `days` giorni (solo testo locale: nel documento restano). */
export async function pruneSent(days = 30) {
  const limit = Date.now() - days * 86400000;
  for (const s of await sessions.all()) if (s.status === 'sent' && s.sentAt && s.sentAt < limit) await sessions.remove(s.id);
}
