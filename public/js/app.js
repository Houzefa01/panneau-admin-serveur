'use strict';

import { logout, bindSudoUI, refreshSudoState, apiGet } from './api.js';
import { applyIcons, enhancePasswords } from './ui.js';
import { startStats, stopStats } from './stats.js';
import { initTerminal, fitTerminal } from './terminal.js';
import { initFiles } from './files.js';
import { initServices } from './services.js';
import { initUsers } from './users.js';
import { initProfile } from './profile.js';
import { initLogs, stopLogs } from './logs.js';

const ROLE_LABEL = { admin: 'administrateur', editeur: 'éditeur', lecteur: 'lecteur' };
const views = ['dashboard', 'terminal', 'files', 'services', 'users', 'logs', 'profile'];
let current = null;
let me = null;
const loaded = new Set();

function applyRole() {
  // Masque les onglets selon le rôle (le serveur reste l'autorité).
  document.querySelectorAll('#nav button[data-role]').forEach((b) => {
    const need = b.dataset.role;
    let visible = true;
    if (need === 'admin') visible = me.role === 'admin';
    if (need === 'terminal') visible = me.role !== 'lecteur';
    b.style.display = visible ? '' : 'none';
  });
  // Le lecteur ne voit pas l'onglet Vitals (aucune statistique).
  const dash = document.querySelector('#nav button[data-view="dashboard"]');
  if (dash) dash.style.display = me.role === 'lecteur' ? 'none' : '';
  document.getElementById('brand-sub').textContent = `${me.username} · ${ROLE_LABEL[me.role] || me.role}`;
  // L'indicateur d'élévation (sudo) n'a de sens que pour l'admin.
  const sudoBtn = document.getElementById('sudo-state');
  if (sudoBtn) sudoBtn.style.display = me.role === 'admin' ? '' : 'none';
}

function show(view) {
  if (!views.includes(view)) view = 'dashboard';
  // Redirige si l'onglet est interdit au rôle.
  if (view === 'services' || view === 'users' || view === 'logs') { if (me.role !== 'admin') view = me.role === 'lecteur' ? 'files' : 'dashboard'; }
  if ((view === 'terminal' || view === 'dashboard') && me.role === 'lecteur') view = 'files';
  if (view === current) return;

  if (current === 'dashboard') stopStats();
  if (current === 'logs') stopLogs();
  current = view;

  views.forEach((v) => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === view);
  });
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  if (view === 'dashboard') startStats(me);
  if (view === 'terminal') { initTerminal(); requestAnimationFrame(fitTerminal); }
  if (view === 'files' && !loaded.has('files')) { initFiles(me); loaded.add('files'); }
  if (view === 'services') initServices();
  if (view === 'users') initUsers();
  if (view === 'logs') initLogs();
  if (view === 'profile') initProfile(me);

  location.hash = view;
}

async function init() {
  try {
    me = await apiGet('/api/auth/me');
  } catch (e) {
    window.location.href = '/login';
    return;
  }
  applyRole();
  applyIcons(document);        // remplit les <span data-icon> par les SVG
  enhancePasswords(document);  // ajoute l'œil afficher/masquer aux champs mot de passe

  document.getElementById('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (btn) show(btn.dataset.view);
  });
  document.getElementById('logout-btn').addEventListener('click', logout);
  if (me.role === 'admin') { bindSudoUI(); refreshSudoState(); }

  window.addEventListener('hashchange', () => show(location.hash.replace('#', '')));

  const initial = location.hash.replace('#', '') || (me.role === 'lecteur' ? 'files' : 'dashboard');
  current = null;
  show(initial);
}

init();
