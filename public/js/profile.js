'use strict';

import { apiPost, toast } from './api.js';

const ROLE_LABEL = { admin: 'Administrateur (contrôle total)', editeur: 'Éditeur', lecteur: 'Lecteur' };
let bound = false;

export function initProfile(me) {
  document.getElementById('pf-user').textContent = me.username;
  document.getElementById('pf-role').textContent = ROLE_LABEL[me.role] || me.role;
  let rootLine = me.fileRoot;
  if (me.quota) rootLine += ` · CPU ${me.quota.cpu} · RAM ${me.quota.memory} Mo · Disque ${me.quota.storage} Mo`;
  document.getElementById('pf-root').textContent = rootLine;

  if (bound) return;
  bound = true;
  document.getElementById('pf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('pf-msg');
    msg.textContent = '';
    msg.style.color = '';
    const current = document.getElementById('pf-current').value;
    const next = document.getElementById('pf-new').value;
    const confirm = document.getElementById('pf-confirm').value;
    if (next !== confirm) { msg.textContent = 'La confirmation ne correspond pas.'; return; }
    try {
      await apiPost('/api/auth/password', { currentPassword: current, newPassword: next });
      msg.style.color = 'var(--green)';
      msg.textContent = 'Mot de passe mis à jour.';
      toast('Mot de passe mis à jour.', 'ok');
      e.target.reset();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}
