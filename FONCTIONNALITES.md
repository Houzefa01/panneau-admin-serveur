# Fonctionnalités du panneau d'administration

Panneau web de contrôle d'un serveur Debian/Linux personnel, multi-utilisateurs,
conçu pour tourner derrière un tunnel Cloudflare **ou** sur le réseau local (en
HTTPS). Backend Node.js/Express, frontend HTML/CSS/JS sans framework.

---

## 1. Authentification & sessions
- Connexion par identifiant + mot de passe (**bcrypt**, coût 12).
- Comptes multiples stockés dans `data/users.json` (jamais en clair ; hors git).
- Un compte **admin** est amorcé depuis `.env` au premier démarrage.
- Sessions `express-session` : cookie `HttpOnly`, `Secure` (en HTTPS),
  `SameSite=Strict` ; régénération de session à la connexion (anti-fixation).
- **Rate limiting** strict sur `/login` (5 tentatives / 10 min / IP).
- Déconnexion (destruction de session).
- **Afficher / masquer le mot de passe** (bouton œil) sur tous les champs de mot
  de passe (connexion, profil, création d'utilisateur, élévation).

## 2. Rôles et permissions
| Capacité | admin | éditeur | lecteur |
|---|---|---|---|
| Tableau de bord (Vitals) | machine entière | **ses ressources allouées** | ❌ masqué |
| Fichiers — lecture / téléchargement | tout | dans son dossier | dans son dossier |
| Fichiers — écriture / modification | tout | dans son dossier | ❌ (lecture seule) |
| Terminal | shell complet | **shell isolé** (jail + quotas) | ❌ |
| Services systemd / reboot | ✅ | ❌ | ❌ |
| Élévation de privilèges (root) | ✅ | ❌ | ❌ |
| Gestion des utilisateurs | ✅ | ❌ | ❌ |
| Journal d'activité | ✅ | ❌ | ❌ |
| Profil (changer son mot de passe) | ✅ | ✅ | ✅ |

Le serveur est **seul juge** des permissions (middleware `requireRole`,
confinement par dossier) ; l'interface ne fait que masquer ce qui est interdit.

## 3. Gestion des utilisateurs (admin)
- Lister, créer, modifier, supprimer des comptes (impossible de supprimer le
  dernier admin ou son propre compte).
- Attribution d'un **dossier racine** (confinement) par compte non-admin.
- Pour un **éditeur** : quotas **CPU (cœurs), RAM (Mo), stockage (Mo)**.
- La **somme** des CPU/RAM alloués aux éditeurs ne peut pas dépasser la capacité
  réelle de la machine ; capacité restante affichée à la création.
- Réinitialisation du mot de passe d'un compte.

## 4. Tableau de bord (Vitals)
- **Admin** : CPU, RAM, disque(s), réseau, uptime, charge, **température CPU**
  (capteur principal, maximum et par cœur ; « n/d » si aucun capteur) — jauges
  rafraîchies toutes les 3 s, oscilloscope CPU en direct, LED d'état (dont TEMP).
- **Éditeur** : uniquement **ses** ressources — stockage utilisé / quota (jauge),
  CPU et RAM alloués. Aucune vue de la machine hôte.
- **Lecteur** : onglet masqué (aucune statistique).

## 5. Terminal web (xterm.js + node-pty + WebSocket)
- **Plusieurs terminaux en onglets** (sessions indépendantes, un PTY par session).
- **Admin** : shell complet de la machine.
- **Éditeur** : shell **isolé par bubblewrap** — ne voit QUE son dossier (pas de
  `/etc`, `/home`, `/root`…), **sans réseau**, environnement nettoyé (aucun secret
  de l'appli). CPU/RAM bornés par **cgroups** (`systemd-run --user --scope`,
  `CPUQuota`/`MemoryMax`/`TasksMax`).
- **Lecteur** : pas d'accès au terminal.
- Session vérifiée **avant** tout spawn ; redimensionnement synchronisé.
- **Maintien de connexion (keepalive)** : ping serveur toutes les 30 s — la
  connexion ne tombe plus après quelques minutes d'inactivité (coupure par un
  routeur/NAT du LAN, ou plus tard par le tunnel Cloudflare). En cas de perte
  réelle (réseau, veille), **reconnexion automatique** côté client.
- **Faible latence** : `TCP_NODELAY` (anti-Nagle) sur toutes les connexions et
  WebSocket sans compression — la frappe reste réactive même à distance / sur
  connexion faible.

## 6. Gestionnaire de fichiers
- Navigateur en pleine largeur ; **éditeur de texte multi-onglets** (plusieurs
  fichiers ouverts, indicateur de modifications •, `Ctrl+S`).
- Opérations : lister, lire, écrire, créer dossier/fichier, renommer, déplacer,
  copier, supprimer, **upload (glisser-déposer)**, **download** (fichier brut ou
  **dossier zippé** à la volée).
- **Menu contextuel** (clic droit) : Ouvrir, Télécharger, Renommer, Copier,
  Couper, Coller, Supprimer, Nouveau dossier/fichier, Actualiser.
- Couper / copier / coller, navigation confinée à la racine du compte.
- Lecteur : interface en lecture seule (édition désactivée, pas d'actions d'écriture).
- **Icônes SVG** monochromes (cohérentes avec le thème, pas d'emoji).
- **Compression gzip** des listings et du contenu des fichiers (réponses JSON) —
  jusqu'à ~85 % d'octets en moins, utile sur connexion faible.

## 7. Contrôle des services (admin)
- Liste des unités systemd (état, sub-état, description).
- Démarrer / arrêter / redémarrer un service ; **reboot** de la machine.
- Exécution **exclusivement** via `execFile` (jamais de commande shell concaténée) ;
  noms d'unités validés par liste blanche.

## 8. Élévation de privilèges (admin)
- Quand une opération fichier/service bute sur une permission, l'interface
  demande **un utilisateur (root par défaut) et son mot de passe**.
- Authentification via `su` dans un pseudo-terminal ; mot de passe **jamais**
  passé en argument ni journalisé. Les chemins transitent par un fichier JSON
  temporaire (aucune donnée client dans la commande shell).
- Confinement `FILE_ROOT` réappliqué même en root.
- Identifiants en mémoire de session (TTL 15 min), verrouillables manuellement.

## 9. Journal d'activité (admin)
- **Toutes les activités** horodatées avec utilisateur / rôle / IP : connexions
  et échecs, rate-limit, navigation, lecture/écriture/suppression de fichiers,
  uploads/downloads, **tentatives d'écriture refusées**, terminal, services,
  reboot, élévations, gestion des comptes, changements de mot de passe.
- Onglet **Journal** : filtrage par utilisateur / type d'événement / recherche,
  rafraîchissement automatique, **export brut** (`audit.log`, JSON Lines).
- Jamais de mot de passe ni de contenu de fichier dans le journal.

## 10. Accès réseau et chiffrement
- Écoute par défaut sur `127.0.0.1` (loopback) ; **exposable sur le LAN**
  (`HOST=0.0.0.0`).
- **TLS obligatoire hors loopback** : refus de démarrer sur une IP réseau sans
  certificat. Génération d'un certificat auto-signé : `npm run gen-cert`.
- `trust proxy: loopback` : les en-têtes `X-Forwarded-*` ne sont acceptés que du
  tunnel local → pas d'usurpation d'IP pour contourner le rate-limit depuis le LAN.
- Compatible **Cloudflare Tunnel + Access** (le tunnel se connecte en loopback).

## 11. Sécurité (transversal)
- En-têtes durcis par **Helmet** (CSP stricte, `script-src 'self'`).
- Tous les chemins client résolus + confinés (`resolveSafe`, anti-`..`, anti-lien
  symbolique, octet nul).
- Suite d'attaques vérifiée (auth bypass, évasion de confinement, escalade de
  rôle, injection de commande, cookie forgé, dépassement/sur-allocation de quota,
  usurpation XFF, WebSocket non autorisée) — **toutes bloquées**.
- **CSRF** : jeton par session (en-tête + cookie) + `SameSite=strict` ; la
  WebSocket refuse les origines tierces.
- **Bannissement d'IP automatique** (fail2ban interne) après trop d'anomalies.
- **Journal d'accès complet** (toute réponse 4xx/5xx tracée) + **rotation** du
  journal (usage disque borné) + export intégral.
- Détails et compromis assumés dans [`SECURITY.md`](SECURITY.md).

## 12. Outils & exploitation
- `npm start` — démarre le serveur.
- `npm run hash` — génère un hash bcrypt de mot de passe.
- `npm run gen-cert` — certificat TLS auto-signé (avec les IP réseau).
- `npm test` — tests unitaires (validation de chemin, middleware d'auth/rôle).
- `npm run verify` — démarre le serveur et l'exerce réellement (HTTP + WebSocket) ;
  affiche `ALL CHECKS PASSED` si tout est conforme.
- Fichier de service **systemd** d'exemple fourni (`systemd/admin-panel.service`).

---

Voir aussi : [`README.md`](README.md) (installation, Cloudflare, LAN/TLS) et
[`SECURITY.md`](SECURITY.md) (modèle de menace, rôles, tests de sécurité).
