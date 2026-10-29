#!/usr/bin/env node
'use strict';

// Démarre réellement le serveur et l'exerce via HTTP/WebSocket pour vérifier
// concrètement chaque exigence. N'opère JAMAIS sur de vrais chemins : toutes
// les manipulations de fichiers ont lieu dans ./test-sandbox, créé puis
// détruit par ce script.
//
// Affiche exactement "ALL CHECKS PASSED" si et seulement si tout est vérifié.

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const net = require('net');
const os = require('os');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');

const PROJECT_ROOT = path.join(__dirname, '..');
const SANDBOX = path.join(PROJECT_ROOT, 'test-sandbox');
const TEST_USER = 'verify-admin';
const TEST_PASS = 'Verify-Pass-' + Math.random().toString(36).slice(2);
const TMP_AUDIT = path.join(os.tmpdir(), 'verify-audit-' + Date.now() + '.log');
const TMP_USERS = path.join(os.tmpdir(), 'verify-users-' + Date.now() + '.json');

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  process.stdout.write(`${mark} ${name}${ok ? '' : '  — ' + (detail || 'échec')}\n`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function getCookie(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const sid = all.find((c) => c.startsWith('sid='));
  return sid ? sid.split(';')[0] : null;
}
// Valeur d'un cookie 'name' dans les en-têtes Set-Cookie d'une réponse.
function setCookieVal(res, name) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const c = all.find((x) => x.startsWith(name + '='));
  return c ? c.split(';')[0].slice(name.length + 1) : null;
}

async function main() {
  // --- Préparation du bac à sable ---
  await fsp.rm(SANDBOX, { recursive: true, force: true });
  await fsp.mkdir(SANDBOX, { recursive: true });
  const sandboxReal = await fsp.realpath(SANDBOX);

  const hash = await bcrypt.hash(TEST_PASS, 12);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  // --- Démarrage du serveur réel (process enfant) ---
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server', 'index.js')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SESSION_SECRET: 'verify-secret-' + Math.random().toString(36).slice(2),
      ADMIN_USER: TEST_USER,
      ADMIN_PASSWORD_HASH: hash,
      FILE_ROOT: sandboxReal,
      COOKIE_SECURE: 'false',
      TLS_KEY: '', // neutralise un éventuel TLS du .env (test en HTTP loopback)
      TLS_CERT: '',
      AUDIT_LOG: TMP_AUDIT,
      USERS_FILE: TMP_USERS,
      SHELL: process.env.SHELL || '/bin/bash',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverStderr = '';
  child.stderr.on('data', (d) => (serverStderr += d.toString()));

  const ready = await new Promise((resolve) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      if (buf.includes('LISTENING')) {
        child.stdout.off('data', onData);
        resolve(true);
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', () => resolve(false));
    setTimeout(() => resolve(false), 15000);
  });

  record('Le serveur démarre sur le port configuré', ready, ready ? '' : serverStderr.slice(0, 400));
  if (!ready) {
    return finish(child);
  }

  let cookie = null;
  let csrf = null;
  try {
    // --- 1. Authentification : bons identifiants ---
    const loginOk = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
    });
    cookie = getCookie(loginOk);
    record('Login (bons identifiants) crée une session', loginOk.status === 200 && !!cookie,
      `status=${loginOk.status} cookie=${!!cookie}`);

    // La session est réellement valide.
    const sess = await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie || '' } });
    const sessBody = await sess.json();
    record('La session authentifiée est reconnue', sess.status === 200 && sessBody.authenticated === true,
      JSON.stringify(sessBody));
    // Jeton CSRF (posé en cookie sur les réponses authentifiées) — requis en
    // en-tête sur les mutations, comme le ferait le navigateur.
    csrf = setCookieVal(sess, 'csrf');
    record('Un jeton CSRF est fourni à la session', !!csrf, csrf ? 'présent' : 'absent');

    // --- 1b. Mauvais identifiants ---
    const loginBad = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: 'mauvais' }),
    });
    record('Login (mauvais identifiants) renvoie une erreur', loginBad.status === 401,
      `status=${loginBad.status}`);

    // --- 1c. Rate limiter ---
    let limited = false;
    let lastStatus = 0;
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: TEST_USER, password: 'mauvais' }),
      });
      lastStatus = r.status;
      if (r.status === 429) limited = true;
    }
    record('Le rate limiter bloque les tentatives répétées', limited, `dernier status=${lastStatus}`);

    // --- 2. WebSocket terminal ---
    record('La WebSocket refuse une connexion sans session', await wsRejectsNoAuth(port));
    const echoOk = await wsEchoWithAuth(port, cookie);
    record('La WebSocket accepte une session valide et relaie un echo', echoOk.ok, echoOk.detail);

    // --- 3. API fichiers (dans le bac à sable uniquement) ---
    await runFileChecks(base, cookie, sandboxReal, csrf);

    // --- 4. Stats système ---
    const stats = await fetch(`${base}/api/stats`, { headers: { Cookie: cookie } });
    let statsBody = {};
    try { statsBody = await stats.json(); } catch (e) { /* */ }
    const statsOk = stats.status === 200 && statsBody.cpu && statsBody.memory &&
      Array.isArray(statsBody.disk) && statsBody.network;
    record('Les stats renvoient cpu/mémoire/disque/réseau', statsOk,
      `status=${stats.status} keys=${Object.keys(statsBody).join(',')}`);

    // --- 5. Contrôle des services ---
    const svc = await fetch(`${base}/api/services`, { headers: { Cookie: cookie } });
    let svcBody = {};
    try { svcBody = await svc.json(); } catch (e) { /* */ }
    record('GET /api/services répond (liste systemd)',
      svc.status === 200 && Array.isArray(svcBody.services), `status=${svc.status}`);

    // Endpoints d'action protégés : sans session -> 401 (la route existe, et
    // surtout aucun service n'est touché / aucun reboot n'est déclenché).
    const actNoAuth = await fetch(`${base}/api/services/restart`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}',
    });
    record('POST /api/services/:action existe et est protégé', actNoAuth.status === 401,
      `status=${actNoAuth.status}`);

    const rebootNoAuth = await fetch(`${base}/api/system/reboot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    record('POST /api/system/reboot existe et est protégé (non déclenché)',
      rebootNoAuth.status === 401, `status=${rebootNoAuth.status}`);

    // --- Élévation de privilèges ---
    const elevNoAuth = await fetch(`${base}/api/elevate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"user":"root","password":"x"}',
    });
    record('POST /api/elevate existe et est protégé', elevNoAuth.status === 401, `status=${elevNoAuth.status}`);

    const elevStatus = await fetch(`${base}/api/elevate/status`, { headers: { Cookie: cookie } });
    let elevBody = {};
    try { elevBody = await elevStatus.json(); } catch (e) { /* */ }
    record('GET /api/elevate/status répond (non élevé par défaut)',
      elevStatus.status === 200 && elevBody.elevated === false, JSON.stringify(elevBody));

    // --- Multi-utilisateurs / rôles ---
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    let meBody = {};
    try { meBody = await me.json(); } catch (e) { /* */ }
    record('GET /api/auth/me renvoie le profil (rôle admin)',
      me.status === 200 && meBody.role === 'admin', JSON.stringify(meBody));

    const ulist = await fetch(`${base}/api/users`, { headers: { Cookie: cookie } });
    let ulistBody = {};
    try { ulistBody = await ulist.json(); } catch (e) { /* */ }
    record('GET /api/users (admin) liste les comptes',
      ulist.status === 200 && Array.isArray(ulistBody.users) && ulistBody.users.length >= 1, `status=${ulist.status}`);

    // Création + suppression d'un compte lecteur (CRUD utilisateurs).
    const created = await fetch(`${base}/api/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ username: 'verif-lecteur', password: 'lecteur-123', role: 'lecteur', root: sandboxReal }),
    });
    const createdBody = await created.json().catch(() => ({}));
    record('POST /api/users crée un compte lecteur', created.status === 200 && createdBody.user && createdBody.user.role === 'lecteur', `status=${created.status}`);
    if (createdBody.user && createdBody.user.id) {
      const del = await fetch(`${base}/api/users/${createdBody.user.id}`, { method: 'DELETE', headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
      record('DELETE /api/users/:id supprime le compte', del.status === 200, `status=${del.status}`);
    }

    // --- Journal d'activité ---
    const logs = await fetch(`${base}/api/logs?limit=50`, { headers: { Cookie: cookie } });
    let logsBody = {};
    try { logsBody = await logs.json(); } catch (e) { /* */ }
    const loggedLogin = Array.isArray(logsBody.entries) && logsBody.entries.some((e) => e.event === 'login_success');
    record('GET /api/logs renvoie le journal (connexion enregistrée)',
      logs.status === 200 && loggedLogin, `status=${logs.status} entries=${logsBody.entries ? logsBody.entries.length : 0}`);
  } catch (e) {
    record('Exécution des vérifications HTTP/WS', false, e.message);
  }

  // --- 6. Livrables sur disque ---
  for (const rel of ['README.md', 'SECURITY.md', '.env.example', 'scripts/hash-password.js']) {
    record(`Fichier présent : ${rel}`, fs.existsSync(path.join(PROJECT_ROOT, rel)));
  }
  const svcFiles = fs.existsSync(path.join(PROJECT_ROOT, 'systemd'))
    ? fs.readdirSync(path.join(PROJECT_ROOT, 'systemd')).filter((f) => f.endsWith('.service'))
    : [];
  record('Fichier de service systemd présent', svcFiles.length > 0, svcFiles.join(','));

  // --- 7. npm test ---
  let testOk = false;
  let testDetail = '';
  try {
    execFileSync(process.execPath, ['--test', 'test/**/*.test.js'], { cwd: PROJECT_ROOT, stdio: 'pipe' });
    testOk = true;
  } catch (e) {
    testDetail = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    testDetail = testDetail.split('\n').filter((l) => /not ok|Error|fail/i.test(l)).slice(0, 5).join(' | ');
  }
  record('npm test passe sans échec', testOk, testDetail);

  return finish(child);
}

// --- WebSocket : refus sans session ---
function wsRejectsNoAuth(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`);
    let settled = false;
    const done = (rejected) => { if (!settled) { settled = true; try { ws.terminate(); } catch (e) {} resolve(rejected); } };
    ws.on('open', () => done(false)); // ouvert = pas refusé = échec
    ws.on('error', () => done(true));
    ws.on('unexpected-response', () => done(true));
    setTimeout(() => done(false), 5000);
  });
}

// --- WebSocket : echo avec session ---
function wsEchoWithAuth(port, cookie) {
  return new Promise((resolve) => {
    const marker = 'WS_ECHO_' + Math.random().toString(36).slice(2);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`, { headers: { Cookie: cookie } });
    let buf = '';
    let settled = false;
    const done = (ok, detail) => { if (!settled) { settled = true; try { ws.terminate(); } catch (e) {} resolve({ ok, detail }); } };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'data', data: `echo ${marker}\n` })));
    ws.on('message', (d) => {
      buf += d.toString();
      if (buf.includes(marker)) done(true, 'echo reçu');
    });
    ws.on('error', (e) => done(false, e.message));
    setTimeout(() => done(false, 'timeout, pas d\'echo'), 8000);
  });
}

// --- API fichiers : chaque opération, dans le bac à sable ---
async function runFileChecks(base, cookie, root, csrf) {
  const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const dir = path.join(root, 'dossier');
  const file = path.join(dir, 'note.txt');
  const renamed = path.join(dir, 'note-renomme.txt');
  const copied = path.join(dir, 'copie.txt');
  const subdir = path.join(root, 'cible');

  const post = (p, body) => fetch(`${base}/api/files/${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const jget = async (p) => { const r = await fetch(`${base}/api/files/${p}`, { headers: { Cookie: cookie } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  let r;
  r = await post('mkdir', { path: dir });
  record('files: mkdir', r.status === 200);
  r = await post('mkdir', { path: subdir });
  record('files: mkdir (2e dossier)', r.status === 200);

  r = await post('write', { path: file, content: 'bonjour' });
  record('files: write', r.status === 200);

  let rr = await jget(`read?path=${encodeURIComponent(file)}`);
  record('files: read renvoie le contenu', rr.status === 200 && rr.body.content === 'bonjour', JSON.stringify(rr.body).slice(0, 120));

  rr = await jget(`list?path=${encodeURIComponent(dir)}`);
  record('files: list contient le fichier', rr.status === 200 && Array.isArray(rr.body.entries) && rr.body.entries.some((e) => e.name === 'note.txt'));

  r = await post('create', { path: path.join(dir, 'vide.txt') });
  record('files: create (fichier vide)', r.status === 200);

  r = await post('rename', { path: file, newName: 'note-renomme.txt' });
  record('files: rename', r.status === 200 && fs.existsSync(renamed));

  r = await post('copy', { source: renamed, destination: copied });
  record('files: copy', r.status === 200 && fs.existsSync(copied));

  r = await post('move', { source: copied, destination: subdir });
  record('files: move', r.status === 200 && fs.existsSync(path.join(subdir, 'copie.txt')));

  // upload (multipart)
  const fd = new FormData();
  fd.append('path', subdir);
  fd.append('files', new Blob([Buffer.from('contenu uploade')]), 'uploaded.txt');
  const up = await fetch(`${base}/api/files/upload`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: fd });
  record('files: upload', up.status === 200 && fs.existsSync(path.join(subdir, 'uploaded.txt')), `status=${up.status}`);

  // download fichier
  const dlFile = await fetch(`${base}/api/files/download?path=${encodeURIComponent(renamed)}`, { headers: { Cookie: cookie } });
  const dlText = await dlFile.text();
  record('files: download (fichier)', dlFile.status === 200 && dlText === 'bonjour', `status=${dlFile.status}`);

  // download dossier (zip)
  const dlDir = await fetch(`${base}/api/files/download?path=${encodeURIComponent(dir)}`, { headers: { Cookie: cookie } });
  const ab = Buffer.from(await dlDir.arrayBuffer());
  record('files: download (dossier zippé)', dlDir.status === 200 && ab.length > 0 && ab[0] === 0x50 && ab[1] === 0x4b, `bytes=${ab.length}`);

  // delete
  r = await post('delete', { path: dir });
  record('files: delete', r.status === 200 && !fs.existsSync(dir));

  // confinement : tentative d'évasion hors racine -> refus
  const escape = await post('write', { path: '/etc/verify-should-not-exist', content: 'x' });
  record('files: confinement hors racine refusé', escape.status === 400 || escape.status === 403, `status=${escape.status}`);
}

async function finish(child) {
  try { child.kill('SIGTERM'); } catch (e) {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 1500).unref();
  await fsp.rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(TMP_AUDIT, { force: true }).catch(() => {});
  await fsp.rm(TMP_USERS, { force: true }).catch(() => {});

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write('\n');
  if (failed.length === 0) {
    process.stdout.write('ALL CHECKS PASSED\n');
    process.exitCode = 0;
  } else {
    process.stdout.write(`${failed.length} vérification(s) en échec :\n`);
    failed.forEach((c) => process.stdout.write(`  - ${c.name}${c.detail ? ' : ' + c.detail : ''}\n`));
    process.exitCode = 1;
  }
  // Laisse le temps au kill de s'appliquer.
  setTimeout(() => process.exit(process.exitCode), 300).unref();
}

main().catch((e) => {
  process.stderr.write('verify.js a échoué : ' + (e.stack || e.message) + '\n');
  process.exitCode = 1;
  process.exit(1);
});
