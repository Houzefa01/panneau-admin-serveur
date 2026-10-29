'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config();

function bool(v, def) {
  if (v === undefined) return def;
  return String(v).toLowerCase() === 'true' || v === '1';
}

// FILE_ROOT confine toutes les opérations du gestionnaire de fichiers.
// Par défaut '/' = accès complet au système (but du panneau). Le script de
// vérification le surcharge vers ./test-sandbox pour ne jamais toucher de
// vrais chemins. On résout le realpath au démarrage pour les comparaisons.
let fileRoot = process.env.FILE_ROOT || '/';
try {
  fileRoot = fs.realpathSync(path.resolve(fileRoot));
} catch (e) {
  fileRoot = path.resolve(fileRoot);
}

const config = {
  // Interface d'écoute. Par défaut 127.0.0.1 (loopback). Mettre 0.0.0.0 (ou une
  // IP de carte réseau) pour exposer sur le réseau local. ⚠️ Hors loopback, le
  // panneau n'est plus protégé que par sa propre authentification (voir SECURITY.md).
  HOST: process.env.HOST || '127.0.0.1',
  PORT: parseInt(process.env.PORT || '3000', 10),

  SESSION_SECRET: process.env.SESSION_SECRET || '',
  // secure cookie activé sauf si explicitement désactivé (dev/local sans HTTPS).
  COOKIE_SECURE: bool(process.env.COOKIE_SECURE, true),

  ADMIN_USER: process.env.ADMIN_USER || '',
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || '',

  // Compte « propriétaire » (god mode) — défini uniquement par variables
  // d'environnement, jamais stocké dans data/users.json. Invisible dans la
  // liste, non créable via l'UI, ses actions ne sont pas journalisées.
  GOD_USER: process.env.GOD_USER || '',
  GOD_PASSWORD_HASH: process.env.GOD_PASSWORD_HASH || '',

  FILE_ROOT: fileRoot,
  // Limite de taille d'upload par fichier (octets). Défaut borné à 5 Gio pour
  // éviter qu'un upload géant ne remplisse le disque ; mettre 0 = illimité.
  MAX_UPLOAD_BYTES: parseInt(process.env.MAX_UPLOAD_BYTES || String(5 * 1024 * 1024 * 1024), 10),

  SHELL: process.env.SHELL || '/bin/bash',
  AUDIT_LOG: process.env.AUDIT_LOG || path.join(__dirname, '..', 'audit.log'),

  // Chemins TLS (clé + certificat). Si les deux sont définis et lisibles, le
  // serveur écoute en HTTPS — indispensable hors loopback pour chiffrer les
  // identifiants sur le réseau. Générer avec : npm run gen-cert
  TLS_KEY: process.env.TLS_KEY || '',
  TLS_CERT: process.env.TLS_CERT || '',
  // Autorise explicitement l'écoute LAN en HTTP non chiffré (déconseillé).
  ALLOW_INSECURE_LAN: String(process.env.ALLOW_INSECURE_LAN || '').toLowerCase() === 'true',

  SESSION_TTL_MS: parseInt(process.env.SESSION_TTL_MS || String(8 * 60 * 60 * 1000), 10),
};

function assertReady() {
  const missing = [];
  if (!config.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (!config.ADMIN_USER) missing.push('ADMIN_USER');
  if (!config.ADMIN_PASSWORD_HASH) missing.push('ADMIN_PASSWORD_HASH');
  if (missing.length) {
    throw new Error(
      'Configuration incomplète, variables manquantes dans .env : ' + missing.join(', ')
    );
  }
}

module.exports = { config, assertReady };
