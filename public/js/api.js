'use strict';

import { icon } from './ui.js';

// Wrappers fetch : gèrent le 401 (session expirée -> login) et le 403 NEED_SUDO
// (demande d'élévation puis rejeu unique de la requête).

async function handle(res) {
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expirée');
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  return res;
}

// Rejoue la requête une fois si le serveur réclame une élévation (NEED_SUDO).
async function withRetry(doFetch) {
  let res = await doFetch();
  if (res.status === 403) {
    let body = null;
    try { body = await res.clone().json(); } catch (e) { /* pas du JSON */ }
    if (body && body.code === 'NEED_SUDO') {
      const granted = await openSudoModal();
      if (granted) res = await doFetch();
    }
  }
  return res;
}

// En-tête anti-CSRF : le serveur pose un cookie 'csrf' (lisible) par session ;
// on le renvoie en en-tête sur chaque requête mutante (défense en profondeur
// avec SameSite=strict).
export function csrfHeaders() {
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m ? { 'X-CSRF-Token': decodeURIComponent(m[1]) } : {};
}

export function apiGet(path) {
  return withRetry(() => fetch(path, { headers: { Accept: 'application/json' } })).then(handle);
}

export function apiPost(path, body, method = 'POST') {
  return withRetry(() => fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body || {}),
  })).then(handle);
}

// Pour les requêtes non-JSON (upload multipart) : renvoie la Response brute.
export function fetchWithSudo(input, init = {}) {
  const headers = { ...(init.headers || {}), ...csrfHeaders() };
  return withRetry(() => fetch(input, { ...init, headers }));
}

export async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: csrfHeaders() }); } catch (e) { /* */ }
  window.location.href = '/login';
}

/* ----------------------------------------------------------------------- *
 * Élévation de privilèges (modal + indicateur de verrou)
 * ----------------------------------------------------------------------- */
let sudoOn = false;
let sudoResolvers = [];

function setSudoBadge(on, user) {
  sudoOn = on;
  const el = document.getElementById('sudo-state');
  if (!el) return;
  el.classList.toggle('on', on);
  el.classList.toggle('locked', !on);
  const safeUser = String(user || 'root').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  el.innerHTML = (on ? icon('unlock') : icon('lock')) +
    '<span>' + (on ? 'root: ' + safeUser : 'Privilèges verrouillés') + '</span>';
}

export async function refreshSudoState() {
  try {
    const r = await fetch('/api/elevate/status', { headers: { Accept: 'application/json' } });
    const d = await r.json();
    setSudoBadge(!!d.elevated, d.user);
  } catch (e) { /* */ }
}

// Ouvre la modal et renvoie une promesse résolue à true (accordé) / false (annulé).
function openSudoModal() {
  const m = document.getElementById('sudo-modal');
  if (!m) return Promise.resolve(false);
  if (!m.classList.contains('open')) {
    document.getElementById('sudo-err').textContent = '';
    document.getElementById('sudo-pass').value = '';
    m.classList.add('open');
    setTimeout(() => document.getElementById('sudo-pass').focus(), 50);
  }
  return new Promise((resolve) => sudoResolvers.push(resolve));
}

function closeSudoModal(result) {
  const m = document.getElementById('sudo-modal');
  if (m) m.classList.remove('open');
  const rs = sudoResolvers; sudoResolvers = [];
  rs.forEach((r) => r(result));
}

async function submitElevation() {
  const user = document.getElementById('sudo-user').value.trim() || 'root';
  const password = document.getElementById('sudo-pass').value;
  const errEl = document.getElementById('sudo-err');
  const btn = document.getElementById('sudo-ok');
  errEl.textContent = '';
  if (!password) { errEl.textContent = 'Mot de passe requis.'; return; }
  btn.disabled = true; btn.textContent = 'Vérification…';
  try {
    const res = await fetch('/api/elevate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify({ user, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setSudoBadge(true, user);
      toast(`Privilèges administrateur accordés (${user}).`, 'ok');
      closeSudoModal(true);
    } else {
      errEl.textContent = data.error || 'Échec de l\'authentification.';
    }
  } catch (e) {
    errEl.textContent = 'Erreur réseau : ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Déverrouiller';
    document.getElementById('sudo-pass').value = '';
  }
}

export function bindSudoUI() {
  document.getElementById('sudo-ok').addEventListener('click', submitElevation);
  document.getElementById('sudo-pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitElevation(); }
  });
  document.getElementById('sudo-cancel').addEventListener('click', () => closeSudoModal(false));
  document.getElementById('sudo-close').addEventListener('click', () => closeSudoModal(false));
  document.getElementById('sudo-modal').addEventListener('click', (e) => {
    if (e.target.id === 'sudo-modal') closeSudoModal(false);
  });
  document.getElementById('sudo-state').addEventListener('click', async () => {
    if (sudoOn) {
      try { await fetch('/api/elevate/lock', { method: 'POST', headers: csrfHeaders() }); } catch (e) { /* */ }
      setSudoBadge(false, null);
      toast('Privilèges administrateur verrouillés.');
    } else {
      openSudoModal();
    }
  });
}

// ---------- Toasts ----------
export function toast(message, kind = '') {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 3500);
}

// ---------- Formatage ----------
export function fmtBytes(n) {
  if (!n || n < 0) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function fmtUptime(sec) {
  sec = Math.floor(sec || 0);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(d + 'j');
  if (h || d) parts.push(h + 'h');
  parts.push(m + 'm');
  return parts.join(' ');
}

export function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}
