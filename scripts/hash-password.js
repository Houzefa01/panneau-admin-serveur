#!/usr/bin/env node
'use strict';

// Génère un hash bcrypt à partir d'un mot de passe.
//   node scripts/hash-password.js 'mon mot de passe'
// ou, plus sûr (le mot de passe n'apparaît pas dans l'historique shell) :
//   node scripts/hash-password.js        puis saisie au prompt / via stdin
//
// Seul le hash est imprimé sur stdout. Le mot de passe en clair n'est jamais
// écrit sur disque.

const bcrypt = require('bcrypt');
const readline = require('readline');

const COST = 12; // >= 12 exigé

async function readPassword() {
  const fromArg = process.argv[2];
  if (typeof fromArg === 'string' && fromArg.length > 0) return fromArg;

  // Lecture sur stdin (sans écho si possible).
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    if (process.stdin.isTTY) {
      process.stderr.write('Mot de passe : ');
      // Masque la saisie.
      const onData = () => rl.output.write('\x1b[2K\r');
      rl._writeToOutput = onData;
    }
    rl.question('', (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on('error', reject);
  });
}

(async () => {
  const password = (await readPassword()).replace(/\r?\n$/, '');
  if (!password) {
    process.stderr.write('Erreur : mot de passe vide.\n');
    process.exit(1);
  }
  if (password.length < 8) {
    process.stderr.write('Avertissement : mot de passe court (< 8 caractères).\n');
  }
  const hash = await bcrypt.hash(password, COST);
  process.stderr.write('\nAjoutez cette ligne à votre .env :\n');
  process.stdout.write('ADMIN_PASSWORD_HASH=' + hash + '\n');
})().catch((e) => {
  process.stderr.write('Erreur : ' + e.message + '\n');
  process.exit(1);
});
