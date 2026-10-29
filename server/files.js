'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { execFile } = require('child_process');

const { config } = require('./config');
const { resolveSafe, PathError } = require('./paths');
const { audit } = require('./audit');
const elevate = require('./elevate');

// Taille (octets) d'un fichier ou dossier, via du. 0 si illisible.
function diskUsage(p) {
  return new Promise((resolve) => {
    execFile('du', ['-sb', '--', p], { timeout: 20000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err || !stdout) return resolve(0);
      const n = parseInt(String(stdout).split(/\s+/)[0], 10);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });
}

// Quota de stockage des éditeurs (soft) : refuse si la racine dépasserait la limite.
async function enforceStorage(req, addBytes) {
  const q = req.session.quota;
  if (req.session.role !== 'editeur' || !q || !q.storage) return;
  const limit = q.storage * 1048576;
  const current = await diskUsage(req.session.fileRoot);
  if (current + (addBytes || 0) > limit) {
    const e = new Error(`Quota de stockage dépassé (${q.storage} Mo).`);
    e.statusCode = 507;
    throw e;
  }
}

const READ_MAX_BYTES = 5 * 1024 * 1024;
const TMP_UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'adminpanel-upload-'));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_UPLOAD),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + '.part'),
  }),
  limits: config.MAX_UPLOAD_BYTES > 0 ? { fileSize: config.MAX_UPLOAD_BYTES } : {},
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const permErr = (e) => e && (e.code === 'EACCES' || e.code === 'EPERM');
const rootOf = (req) => req.session.fileRoot;

function needSudo() { const e = new Error('Permission refusée — droits administrateur requis.'); e.statusCode = 403; e.code = 'NEED_SUDO'; return e; }
function permDenied() { const e = new Error('Permission refusée par le système de fichiers.'); e.statusCode = 403; return e; }

// Rôles autorisés à modifier.
function canWrite(req, res, next) {
  if (req.session.role === 'admin' || req.session.role === 'editeur') return next();
  // Tentative d'écriture refusée : tracée (sécurité).
  audit(req, 'write_denied', { path: (req.body && req.body.path) || (req.query && req.query.path) || '-', route: req.path });
  return res.status(403).json({ error: 'Lecture seule : votre rôle ne permet pas cette action.' });
}

async function moveInto(src, dest) {
  try { await fsp.rename(src, dest); }
  catch (e) { if (e.code === 'EXDEV') { await fsp.copyFile(src, dest); await fsp.unlink(src); } else throw e; }
}

// Sur erreur de permission : admin -> worker root (si élevé) sinon NEED_SUDO ;
// autres rôles -> refus simple (pas d'élévation possible pour eux).
async function onPermError(req, e, payload) {
  if (!permErr(e)) throw e;
  if (req.session.role !== 'admin') throw permDenied();
  if (!elevate.elevated(req)) throw needSudo();
  return elevate.runWorker(req, payload);
}

async function withElevation(req, local, payloadFactory) {
  try { return await local(); }
  catch (e) { return onPermError(req, e, payloadFactory()); }
}

function buildFilesRouter() {
  const router = express.Router();
  const json = express.json({ limit: '20mb' });

  // --- Lister (tous rôles) ---
  router.get('/list', wrap(async (req, res) => {
    const root = rootOf(req);
    const dir = resolveSafe(root, String(req.query.path || root), { mustExist: true });
    const out = await withElevation(req,
      async () => {
        const st = await fsp.stat(dir);
        if (!st.isDirectory()) throw new PathError('Le chemin n\'est pas un dossier.');
        const dirents = await fsp.readdir(dir, { withFileTypes: true });
        const entries = await Promise.all(dirents.map(async (d) => {
          const full = path.join(dir, d.name);
          let size = 0, mtimeMs = 0, type = 'other';
          try {
            const ls = await fsp.lstat(full);
            mtimeMs = ls.mtimeMs;
            if (ls.isSymbolicLink()) type = 'symlink';
            else if (ls.isDirectory()) type = 'dir';
            else if (ls.isFile()) { type = 'file'; size = ls.size; }
          } catch (e) { /* défaut */ }
          return { name: d.name, type, size, mtimeMs };
        }));
        entries.sort((a, b) => ((a.type === 'dir') !== (b.type === 'dir')) ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
        return { ok: true, path: dir, parent: isRoot(dir, root) ? dir : path.dirname(dir), entries };
      },
      () => ({ root, op: 'list', path: dir }));
    audit(req, 'file_list', { path: dir, count: out.entries ? out.entries.length : 0 });
    res.json(out);
  }));

  // --- Lire (tous rôles) ---
  router.get('/read', wrap(async (req, res) => {
    const root = rootOf(req);
    const file = resolveSafe(root, String(req.query.path || ''), { mustExist: true });
    const out = await withElevation(req,
      async () => {
        const st = await fsp.stat(file);
        if (!st.isFile()) throw new PathError('Le chemin n\'est pas un fichier.');
        if (st.size > READ_MAX_BYTES) throw Object.assign(new Error('Fichier trop volumineux pour l\'éditeur, téléchargez-le.'), { statusCode: 413 });
        return { ok: true, path: file, size: st.size, content: await fsp.readFile(file, 'utf8') };
      },
      () => ({ root, op: 'read', path: file }));
    audit(req, 'file_read', { path: file, bytes: out.size });
    res.json(out);
  }));

  // --- Écrire (admin, éditeur) ---
  router.post('/write', canWrite, json, wrap(async (req, res) => {
    const root = rootOf(req);
    const target = resolveSafe(root, String(req.body.path || ''), { mustExist: false });
    const content = typeof req.body.content === 'string' ? req.body.content : '';
    await enforceStorage(req, Buffer.byteLength(content));
    try {
      await fsp.writeFile(target, content, 'utf8');
      audit(req, 'file_write', { path: target, bytes: Buffer.byteLength(content), elevated: false });
      return res.json({ ok: true, path: target });
    } catch (e) {
      if (!permErr(e)) throw e;
      if (req.session.role !== 'admin') throw permDenied();
      if (!elevate.elevated(req)) throw needSudo();
      const tmp = path.join(TMP_UPLOAD, 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      await fsp.writeFile(tmp, content, 'utf8');
      try {
        const r = await elevate.runWorker(req, { root, op: 'write', path: target, src: tmp });
        audit(req, 'file_write', { path: target, bytes: Buffer.byteLength(content), elevated: true });
        return res.json(r);
      } finally { fsp.unlink(tmp).catch(() => {}); }
    }
  }));

  // --- Créer un dossier (admin, éditeur) ---
  router.post('/mkdir', canWrite, json, wrap(async (req, res) => {
    const root = rootOf(req);
    const target = resolveSafe(root, String(req.body.path || ''), { mustExist: false });
    const out = await withElevation(req,
      async () => { await fsp.mkdir(target, { recursive: false }); return { ok: true, path: target }; },
      () => ({ root, op: 'mkdir', path: target }));
    audit(req, 'file_mkdir', { path: target });
    res.json(out);
  }));

  // --- Créer un fichier vide (admin, éditeur) ---
  router.post('/create', canWrite, json, wrap(async (req, res) => {
    const root = rootOf(req);
    const target = resolveSafe(root, String(req.body.path || ''), { mustExist: false });
    const out = await withElevation(req,
      async () => { const fh = await fsp.open(target, 'wx'); await fh.close(); return { ok: true, path: target }; },
      () => ({ root, op: 'create', path: target }));
    audit(req, 'file_create', { path: target });
    res.json(out);
  }));

  // --- Renommer (admin, éditeur) ---
  router.post('/rename', canWrite, json, wrap(async (req, res) => {
    const root = rootOf(req);
    const src = resolveSafe(root, String(req.body.path || ''), { mustExist: true });
    const newName = path.basename(String(req.body.newName || ''));
    if (!newName || newName === '.' || newName === '..') throw new PathError('Nouveau nom invalide.');
    const dest = resolveSafe(root, path.join(path.dirname(src), newName), { mustExist: false });
    const out = await withElevation(req,
      async () => { await fsp.rename(src, dest); return { ok: true, path: dest }; },
      () => ({ root, op: 'rename', path: src, dest }));
    audit(req, 'file_rename', { from: src, to: dest });
    res.json(out);
  }));

  // --- Déplacer (admin, éditeur) ---
  router.post('/move', canWrite, json, wrap(async (req, res) => {
    const root = rootOf(req);
    const src = resolveSafe(root, String(req.body.source || ''), { mustExist: true });
    let dest = resolveSafe(root, String(req.body.destination || ''), { mustExist: false });
    if (fs.existsSync(dest) && (await fsp.stat(dest)).isDirectory()) {
      dest = resolveSafe(root, path.join(dest, path.basename(src)), { mustExist: false });
    }
    const out = await withElevation(req,
      async () => { await moveInto(src, dest); return { ok: true, path: dest }; },
      () => ({ root, op: 'move', src, dest }));
    audit(req, 'file_move', { from: src, to: dest });
    res.json(out);
  }));

  // --- Copier (admin, éditeur) ---
  router.post('/copy', canWrite, json, wrap(async (req, res) => {
    const root = rootOf(req);
    const src = resolveSafe(root, String(req.body.source || ''), { mustExist: true });
    let dest = resolveSafe(root, String(req.body.destination || ''), { mustExist: false });
    if (fs.existsSync(dest) && (await fsp.stat(dest)).isDirectory()) {
      dest = resolveSafe(root, path.join(dest, path.basename(src)), { mustExist: false });
    }
    await enforceStorage(req, await diskUsage(src));
    const out = await withElevation(req,
      async () => { await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false }); return { ok: true, path: dest }; },
      () => ({ root, op: 'copy', src, dest }));
    audit(req, 'file_copy', { from: src, to: dest });
    res.json(out);
  }));

  // --- Supprimer (admin, éditeur) ---
  router.post('/delete', canWrite, json, wrap(async (req, res) => {
    const root = rootOf(req);
    const target = resolveSafe(root, String(req.body.path || ''), { mustExist: true });
    if (target === root) throw new PathError('Suppression de la racine interdite.');
    const out = await withElevation(req,
      async () => { await fsp.rm(target, { recursive: true, force: false }); return { ok: true, path: target }; },
      () => ({ root, op: 'delete', path: target }));
    audit(req, 'file_delete', { path: target });
    res.json(out);
  }));

  // --- Upload (admin, éditeur) ---
  router.post('/upload', canWrite, upload.array('files'), wrap(async (req, res) => {
    const root = rootOf(req);
    let targetDir;
    try {
      targetDir = resolveSafe(root, String(req.body.path || ''), { mustExist: true });
      const st = await fsp.stat(targetDir);
      if (!st.isDirectory()) throw new PathError('La cible d\'upload n\'est pas un dossier.');
    } catch (e) {
      await Promise.all((req.files || []).map((f) => fsp.unlink(f.path).catch(() => {})));
      throw e;
    }

    const incoming = (req.files || []).reduce((a, f) => a + (f.size || 0), 0);
    try { await enforceStorage(req, incoming); }
    catch (e) { await cleanup(req.files); throw e; }

    let writable = true;
    try { await fsp.access(targetDir, fs.constants.W_OK); }
    catch (e) { if (permErr(e)) writable = false; else throw e; }

    if (!writable) {
      if (req.session.role !== 'admin') { await cleanup(req.files); throw permDenied(); }
      if (!elevate.elevated(req)) { await cleanup(req.files); throw needSudo(); }
      const items = (req.files || []).map((f) => ({ src: f.path, dest: resolveSafe(root, path.join(targetDir, path.basename(f.originalname)), { mustExist: false }) }));
      const r = await elevate.runWorker(req, { root, op: 'upload', items });
      (req.files || []).forEach((f) => audit(req, 'file_upload', { path: path.join(targetDir, path.basename(f.originalname)), bytes: f.size, elevated: true }));
      await cleanup(req.files);
      return res.json(r);
    }

    const saved = [];
    for (const f of req.files || []) {
      const dest = resolveSafe(root, path.join(targetDir, path.basename(f.originalname)), { mustExist: false });
      await moveInto(f.path, dest);
      saved.push(path.basename(dest));
      audit(req, 'file_upload', { path: dest, bytes: f.size, elevated: false });
    }
    res.json({ ok: true, saved });
  }));

  // --- Télécharger (tous rôles) ---
  router.get('/download', wrap(async (req, res) => {
    const root = rootOf(req);
    const target = resolveSafe(root, String(req.query.path || ''), { mustExist: true });
    let st, readable = true;
    try { st = await fsp.stat(target); if (!st.isDirectory()) await fsp.access(target, fs.constants.R_OK); }
    catch (e) { if (!permErr(e)) throw e; readable = false; }

    if (readable) {
      audit(req, 'file_download', { path: target, dir: st.isDirectory(), elevated: false });
      if (st.isDirectory()) {
        res.attachment((path.basename(target) || 'archive') + '.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => { if (!res.headersSent) res.status(500); res.end(); process.stderr.write('[archive] ' + err.message + '\n'); });
        archive.pipe(res);
        archive.directory(target, false);
        await archive.finalize();
      } else {
        res.download(target, path.basename(target));
      }
      return;
    }
    if (req.session.role !== 'admin') throw permDenied();
    if (!elevate.elevated(req)) throw needSudo();
    const tmpOut = path.join(TMP_UPLOAD, 'dl-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    const r = await elevate.runWorker(req, { root, op: 'download', path: target, out: tmpOut });
    if (r.isDir) throw Object.assign(new Error('Téléchargement zip d\'un dossier protégé non pris en charge.'), { statusCode: 400 });
    audit(req, 'file_download', { path: target, dir: false, elevated: true });
    res.download(r.out, path.basename(target), () => { fsp.unlink(tmpOut).catch(() => {}); });
  }));

  return router;
}

function isRoot(dir, root) { return dir === root; }
function cleanup(files) { return Promise.all((files || []).map((f) => fsp.unlink(f.path).catch(() => {}))); }

module.exports = { buildFilesRouter, TMP_UPLOAD };
