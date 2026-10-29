'use strict';

const fs = require('fs');
const { config } = require('./config');
const guard = require('./guard');

// Journal d'audit append-only en JSON Lines. Aucune donnée sensible
// (mot de passe, contenu de fichier) n'y est jamais écrite.
// Rotation par taille : au-delà de AUDIT_MAX_BYTES, audit.log devient
// audit.log.1, etc. (on garde AUDIT_KEEP archives) — borne l'usage disque même
// sous un flot de sondes/attaques.
const LOG = config.AUDIT_LOG;
const MAX_BYTES = parseInt(process.env.AUDIT_MAX_BYTES || String(5 * 1024 * 1024), 10);
const KEEP = parseInt(process.env.AUDIT_KEEP || '5', 10);

let currentSize = 0;
try { currentSize = fs.statSync(LOG).size; } catch (e) { currentSize = 0; }

function openStream() {
  const s = fs.createWriteStream(LOG, { flags: 'a' });
  s.on('error', (err) => process.stderr.write('[audit] erreur écriture journal : ' + err.message + '\n'));
  return s;
}
let stream = openStream();

function rotate() {
  try { stream.end(); } catch (e) { /* */ }
  try { const oldest = `${LOG}.${KEEP}`; if (fs.existsSync(oldest)) fs.unlinkSync(oldest); } catch (e) { /* */ }
  for (let i = KEEP - 1; i >= 1; i--) {
    try { const src = `${LOG}.${i}`; if (fs.existsSync(src)) fs.renameSync(src, `${LOG}.${i + 1}`); } catch (e) { /* */ }
  }
  try { if (fs.existsSync(LOG)) fs.renameSync(LOG, `${LOG}.1`); } catch (e) { /* */ }
  stream = openStream();
  currentSize = 0;
}

function writeLine(line) {
  try {
    stream.write(line);
    currentSize += Buffer.byteLength(line);
    if (currentSize >= MAX_BYTES) rotate();
  } catch (e) { process.stderr.write('[audit] ' + e.message + '\n'); }
}

function clientIp(req) {
  if (!req) return '-';
  return (
    (req.headers && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'])) ||
    (req.socket && req.socket.remoteAddress) ||
    '-'
  );
}

/**
 * Écrit une entrée d'audit horodatée.
 * @param {object|null} req requête Express (pour user/ip), peut être null
 * @param {string} event nom court de l'événement
 * @param {object} details détails structurés (pas de secrets)
 */
function audit(req, event, details = {}) {
  const user = (req && req.session && req.session.user) || (details && details.user) || '-';
  // Compte propriétaire (god mode) : ne laisse AUCUNE trace — ni pour ses
  // propres actions (session.godMode), ni pour toute entrée le mentionnant,
  // y compris les ÉCHECS de connexion et quelle que soit la casse saisie.
  const godU = config.GOD_USER;
  const mentionsGod = godU && typeof user === 'string' && user.trim().toLowerCase() === godU.trim().toLowerCase();
  if ((req && req.session && req.session.godMode) || mentionsGod) return;
  const ua = req && req.headers && req.headers['user-agent'];
  const entry = {
    ts: new Date().toISOString(),
    event,
    user,
    role: (req && req.session && req.session.role) || (details && details.role) || '-',
    ip: clientIp(req),
    // Contexte maximal pour l'analyse (méthode, chemin, agent).
    ...(req && req.method ? { method: req.method } : {}),
    ...(req && (req.originalUrl || req.url) ? { path: req.originalUrl || req.url } : {}),
    ...(ua ? { ua: String(ua).slice(0, 200) } : {}),
    ...details,
  };
  // Jamais de secret dans le journal.
  delete entry.password;
  delete entry.currentPassword;
  delete entry.newPassword;
  writeLine(JSON.stringify(entry) + '\n');
}

// Fichiers de journal, du plus récent au plus ancien : [audit.log, .1, .2, …].
function logFilesNewestFirst() {
  const files = [];
  if (fs.existsSync(LOG)) files.push(LOG);
  for (let i = 1; i <= KEEP; i++) { const f = `${LOG}.${i}`; if (fs.existsSync(f)) files.push(f); }
  return files;
}

// Fichiers de journal du plus ancien au plus récent (pour l'export complet).
function logFilesOldestFirst() {
  const files = [];
  for (let i = KEEP; i >= 1; i--) { const f = `${LOG}.${i}`; if (fs.existsSync(f)) files.push(f); }
  if (fs.existsSync(LOG)) files.push(LOG);
  return files;
}

/**
 * Lit les entrées récentes du journal (les plus récentes d'abord), à travers les
 * fichiers (courant + archives) jusqu'à atteindre `limit`. Lecture fichier par
 * fichier, arrêt dès que suffisamment d'entrées : mémoire bornée.
 * @param {{limit?:number, user?:string, event?:string, q?:string}} opts
 */
function readRecent(opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 50000);
  const userF = opts.user && opts.user !== '*' ? String(opts.user) : null;
  const eventF = opts.event && opts.event !== '*' ? String(opts.event) : null;
  const qF = opts.q ? String(opts.q).toLowerCase() : null;
  const out = [];

  for (const file of logFilesNewestFirst()) {
    if (out.length >= limit) break;
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch (err) { continue; }
      if (userF && e.user !== userF) continue;
      if (eventF && e.event !== eventF) continue;
      if (qF && JSON.stringify(e).toLowerCase().indexOf(qF) === -1) continue;
      out.push(e);
    }
  }
  return { entries: out, total: out.length };
}

// Endpoints internes à haute fréquence (polling de l'app) : ignorés par le
// logger d'accès pour ne pas inonder le journal.
const LOGGER_SKIP = new Set([
  '/api/health', '/api/auth/me', '/api/auth/session', '/api/stats', '/api/elevate/status',
  '/favicon.svg', '/favicon.ico',
]);
// Routes qui écrivent déjà leur propre événement détaillé.
const SELF_AUDITED = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/password']);

// Logger d'accès global : journalise TOUTE réponse anormale (4xx/5xx) — sondes,
// accès non authentifiés/refusés, injections/traversées rejetées, erreurs — avec
// le maximum d'infos. Alimente aussi le bannissement d'IP (anomalies non
// authentifiées). Le compte propriétaire (god mode) n'y apparaît jamais.
function accessLogger(req, res, next) {
  res.on('finish', () => {
    try {
      if (req.session && req.session.godMode) return; // furtif
      const status = res.statusCode;
      if (status < 400) return;
      const ip = guard.clientIp(req);
      if (guard.isBanned(ip)) return; // déjà banni : on ne réinonde pas le journal
      const p = req.path || '';
      if (LOGGER_SKIP.has(p) || SELF_AUDITED.has(p)) return;
      if (p.startsWith('/css') || p.startsWith('/js') || p.startsWith('/vendor')) return;
      const event = status === 401 ? 'access_unauth'
        : status === 403 ? 'access_forbidden'
        : status === 404 ? 'probe_notfound'
        : status === 429 ? 'rate_limited'
        : status >= 500 ? 'server_error'
        : 'request_rejected'; // autres 4xx : validation / traversée / injection rejetée
      // Anomalies NON authentifiées -> comptées pour le bannissement.
      let banned = false;
      if (!(req.session && req.session.authenticated)) banned = guard.noteAnomaly(ip);
      audit(req, event, { method: req.method, path: req.originalUrl, status });
      if (banned) audit(req, 'ip_banned', { method: req.method, path: req.originalUrl, status, blockedIp: ip });
    } catch (e) { /* le logging ne doit jamais casser une réponse */ }
  });
  next();
}

module.exports = { audit, accessLogger, readRecent, logFilesOldestFirst };
