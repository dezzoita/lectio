// app.js — Avvio dell'app, stato globale e navigazione tra le schermate.

import { loadConfig, saveConfig, pruneSent } from './services/store.js';
import { captureRedirect, currentToken } from './services/google.js';
import { WhisperEngine } from './services/engine.js';
import { Pipeline } from './services/pipeline.js';
import { h, icon, toast } from './ui/dom.js';
import { renderLesson, renderInbox, renderSettings, openWizard, updateLive } from './ui/views.js';

const ctx = {
  cfg: loadConfig(),
  view: 'lesson',
  save() { saveConfig(ctx.cfg); },
  go(view) { ctx.view = view; render(); window.scrollTo(0, 0); },
  render: () => render(),
  wake: null,
};
ctx.engine = new WhisperEngine();
ctx.pipeline = new Pipeline(ctx.engine, () => ctx.cfg);

// ---------- schermo acceso durante la registrazione ----------
ctx.holdWake = async () => {
  if (!('wakeLock' in navigator) || ctx.wake) return;
  try { ctx.wake = await navigator.wakeLock.request('screen'); ctx.wake.addEventListener('release', () => { ctx.wake = null; }); } catch {}
};
ctx.releaseWake = () => { try { ctx.wake?.release(); } catch {} ctx.wake = null; };
document.addEventListener('visibilitychange', async () => {
  if (!ctx.pipeline.mode) return;
  if (document.hidden) { ctx.wasHidden = true; return; }
  await ctx.holdWake();
  const ok = await ctx.engine.resume();
  ctx.micWarning = ok ? 'L\'app è andata in secondo piano: alcuni secondi di lezione potrebbero mancare. Lascia lo schermo acceso con Lectio aperta.'
    : 'Il microfono si è fermato mentre l\'app era in secondo piano. Tocca "Riattiva microfono".';
  render();
});
ctx.engine.addEventListener('mic-lost', () => { ctx.micWarning = 'Il microfono si è interrotto. Tocca "Riattiva microfono".'; render(); });

// ---------- navigazione ----------
const TABS = [
  { id: 'lesson', label: 'Lezione', icon: 'mic' },
  { id: 'inbox', label: 'Da inviare', icon: 'inbox' },
  { id: 'settings', label: 'Impostazioni', icon: 'gear' },
];
let inboxCount = 0;
function renderTabbar() {
  const bar = document.getElementById('tabbar');
  bar.replaceChildren(h('div', { class: 'in' }, TABS.map(t => h('button', {
    class: ctx.view === t.id ? 'on' : '', 'aria-current': ctx.view === t.id ? 'page' : null, onClick: () => ctx.go(t.id),
  }, icon(t.icon), t.label, t.id === 'inbox' && inboxCount ? h('span', { class: 'badge' }, inboxCount) : null))));
}

let rendering = false, again = false;
async function render() {
  if (rendering) { again = true; return; }
  rendering = true;
  try {
    const list = await ctx.pipeline.list();
    inboxCount = list.filter(s => ['review', 'queued'].includes(s.status)).length;
    const root = document.getElementById('root');
    const views = { lesson: renderLesson, inbox: renderInbox, settings: renderSettings };
    if (ctx.view === 'settings' && root.dataset.view === 'settings' && !ctx.forceSettings) { renderTabbar(); return; } // non distruggere i campi in modifica
    ctx.forceSettings = false;
    root.replaceChildren(await views[ctx.view](ctx, list));
    root.dataset.view = ctx.view;
    renderTabbar();
  } catch (e) {
    console.error(e);
    document.getElementById('root').replaceChildren(h('div', { class: 'banner bad' }, 'Errore dell\'interfaccia: ' + e.message));
  } finally {
    rendering = false;
    if (again) { again = false; render(); }
  }
}
ctx.rerenderSettings = () => { ctx.forceSettings = true; render(); };

ctx.pipeline.addEventListener('change', () => { if (ctx.view !== 'settings') render(); else renderTabbar(); });
ctx.pipeline.addEventListener('text', e => updateLive(ctx, e.detail));
ctx.pipeline.addEventListener('notice', e => toast(e.detail));

// ---------- avvio ----------
async function boot() {
  const back = captureRedirect();
  if (back?.error) toast(back.error === 'access_denied' ? 'Accesso a Google annullato.' : 'Accesso a Google non riuscito: ' + back.error, 5000);
  else if (back?.ok) toast('Accesso a Google eseguito.');

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  await ctx.pipeline.init();
  pruneSent(30).catch(() => {});
  await render();

  if (back?.ok && back.after) {
    if (back.after.startsWith('wizard:')) openWizard(ctx, +back.after.split(':')[1]);
    else if (back.after === 'sendall') { ctx.go('inbox'); ctx.pipeline.retryQueued(); }
    else if (back.after.startsWith('send:')) { ctx.go('inbox'); ctx.pipeline.send(back.after.slice(5)).catch(e => toast(e.message, 5000)); }
    else if (back.after === 'settings') ctx.go('settings');
  } else if (!ctx.cfg.setupDone) openWizard(ctx, 0);
  else if (currentToken()) ctx.pipeline.retryQueued();
}

window.addEventListener('beforeunload', e => { if (ctx.pipeline.mode) { e.preventDefault(); e.returnValue = ''; } });
boot();

// per i test automatici
window.__lectio = ctx;
