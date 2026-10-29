'use strict';

/*
 * Worker d'opérations fichiers exécuté EN ROOT via `sudo node fs-worker.js`.
 * Reçoit une charge utile JSON unique en argument (chemins déjà résolus et
 * validés côté serveur). Re-vérifie le confinement dans FILE_ROOT (défense en
 * profondeur) puis exécute l'opération. Émet exactement une ligne JSON sur
 * stdout et sort toujours avec le code 0 (le résultat est porté par `ok`).
 *
 * Aucune donnée sensible ne transite ici : le mot de passe sudo est consommé
 * par sudo lui-même sur stdin et n'atteint jamais ce script.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const READ_MAX_BYTES = 5 * 1024 * 1024;

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(0);
}

function confine(p, root) {
  if (typeof p !== 'string' || !p || p.indexOf('\0') !== -1) throw mkErr('Chemin invalide.', 400);
  const base = root.endsWith(path.sep) ? root : root + path.sep; // évite '//' si root === '/'
  const lex = (x) => x === root || x.startsWith(base);
  if (!lex(p)) throw mkErr('Hors de la racine autorisée.', 400);
  // En root on peut résoudre les liens : confinement realpath (anti-évasion).
  try {
    const real = fs.realpathSync(p);
    if (!lex(real)) throw mkErr('Lien hors de la racine autorisée.', 400);
    return real;
  } catch (e) {
    if (e.statusCode) throw e;
    if (e.code === 'ENOENT') {
      const parent = path.dirname(p);
      try {
        const rp = fs.realpathSync(parent);
        if (!lex(rp)) throw mkErr('Hors de la racine autorisée.', 400);
        return path.join(rp, path.basename(p));
      } catch (e2) { if (e2.statusCode) throw e2; return p; }
    }
    return p;
  }
}
function mkErr(msg, code) { const e = new Error(msg); e.statusCode = code || 500; return e; }

async function moveInto(src, dest) {
  try { await fsp.rename(src, dest); }
  catch (e) {
    if (e.code === 'EXDEV') { await fsp.copyFile(src, dest); await fsp.unlink(src); }
    else throw e;
  }
}

async function run(p) {
  const root = p.root;
  switch (p.op) {
    case 'list': {
      const dir = confine(p.path, root);
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) throw mkErr('Le chemin n\'est pas un dossier.', 400);
      const dirents = await fsp.readdir(dir, { withFileTypes: true });
      const entries = await Promise.all(dirents.map(async (d) => {
        const full = path.join(dir, d.name);
        let size = 0, mtimeMs = 0, type = 'other';
        try {
          const ls = await fsp.lstat(full);
          mtimeMs = ls.mtimeMs;
          if (ls.isSymbolicLink()) type = 'symlink';
          else if (ls.isDirectory()) type = 'dir';
          else if (ls.isFile()) { type = 'file'; size = ls.size; }
        } catch (e) { /* défaut */ }
        return { name: d.name, type, size, mtimeMs };
      }));
      entries.sort((a, b) => ((a.type === 'dir') !== (b.type === 'dir')) ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
      return { ok: true, path: dir, parent: path.dirname(dir), entries };
    }
    case 'read': {
      const f = confine(p.path, root);
      const st = await fsp.stat(f);
      if (!st.isFile()) throw mkErr('Le chemin n\'est pas un fichier.', 400);
      if (st.size > READ_MAX_BYTES) throw mkErr('Fichier trop volumineux pour l\'éditeur.', 413);
      return { ok: true, path: f, size: st.size, content: await fsp.readFile(f, 'utf8') };
    }
    case 'write': {
      const dest = confine(p.path, root);
      // p.src est un fichier temporaire créé par le serveur (hors racine) : pas de confinement.
      await fsp.copyFile(p.src, dest);
      return { ok: true, path: dest };
    }
    case 'mkdir': {
      const t = confine(p.path, root);
      await fsp.mkdir(t, { recursive: false });
      return { ok: true, path: t };
    }
    case 'create': {
      const t = confine(p.path, root);
      const fh = await fsp.open(t, 'wx'); await fh.close();
      return { ok: true, path: t };
    }
    case 'rename': {
      const src = confine(p.path, root); const dest = confine(p.dest, root);
      await fsp.rename(src, dest);
      return { ok: true, path: dest };
    }
    case 'move': {
      const src = confine(p.src, root); const dest = confine(p.dest, root);
      await moveInto(src, dest);
      return { ok: true, path: dest };
    }
    case 'copy': {
      const src = confine(p.src, root); const dest = confine(p.dest, root);
      await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
      return { ok: true, path: dest };
    }
    case 'delete': {
      const t = confine(p.path, root);
      if (t === root) throw mkErr('Suppression de la racine interdite.', 400);
      await fsp.rm(t, { recursive: true, force: false });
      return { ok: true, path: t };
    }
    case 'upload': {
      // it.src = fichier temporaire serveur (hors racine) ; seul dest est confiné.
      const saved = [];
      for (const it of p.items || []) {
        const dest = confine(it.dest, root);
        await moveInto(it.src, dest);
        saved.push(path.basename(dest));
      }
      return { ok: true, saved };
    }
    case 'download': {
      const t = confine(p.path, root);
      const st = await fsp.stat(t);
      if (st.isDirectory()) return { ok: true, isDir: true };
      await fsp.copyFile(t, p.out);
      await fsp.chmod(p.out, 0o644); // lisible par l'utilisateur du serveur pour le streaming
      return { ok: true, isDir: false, out: p.out };
    }
    default:
      throw mkErr('Opération inconnue.', 400);
  }
}

(async () => {
  // argv[2] = chemin d'un fichier JSON (les chemins utilisateur n'apparaissent
  // jamais dans une ligne de commande shell). Repli : JSON direct.
  let payload;
  try {
    const arg = process.argv[2] || '{}';
    const raw = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg;
    payload = JSON.parse(raw);
  } catch (e) { out({ ok: false, error: 'Charge utile invalide.', statusCode: 400 }); return; }
  try { out(await run(payload)); }
  catch (e) { out({ ok: false, error: e.message, statusCode: e.statusCode || 500 }); }
})();
