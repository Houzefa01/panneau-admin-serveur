'use strict';

const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const { config, assertReady } = require('./config');
const { gzipJson } = require('./compress');
const { requireAuth, requireRole, buildAuthRouter } = require('./auth');
const { buildFilesRouter } = require('./files');
const { buildStatsRouter } = require('./stats');
const { buildServicesRouter } = require('./services');
const { buildElevateRouter } = require('./elevate');
const { buildUsersRouter } = require('./usermgmt');
const { buildLogsRouter } = require('./logs');
const { setupTerminal } = require('./terminal');
const users = require('./users');
const { audit, accessLogger } = require('./audit');
const { ipGuard } = require('./guard');

const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules');

function createApp() {
  const app = express();

  // On ne fait confiance aux en-têtes X-Forwarded-* QUE depuis la boucle locale
  // (le tunnel Cloudflare s'y connecte). Ainsi un client direct sur le LAN ne
  // peut pas usurper son IP (X-Forwarded-For) pour contourner le rate limiting,
  // tout en gardant `secure`/cf-connecting-ip valides via le tunnel.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // xterm.js injecte une feuille de style en ligne -> 'unsafe-inline'
          // limité au style (documenté dans SECURITY.md).
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"], // couvre la WebSocket same-origin
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  const sessionMiddleware = session({
    name: 'sid',
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'strict',
      maxAge: config.SESSION_TTL_MS,
    },
  });
  app.use(sessionMiddleware);

  // Bannissement d'IP (fail2ban interne) : bloque les IP ayant trop d'anomalies.
  // Placé avant tout traitement ; n'affecte ni le loopback ni le compte god.
  app.use(ipGuard);

  // Journalise toute anomalie (4xx/5xx) : sondes, accès refusés, injections
  // rejetées — visibles par admin et propriétaire, jamais le compte god.
  app.use(accessLogger);

  // Compression gzip des réponses JSON volumineuses (listings, contenu de
  // fichiers) — réduit la latence sur connexion faible. N'affecte pas les
  // téléchargements bruts/zip (qui n'utilisent pas res.json).
  app.use(gzipJson());

  // --- CSRF (défense en profondeur, en plus de SameSite=strict) ---
  // Pour une session authentifiée : génère un jeton et l'expose via un cookie
  // lisible par JS. Le front le renvoie en en-tête X-CSRF-Token sur les mutations.
  app.use((req, res, next) => {
    if (req.session && req.session.authenticated) {
      if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      res.cookie('csrf', req.session.csrfToken, {
        httpOnly: false, sameSite: 'strict', secure: config.COOKIE_SECURE, path: '/',
      });
    }
    next();
  });
  const CSRF_SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  app.use((req, res, next) => {
    if (CSRF_SAFE.has(req.method)) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/auth/login') return next(); // pas encore de session
    // Le CSRF ne vise que les sessions authentifiées (l'attaque chevauche une
    // session ouverte). Une requête non authentifiée est laissée à requireAuth
    // (-> 401), pas masquée par un 403 CSRF.
    if (!(req.session && req.session.authenticated)) return next();
    const token = req.get('X-CSRF-Token');
    if (req.session.csrfToken && token && token === req.session.csrfToken) return next();
    audit(req, 'csrf_denied', { method: req.method, path: req.originalUrl });
    return res.status(403).json({ error: 'Requête refusée (jeton CSRF manquant ou invalide).' });
  });

  // --- Ressources statiques publiques (aucun secret) ---
  app.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
  app.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));
  app.use('/vendor/xterm', express.static(path.join(NODE_MODULES, '@xterm', 'xterm')));
  app.use('/vendor/addon-fit', express.static(path.join(NODE_MODULES, '@xterm', 'addon-fit')));

  // --- Favicon (public, icône d'onglet du navigateur) ---
  app.get('/favicon.svg', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'favicon.svg')));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

  // --- Pages ---
  app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) return res.redirect('/');
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // --- API ---
  // Sonde publique : déclarée avant le montage protégé /api pour ne pas être
  // interceptée par requireAuth.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', buildAuthRouter());
  app.use('/api/elevate', requireAuth, requireRole('admin'), buildElevateRouter());
  app.use('/api/users', requireAuth, requireRole('admin'), buildUsersRouter());
  app.use('/api/logs', requireAuth, requireRole('admin'), buildLogsRouter());
  app.use('/api/files', requireAuth, buildFilesRouter());
  app.use('/api/stats', requireAuth, buildStatsRouter());
  app.use('/api', requireAuth, requireRole('admin'), buildServicesRouter()); // /api/services, /api/system/* (admin)

  // 404 JSON pour l'API, redirection pour le reste.
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Introuvable.' });
    }
    res.redirect('/');
  });

  // Gestionnaire d'erreurs final.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.statusCode || 500;
    if (status >= 500) {
      process.stderr.write('[error] ' + (err.stack || err.message) + '\n');
    }
    if (res.headersSent) return;
    const body = { error: err.message || 'Erreur interne.' };
    if (err.code === 'NEED_SUDO') body.code = 'NEED_SUDO'; // déclenche la demande d'élévation côté client
    res.status(status).json(body);
  });

  return { app, sessionMiddleware };
}

function start() {
  assertReady();
  users.seedFromEnv(); // amorce l'admin depuis .env si aucun compte n'existe
  const { app, sessionMiddleware } = createApp();

  const loopback = config.HOST === '127.0.0.1' || config.HOST === '::1' || config.HOST === 'localhost';

  let tls = null;
  if (config.TLS_KEY && config.TLS_CERT) {
    try { tls = { key: fs.readFileSync(config.TLS_KEY), cert: fs.readFileSync(config.TLS_CERT) }; }
    catch (e) { throw new Error('TLS configuré mais clé/certificat illisibles : ' + e.message); }
  }
  // Hors loopback sans TLS : refus (sauf dérogation explicite). Chiffrement
  // obligatoire sur le réseau pour ne pas exposer les identifiants en clair.
  if (!loopback && !tls && !config.ALLOW_INSECURE_LAN) {
    throw new Error(
      `Écoute LAN (HOST=${config.HOST}) sans TLS interdite. Exécutez « npm run gen-cert » ` +
      'puis définissez TLS_KEY/TLS_CERT dans .env, ou (déconseillé) ALLOW_INSECURE_LAN=true.'
    );
  }

  const scheme = tls ? 'https' : 'http';
  const server = tls ? https.createServer(tls, app) : http.createServer(app);

  // Latence : désactive l'algorithme de Nagle sur chaque connexion TCP. Sinon,
  // les petits paquets (chaque frappe au clavier dans le terminal) peuvent être
  // retardés jusqu'à ~40 ms — très perceptible à distance / sur connexion faible.
  server.on('connection', (socket) => { try { socket.setNoDelay(true); } catch (e) { /* */ } });

  // La WebSocket du terminal vérifie elle-même la session avant tout spawn.
  setupTerminal(server, sessionMiddleware);

  server.listen(config.PORT, config.HOST, () => {
    audit(null, 'server_start', { host: config.HOST, port: config.PORT, tls: !!tls });
    // Ligne lue par scripts/verify.js pour détecter la disponibilité.
    process.stdout.write(`LISTENING ${scheme}://${config.HOST}:${config.PORT}\n`);
    if (!loopback) {
      const urls = [];
      for (const ifs of Object.values(os.networkInterfaces())) {
        for (const n of ifs || []) if (n.family === 'IPv4' && !n.internal) urls.push(`${scheme}://${n.address}:${config.PORT}`);
      }
      process.stdout.write('Accès LAN : ' + (urls.join('  ') || '(aucune interface)') + '\n');
      if (!tls) process.stdout.write('⚠ HTTP non chiffré sur le réseau — voir SECURITY.md\n');
    }
  });

  const shutdown = (sig) => {
    audit(null, 'server_stop', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  try {
    start();
  } catch (e) {
    process.stderr.write('Démarrage impossible : ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = { createApp, start };
