'use strict';

const express = require('express');
const users = require('./users');
const { audit } = require('./audit');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  e.statusCode = e.statusCode || 400;
  next(e);
});

// Routeur d'administration des comptes. Monté derrière requireRole('admin').
function buildUsersRouter() {
  const router = express.Router();
  const json = express.json();

  router.get('/', (req, res) => {
    res.json({ ok: true, users: users.list(), roles: users.ROLES, limits: users.limits(), allocated: users.allocated(), me: req.session.userId });
  });

  router.post('/', json, wrap(async (req, res) => {
    const { username, password, role, root, quota } = req.body || {};
    const created = await users.create({ username, password, role, root, quota, createdBy: req.session.user });
    audit(req, 'user_create', { username: created.username, role: created.role, root: created.root });
    res.json({ ok: true, user: created });
  }));

  router.patch('/:id', json, wrap(async (req, res) => {
    const { role, root, quota, password } = req.body || {};
    const updated = await users.update(req.params.id, { role, root, quota, password });
    audit(req, 'user_update', { id: req.params.id, role: updated.role, root: updated.root, passwordReset: !!password });
    res.json({ ok: true, user: updated });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    users.remove(req.params.id, req.session.userId);
    audit(req, 'user_delete', { id: req.params.id });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { buildUsersRouter };
