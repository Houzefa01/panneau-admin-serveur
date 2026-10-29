'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const express = require('express');
const { audit } = require('./audit');

const WORKER = path.join(__dirname, 'fs-worker.js');
const CRED_TTL_MS = parseInt(process.env.ELEVATE_TTL_MS || String(15 * 60 * 1000), 10);
// Marqueurs de délimitation de sortie : alphanumériques uniquement (compatibles
// shellQuote) et improbables dans une sortie réelle.
const S = 'ADMSTARTx7Q3K';
const E = 'ADMENDx7Q3K';

// --- État d'élévation, stocké côté serveur (MemoryStore), jamais dans le cookie ---
function elevated(req) {
  const s = req.session;
  return !!(s && s.suPass && s.suAt && Date.now() - s.suAt < CRED_TTL_MS);
}
function setCreds(req, user, pass) { req.session.suUser = user; req.session.suPass = pass; req.session.suAt = Date.now(); }
function clearCreds(req) { if (req.session) { delete req.session.suUser; delete req.session.suPass; delete req.session.suAt; } }

// Chaque composant de commande est validé sur une liste blanche de caractères
// PUIS quoté : aucune donnée utilisateur ne transite ici (les chemins client
// passent par un fichier JSON), donc ces composants sont toujours sûrs.
function shellQuote(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9@%_+=:,./-]+$/.test(s)) {
    throw new Error('Composant de commande non sûr : ' + s);
  }
  return "'" + s + "'";
}

const AUTH_FAIL_RE = /authentication failure|incorrect password|su: |sorry|password is incorrect/i;

/**
 * Exécute une commande EN TANT QUE `user` via `su`, mot de passe saisi sur le
 * pseudo-terminal (jamais en argument, jamais journalisé). La sortie de la
 * commande est encadrée par des marqueurs pour une extraction fiable.
 */
function runAsUser(user, password, parts, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let cmd;
    try {
      cmd = `printf %s ${shellQuote(S)}; ` + parts.map(shellQuote).join(' ') +
            `; __rc=$?; printf %s ${shellQuote(E)}; exit "$__rc"`;
    } catch (e) { return resolve({ error: e.message }); }

    let term;
    try {
      term = pty.spawn('su', [user, '-c', cmd], {
        name: 'xterm-color', cols: 200, rows: 50, cwd: '/',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      });
    } catch (e) { return resolve({ error: e.message }); }

    let buf = '', sentPw = false, done = false, exitCode = null;
    const finish = (extra) => {
      if (done) return; done = true;
      clearTimeout(tm);
      try { term.kill(); } catch (e) { /* déjà mort */ }
      const si = buf.indexOf(S), ei = buf.indexOf(E);
      const saw = si !== -1 && ei !== -1 && ei > si;
      const output = saw ? buf.slice(si + S.length, ei).replace(/\r/g, '') : '';
      const authFailed = !saw && AUTH_FAIL_RE.test(buf);
      resolve({ exitCode, output, saw, authFailed, ...(extra || {}) });
    };
    const tm = setTimeout(() => finish({ error: 'Délai dépassé.' }), timeout);

    term.onData((d) => {
      buf += d;
      if (!sentPw) { sentPw = true; try { term.write(password + '\r'); } catch (e) { /* */ } }
      if (buf.indexOf(E) !== -1) finish();
    });
    term.onExit(({ exitCode: ec }) => { exitCode = ec; setTimeout(() => finish(), 60); });
  });
}

async function verifyCreds(user, password) {
  const r = await runAsUser(user, password, ['true']);
  if (r.saw && (r.exitCode === 0 || r.exitCode == null)) return { ok: true };
  if (r.authFailed || /authentication failure/i.test(r.raw || '')) {
    return { ok: false, error: 'Identifiant ou mot de passe incorrect.' };
  }
  return { ok: false, error: r.error || 'Échec de l\'authentification.' };
}

/** Exécute le worker fs en root (ou compte élevé). Renvoie l'objet JSON émis. */
async function runWorker(req, payload) {
  if (!elevated(req)) { const e = new Error('Élévation requise.'); e.statusCode = 403; e.code = 'NEED_SUDO'; throw e; }
  const tmp = path.join(os.tmpdir(), 'adminpanel-op-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  await fsp.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
  try {
    const r = await runAsUser(req.session.suUser, req.session.suPass, [process.execPath, WORKER, tmp]);
    if (r.authFailed) { clearCreds(req); const e = new Error('Authentification expirée.'); e.statusCode = 403; e.code = 'NEED_SUDO'; throw e; }
    if (!r.saw) { const e = new Error('Échec de l\'exécution privilégiée.'); e.statusCode = 500; throw e; }
    let parsed;
    try { parsed = JSON.parse(r.output.trim().split('\n').filter(Boolean).pop()); }
    catch (e) { const er = new Error('Réponse privilégiée illisible.'); er.statusCode = 500; throw er; }
    if (!parsed.ok) { const er = new Error(parsed.error || 'Échec opération privilégiée.'); er.statusCode = parsed.statusCode || 500; throw er; }
    return parsed;
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
}

/** Exécute une commande système (ex. systemctl) en root. */
async function runPrivileged(req, parts) {
  if (!elevated(req)) { const e = new Error('Élévation requise.'); e.statusCode = 403; e.code = 'NEED_SUDO'; throw e; }
  const r = await runAsUser(req.session.suUser, req.session.suPass, parts);
  if (r.authFailed) { clearCreds(req); const e = new Error('Authentification expirée.'); e.statusCode = 403; e.code = 'NEED_SUDO'; throw e; }
  return { exitCode: r.exitCode, output: (r.output || '').trim() };
}

function buildElevateRouter() {
  const router = express.Router();
  const json = express.json();

  router.get('/status', (req, res) =>
    res.json({ elevated: elevated(req), user: (elevated(req) && req.session.suUser) || null, ttlMs: CRED_TTL_MS }));

  router.post('/', json, async (req, res) => {
    const user = (req.body && typeof req.body.user === 'string' && req.body.user.trim()) || 'root';
    const password = req.body && req.body.password;
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(user)) return res.status(400).json({ ok: false, error: 'Nom d\'utilisateur invalide.' });
    if (typeof password !== 'string' || !password) return res.status(400).json({ ok: false, error: 'Mot de passe requis.' });
    const r = await verifyCreds(user, password);
    if (!r.ok) { audit(req, 'elevate_failure', { target: user }); return res.status(403).json({ ok: false, error: r.error }); }
    setCreds(req, user, password);
    audit(req, 'elevate_success', { target: user });
    res.json({ ok: true, user });
  });

  router.post('/lock', (req, res) => { clearCreds(req); audit(req, 'elevate_lock', {}); res.json({ ok: true }); });

  return router;
}

module.exports = { buildElevateRouter, elevated, runWorker, runPrivileged, clearCreds };
