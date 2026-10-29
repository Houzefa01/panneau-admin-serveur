'use strict';

// Bannissement d'IP de type fail2ban, en mémoire. Compte les réponses anormales
// (4xx) NON authentifiées par IP sur une fenêtre glissante ; au-delà d'un seuil,
// l'IP est bannie pour une durée. Le loopback (tunnel/local) et le compte
// propriétaire (god mode) ne sont jamais comptés ni bannis.

const WINDOW_MS = parseInt(process.env.BAN_WINDOW_MS || String(60 * 1000), 10);     // 1 min
const THRESHOLD = parseInt(process.env.BAN_THRESHOLD || '20', 10);                  // 20 anomalies / min
const BAN_MS = parseInt(process.env.BAN_DURATION_MS || String(15 * 60 * 1000), 10); // 15 min

const strikes = new Map(); // ip -> number[] (horodatages des anomalies)
const bans = new Map();     // ip -> banUntil (ms epoch)

function isLoopback(ip) {
  return !ip || ip === '-' || ip === '127.0.0.1' || ip === '::1' ||
    ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

// IP client réelle (premier élément de X-Forwarded-For derrière le tunnel local).
function clientIp(req) {
  if (!req) return '-';
  const xff = req.headers && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
  return (xff ? String(xff).split(',')[0].trim() : '') ||
    (req.socket && req.socket.remoteAddress) || '-';
}

function isBanned(ip) {
  const until = bans.get(ip);
  if (!until) return false;
  if (until <= Date.now()) { bans.delete(ip); return false; }
  return true;
}

// Enregistre une anomalie ; renvoie true si elle vient de DÉCLENCHER un ban.
function noteAnomaly(ip) {
  if (isLoopback(ip) || isBanned(ip)) return false;
  const now = Date.now();
  const arr = (strikes.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  strikes.set(ip, arr);
  if (arr.length >= THRESHOLD) {
    bans.set(ip, now + BAN_MS);
    strikes.delete(ip);
    return true;
  }
  return false;
}

// Middleware : bloque les IP bannies (sauf loopback et compte god).
function ipGuard(req, res, next) {
  if (req.session && req.session.godMode) return next();
  const ip = clientIp(req);
  if (isLoopback(ip)) return next();
  if (isBanned(ip)) {
    return res.status(403).json({ error: 'Trop de tentatives. Accès temporairement bloqué.' });
  }
  next();
}

// Nettoyage périodique (borne la mémoire).
setInterval(() => {
  const now = Date.now();
  for (const [ip, until] of bans) if (until <= now) bans.delete(ip);
  for (const [ip, arr] of strikes) {
    const f = arr.filter((t) => now - t < WINDOW_MS);
    if (f.length) strikes.set(ip, f); else strikes.delete(ip);
  }
}, 60 * 1000).unref();

module.exports = { ipGuard, noteAnomaly, isBanned, clientIp, isLoopback, limits: { WINDOW_MS, THRESHOLD, BAN_MS } };
