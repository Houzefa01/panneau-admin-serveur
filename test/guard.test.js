'use strict';

// Bannissement d'IP (fail2ban). Seuil bas pour un test rapide, défini AVANT le
// chargement du module (il lit l'environnement au require).
process.env.BAN_THRESHOLD = '3';
process.env.BAN_WINDOW_MS = '10000';
process.env.BAN_DURATION_MS = '60000';

const { test } = require('node:test');
const assert = require('node:assert');
const guard = require('../server/guard');

test('isLoopback reconnaît les adresses locales', () => {
  assert.equal(guard.isLoopback('127.0.0.1'), true);
  assert.equal(guard.isLoopback('::1'), true);
  assert.equal(guard.isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(guard.isLoopback('203.0.113.1'), false);
});

test('le loopback n\'est jamais compté ni banni', () => {
  for (let i = 0; i < 10; i++) assert.equal(guard.noteAnomaly('127.0.0.1'), false);
  assert.equal(guard.isBanned('127.0.0.1'), false);
});

test('une IP est bannie après le seuil d\'anomalies', () => {
  const ip = '203.0.113.50';
  assert.equal(guard.isBanned(ip), false);
  assert.equal(guard.noteAnomaly(ip), false); // 1
  assert.equal(guard.noteAnomaly(ip), false); // 2
  assert.equal(guard.noteAnomaly(ip), true);  // 3 -> déclenche le ban
  assert.equal(guard.isBanned(ip), true);
  // Une IP déjà bannie ne re-déclenche pas un ban.
  assert.equal(guard.noteAnomaly(ip), false);
});

test('une IP propre n\'est pas bannie', () => {
  assert.equal(guard.isBanned('198.51.100.7'), false);
});
