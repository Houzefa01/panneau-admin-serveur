#!/usr/bin/env node
'use strict';

// Génère un certificat TLS auto-signé pour l'accès HTTPS sur le réseau local.
// SAN : localhost + 127.0.0.1 + toutes les IPv4 des cartes réseau.
//   node scripts/gen-cert.js
// Puis dans .env :  TLS_KEY=./certs/key.pem  TLS_CERT=./certs/cert.pem

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const KEY = path.join(CERT_DIR, 'key.pem');
const CERT = path.join(CERT_DIR, 'cert.pem');

const ips = ['127.0.0.1'];
for (const ifs of Object.values(os.networkInterfaces())) {
  for (const n of ifs || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
}
const san = ['DNS:localhost', ...[...new Set(ips)].map((ip) => 'IP:' + ip)].join(',');

fs.mkdirSync(CERT_DIR, { recursive: true });
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY, '-out', CERT,
    '-days', '825', '-subj', '/CN=serveur-admin-panel',
    '-addext', 'subjectAltName=' + san,
  ], { stdio: 'pipe' });
} catch (e) {
  process.stderr.write('Échec openssl : ' + (e.stderr ? e.stderr.toString() : e.message) + '\n');
  process.exit(1);
}
fs.chmodSync(KEY, 0o600);

process.stdout.write('Certificat auto-signé généré :\n');
process.stdout.write('  ' + KEY + '\n  ' + CERT + '\n');
process.stdout.write('SAN : ' + san + '\n\n');
process.stdout.write('Ajoutez à votre .env :\n');
process.stdout.write('  TLS_KEY=' + path.relative(path.join(__dirname, '..'), KEY) + '\n');
process.stdout.write('  TLS_CERT=' + path.relative(path.join(__dirname, '..'), CERT) + '\n');
process.stdout.write('  COOKIE_SECURE=true\n');
process.stdout.write('\nLes navigateurs afficheront un avertissement (certificat auto-signé) : acceptez-le.\n');
