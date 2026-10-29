'use strict';

const fs = require('fs');
const express = require('express');
const { config } = require('./config');
const { readRecent, logFilesOldestFirst } = require('./audit');

// Liste connue des types d'événements (pour le filtre côté client).
const EVENTS = [
  'login_success', 'login_failure', 'login_rate_limited', 'logout',
  'file_list', 'file_read', 'file_write', 'file_create', 'file_mkdir',
  'file_rename', 'file_move', 'file_copy', 'file_delete', 'file_upload', 'file_download', 'write_denied',
  'terminal_open', 'terminal_close', 'terminal_denied',
  'service_action', 'system_reboot',
  'elevate_success', 'elevate_failure', 'elevate_lock',
  'user_create', 'user_update', 'user_delete', 'password_change',
  'server_start', 'server_stop',
  // Anomalies / tentatives (logger d'accès global).
  'access_unauth', 'access_forbidden', 'probe_notfound', 'rate_limited',
  'request_rejected', 'server_error', 'ip_banned', 'csrf_denied',
];

// Routeur du journal d'activité. Monté derrière requireRole('admin').
function buildLogsRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { entries, total } = readRecent({
      limit: req.query.limit,
      user: req.query.user,
      event: req.query.event,
      q: req.query.q,
    });
    // Utilisateurs distincts apparus récemment (pour le filtre).
    const users = [...new Set(entries.map((e) => e.user).filter((u) => u && u !== '-'))].sort();
    res.json({ ok: true, entries, total, events: EVENTS, users });
  });

  // Téléchargement du journal brut COMPLET (JSON Lines) : archives + courant,
  // dans l'ordre chronologique. Tout l'historique en un fichier.
  router.get('/raw', (req, res) => {
    const files = logFilesOldestFirst();
    if (!files.length) return res.status(404).json({ error: 'Journal vide.' });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-complet.log"');
    let i = 0;
    const next = () => {
      if (i >= files.length) return res.end();
      const rs = fs.createReadStream(files[i++]);
      rs.on('error', next);
      rs.on('end', next);
      rs.pipe(res, { end: false });
    };
    next();
  });

  return router;
}

module.exports = { buildLogsRouter };
