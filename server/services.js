'use strict';

const express = require('express');
const { execFile } = require('child_process');
const { audit } = require('./audit');
const elevate = require('./elevate');

// systemctl sans privilèges renvoie ce type de message -> on demande l'élévation.
const PERM_RE = /interactive authentication required|access denied|permission denied|authentication is required|not authorized|polkit/i;
function needSudo() { const e = new Error('Droits administrateur requis.'); e.statusCode = 403; e.code = 'NEED_SUDO'; return e; }

// Noms d'unités systemd autorisés. Strict pour éviter toute injection
// d'argument même si execFile sépare déjà les arguments.
const UNIT_RE = /^[a-zA-Z0-9@._:-]+$/;
const ACTIONS = new Set(['start', 'stop', 'restart']);

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function normalizeUnit(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!UNIT_RE.test(trimmed) || trimmed.length > 256) return null;
  return /\.[a-z]+$/.test(trimmed) ? trimmed : trimmed + '.service';
}

function buildServicesRouter() {
  const router = express.Router();
  const json = express.json();

  // --- Lister les services systemd ---
  router.get('/services', async (req, res) => {
    const { err, stdout, stderr } = await run('systemctl', [
      'list-units',
      '--type=service',
      '--all',
      '--no-pager',
      '--no-legend',
      '--plain',
    ]);
    if (err && !stdout) {
      return res.status(500).json({ ok: false, error: (stderr || err.message).trim() });
    }
    const services = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        if (parts.length < 4) return null;
        const [unit, load, active, sub, ...desc] = parts;
        return { unit, load, active, sub, description: desc.join(' ') };
      })
      .filter(Boolean);
    res.json({ ok: true, services });
  });

  // --- État détaillé d'un service ---
  router.get('/services/:name/status', async (req, res) => {
    const unit = normalizeUnit(req.params.name);
    if (!unit) return res.status(400).json({ ok: false, error: 'Nom de service invalide.' });
    const { stdout } = await run('systemctl', ['show', unit,
      '--property=ActiveState,SubState,LoadState,UnitFileState,Description']);
    const props = {};
    stdout.split('\n').forEach((l) => {
      const i = l.indexOf('=');
      if (i > 0) props[l.slice(0, i)] = l.slice(i + 1);
    });
    res.json({ ok: true, unit, props });
  });

  // --- Action sur un service : start | stop | restart ---
  router.post('/services/:action', json, async (req, res) => {
    const action = req.params.action;
    if (!ACTIONS.has(action)) {
      return res.status(400).json({ ok: false, error: 'Action non autorisée.' });
    }
    const unit = normalizeUnit(req.body && req.body.name);
    if (!unit) {
      return res.status(400).json({ ok: false, error: 'Nom de service invalide.' });
    }
    audit(req, 'service_action', { action, unit, elevated: elevate.elevated(req) });

    // Élevé : exécution en root. Sinon tentative directe, et demande d'élévation
    // si systemd réclame une autorisation.
    if (elevate.elevated(req)) {
      const r = await elevate.runPrivileged(req, ['systemctl', action, unit]);
      if (r.exitCode !== 0) return res.status(500).json({ ok: false, error: r.output || ('code ' + r.exitCode), unit, action });
      return res.json({ ok: true, unit, action, output: r.output });
    }
    const { err, stdout, stderr } = await run('systemctl', [action, unit]);
    if (err) {
      if (PERM_RE.test(stderr)) throw needSudo();
      return res.status(500).json({ ok: false, error: (stderr || err.message).trim(), unit, action });
    }
    res.json({ ok: true, unit, action, output: (stdout || stderr).trim() });
  });

  // --- Redémarrage de la machine ---
  router.post('/system/reboot', json, async (req, res) => {
    audit(req, 'system_reboot', { elevated: elevate.elevated(req) });
    if (elevate.elevated(req)) {
      const r = await elevate.runPrivileged(req, ['systemctl', 'reboot']);
      if (r.exitCode !== 0) return res.status(500).json({ ok: false, error: r.output || ('code ' + r.exitCode) });
      return res.json({ ok: true });
    }
    const { err, stderr } = await run('systemctl', ['reboot']);
    if (err) {
      if (PERM_RE.test(stderr)) throw needSudo();
      return res.status(500).json({ ok: false, error: (stderr || err.message).trim() });
    }
    res.json({ ok: true });
  });

  return router;
}

module.exports = { buildServicesRouter, normalizeUnit };
