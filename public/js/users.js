'use strict';

import { apiGet, apiPost, toast, fmtBytes } from './api.js';

let cache = [];
let meId = null;
let limits = { cpuMax: 1, memMax: 1024 };
let allocated = { cpu: 0, memory: 0, storage: 0 };
let bound = false;

const ROLE_BADGE = {
  admin: '<span class="badge failed">admin</span>',
  editeur: '<span class="badge active">éditeur</span>',
  lecteur: '<span class="badge inactive">lecteur</span>',
};
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  const tbody = document.getElementById('u-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading">Chargement…</td></tr>';
  try {
    const data = await apiGet('/api/users');
    cache = data.users || [];
    meId = data.me;
    if (data.limits) limits = data.limits;
    if (data.allocated) allocated = data.allocated;
    render();
  } catch (e) {
    if (e.message !== 'Session expirée') tbody.innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`;
  }
}

function render() {
  const tbody = document.getElementById('u-tbody');
  if (!cache.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">Aucun utilisateur.</td></tr>'; return; }
  tbody.innerHTML = cache.map((u) => {
    const quota = u.quota ? `${u.quota.cpu} CPU · ${u.quota.memory} Mo · ${u.quota.storage} Mo` : '—';
    const isMe = u.id === meId;
    return `<tr>
      <td class="unit">${esc(u.username)}${isMe ? ' <span class="muted">(vous)</span>' : ''}</td>
      <td>${ROLE_BADGE[u.role] || esc(u.role)}</td>
      <td class="muted">${esc(u.root)}</td>
      <td class="muted">${esc(quota)}</td>
      <td class="muted">${esc(u.createdBy)}</td>
      <td><div class="svc-actions">
        <button data-act="edit" data-id="${esc(u.id)}">Modifier</button>
        <button data-act="del" data-id="${esc(u.id)}" class="danger"${isMe ? ' disabled' : ''}>Supprimer</button>
      </div></td>
    </tr>`;
  }).join('');
}

// ---------- Modal ----------
function syncRoleFields() {
  const role = document.getElementById('user-role').value;
  document.getElementById('user-root-wrap').style.display = role === 'admin' ? 'none' : '';
  document.getElementById('user-quota-wrap').style.display = role === 'editeur' ? '' : 'none';
  // Capacité restante = total serveur − déjà alloué aux autres éditeurs.
  const editId = document.getElementById('user-id').value;
  const self = editId ? cache.find((u) => u.id === editId) : null;
  const usedCpu = allocated.cpu - (self && self.quota ? self.quota.cpu : 0);
  const usedMem = allocated.memory - (self && self.quota ? self.quota.memory : 0);
  const remCpu = Math.max(0, limits.cpuMax - usedCpu);
  const remMem = Math.max(0, limits.memMax - usedMem);
  document.getElementById('user-quota-hint').innerHTML =
    `disponible : <b>${remCpu}</b> cœur(s) · <b>${remMem}</b> Mo RAM ` +
    `(serveur : ${limits.cpuMax} cœurs / ${fmtBytes(limits.memMax * 1048576)})`;
}

function openModal(user) {
  document.getElementById('user-id').value = user ? user.id : '';
  document.getElementById('user-modal-title').textContent = user ? 'Modifier l\'utilisateur' : 'Nouvel utilisateur';
  const uname = document.getElementById('user-username');
  uname.value = user ? user.username : '';
  uname.disabled = !!user;
  document.getElementById('user-password').value = '';
  document.getElementById('user-pw-hint').textContent = user ? '(laisser vide pour ne pas changer)' : '';
  document.getElementById('user-role').value = user ? user.role : 'lecteur';
  document.getElementById('user-root').value = user ? user.root : '';
  document.getElementById('user-cpu').value = user && user.quota ? user.quota.cpu : 1;
  document.getElementById('user-mem').value = user && user.quota ? user.quota.memory : 512;
  document.getElementById('user-sto').value = user && user.quota ? user.quota.storage : 1024;
  document.getElementById('user-err').textContent = '';
  syncRoleFields();
  document.getElementById('user-modal').classList.add('open');
}
function closeModal() { document.getElementById('user-modal').classList.remove('open'); }

async function save() {
  const id = document.getElementById('user-id').value;
  const role = document.getElementById('user-role').value;
  const body = {
    role,
    root: role === 'admin' ? undefined : document.getElementById('user-root').value.trim(),
  };
  const pw = document.getElementById('user-password').value;
  if (pw) body.password = pw;
  if (!id) body.username = document.getElementById('user-username').value.trim();
  if (role === 'editeur') {
    body.quota = {
      cpu: Number(document.getElementById('user-cpu').value),
      memory: Number(document.getElementById('user-mem').value),
      storage: Number(document.getElementById('user-sto').value),
    };
  }
  const err = document.getElementById('user-err');
  err.textContent = '';
  try {
    if (id) await apiPost('/api/users/' + id, body, 'PATCH');
    else {
      if (!body.password) throw new Error('Mot de passe requis.');
      await apiPost('/api/users', body);
    }
    toast(id ? 'Utilisateur mis à jour.' : 'Utilisateur créé.', 'ok');
    closeModal();
    refresh();
  } catch (e) { err.textContent = e.message; }
}

export function initUsers() {
  if (!bound) {
    bound = true;
    document.getElementById('u-refresh').addEventListener('click', refresh);
    document.getElementById('u-add').addEventListener('click', () => openModal(null));
    document.getElementById('user-role').addEventListener('change', syncRoleFields);
    document.getElementById('user-close').addEventListener('click', closeModal);
    document.getElementById('user-cancel').addEventListener('click', closeModal);
    document.getElementById('user-save').addEventListener('click', save);
    document.getElementById('user-modal').addEventListener('click', (e) => { if (e.target.id === 'user-modal') closeModal(); });
    document.getElementById('u-tbody').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const user = cache.find((u) => u.id === btn.dataset.id);
      if (btn.dataset.act === 'edit') openModal(user);
      else if (btn.dataset.act === 'del') {
        if (!window.confirm(`Supprimer l'utilisateur « ${user.username} » ?`)) return;
        try { await apiPost('/api/users/' + user.id, {}, 'DELETE'); toast('Utilisateur supprimé.', 'ok'); refresh(); }
        catch (err) { toast(err.message, 'error'); }
      }
    });
  }
  refresh();
}
