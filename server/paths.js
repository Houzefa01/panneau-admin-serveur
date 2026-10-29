'use strict';

const path = require('path');
const fs = require('fs');
const { config } = require('./config');

class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
    this.statusCode = 400;
  }
}

// Racine par défaut (admin amorcé depuis .env). Chaque utilisateur possède sa
// propre racine ; resolveSafe la reçoit en paramètre.
const DEFAULT_ROOT = config.FILE_ROOT;

function isInsideRoot(root, resolved) {
  if (resolved === root) return true;
  const base = root.endsWith(path.sep) ? root : root + path.sep; // évite '//' si root === '/'
  return resolved.startsWith(base);
}

/**
 * Résout un chemin client en le confinant STRICTEMENT dans `root`.
 * @param {string} root racine autorisée (chemin absolu, déjà realpath)
 * @param {string} clientPath chemin absolu (dans root) ou relatif à root
 * @param {{mustExist?: boolean}} opts
 * @returns {string} chemin absolu vérifié
 */
function resolveSafe(root, clientPath, opts = {}) {
  const { mustExist = false } = opts;
  if (!root || typeof root !== 'string') throw new PathError('Racine non définie.');
  if (typeof clientPath !== 'string' || clientPath.length === 0) throw new PathError('Chemin invalide.');
  if (clientPath.indexOf('\0') !== -1) throw new PathError('Chemin invalide (octet nul).');

  const resolved = path.isAbsolute(clientPath) ? path.resolve(clientPath) : path.resolve(root, clientPath);

  if (!isInsideRoot(root, resolved)) {
    throw new PathError('Accès refusé : chemin hors de la racine autorisée.');
  }

  // Résolution des liens si accessible ; sinon confinement lexical (l'opération
  // privilégiée — worker root — refera un confinement realpath).
  let st = null;
  try {
    st = fs.lstatSync(resolved);
  } catch (e) {
    if (e.code === 'ENOENT') st = null;
    else if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOTDIR') return resolved;
    else throw new PathError('Chemin invalide.');
  }

  if (st) {
    let real;
    try { real = fs.realpathSync(resolved); }
    catch (e) { if (e.code === 'EACCES' || e.code === 'EPERM') return resolved; throw new PathError('Chemin invalide.'); }
    if (!isInsideRoot(root, real)) throw new PathError('Accès refusé : lien hors de la racine autorisée.');
    return real;
  }

  if (mustExist) throw new PathError('Le chemin n\'existe pas.');
  const parent = path.dirname(resolved);
  let realParent;
  try { realParent = fs.realpathSync(parent); }
  catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOTDIR') return resolved;
    throw new PathError('Le dossier parent n\'existe pas.');
  }
  if (!isInsideRoot(root, realParent)) throw new PathError('Accès refusé : chemin hors de la racine autorisée.');
  return path.join(realParent, path.basename(resolved));
}

module.exports = { resolveSafe, PathError, DEFAULT_ROOT };
