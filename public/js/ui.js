'use strict';

// Jeu d'icônes « ligne » monochromes (currentColor), cohérent avec le thème
// Châssis. viewBox 16, trait 1.5, bouts arrondis. Remplace les emoji de l'UI.
function svg(inner) {
  return '<svg class="ic-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
}

export const ICONS = {
  eye: svg('<path d="M1 8s2.6-4.5 7-4.5 7 4.5 7 4.5-2.6 4.5-7 4.5S1 8 1 8Z"/><circle cx="8" cy="8" r="1.9"/>'),
  'eye-off': svg('<path d="M2 2l12 12"/><path d="M6.6 6.7A1.9 1.9 0 0 0 9.3 9.4"/><path d="M4 4.5C2.2 5.7 1 8 1 8s2.6 4.5 7 4.5c1.1 0 2.1-.3 3-.7"/><path d="M7.2 3.6A6.3 6.3 0 0 1 8 3.5c4.4 0 7 4.5 7 4.5s-.6 1-1.7 2"/>'),
  lock: svg('<rect x="3" y="7" width="10" height="6.6" rx="1.2"/><path d="M5 7V5.3a3 3 0 0 1 6 0V7"/>'),
  unlock: svg('<rect x="3" y="7" width="10" height="6.6" rx="1.2"/><path d="M5 7V5.3a3 3 0 0 1 5.8-1.1"/>'),
  folder: svg('<path d="M1.5 4.6a1 1 0 0 1 1-1h3l1.3 1.6H13a1 1 0 0 1 1 1v5.7a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1Z"/>'),
  'folder-open': svg('<path d="M1.6 6.6 2.9 12.4a.6.6 0 0 0 .6.5h9a.6.6 0 0 0 .6-.45l1.2-4.8a.6.6 0 0 0-.58-.75H4.2a.6.6 0 0 0-.58.46Z"/><path d="M1.6 8.2V4.6a1 1 0 0 1 1-1h2.9l1.3 1.6H12a1 1 0 0 1 1 1v1"/>'),
  file: svg('<path d="M4 1.6h5l4 3.6v9.2H4Z"/><path d="M8.9 1.8V5.4H13"/>'),
  link: svg('<path d="m6.4 9.6 3.2-3.2"/><path d="M7.2 4.7 8.7 3.2a2.3 2.3 0 0 1 3.3 3.3L10.5 8"/><path d="M8.8 11.3 7.3 12.8A2.3 2.3 0 0 1 4 9.5l1.5-1.5"/>'),
  download: svg('<path d="M8 2.2v7.6"/><path d="M4.7 6.7 8 10l3.3-3.3"/><path d="M2.6 13.4h10.8"/>'),
  upload: svg('<path d="M8 10.2V2.6"/><path d="M4.7 5.9 8 2.6l3.3 3.3"/><path d="M2.6 13.4h10.8"/>'),
  refresh: svg('<path d="M13.2 5A5.6 5.6 0 1 0 13.8 8"/><path d="M13.4 1.7v3.5H9.9"/>'),
  trash: svg('<path d="M2.6 4.2h10.8"/><path d="M6 4.2V2.9h4v1.3"/><path d="M3.8 4.2 4.4 13.2h7.2l.6-9"/>'),
  pencil: svg('<path d="M10.8 2.6 13.4 5.2 6 12.6l-3.1.7.7-3.1Z"/>'),
  scissors: svg('<circle cx="4.1" cy="4.1" r="1.9"/><circle cx="4.1" cy="11.9" r="1.9"/><path d="m5.6 5.3 7.7 6.8M5.6 10.7 13.3 3.9"/>'),
  copy: svg('<rect x="5.4" y="5.4" width="8.1" height="8.1" rx="1.2"/><path d="M3.4 10.6h-.9a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1h7.1a1 1 0 0 1 1 1v.9"/>'),
  paste: svg('<rect x="3" y="2.9" width="10" height="10.6" rx="1.2"/><path d="M5.9 2.9V1.8h4.2v1.1"/><path d="M6 7.3h4M6 9.7h4"/>'),
  close: svg('<path d="m3.6 3.6 8.8 8.8M12.4 3.6l-8.8 8.8"/>'),
  'level-up': svg('<path d="M8 13.2V3.6"/><path d="M4.5 7.1 8 3.6l3.5 3.5"/>'),
  'folder-plus': svg('<path d="M1.5 4.6a1 1 0 0 1 1-1h3l1.3 1.6H13a1 1 0 0 1 1 1v5.7a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1Z"/><path d="M8 7.4v3.4M6.3 9.1h3.4"/>'),
  'file-plus': svg('<path d="M4 1.6h5l4 3.6v9.2H4Z"/><path d="M8.9 1.8V5.4H13"/><path d="M8 7.8v3.2M6.4 9.4h3.2"/>'),
  plus: svg('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  'user-plus': svg('<circle cx="6" cy="5" r="2.4"/><path d="M1.7 13.2a4.4 4.4 0 0 1 8.6 0"/><path d="M12.6 4.6v4M10.6 6.6h4"/>'),
  power: svg('<path d="M8 1.7v6.1"/><path d="M11.6 3.7a5.2 5.2 0 1 1-7.2 0"/>'),
};

export function icon(name) { return ICONS[name] || ''; }

// Remplit chaque élément [data-icon="nom"] par l'icône SVG correspondante.
export function applyIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    if (ICONS[name]) el.innerHTML = ICONS[name];
  });
}

// Ajoute un bouton « œil » (afficher/masquer) à chaque champ mot de passe.
export function enhancePasswords(root = document) {
  root.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.eye) return;
    input.dataset.eye = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.tabIndex = -1;
    const setLabel = (show) => {
      const t = show ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
      btn.title = t; btn.setAttribute('aria-label', t);
    };
    btn.innerHTML = ICONS.eye;
    setLabel(false);
    wrap.appendChild(btn);

    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? ICONS['eye-off'] : ICONS.eye;
      setLabel(show);
      const pos = input.value.length;
      input.focus();
      try { input.setSelectionRange(pos, pos); } catch (e) { /* champ non sélectionnable */ }
    });
  });
}
