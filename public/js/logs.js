'use strict';

import { apiGet, toast } from './api.js';

let bound = false;
let timer = null;
let knownUsers = [];

const LABEL = {
  login_success: 'Connexion', login_failure: 'Échec de connexion', login_rate_limited: 'Connexion bloquée',
  logout: 'Déconnexion', file_list: 'Navigation', file_read: 'Lecture fichier', file_write: 'Écriture',
  file_create: 'Création fichier', file_mkdir: 'Création dossier', file_rename: 'Renommage', file_move: 'Déplacement',
  file_copy: 'Copie', file_delete: 'Suppression', file_upload: 'Upload', file_download: 'Téléchargement',
  write_denied: 'Écriture refusée',
  terminal_open: 'Terminal ouvert', terminal_close: 'Terminal fermé', terminal_denied: 'Terminal refusé',
  service_action: 'Action service', system_reboot: 'Redémarrage machine', elevate_success: 'Élévation accordée',
  elevate_failure: 'Élévation refusée', elevate_lock: 'Privilèges verrouillés', user_create: 'Compte créé',
  user_update: 'Compte modifié', user_delete: 'Compte supprimé', password_change: 'Mot de passe changé',
  server_start: 'Serveur démarré', server_stop: 'Serveur arrêté',
  access_unauth: 'Accès non authentifié', access_forbidden: 'Accès interdit',
  probe_notfound: 'Sonde (404)', rate_limited: 'Débit bloqué',
  request_rejected: 'Requête rejetée', server_error: 'Erreur serveur',
  ip_banned: 'IP bannie', csrf_denied: 'CSRF refusé',
};
const RED = new Set(['login_failure', 'login_rate_limited', 'terminal_denied', 'elevate_failure', 'file_delete', 'system_reboot', 'user_delete', 'write_denied',
  'access_unauth', 'access_forbidden', 'probe_notfound', 'rate_limited', 'request_rejected', 'server_error', 'ip_banned', 'csrf_denied']);
const GREEN = new Set(['login_success', 'elevate_success', 'user_create']);
const AMBER = new Set(['file_write', 'file_upload', 'file_rename', 'file_move', 'file_copy', 'file_mkdir', 'file_create', 'service_action', 'user_update', 'password_change']);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function badge(ev) {
  const cls = RED.has(ev) ? 'failed' : GREEN.has(ev) ? 'active' : AMBER.has(ev) ? 'warn' : 'inactive';
  return `<span class="badge ${cls}">${esc(LABEL[ev] || ev)}</span>`;
}
function details(e) {
  const skip = new Set(['ts', 'event', 'user', 'role', 'ip']);
  const parts = [];
  if (e.from && e.to) parts.push(`${e.from} → ${e.to}`);
  for (const k of Object.keys(e)) {
    if (skip.has(k) || k === 'from' || k === 'to') continue;
    let v = e[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') v = JSON.stringify(v);
    parts.push(`${k}=${v}`);
  }
  return parts.join(' · ');
}

function buildQuery() {
  const u = document.getElementById('log-user').value;
  const ev = document.getElementById('log-event').value;
  const q = document.getElementById('log-q').value.trim();
  const p = new URLSearchParams({ limit: '50000' }); // tout afficher
  if (u && u !== '*') p.set('user', u);
  if (ev && ev !== '*') p.set('event', ev);
  if (q) p.set('q', q);
  return p.toString();
}

function fillSelect(sel, values, current, allLabel) {
  const keep = current && current !== '*' ? current : '*';
  sel.innerHTML = `<option value="*">${allLabel}</option>` +
    values.map((v) => `<option value="${esc(v)}">${esc(LABEL[v] || v)}</option>`).join('');
  sel.value = keep;
}

async function refresh() {
  const tbody = document.getElementById('log-tbody');
  try {
    const data = await apiGet('/api/logs?' + buildQuery());
    // Remplit les filtres (une fois les valeurs connues).
    const evSel = document.getElementById('log-event');
    if (evSel.options.length <= 1 && data.events) fillSelect(evSel, data.events, evSel.value, 'Tous les événements');
    const uSel = document.getElementById('log-user');
    const merged = [...new Set([...knownUsers, ...(data.users || [])])].sort();
    if (merged.length !== knownUsers.length) { knownUsers = merged; fillSelect(uSel, knownUsers, uSel.value, 'Tous les utilisateurs'); }

    if (!data.entries.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">Aucune activité.</td></tr>'; return; }
    tbody.innerHTML = data.entries.map((e) => `<tr>
      <td class="mtime">${new Date(e.ts).toLocaleString('fr-FR')}</td>
      <td class="unit">${esc(e.user)}</td>
      <td class="muted">${esc(e.role || '-')}</td>
      <td>${badge(e.event)}</td>
      <td class="muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(details(e))}">${esc(details(e))}</td>
      <td class="muted">${esc(e.ip)}</td>
    </tr>`).join('');
  } catch (e) {
    if (e.message !== 'Session expirée') tbody.innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`;
  }
}

function setAuto(on) {
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(refresh, 5000);
}

export function initLogs() {
  if (!bound) {
    bound = true;
    document.getElementById('log-refresh').addEventListener('click', refresh);
    document.getElementById('log-user').addEventListener('change', refresh);
    document.getElementById('log-event').addEventListener('change', refresh);
    let t;
    document.getElementById('log-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 300); });
    document.getElementById('log-auto').addEventListener('change', (e) => setAuto(e.target.checked));
    document.getElementById('log-raw').addEventListener('click', () => {
      const a = document.createElement('a'); a.href = '/api/logs/raw'; a.download = 'audit.log';
      document.body.appendChild(a); a.click(); a.remove();
    });
  }
  refresh();
}

export function stopLogs() { setAuto(false); document.getElementById('log-auto').checked = false; }
