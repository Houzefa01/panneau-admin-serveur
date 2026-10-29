'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
process.env.FILE_ROOT = ROOT;
process.env.AUDIT_LOG = path.join(os.tmpdir(), 'paths-test-audit.log');

const { resolveSafe, PathError } = require('../server/paths');

const R = fs.realpathSync(ROOT);
fs.writeFileSync(path.join(R, 'fichier.txt'), 'x');
fs.mkdirSync(path.join(R, 'sous'));

test('résout un fichier existant dans la racine', () => {
  assert.strictEqual(resolveSafe(R, path.join(R, 'fichier.txt'), { mustExist: true }), path.join(R, 'fichier.txt'));
});

test('accepte un chemin relatif confiné', () => {
  assert.strictEqual(resolveSafe(R, 'sous', { mustExist: true }), path.join(R, 'sous'));
});

test('autorise une cible inexistante dont le parent existe', () => {
  assert.strictEqual(resolveSafe(R, path.join(R, 'sous', 'nouveau.txt')), path.join(R, 'sous', 'nouveau.txt'));
});

test('refuse une évasion par ..', () => {
  assert.throws(() => resolveSafe(R, '../../etc/passwd'), PathError);
});

test('refuse un chemin absolu hors racine', () => {
  assert.throws(() => resolveSafe(R, '/etc/passwd', { mustExist: true }), PathError);
});

test('refuse un octet nul', () => {
  assert.throws(() => resolveSafe(R, 'fichier\0.txt'), PathError);
});

test('refuse un chemin vide', () => {
  assert.throws(() => resolveSafe(R, ''), PathError);
});

test('mustExist échoue sur une cible absente', () => {
  assert.throws(() => resolveSafe(R, path.join(R, 'absent.txt'), { mustExist: true }), PathError);
});

test('refuse une évasion via lien symbolique', () => {
  const linkPath = path.join(R, 'evasion');
  try { fs.symlinkSync('/etc', linkPath); } catch (e) { return; }
  assert.throws(() => resolveSafe(R, path.join(linkPath, 'passwd'), { mustExist: true }), PathError);
});

test('confine deux racines distinctes indépendamment', () => {
  // Un chemin valide pour une racine est rejeté pour une autre.
  assert.throws(() => resolveSafe(path.join(R, 'sous'), path.join(R, 'fichier.txt')), PathError);
});
