'use strict';

import { apiGet, apiPost, toast } from './api.js';

let all = [];
let initialized = false;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badge(active) {
  if (active === 'active') return '<span class="badge active">active</span>';
  if (active === 'failed') return '<span class="badge failed">failed</span>';
  return `<span class="badge inactive">${esc(active)}</span>`;
}

function render() {
  const filter = document.getElementById('svc-filter').value.toLowerCase();
  const tbody = document.getElementById('svc-tbody');
  const rows = all.filter((s) => !filter || s.unit.toLowerCase().includes(filter) ||
    (s.description || '').toLowerCase().includes(filter));
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">Aucun service.</td></tr>'; return; }
  tbody.innerHTML = rows.map((s) => {
    const name = esc(s.unit);
    return `<tr>
      <td class="unit">${name}</td>
      <td>${badge(s.active)}</td>
      <td class="muted">${esc(s.sub)}</td>
      <td class="muted">${esc(s.description || '')}</td>
      <td><div class="svc-actions">
        <button data-act="start" data-unit="${name}">Start</button>
        <button data-act="stop" data-unit="${name}">Stop</button>
        <button data-act="restart" data-unit="${name}">Restart</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function refresh() {
  const tbody = document.getElementById('svc-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="loading">Chargement…</td></tr>';
  try {
    const data = await apiGet('/api/services');
    all = data.services || [];
    render();
  } catch (e) {
    if (e.message !== 'Session expirée') tbody.innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)}</td></tr>`;
  }
}

async function action(act, unit) {
  if (!window.confirm(`${act} ${unit} ?`)) return;
  try {
    await apiPost('/api/services/' + act, { name: unit });
    toast(`${unit} : ${act} OK.`, 'ok');
    setTimeout(refresh, 600);
  } catch (e) { toast(`${unit} : ${e.message}`, 'error'); }
}

export function initServices() {
  if (!initialized) {
    initialized = true;
    document.getElementById('svc-refresh').addEventListener('click', refresh);
    document.getElementById('svc-filter').addEventListener('input', render);
    document.getElementById('svc-tbody').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (btn) action(btn.dataset.act, btn.dataset.unit);
    });
    document.getElementById('svc-reboot').addEventListener('click', async () => {
      if (!window.confirm('Redémarrer toute la machine ? La connexion sera perdue.')) return;
      try { await apiPost('/api/system/reboot', {}); toast('Redémarrage déclenché…', 'ok'); }
      catch (e) { toast('Reboot : ' + e.message, 'error'); }
    });
  }
  refresh();
}
