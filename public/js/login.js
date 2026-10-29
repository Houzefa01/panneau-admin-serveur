'use strict';

import { enhancePasswords } from './ui.js';

enhancePasswords(document); // œil afficher/masquer sur le champ mot de passe

const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');
const btn = document.getElementById('submit-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Connexion…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    if (res.status === 429) {
      errorEl.textContent = 'Trop de tentatives. Réessayez dans quelques minutes.';
    } else {
      errorEl.textContent = data.error || 'Identifiants invalides.';
    }
  } catch (err) {
    errorEl.textContent = 'Erreur réseau : ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Se connecter';
    document.getElementById('password').value = '';
  }
});
