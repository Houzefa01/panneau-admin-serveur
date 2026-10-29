'use strict';

import { apiGet, fmtBytes, fmtUptime } from './api.js';

let timer = null;
let myRole = 'admin';

const AMBER = '#F2B03D';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ----------------------------------------------------------------------- *
 * Oscilloscope CPU — la signature. Trace ambre défilante (le « pouls » de
 * la machine) sur un afficheur encastré. Tampon circulaire, valeur lissée,
 * figée si l'utilisateur réclame moins d'animation.
 * ----------------------------------------------------------------------- */
const scope = {
  ctx: null, W: 0, H: 0,
  buf: [], len: 140,
  target: 0, display: 0,
  raf: null, lastPush: 0, pushEvery: 55,
};

function sizeScope() {
  const c = document.getElementById('cpu-scope');
  if (!c || !c.clientWidth) return false;
  const dpr = window.devicePixelRatio || 1;
  scope.W = c.clientWidth; scope.H = c.clientHeight;
  c.width = scope.W * dpr; c.height = scope.H * dpr;
  scope.ctx = c.getContext('2d');
  scope.ctx.scale(dpr, dpr);
  if (!scope.buf.length) scope.buf = new Array(scope.len).fill(0);
  return true;
}

function drawScope() {
  const { ctx, W, H, buf, len } = scope;
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);

  // Grille de fond discrète.
  ctx.strokeStyle = 'rgba(105,122,144,.10)';
  ctx.lineWidth = 1;
  for (let gy = 1; gy < 4; gy++) {
    const y = (H / 4) * gy;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  // Bande « zone rouge » (90–100 %).
  ctx.fillStyle = 'rgba(255,94,94,.07)';
  ctx.fillRect(0, 0, W, H * 0.10);

  const x = (i) => (i / (len - 1)) * W;
  const y = (v) => H - (Math.min(100, Math.max(0, v)) / 100) * (H - 4) - 2;

  // Remplissage sous la courbe.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(242,176,61,.22)');
  grad.addColorStop(1, 'rgba(242,176,61,0)');
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i < len; i++) ctx.lineTo(x(i), y(buf[i]));
  ctx.lineTo(W, H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Trace.
  ctx.beginPath();
  for (let i = 0; i < len; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(i), y(buf[i]));
  ctx.strokeStyle = AMBER; ctx.lineWidth = 1.6;
  ctx.shadowColor = 'rgba(242,176,61,.6)'; ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Point de tête.
  const hx = x(len - 1), hy = y(buf[len - 1]);
  ctx.beginPath(); ctx.arc(hx, hy, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = AMBER; ctx.fill();
}

function animateScope(now) {
  scope.raf = requestAnimationFrame(animateScope);
  if (!scope.ctx && !sizeScope()) return;
  scope.display += (scope.target - scope.display) * 0.09;
  if (now - scope.lastPush >= scope.pushEvery) {
    scope.lastPush = now;
    scope.buf.push(scope.display);
    if (scope.buf.length > scope.len) scope.buf.shift();
  }
  drawScope();
}

function pushScope(v) {
  scope.target = v;
  if (reduceMotion) {
    if (!scope.ctx && !sizeScope()) return;
    scope.display = v;
    scope.buf.push(v); if (scope.buf.length > scope.len) scope.buf.shift();
    drawScope();
  }
}

function startScope() {
  sizeScope();
  if (reduceMotion) { drawScope(); return; }
  if (!scope.raf) { scope.lastPush = performance.now(); scope.raf = requestAnimationFrame(animateScope); }
}
function stopScope() { if (scope.raf) { cancelAnimationFrame(scope.raf); scope.raf = null; } }

window.addEventListener('resize', () => { scope.ctx = null; sizeScope(); drawScope(); });

/* ----------------------------------------------------------------------- *
 * Baies d'instruments + panneau avant
 * ----------------------------------------------------------------------- */
function sev(pct) { return pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : ''; }
function ledClass(pct) { return pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'on'; }
function clamp(p) { return Math.min(100, Math.max(0, p)); }

function bay(label, sub, valHtml, pct, rows) {
  const s = pct == null ? '' : sev(pct);
  const well = `<div class="well-row"><span class="well-val ${s}">${valHtml}</span></div>`;
  const gauge = pct == null ? '' :
    `<div class="gauge ${s === 'crit' ? 'crit' : ''}"><span class="fill" style="width:${clamp(pct)}%"></span><i class="redline"></i></div>`;
  const rws = rows.map((r) => `<div class="row"><span>${r[0]}</span><b>${r[1]}</b></div>`).join('');
  return `<div class="bay"><div class="bay-head"><span class="stencil">${label}</span>` +
    `<span class="bay-sub">${sub || ''}</span></div>${well}${gauge}<div class="rows">${rws}</div></div>`;
}

function pctVal(p) { return `${p.toFixed(1)}<i>%</i>`; }

function frontPanel(show) {
  const fp = document.querySelector('.frontpanel');
  const ff = document.querySelector('.fp-foot');
  if (fp) fp.style.display = show ? '' : 'none';
  if (ff) ff.style.display = show ? '' : 'none';
}

// Dispatcher selon le rôle renvoyé par le serveur.
function render(s) {
  if (s.role === 'editeur') return renderEditor(s);
  return renderAdmin(s);
}

// Éditeur : uniquement SES ressources attribuées (stockage utilisé/quota,
// CPU et RAM alloués). Pas de vue machine, pas d'oscilloscope global.
function renderEditor(s) {
  frontPanel(false);
  const usePct = s.storage.usePercent || 0;
  const sev = usePct >= 90 ? 'crit' : usePct >= 75 ? 'warn' : '';
  const bays = [];
  bays.push(bay('Mon stockage', `quota ${s.quota.storage} Mo`,
    `${usePct.toFixed(1)}<i>%</i>`, usePct,
    [['Utilisé', fmtBytes(s.storage.used)], ['Quota', fmtBytes(s.storage.total)],
     ['Disponible', fmtBytes(Math.max(0, s.storage.total - s.storage.used))]]));
  bays.push(bay('Processeur alloué', 'cgroups', `${s.cpuCores}<i> cœur(s)</i>`, null,
    [['Limite CPU', `${s.cpuCores} cœur(s)`]]));
  bays.push(bay('Mémoire allouée', 'cgroups', `${s.memoryMB}<i> Mo</i>`, null,
    [['Limite RAM', `${s.memoryMB} Mo`]]));
  document.getElementById('stats-grid').innerHTML =
    '<div class="bays-note muted">Ressources attribuées à votre espace</div>' + bays.join('');
  document.getElementById('stats-ts').textContent = new Date(s.ts).toLocaleTimeString('fr-FR');
  document.getElementById('uptime-foot').textContent = '⛁ ' + fmtBytes(s.storage.used);
  void sev;
}

function renderAdmin(s) {
  frontPanel(true);
  const cpu = s.cpu.loadPercent;
  const mem = s.memory.usePercent;
  const root = s.disk.find((d) => d.mount === '/') || s.disk[0];
  const rootPct = root ? (root.usePercent || 0) : 0;

  // --- Panneau avant ---
  const host = s.os.hostname || 'serveur';
  document.getElementById('panel-host').textContent = host;
  document.getElementById('hostname').textContent = host;
  document.getElementById('vital-uptime').textContent = fmtUptime(s.uptime);
  document.getElementById('vital-load').textContent = (s.load.avg1 || 0).toFixed(2);
  // Température (°C). En °C, les seuils 75/90 de sev()/ledClass() font sens
  // (avertissement / zone critique avant throttling). Null = pas de capteur.
  const temp = s.temperature;
  document.getElementById('vital-temp').textContent = temp ? `${Math.round(temp.main)} °C` : 'n/d';
  document.getElementById('scope-pct').innerHTML = `${Math.round(cpu)}<i>%</i>`;
  document.getElementById('panel-leds').innerHTML =
    `<span class="led ${ledClass(cpu)}">CPU</span>` +
    `<span class="led ${ledClass(mem)}">MEM</span>` +
    `<span class="led ${ledClass(rootPct)}">DSK</span>` +
    (temp ? `<span class="led ${ledClass(temp.main)}">TEMP</span>` : '') +
    `<span class="led on">LINK</span>`;
  pushScope(cpu);

  // --- Baies ---
  const bays = [];
  bays.push(bay('Processeur', `${s.cpu.cores} cœurs`, pctVal(cpu), cpu,
    [['Charge moy. 1 min', (s.load.avg1 || 0).toFixed(2)], ['Cœurs logiques', s.cpu.cores]]));

  bays.push(bay('Mémoire vive', fmtBytes(s.memory.total), pctVal(mem), mem,
    [['Utilisée', fmtBytes(s.memory.used)], ['Disponible', fmtBytes(s.memory.free)],
     ['Swap', `${fmtBytes(s.memory.swapUsed)} / ${fmtBytes(s.memory.swapTotal)}`]]));

  // Température CPU. La jauge prend la valeur en °C (échelle 0–100) ; la zone
  // rouge correspond donc au throttling thermique. Affiche le détail par cœur
  // s'il est disponible, ou un état « aucun capteur » sinon.
  if (temp) {
    const tRows = [['Maximum', `${Math.round(temp.max)} °C`]];
    if (temp.cores && temp.cores.length) {
      tRows.push(['Par cœur', temp.cores.map((c) => `${c}°`).join('  ')]);
    }
    bays.push(bay('Température', 'capteur CPU', `${Math.round(temp.main)}<i>°C</i>`, temp.main, tRows));
  } else {
    bays.push(bay('Température', 'capteur CPU', '<span class="muted">n/d</span>', null,
      [['État', 'Aucun capteur détecté']]));
  }

  if (root) {
    bays.push(bay(`Stockage ${root.mount}`, root.fs || '', pctVal(rootPct), rootPct,
      [['Utilisé', fmtBytes(root.used)], ['Libre', fmtBytes(root.available)], ['Capacité', fmtBytes(root.size)]]));
  }

  bays.push(bay('Réseau', 'débit instantané', `${fmtBytes(s.network.rx_sec)}<i>/s ↓</i>`, null,
    [['Émission ↑', `${fmtBytes(s.network.tx_sec)}/s`],
     ['Reçu (total)', fmtBytes(s.network.rx_bytes)], ['Émis (total)', fmtBytes(s.network.tx_bytes)]]));

  bays.push(bay('Système', s.os.platform || '', host, null,
    [['Distribution', `${s.os.distro} ${s.os.release}`.trim()],
     ['Disponibilité', fmtUptime(s.uptime)]]));

  s.disk.filter((d) => d !== root && d.size > 0).forEach((d) => {
    bays.push(bay(`Stockage ${d.mount}`, d.fs || '', pctVal(d.usePercent || 0), d.usePercent || 0,
      [['Utilisé', fmtBytes(d.used)], ['Capacité', fmtBytes(d.size)]]));
  });

  document.getElementById('stats-grid').innerHTML = bays.join('');
  document.getElementById('stats-ts').textContent = new Date(s.ts).toLocaleTimeString('fr-FR');
  document.getElementById('uptime-foot').textContent = '↑ ' + fmtUptime(s.uptime);
}

async function tick() {
  try {
    render(await apiGet('/api/stats'));
  } catch (e) {
    if (e.message !== 'Session expirée') {
      document.getElementById('stats-grid').innerHTML =
        `<div class="empty">Capteurs indisponibles — ${e.message}</div>`;
    }
  }
}

export function startStats(me) {
  if (me && me.role) myRole = me.role;
  if (timer) return;
  if (myRole === 'admin') startScope(); // l'oscilloscope = CPU machine, admin uniquement
  tick();
  timer = setInterval(tick, 3000);
}

export function stopStats() {
  if (timer) { clearInterval(timer); timer = null; }
  stopScope();
}
