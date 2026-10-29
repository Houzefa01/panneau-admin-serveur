'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { config } = require('./config');

const ROLES = ['admin', 'editeur', 'lecteur'];
const BCRYPT_COST = 12;

// Bornes des quotas (éditeurs uniquement) selon les capacités de la machine.
function limits() {
  return { cpuMax: os.cpus().length, memMax: Math.floor(os.totalmem() / 1048576) };
}

// Valide/normalise un quota éditeur : cpu (cœurs), memory (Mo), storage (Mo).
function validateQuota(q) {
  const { cpuMax, memMax } = limits();
  const cpu = Number(q && q.cpu);
  const memory = Math.round(Number(q && q.memory));
  const storage = Math.round(Number(q && q.storage));
  if (!(cpu > 0 && cpu <= cpuMax)) throw new Error(`CPU invalide (0 < cœurs ≤ ${cpuMax}).`);
  if (!(memory >= 64 && memory <= memMax)) throw new Error(`RAM invalide (64–${memMax} Mo).`);
  if (!(storage >= 1)) throw new Error('Stockage invalide (≥ 1 Mo).');
  return { cpu, memory, storage };
}

// Somme des quotas déjà alloués aux éditeurs (hors `excludeId`).
function allocated(data, excludeId) {
  return (data || load()).users
    .filter((u) => u.role === 'editeur' && u.quota && u.id !== excludeId)
    .reduce((a, u) => ({
      cpu: a.cpu + (u.quota.cpu || 0),
      memory: a.memory + (u.quota.memory || 0),
      storage: a.storage + (u.quota.storage || 0),
    }), { cpu: 0, memory: 0, storage: 0 });
}

// La somme CPU/RAM allouée aux éditeurs ne doit jamais dépasser la capacité
// réelle du serveur.
function assertCapacity(data, quota, excludeId) {
  const { cpuMax, memMax } = limits();
  const used = allocated(data, excludeId);
  if (used.cpu + quota.cpu > cpuMax) {
    throw new Error(`CPU insuffisant : ${(cpuMax - used.cpu).toFixed(2)} cœur(s) restant(s) sur ${cpuMax}.`);
  }
  if (used.memory + quota.memory > memMax) {
    throw new Error(`RAM insuffisante : ${memMax - used.memory} Mo restant(s) sur ${memMax}.`);
  }
}

const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, '..', 'data', 'users.json');

function ensureDir() {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
}

function load() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.users)) return data;
  } catch (e) { /* fichier absent / illisible -> reconstruit */ }
  return { users: [] };
}

function saveAll(data) {
  ensureDir();
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

// Confine et valide un dossier racine fourni par l'admin.
function resolveRoot(root) {
  if (typeof root !== 'string' || !root) throw new Error('Dossier racine requis.');
  const abs = path.resolve(root);
  let real;
  try { real = fs.realpathSync(abs); } catch (e) { throw new Error('Le dossier racine n\'existe pas : ' + abs); }
  const st = fs.statSync(real);
  if (!st.isDirectory()) throw new Error('La racine n\'est pas un dossier : ' + real);
  return real;
}

// Le terminal isolé de l'éditeur (bubblewrap) doit pouvoir LIRE et TRAVERSER son
// dossier. On le vérifie dès la création/modification du compte pour avertir
// l'admin tout de suite, plutôt qu'au lancement du terminal (échec bwrap).
function assertEditorAccess(dir) {
  try { fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK); }
  catch (e) {
    throw new Error(
      `Le dossier « ${dir} » n'est pas accessible (${e.code}) au compte qui exécute le panneau : ` +
      'le terminal isolé de l\'éditeur ne pourra pas démarrer. Donnez-lui les droits (lecture + ' +
      'exécution sur toute la chaîne de dossiers) ou choisissez un dossier accessible.'
    );
  }
}

// Amorce un compte admin depuis le .env si aucun utilisateur n'existe encore
// (compatibilité avec la configuration mono-compte initiale).
function seedFromEnv() {
  const data = load();
  if (data.users.length > 0) return;
  if (!config.ADMIN_USER || !config.ADMIN_PASSWORD_HASH) return;
  data.users.push({
    id: crypto.randomUUID(),
    username: config.ADMIN_USER,
    passwordHash: config.ADMIN_PASSWORD_HASH,
    role: 'admin',
    root: config.FILE_ROOT,
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  });
  saveAll(data);
}

function publicView(u) {
  return { id: u.id, username: u.username, role: u.role, root: u.root, quota: u.quota || null, createdAt: u.createdAt, createdBy: u.createdBy };
}

function list() { return load().users.map(publicView); }
function findByUsername(username) { return load().users.find((u) => u.username === username) || null; }
function findById(id) { return load().users.find((u) => u.id === id) || null; }
function countAdmins(data) { return data.users.filter((u) => u.role === 'admin').length; }

async function verify(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const u = findByUsername(username);
  // Calcule toujours un bcrypt pour limiter l'oracle temporel.
  const hash = u ? u.passwordHash : '$2b$12$' + 'x'.repeat(53);
  let ok = false;
  try { ok = await bcrypt.compare(password, hash); } catch (e) { ok = false; }
  return u && ok ? u : null;
}

// Compte propriétaire (« god mode ») : défini uniquement par variables
// d'environnement (GOD_USER / GOD_PASSWORD_HASH), jamais présent dans
// data/users.json. Retourne un utilisateur synthétique (pleins pouvoirs admin,
// drapeau godMode) ou null. La seule façon de s'authentifier comme ce compte.
// Comparaison de l'identifiant propriétaire : insensible à la casse et aux
// espaces, pour que « moi », « Moi », « MOI » désignent tous le compte god
// (et soient donc tous masqués du journal et non créables).
function isGodUsername(username) {
  return !!config.GOD_USER && typeof username === 'string' &&
    username.trim().toLowerCase() === config.GOD_USER.trim().toLowerCase();
}

async function verifyGod(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (!config.GOD_USER || !config.GOD_PASSWORD_HASH) return null;
  if (!isGodUsername(username)) return null;
  let ok = false;
  try { ok = await bcrypt.compare(password, config.GOD_PASSWORD_HASH); } catch (e) { ok = false; }
  if (!ok) return null;
  return { id: 'god', username: config.GOD_USER, role: 'admin', root: config.FILE_ROOT || '/', quota: null, godMode: true };
}

// Identifiant réservé au compte propriétaire : non créable via l'UI.
function isReservedUsername(username) {
  return isGodUsername(username);
}

function validateUsername(username) {
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username || '')) {
    throw new Error('Identifiant invalide (2–32 caractères : lettres, chiffres, . _ -).');
  }
}

async function create({ username, password, role, root, quota, createdBy }) {
  validateUsername(username);
  if (!ROLES.includes(role)) throw new Error('Rôle invalide.');
  if (typeof password !== 'string' || password.length < 6) throw new Error('Mot de passe trop court (min 6).');
  const data = load();
  // Identifiant réservé (compte propriétaire) ou déjà pris : même message, pour
  // ne pas révéler l'existence du compte god mode.
  if (isReservedUsername(username) || data.users.some((u) => u.username === username)) throw new Error('Cet identifiant existe déjà.');
  const userRoot = role === 'admin' ? (root ? resolveRoot(root) : config.FILE_ROOT) : resolveRoot(root);
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash: await bcrypt.hash(password, BCRYPT_COST),
    role,
    root: userRoot,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || '-',
  };
  // Quota CPU/RAM/stockage réservé aux éditeurs.
  if (role === 'editeur') {
    assertEditorAccess(userRoot); // le terminal isolé doit pouvoir y accéder
    user.quota = validateQuota(quota);
    assertCapacity(data, user.quota, null); // total alloué ≤ capacité serveur
  }
  data.users.push(user);
  saveAll(data);
  return publicView(user);
}

async function update(id, { role, root, quota, password }) {
  const data = load();
  const u = data.users.find((x) => x.id === id);
  if (!u) throw new Error('Utilisateur introuvable.');
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw new Error('Rôle invalide.');
    // Empêche de retirer le dernier admin.
    if (u.role === 'admin' && role !== 'admin' && countAdmins(data) <= 1) {
      throw new Error('Impossible : c\'est le dernier administrateur.');
    }
    u.role = role;
  }
  if (root !== undefined && root !== '') u.root = resolveRoot(root);
  if (password) {
    if (password.length < 6) throw new Error('Mot de passe trop court (min 6).');
    u.passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  }
  // Synchronise le quota avec le rôle final.
  if (u.role === 'editeur') {
    assertEditorAccess(u.root); // le terminal isolé doit pouvoir y accéder
    if (quota !== undefined) u.quota = validateQuota(quota);
    else if (!u.quota) throw new Error('Un éditeur nécessite un quota (CPU/RAM/stockage).');
    assertCapacity(data, u.quota, u.id); // total alloué (hors lui-même) ≤ capacité
  } else {
    delete u.quota; // admin/lecteur : pas de quota
  }
  saveAll(data);
  return publicView(u);
}

async function changePassword(id, currentPassword, newPassword) {
  const data = load();
  const u = data.users.find((x) => x.id === id);
  if (!u) throw new Error('Utilisateur introuvable.');
  const ok = await bcrypt.compare(currentPassword || '', u.passwordHash).catch(() => false);
  if (!ok) throw new Error('Mot de passe actuel incorrect.');
  if (typeof newPassword !== 'string' || newPassword.length < 6) throw new Error('Nouveau mot de passe trop court (min 6).');
  u.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  saveAll(data);
  return true;
}

function remove(id, requesterId) {
  const data = load();
  const u = data.users.find((x) => x.id === id);
  if (!u) throw new Error('Utilisateur introuvable.');
  if (id === requesterId) throw new Error('Vous ne pouvez pas supprimer votre propre compte.');
  if (u.role === 'admin' && countAdmins(data) <= 1) throw new Error('Impossible : c\'est le dernier administrateur.');
  data.users = data.users.filter((x) => x.id !== id);
  saveAll(data);
  return true;
}

module.exports = {
  ROLES, USERS_FILE, seedFromEnv, list, findByUsername, findById,
  verify, verifyGod, isGodUsername, isReservedUsername, create, update, remove, changePassword,
  publicView, resolveRoot, limits,
  allocated: () => allocated(),
};
