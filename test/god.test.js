'use strict';

// Compte propriétaire (god mode). On configure l'environnement AVANT de charger
// les modules (chaque fichier de test tourne dans son propre process).
const bcrypt = require('bcrypt');
process.env.GOD_USER = 'owner-test';
process.env.GOD_PASSWORD_HASH = bcrypt.hashSync('god-secret-pass', 12);

const { test } = require('node:test');
const assert = require('node:assert');
const users = require('../server/users');

test('isGodUsername : insensible à la casse et aux espaces', () => {
  assert.equal(users.isGodUsername('owner-test'), true);
  assert.equal(users.isGodUsername('OWNER-TEST'), true);
  assert.equal(users.isGodUsername(' Owner-Test '), true);
  assert.equal(users.isGodUsername('autre'), false);
  assert.equal(users.isGodUsername(''), false);
  assert.equal(users.isGodUsername(null), false);
});

test('isReservedUsername : couvre le compte propriétaire, pas les autres', () => {
  assert.equal(users.isReservedUsername('Owner-Test'), true);
  assert.equal(users.isReservedUsername('admin'), false);
});

test('verifyGod : accepte les bons identifiants quelle que soit la casse', async () => {
  const a = await users.verifyGod('owner-test', 'god-secret-pass');
  assert.ok(a && a.godMode === true && a.role === 'admin');
  const b = await users.verifyGod('OWNER-TEST', 'god-secret-pass');
  assert.ok(b && b.godMode === true);
});

test('verifyGod : refuse mauvais mot de passe, autre identifiant, types invalides', async () => {
  assert.equal(await users.verifyGod('owner-test', 'mauvais'), null);
  assert.equal(await users.verifyGod('autre', 'god-secret-pass'), null);
  assert.equal(await users.verifyGod(123, 'god-secret-pass'), null);
});
