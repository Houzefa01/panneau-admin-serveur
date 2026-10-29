'use strict';

const express = require('express');
const { execFile } = require('child_process');
const si = require('systeminformation');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function duBytes(p) {
  return new Promise((resolve) => {
    execFile('du', ['-sb', '--', p], { timeout: 20000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err || !stdout) return resolve(0);
      const n = parseInt(String(stdout).split(/\s+/)[0], 10);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });
}

function buildStatsRouter() {
  const router = express.Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const role = req.session.role;

      // Lecteur : aucune statistique.
      if (role === 'lecteur') {
        return res.status(403).json({ error: 'Statistiques indisponibles pour ce rôle.' });
      }

      // Éditeur : uniquement les ressources qui LUI sont attribuées (quota) +
      // l'utilisation réelle de son espace de stockage. Jamais la machine entière.
      if (role === 'editeur') {
        const q = req.session.quota || { cpu: 0, memory: 0, storage: 0 };
        const used = await duBytes(req.session.fileRoot);
        return res.json({
          role: 'editeur',
          root: req.session.fileRoot,
          quota: q,
          storage: { used, total: q.storage * 1048576, usePercent: q.storage ? Math.min(100, (used / (q.storage * 1048576)) * 100) : 0 },
          cpuCores: q.cpu,
          memoryMB: q.memory,
          ts: Date.now(),
        });
      }

      // Admin : vue complète de la machine.
      const [load, mem, fs, net, time, osInfo, cpu, temp] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.networkStats(),
        Promise.resolve(si.time()),
        si.osInfo(),
        si.cpu(),
        si.cpuTemperature().catch(() => null), // capteur absent sur certaines machines/VM
      ]);

      const netAgg = net.reduce(
        (acc, n) => {
          acc.rx_sec += n.rx_sec || 0;
          acc.tx_sec += n.tx_sec || 0;
          acc.rx_bytes += n.rx_bytes || 0;
          acc.tx_bytes += n.tx_bytes || 0;
          return acc;
        },
        { rx_sec: 0, tx_sec: 0, rx_bytes: 0, tx_bytes: 0 }
      );

      // Température CPU : `main` = capteur principal, `cores` = par cœur, `max` =
      // le plus chaud. systeminformation renvoie -1 / null quand aucun capteur
      // n'est lisible (VM, droits manquants) → on expose alors `null`.
      const okTemp = (v) => Number.isFinite(v) && v > 0;
      const tMain = temp && okTemp(temp.main) ? Math.round(temp.main * 10) / 10 : null;
      const temperature = tMain == null ? null : {
        main: tMain,
        max: temp && okTemp(temp.max) ? Math.round(temp.max * 10) / 10 : tMain,
        cores: temp && Array.isArray(temp.cores) ? temp.cores.filter(okTemp).map((c) => Math.round(c)) : [],
      };

      const disks = fs.map((d) => ({
        fs: d.fs,
        mount: d.mount,
        type: d.type,
        size: d.size,
        used: d.used,
        available: d.available,
        usePercent: d.use,
      }));

      res.json({
        role: 'admin',
        cpu: {
          model: `${cpu.manufacturer} ${cpu.brand}`.trim(),
          cores: cpu.cores,
          loadPercent: Math.round((load.currentLoad || 0) * 100) / 100,
          loadPerCore: load.cpus ? load.cpus.map((c) => Math.round(c.load * 100) / 100) : [],
        },
        memory: {
          total: mem.total,
          used: mem.active, // mémoire réellement utilisée (hors cache/buffers)
          free: mem.available,
          usePercent: mem.total ? Math.round((mem.active / mem.total) * 10000) / 100 : 0,
          swapTotal: mem.swaptotal,
          swapUsed: mem.swapused,
        },
        temperature, // °C (capteur CPU) ou null si indisponible
        disk: disks,
        network: netAgg,
        uptime: time.uptime,
        load: {
          avg1: load.avgLoad || 0,
          currentLoad: load.currentLoad || 0,
        },
        os: { platform: osInfo.platform, distro: osInfo.distro, release: osInfo.release, hostname: osInfo.hostname },
        ts: Date.now(),
      });
    })
  );

  return router;
}

module.exports = { buildStatsRouter };
