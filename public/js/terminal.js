'use strict';

// Plusieurs terminaux indépendants, présentés en onglets. Chaque session a sa
// propre WebSocket + instance xterm (le serveur lance un PTY par connexion).

const sessions = new Map(); // id -> { term, fit, ws, pane, host, tab, label }
let seq = 0;
let activeId = null;

function tabsEl() { return document.getElementById('term-tabs'); }
function stackEl() { return document.getElementById('term-stack'); }

function setStatus(id, cls) {
  const s = sessions.get(id);
  if (s) { const dot = s.tab.querySelector('.dot'); dot.className = 'dot' + (cls ? ' ' + cls : ''); }
}

function connect(s) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal`);
  s.ws = ws;
  ws.onopen = () => {
    setStatus(s.id, 'up');
    if (s.retries) s.term.write('\r\n\x1b[2m[reconnecté — nouveau shell]\x1b[0m\r\n');
    // On ne considère la session « stable » (remise à zéro du compteur) qu'après
    // être restée ouverte un moment. Si le shell meurt aussitôt (ex. jail
    // impossible : dossier inaccessible), le compteur n'est PAS effacé -> la
    // reconnexion s'arrête vite au lieu de boucler à l'infini.
    s.stableTimer = setTimeout(() => { s.retries = 0; s.stableTimer = null; }, 4000);
    sendResize(s);
    if (s.id === activeId) s.term.focus();
  };
  ws.onmessage = (ev) => { s.term.write(typeof ev.data === 'string' ? ev.data : ''); };
  ws.onclose = () => {
    setStatus(s.id, 'down');
    if (s.stableTimer) { clearTimeout(s.stableTimer); s.stableTimer = null; }
    if (s.closing) return; // fermeture volontaire (onglet fermé)
    // Reconnexion bornée : couvre les vraies pertes (réseau, veille). Un échec
    // immédiat et répété (config invalide) s'arrête après quelques essais.
    s.retries = (s.retries || 0) + 1;
    if (s.retries > 4) {
      s.term.write('\r\n\x1b[31m[session terminée — échec répété. Corrigez le problème puis cliquez « + ».]\x1b[0m\r\n');
      return;
    }
    const delay = Math.min(5000, 600 * 2 ** (s.retries - 1));
    s.term.write(`\r\n\x1b[2m[connexion perdue — reconnexion ${s.retries}/4…]\x1b[0m\r\n`);
    s.reconnectTimer = setTimeout(() => { if (sessions.has(s.id) && !s.closing) connect(s); }, delay);
  };
  ws.onerror = () => setStatus(s.id, 'down');
}

function sendResize(s) {
  if (!s.fit || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
  const d = s.fit.proposeDimensions();
  if (d && d.cols && d.rows) s.ws.send(JSON.stringify({ type: 'resize', cols: d.cols, rows: d.rows }));
}

function renderTab(s) {
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = s.id;
  tab.innerHTML = `<span class="dot"></span><span class="lbl">${s.label}</span><span class="x" title="Fermer">×</span>`;
  s.tab = tab;
  tabsEl().appendChild(tab);
}

function newTerminal() {
  const id = ++seq;
  const host = document.createElement('div');
  host.className = 'term-host';
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  pane.dataset.id = id;
  pane.appendChild(host);
  stackEl().appendChild(pane);

  const term = new window.Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    theme: { background: '#05070b', foreground: '#e6e9ef', cursor: '#2dd4bf' },
    scrollback: 5000,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((d) => { const s = sessions.get(id); if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'data', data: d })); });

  const s = { id, term, fit, ws: null, pane, host, tab: null, label: 'Terminal ' + id, closing: false, retries: 0, reconnectTimer: null, stableTimer: null };
  sessions.set(id, s);
  renderTab(s);
  connect(s);
  setActive(id);
}

function setActive(id) {
  if (!sessions.has(id)) return;
  activeId = id;
  for (const s of sessions.values()) {
    const on = s.id === id;
    s.pane.classList.toggle('active', on);
    s.tab.classList.toggle('active', on);
  }
  const s = sessions.get(id);
  requestAnimationFrame(() => { try { s.fit.fit(); sendResize(s); s.term.focus(); } catch (e) { /* */ } });
}

function closeTerminal(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.closing = true; // empêche la reconnexion automatique
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  if (s.stableTimer) { clearTimeout(s.stableTimer); s.stableTimer = null; }
  try { s.ws && s.ws.close(); } catch (e) { /* */ }
  try { s.term.dispose(); } catch (e) { /* */ }
  s.pane.remove(); s.tab.remove();
  sessions.delete(id);
  if (activeId === id) {
    activeId = null;
    const next = [...sessions.keys()].pop();
    if (next) setActive(next);
  }
  if (sessions.size === 0) newTerminal(); // garde toujours au moins un terminal
}

let bound = false;
function bind() {
  if (bound) return; bound = true;
  document.getElementById('term-new').addEventListener('click', () => newTerminal());
  tabsEl().addEventListener('click', (e) => {
    const tab = e.target.closest('.tab'); if (!tab) return;
    const id = parseInt(tab.dataset.id, 10);
    if (e.target.classList.contains('x')) closeTerminal(id);
    else setActive(id);
  });
  window.addEventListener('resize', () => { if (activeId) { const s = sessions.get(activeId); try { s.fit.fit(); sendResize(s); } catch (e) { /* */ } } });
}

export function initTerminal() {
  bind();
  if (sessions.size === 0) newTerminal();
  else setActive(activeId);
}

export function fitTerminal() {
  if (!activeId) return;
  const s = sessions.get(activeId);
  if (s) { try { s.fit.fit(); sendResize(s); s.term.focus(); } catch (e) { /* conteneur masqué */ } }
}
