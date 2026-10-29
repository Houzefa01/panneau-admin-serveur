'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');

// Magasin d'utilisateurs isolé + admin amorcé depuis l'env, AVANT les requires.
const HASH = bcrypt.hashSync('Secret-123', 12);
const USERS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-')), 'users.json');
process.env.USERS_FILE = USERS_FILE;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD_HASH = HASH;
process.env.SESSION_SECRET = 'test-secret';
process.env.FILE_ROOT = os.tmpdir();
process.env.AUDIT_LOG = path.join(os.tmpdir(), 'auth-test-audit.log');

const users = require('../server/users');
users.seedFromEnv();
const { requireAuth, requireRole, verifyCredentials } = require('../server/auth');

function mockRes() {
  return {
    statusCode: 200, body: null, redirected: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    redirect(u) { this.redirected = u; return this; },
  };
}

test('requireAuth laisse passer une session authentifiée', () => {
  let called = false;
  requireAuth({ session: { authenticated: true } }, mockRes(), () => { called = true; });
  assert.strictEqual(called, true);
});

test('requireAuth renvoie 401 JSON pour une API non authentifiée', () => {
  const res = mockRes();
  requireAuth({ session: {}, method: 'GET', originalUrl: '/api/users' }, res, () => {});
  assert.strictEqual(res.statusCode, 401);
  assert.ok(res.body && res.body.error);
});

test('requireAuth redirige une page GET non authentifiée vers /login', () => {
  const res = mockRes();
  requireAuth({ session: {}, method: 'GET', originalUrl: '/' }, res, () => {});
  assert.strictEqual(res.redirected, '/login');
});

test('requireRole laisse passer le bon rôle', () => {
  let called = false;
  requireRole('admin')({ session: { authenticated: true, role: 'admin' } }, mockRes(), () => { called = true; });
  assert.strictEqual(called, true);
});

test('requireRole refuse un rôle insuffisant (403)', () => {
  const res = mockRes();
  requireRole('admin')({ session: { authenticated: true, role: 'lecteur' } }, res, () => {});
  assert.strictEqual(res.statusCode, 403);
});

test('requireRole refuse une session non authentifiée', () => {
  const res = mockRes();
  requireRole('admin')({ session: {} }, res, () => {});
  assert.strictEqual(res.statusCode, 403);
});

test('verifyCredentials accepte les bons identifiants', async () => {
  const u = await verifyCredentials('admin', 'Secret-123');
  assert.ok(u && u.role === 'admin');
});

test('verifyCredentials refuse un mauvais mot de passe', async () => {
  assert.strictEqual(await verifyCredentials('admin', 'mauvais'), null);
});

test('verifyCredentials refuse un utilisateur inconnu', async () => {
  assert.strictEqual(await verifyCredentials('intrus', 'Secret-123'), null);
});

test('verifyCredentials refuse des types non-chaîne', async () => {
  assert.strictEqual(await verifyCredentials(null, undefined), null);
});
