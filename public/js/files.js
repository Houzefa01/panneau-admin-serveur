'use strict';

import { apiGet, apiPost, fetchWithSudo, toast, fmtBytes, fmtDate } from './api.js';
import { icon } from './ui.js';

let cwd = '/';
let root = '/';
let role = 'admin';
let clipboard = null; // { mode:'copy'|'cut', path }
let selected = null;
let initialized = false;

const canWrite = () => role === 'admin' || role === 'editeur';

const ICON = { dir: icon('folder'), file: icon('file'), symlink: icon('link'), other: icon('file') };
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function join(dir, name) { return dir.endsWith('/') ? dir + name : dir + '/' + name; }

async function load(path) {
  try {
    const data = await apiGet('/api/files/list?path=' + encodeURIComponent(path));
    cwd = data.path;
    selected = null;
    document.getElementById('f-path').value = cwd;
    renderRows(data.entries);
  } catch (e) {
    if (e.message !== 'Session expirée') toast(e.message, 'error');
  }
}

function renderRows(entries) {
  const tbody = document.getElementById('f-tbody');
  const empty = document.getElementById('f-empty');
  tbody.innerHTML = '';
  empty.hidden = entries.length > 0;

  for (const e of entries) {
    const full = join(cwd, e.name);
    const tr = document.createElement('tr');
    tr.className = 'row';
    tr.dataset.path = full;
    tr.dataset.type = e.type;
    tr.innerHTML =
      `<td class="name"><span class="ico">${ICON[e.type] || ICON.other}</span><span>${esc(e.name)}</span></td>` +
      `<td class="size">${e.type === 'dir' ? '' : fmtBytes(e.size)}</td>` +
      `<td class="mtime">${fmtDate(e.mtimeMs)}</td>` +
      `<td><div class="svc-actions">` +
        `<button data-act="download" title="Télécharger">${icon('download')}</button>` +
        (canWrite() ?
          `<button data-act="rename" title="Renommer">${icon('pencil')}</button>` +
          `<button data-act="copy" title="Copier">${icon('copy')}</button>` +
          `<button data-act="cut" title="Couper">${icon('scissors')}</button>` +
          `<button data-act="delete" title="Supprimer" class="danger">${icon('trash')}</button>` : '') +
      `</div></td>`;
    tbody.appendChild(tr);
  }
  updateClipboardInfo();
}

function updateClipboardInfo() {
  const info = document.getElementById('f-clip');
  if (clipboard) {
    const label = clipboard.mode === 'cut' ? 'À déplacer' : 'À copier';
    info.innerHTML = `${label} : ${esc(clipboard.path.split('/').pop())} — <button id="f-paste">Coller ici</button> <button id="f-clear">✕</button>`;
    document.getElementById('f-paste').addEventListener('click', paste);
    document.getElementById('f-clear').addEventListener('click', () => { clipboard = null; updateClipboardInfo(); });
  } else {
    info.textContent = '';
  }
}

async function paste(dest) {
  if (!clipboard) return;
  try {
    const ep = clipboard.mode === 'cut' ? 'move' : 'copy';
    await apiPost('/api/files/' + ep, { source: clipboard.path, destination: dest || cwd });
    toast(clipboard.mode === 'cut' ? 'Déplacé.' : 'Copié.', 'ok');
    clipboard = null;
    load(cwd);
  } catch (e) { toast(e.message, 'error'); }
}

async function newFolder(dir) {
  const name = window.prompt('Nom du dossier :');
  if (!name) return;
  try { await apiPost('/api/files/mkdir', { path: join(dir || cwd, name) }); toast('Dossier créé.', 'ok'); load(cwd); }
  catch (e) { toast(e.message, 'error'); }
}

async function newFile(dir) {
  const name = window.prompt('Nom du fichier :');
  if (!name) return;
  try { await apiPost('/api/files/create', { path: join(dir || cwd, name) }); toast('Fichier créé.', 'ok'); load(cwd); }
  catch (e) { toast(e.message, 'error'); }
}

// ---------- Menu contextuel (clic droit) ----------
function hideCtx() { const m = document.getElementById('ctxmenu'); m.hidden = true; m.innerHTML = ''; }

function showCtx(x, y, items) {
  const m = document.getElementById('ctxmenu');
  m.innerHTML = '';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); continue; }
    const el = document.createElement('div');
    el.className = 'item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    el.innerHTML = `<span class="ic">${it.ic || ''}</span><span>${esc(it.label)}</span>`;
    if (!it.disabled) el.addEventListener('click', () => { hideCtx(); it.action(); });
    m.appendChild(el);
  }
  m.hidden = false;
  // Repositionne dans la fenêtre.
  const r = m.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 8);
  const py = Math.min(y, window.innerHeight - r.height - 8);
  m.style.left = px + 'px';
  m.style.top = py + 'px';
}

function ctxItemsFor(tr) {
  const items = [];
  const w = canWrite();
  if (tr) {
    const path = tr.dataset.path;
    const type = tr.dataset.type;
    if (type === 'dir') {
      items.push({ label: 'Ouvrir', ic: icon('folder-open'), action: () => load(path) });
    } else if (type === 'file') {
      items.push({ label: 'Ouvrir', ic: icon('pencil'), action: () => openEditor(path) });
    }
    items.push({ label: 'Télécharger', ic: icon('download'), action: () => download(path) });
    if (w) {
      items.push({ sep: true });
      items.push({ label: 'Renommer', ic: icon('pencil'), action: () => rowAction('rename', path, type) });
      items.push({ label: 'Copier', ic: icon('copy'), action: () => rowAction('copy', path, type) });
      items.push({ label: 'Couper', ic: icon('scissors'), action: () => rowAction('cut', path, type) });
      if (clipboard && type === 'dir') items.push({ label: 'Coller dans ce dossier', ic: icon('paste'), action: () => paste(path) });
      items.push({ sep: true });
      items.push({ label: 'Supprimer', ic: icon('trash'), danger: true, action: () => rowAction('delete', path, type) });
    }
  } else {
    if (w) {
      items.push({ label: 'Nouveau dossier', ic: icon('folder-plus'), action: () => newFolder() });
      items.push({ label: 'Nouveau fichier', ic: icon('file-plus'), action: () => newFile() });
      if (clipboard) items.push({ label: 'Coller ici', ic: icon('paste'), action: () => paste(cwd) });
      items.push({ sep: true });
    }
    items.push({ label: 'Actualiser', ic: icon('refresh'), action: () => load(cwd) });
  }
  return items;
}

function download(path) {
  const a = document.createElement('a');
  a.href = '/api/files/download?path=' + encodeURIComponent(path);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// --- Éditeur multi-fichiers (onglets) ---
const docs = new Map(); // path -> { content, dirty, ro }
let activeDoc = null;
const taEl = () => document.getElementById('editor-text');

async function openEditor(path) {
  if (docs.has(path)) { showEditor(); setActiveDoc(path); return; }
  try {
    const data = await apiGet('/api/files/read?path=' + encodeURIComponent(path));
    docs.set(path, { content: data.content, dirty: false, ro: !canWrite() });
    showEditor();
    setActiveDoc(path);
  } catch (e) { toast(e.message, 'error'); }
}

function showEditor() { document.getElementById('editor-modal').classList.add('open'); }
function hideEditor() { document.getElementById('editor-modal').classList.remove('open'); } // masque sans fermer les fichiers
function stashActive() { if (activeDoc && docs.has(activeDoc)) docs.get(activeDoc).content = taEl().value; }

function setActiveDoc(path) {
  stashActive();
  activeDoc = path;
  const d = docs.get(path);
  const t = taEl();
  t.value = d.content;
  t.readOnly = d.ro;
  t.dataset.path = path;
  document.getElementById('editor-save').style.display = d.ro ? 'none' : '';
  document.getElementById('editor-status').textContent = path + (d.ro ? '  (lecture seule)' : '');
  renderEditorTabs();
  t.focus();
}

function renderEditorTabs() {
  const bar = document.getElementById('editor-tabs');
  bar.innerHTML = '';
  for (const [p, d] of docs) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (p === activeDoc ? ' active' : '');
    tab.dataset.path = p;
    tab.innerHTML = `<span class="lbl">${esc(p.split('/').pop())}</span>` +
      (d.dirty ? '<span class="dirty">•</span>' : '') + '<span class="x" title="Fermer">×</span>';
    bar.appendChild(tab);
  }
}

function closeDoc(path) {
  const d = docs.get(path);
  if (!d) return;
  if (d.dirty && !window.confirm(`« ${path.split('/').pop()} » a des modifications non enregistrées. Fermer quand même ?`)) return;
  docs.delete(path);
  if (activeDoc === path) {
    activeDoc = null;
    const next = [...docs.keys()].pop();
    if (next) setActiveDoc(next); else hideEditor();
  } else renderEditorTabs();
}

async function saveActive() {
  if (!activeDoc) return;
  const d = docs.get(activeDoc);
  if (d.ro) return;
  try {
    await apiPost('/api/files/write', { path: activeDoc, content: taEl().value });
    d.content = taEl().value; d.dirty = false;
    toast('Enregistré.', 'ok');
    renderEditorTabs();
    load(cwd);
  } catch (e) { toast(e.message, 'error'); }
}

async function rowAction(act, path, type) {
  if (act === 'download') return download(path);
  if (act === 'copy') { clipboard = { mode: 'copy', path }; updateClipboardInfo(); return; }
  if (act === 'cut') { clipboard = { mode: 'cut', path }; updateClipboardInfo(); return; }
  if (act === 'rename') {
    const cur = path.split('/').pop();
    const name = window.prompt('Nouveau nom :', cur);
    if (!name || name === cur) return;
    try { await apiPost('/api/files/rename', { path, newName: name }); toast('Renommé.', 'ok'); load(cwd); }
    catch (e) { toast(e.message, 'error'); }
    return;
  }
  if (act === 'delete') {
    if (!window.confirm(`Supprimer définitivement « ${path.split('/').pop()} » ?`)) return;
    try { await apiPost('/api/files/delete', { path }); toast('Supprimé.', 'ok'); load(cwd); }
    catch (e) { toast(e.message, 'error'); }
  }
}

async function uploadFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const fd = new FormData();
  fd.append('path', cwd);
  for (const f of fileList) fd.append('files', f, f.name);
  try {
    const res = await fetchWithSudo('/api/files/upload', { method: 'POST', body: fd });
    if (res.status === 401) { window.location.href = '/login'; return; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec upload');
    toast(`${data.saved.length} fichier(s) envoyé(s).`, 'ok');
    load(cwd);
  } catch (e) { toast(e.message, 'error'); }
}

function bind() {
  document.getElementById('f-go').addEventListener('click', () => load(document.getElementById('f-path').value));
  document.getElementById('f-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(e.target.value); });
  document.getElementById('f-refresh').addEventListener('click', () => load(cwd));
  document.getElementById('f-up').addEventListener('click', () => {
    if (cwd === root) return; // ne pas remonter au-dessus de la racine autorisée
    const parent = cwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
    load(parent.length >= root.length ? parent : root);
  });
  document.getElementById('f-mkdir').addEventListener('click', () => newFolder());
  document.getElementById('f-newfile').addEventListener('click', () => newFile());

  // Upload
  const fileInput = document.getElementById('f-fileinput');
  document.getElementById('f-upload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });

  // Table interactions (délégation)
  document.getElementById('f-tbody').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    const tr = ev.target.closest('tr.row');
    if (!tr) return;
    if (btn) { rowAction(btn.dataset.act, tr.dataset.path, tr.dataset.type); return; }
    // clic sur la ligne
    document.querySelectorAll('#f-tbody tr.selected').forEach((r) => r.classList.remove('selected'));
    tr.classList.add('selected');
    selected = tr.dataset.path;
    if (tr.dataset.type === 'dir') load(tr.dataset.path);
    else if (tr.dataset.type === 'file') openEditor(tr.dataset.path);
  });

  // Menu contextuel (clic droit) sur le navigateur de fichiers
  document.getElementById('f-drop').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const tr = e.target.closest('tr.row');
    if (tr) {
      document.querySelectorAll('#f-tbody tr.selected').forEach((r) => r.classList.remove('selected'));
      tr.classList.add('selected');
      selected = tr.dataset.path;
    }
    showCtx(e.clientX, e.clientY, ctxItemsFor(tr));
  });
  window.addEventListener('click', hideCtx);
  window.addEventListener('scroll', hideCtx, true);
  window.addEventListener('resize', hideCtx);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtx(); });

  // Drag & drop
  const dz = document.getElementById('f-drop');
  ['dragenter', 'dragover'].forEach((evt) => dz.addEventListener(evt, (e) => {
    e.preventDefault(); dz.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((evt) => dz.addEventListener(evt, (e) => {
    e.preventDefault(); if (evt === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files); });

  // Éditeur multi-onglets
  const ta = taEl();
  ta.addEventListener('input', () => {
    if (activeDoc && docs.has(activeDoc) && !docs.get(activeDoc).dirty) { docs.get(activeDoc).dirty = true; renderEditorTabs(); }
  });
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveActive(); } });
  document.getElementById('editor-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab'); if (!tab) return;
    if (e.target.classList.contains('x')) closeDoc(tab.dataset.path);
    else setActiveDoc(tab.dataset.path);
  });
  document.getElementById('editor-save').addEventListener('click', saveActive);
  document.getElementById('editor-close').addEventListener('click', hideEditor); // masque, garde les onglets
  document.getElementById('editor-modal').addEventListener('click', (e) => { if (e.target.id === 'editor-modal') hideEditor(); });
}

function applyRoleUI() {
  // Lecteur : interface en lecture seule (le serveur reste l'autorité).
  const writeBtns = ['f-mkdir', 'f-newfile', 'f-upload'];
  writeBtns.forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = canWrite() ? '' : 'none'; });
}

export function initFiles(me) {
  if (initialized) return;
  initialized = true;
  role = (me && me.role) || 'admin';
  root = (me && me.fileRoot) || '/';
  cwd = root;
  bind();
  applyRoleUI();
  load(cwd);
}
