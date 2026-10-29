'use strict';

const fs = require('fs');
const url = require('url');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { config } = require('./config');
const { audit } = require('./audit');

const WS_PATH = '/ws/terminal';
const BWRAP = '/usr/bin/bwrap';
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const hasBwrap = fs.existsSync(BWRAP);
const hasSystemdRun = fs.existsSync(SYSTEMD_RUN);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const HEARTBEAT_MS = 30000; // ping toutes les 30 s pour garder la WS ouverte

// Avertit UNE seule fois (dans journalctl) si les quotas CPU/RAM des éditeurs ne
// peuvent pas être appliqués faute de session systemd --user (service non-root
// sans linger). Le jail bubblewrap (isolation des fichiers) reste actif.
let _quotaWarned = false;
function warnNoQuota() {
  if (_quotaWarned) return;
  _quotaWarned = true;
  console.warn(
    '[terminal] Quotas CPU/RAM des éditeurs NON appliqués : service non-root sans ' +
    'session systemd --user. Pour les activer : « loginctl enable-linger panel » puis ' +
    'définir XDG_RUNTIME_DIR=/run/user/<uid> dans l\'unité. L\'isolation des fichiers ' +
    '(bubblewrap) reste active.'
  );
}

// Environnement nettoyé pour le shell admin : retire les secrets de l'appli.
// TMOUT=0 : empêche le shell de se déconnecter tout seul après inactivité si la
// machine impose un délai d'auto-logout via l'environnement.
function adminEnv() {
  const e = { ...process.env };
  // Retire TOUS les secrets de l'appli : le shell admin n'est plus root (service
  // sous compte « panel »), un `env`/`printenv` ne doit donc rien révéler — ni le
  // secret de session, ni les hash de mots de passe, ni l'existence du compte
  // propriétaire (god mode).
  delete e.SESSION_SECRET; delete e.ADMIN_PASSWORD_HASH; delete e.COOKIE_SECURE;
  delete e.GOD_USER; delete e.GOD_PASSWORD_HASH;
  e.TMOUT = '0';
  return e;
}

// Point de montage neutre du dossier de l'éditeur DANS le jail. On ne remonte
// pas au chemin absolu de l'hôte : ainsi le shell confiné ne révèle ni le nom
// d'utilisateur ni l'arborescence réelle du serveur (défense en profondeur).
const JAIL_HOME = '/coffre';

// Arguments bubblewrap : shell ne voyant QUE `root`, monté sur /coffre.
// --clearenv empêche toute fuite de l'environnement du serveur (secrets) dans
// le shell confiné.
function bwrapArgs(root, username) {
  return [
    '--clearenv', '--unshare-all', '--die-with-parent',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', root, JAIL_HOME,
    '--chdir', JAIL_HOME,
    '--setenv', 'HOME', JAIL_HOME,
    '--setenv', 'USER', username || 'editeur',
    '--setenv', 'PATH', '/usr/bin',
    '--setenv', 'TERM', 'xterm-color',
    '--setenv', 'TMOUT', '0', // pas d'auto-logout du shell après inactivité
    '--setenv', 'PS1', '[\\u:coffre \\W]\\$ ',
    '/usr/bin/bash',
  ];
}

// - admin   : shell complet (cwd = racine, ou HOME si racine = /).
// - editeur : bubblewrap (isolation FS) + systemd-run --user --scope
//             (cgroups : CPUQuota, MemoryMax) selon son quota.
// - lecteur : refusé en amont.
function spawnForRole(session) {
  const { role, fileRoot: root, user, quota } = session;
  const dim = { name: 'xterm-color', cols: 80, rows: 24 };

  if (role === 'editeur' && hasBwrap) {
    // Pré-vérification d'accès : le compte qui exécute le panneau doit pouvoir
    // lire/traverser le dossier de l'éditeur pour le monter dans le jail. Sinon
    // bwrap échoue avec un message cryptique (« Permission denied ») et la
    // session se reconnecte en boucle -> on remonte une erreur claire.
    try { fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK); }
    catch (e) {
      throw new Error(
        `Dossier de l'éditeur inaccessible : ${root} (${e.code}). Le compte qui exécute ` +
        'le panneau doit pouvoir y accéder (lecture + exécution sur toute la chaîne de ' +
        'dossiers). Corrigez les permissions (ex. « chmod o+rx » sur les dossiers parents, ' +
        'ou « chown » le dossier) ou exécutez le service sous un compte qui y a accès.'
      );
    }
    const inner = bwrapArgs(root, user);

    // Quotas CPU/RAM via cgroups (systemd-run --scope). En root : scope SYSTÈME
    // (aucune session utilisateur requise). Sinon (service sous compte « panel ») :
    // scope UTILISATEUR, possible seulement si une session systemd --user est
    // disponible — c.-à-d. `loginctl enable-linger panel` + XDG_RUNTIME_DIR.
    const useUserScope = !isRoot && !!process.env.XDG_RUNTIME_DIR;
    if (quota && hasSystemdRun && !(isRoot || useUserScope)) warnNoQuota();
    if (hasSystemdRun && quota && (isRoot || useUserScope)) {
      const args = [
        ...(useUserScope ? ['--user'] : []),
        '--scope', '--quiet', '--collect',
        '-p', 'CPUQuota=' + Math.round(quota.cpu * 100) + '%',
        '-p', 'MemoryMax=' + quota.memory + 'M',
        '-p', 'MemorySwapMax=0',
        '-p', 'TasksMax=200', // anti fork-bomb
        '--', BWRAP, ...inner,
      ];
      return pty.spawn(SYSTEMD_RUN, args, {
        ...dim, cwd: root,
        env: {
          PATH: '/usr/bin:/bin',
          TERM: 'xterm-color',
          ...(useUserScope ? {
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
            DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '',
          } : {}),
        },
      });
    }
    // Pas de cgroups applicables : bubblewrap seul (isolation FS conservée).
    return pty.spawn(BWRAP, inner, { ...dim, cwd: root, env: { TERM: 'xterm-color', PATH: '/usr/bin' } });
  }

  // Le shell admin démarre dans la racine configurée (FILE_ROOT), cohérent avec
  // le gestionnaire de fichiers. Évite d'atterrir dans un HOME vide (ex. /root
  // sur le serveur en root, où `ls` n'affichait rien).
  const cwd = root || process.env.HOME || '/';
  const env = adminEnv();
  // God mode : aucun historique shell écrit sur le disque (pas de trace).
  if (session.godMode) { env.HISTFILE = '/dev/null'; env.HISTSIZE = '0'; env.HISTFILESIZE = '0'; }
  return pty.spawn(config.SHELL, [], { ...dim, cwd, env });
}

function setupTerminal(server, sessionMiddleware) {
  // perMessageDeflate:false — pas de compression sur les messages du terminal :
  // ils sont minuscules (frappes/sorties), la compression ajouterait surtout de
  // la latence. Couplé au TCP_NODELAY côté serveur, c'est le plus réactif.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  // Heartbeat : sans trafic, une WebSocket inactive est coupée au bout de
  // quelques minutes par tout intermédiaire (routeur/NAT du LAN, et plus tard le
  // tunnel Cloudflare qui ferme les WS muettes à ~100 s). On envoie donc un ping
  // périodique : le navigateur y répond automatiquement (pong) au niveau du
  // protocole — rien à faire côté client — ce qui garde la connexion vivante.
  // Le pong sert aussi à détecter et fermer les connexions réellement mortes.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) { /* */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = url.parse(req.url);
    if (pathname !== WS_PATH) { socket.destroy(); return; }

    // Défense CSRF WebSocket : refuse un handshake provenant d'une autre origine
    // (en plus du cookie SameSite=strict qui empêche déjà l'envoi cross-site).
    const origin = req.headers.origin;
    if (origin) {
      let bad = true;
      try { bad = new URL(origin).host !== req.headers.host; } catch (e) { bad = true; }
      if (bad) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    }

    sessionMiddleware(req, {}, () => {
      const s = req.session;
      if (!s || !s.authenticated) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy();
        audit(req, 'terminal_denied', {}); return;
      }
      if (s.role === 'lecteur') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy();
        audit(req, 'terminal_denied', { user: s.user, role: s.role, reason: 'role' }); return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  });

  wss.on('connection', (ws, req) => {
    const s = req.session;
    // Marquage pour le heartbeat : la connexion est vivante tant qu'elle répond
    // aux pings (pong). Réinitialisé à chaque pong.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const jailed = s.role === 'editeur' && hasBwrap;
    audit(req, 'terminal_open', { user: s.user, role: s.role, root: s.fileRoot, jailed, quota: s.quota || null });

    let term;
    try {
      term = spawnForRole(s);
    } catch (e) {
      ws.send('\r\n[panneau] Impossible d\'ouvrir le terminal : ' + e.message + '\r\n');
      ws.close(); return;
    }

    if (jailed) {
      const q = s.quota ? ` · CPU ${s.quota.cpu} · RAM ${s.quota.memory} Mo` : '';
      ws.send('\x1b[2m[session confinée à ' + s.fileRoot + q + ']\x1b[0m\r\n');
    }

    let closed = false;
    const cleanup = () => {
      if (closed) return; closed = true;
      try { term.kill(); } catch (e) { /* */ }
      audit(req, 'terminal_close', { user: s.user });
    };

    term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    term.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(); cleanup(); });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === 'data' && typeof msg.data === 'string') term.write(msg.data);
      else if (msg.type === 'resize') {
        const cols = Math.max(1, Math.min(1000, parseInt(msg.cols, 10) || 80));
        const rows = Math.max(1, Math.min(1000, parseInt(msg.rows, 10) || 24));
        try { term.resize(cols, rows); } catch (e) { /* */ }
      }
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return wss;
}

module.exports = { setupTerminal, WS_PATH };
