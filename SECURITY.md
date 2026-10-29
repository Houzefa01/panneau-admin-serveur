# Sécurité — modèle de menace et limites

Ce panneau donne **un contrôle total** sur le serveur (terminal root potentiel,
accès complet au filesystem, contrôle des services, reboot).

**Mode de déploiement actuel : réseau local en HTTPS.** Le serveur écoute sur
`HOST=0.0.0.0` en TLS et **refuse de démarrer sur une IP réseau sans
certificat** (chiffrement obligatoire pour ne pas exposer les identifiants).
Dans ce mode, **la seule barrière est l'authentification applicative** : il faut
donc un mot de passe fort et restreindre l'accès au sous-réseau de confiance.

**Tunnel Cloudflare : prévu plus tard (pas activé).** L'architecture est déjà
prête à l'accueillir (voir [`cloudflare/`](cloudflare/)) ; il ajoutera une
barrière d'authentification en amont (Cloudflare Access). Aucun changement de
code requis le jour venu.

## Modèle de confiance

```
Aujourd'hui (LAN) :
  Client LAN ──HTTPS (cert auto-signé)──> 0.0.0.0:3000 ──> Panneau (auth : session)

Plus tard (tunnel, défense en profondeur) :
  Internet ──TLS──> Cloudflare Access (auth #1) ──Tunnel chiffré──> cloudflared
                                                                       │
                                                          https://127.0.0.1:3000
                                                                       │
                                                          Panneau (auth #2 : session)
```

- **LAN + HTTPS (actuel)** : le trafic est chiffré ; la protection repose sur
  l'auth applicative (bcrypt, rôles, rate limiting) + le pare-feu réseau.
- **Cloudflare Access (futur)** : barrière #1 qui empêchera un inconnu
  d'atteindre l'application ; l'auth applicative restera comme défense #2.

Le serveur écoute sur `HOST` (par défaut `0.0.0.0` dans le `.env` fourni).
Repasser à `127.0.0.1` le rend injoignable hors tunnel/loopback.

## Mesures en place

- **Écoute** par défaut sur `127.0.0.1` (loopback). Exposable sur le réseau local
  via `HOST=0.0.0.0`, mais alors **TLS obligatoire** (voir ci-dessous).
- **Mot de passe** : bcrypt cost 12, jamais stocké ni journalisé en clair ;
  seul le hash vit dans `.env` (ignoré par git).
- **Sessions** : cookie `httpOnly`, `secure`, `sameSite=strict`, nom `sid`,
  régénération à la connexion (anti-fixation), `trust proxy` pour `secure`
  derrière le tunnel.
- **Rate limiting** strict sur `/api/auth/login` (5 tentatives / 10 min / IP).
- **WebSocket terminal** : la session est vérifiée *avant* tout spawn de PTY ;
  une connexion non authentifiée est fermée en 401.
- **Aucune commande shell concaténée** : `execFile`/`spawn` avec arguments
  séparés partout (services, reboot). Noms d'unités validés par liste blanche
  de caractères.
- **Chemins de fichiers** : tout chemin client passe par `resolveSafe()` qui
  résout (`path.resolve` + `fs.realpath`, liens symboliques inclus) et **confine
  dans `FILE_ROOT`** avant toute opération. Octets nuls et `..` rejetés.
- **En-têtes** durcis par `helmet` (CSP, etc.).
- **Journal d'audit** horodaté (`audit.log`, JSON Lines), avec utilisateur +
  rôle + IP pour **chaque activité** : connexions réussies/échouées, rate-limit,
  navigation et lecture de fichiers, écritures/créations/renommages/déplacements/
  copies/suppressions, uploads/downloads, **tentatives d'écriture refusées**,
  ouverture/fermeture/refus de terminal, actions services, reboot, élévations,
  gestion des comptes, changements de mot de passe. Consultable et filtrable
  (par utilisateur / événement / recherche) dans l'onglet **Journal** (admin),
  export brut disponible. Jamais de mot de passe ni de contenu de fichier.

## Élévation de privilèges (compte root)

Le serveur tourne avec les droits de son utilisateur. Quand une opération
fichier ou service bute sur une permission, l'API renvoie `403 { code:
'NEED_SUDO' }` et l'interface demande un **compte privilégié (root par défaut)
et son mot de passe**. L'opération est alors rejouée en root.

- **Authentification via `su`** dans un pseudo-terminal (`node-pty`) : le mot de
  passe est saisi sur le tty, **jamais passé en argument, jamais journalisé**.
- **Aucune donnée client dans une ligne de commande shell** : les chemins
  transitent par un fichier JSON temporaire (`fs-worker.js`) ; les composants de
  la commande `su -c` sont validés par liste blanche de caractères puis quotés.
- **Confinement `FILE_ROOT` réappliqué dans le worker root** : même en root, le
  panneau ne peut pas sortir de la racine configurée (vérifié).
- **Identifiants en mémoire de session** (MemoryStore, jamais sur disque ni dans
  le cookie), purgés au **verrouillage manuel** (bouton 🔒), à la déconnexion, ou
  après expiration (`ELEVATE_TTL_MS`, 15 min par défaut).
- Opérations privilégiées tracées dans l'audit (`elevated: true`).

## Multi-utilisateurs et rôles

Comptes stockés dans `data/users.json` (hors git, mode 600), mots de passe en
bcrypt (coût 12). Un admin est amorcé depuis `.env` au premier démarrage.

| Rôle | Fichiers | Terminal | Services / Reboot | Élévation | Gestion comptes |
|------|----------|----------|-------------------|-----------|-----------------|
| **admin** | tout (racine `/` ou configurée) | shell complet | oui | oui | oui |
| **éditeur** | lire/écrire **dans son dossier** | **shell isolé** (bubblewrap) + quotas CPU/RAM | non | non | non |
| **lecteur** | **lire / télécharger** dans son dossier | **aucun** | non | non | non |

- **Confinement fichiers** : chaque rôle a une racine (`fileRoot`) ; toute
  opération passe par `resolveSafe(racine, …)` (chemins résolus + realpath,
  rejet de `..`, octets nuls, liens hors racine). Chaque racine est indépendante.
- **Autorité serveur** : l'UI masque ce qui est interdit, mais **le serveur
  applique seul** les rôles (`requireRole`) et le confinement — masquer un bouton
  n'est jamais la sécurité.
- **Terminal éditeur isolé** : `bubblewrap` (namespaces) — le shell **ne voit que
  son dossier**, monté sur un point neutre `/coffre` (ne révèle ni le nom
  d'utilisateur ni l'arborescence réelle de l'hôte ; pas de `/etc`, `/home`,
  `/root`…), sans réseau (`--unshare-all`), environnement nettoyé (`--clearenv`,
  aucun secret de l'appli).
- **Quotas éditeur** : CPU et RAM imposés par cgroups v2 via
  `systemd-run --user --scope` (`CPUQuota`, `MemoryMax`, `MemorySwapMax=0`,
  `TasksMax=200` anti fork-bomb). Stockage : quota logiciel (vérif `du` avant
  écriture/upload/copie via l'API). La **somme** CPU/RAM allouée aux éditeurs ne
  peut pas dépasser la capacité réelle de la machine.

## Accès sur le réseau local (LAN)

Le panneau peut être exposé sur le LAN (`HOST=0.0.0.0`). Dans ce cas il n'y a
plus Cloudflare Access en amont : seule l'auth de l'application protège. Mesures
appliquées et **vérifiées** sur l'accès LAN :

- **TLS obligatoire hors loopback** : le serveur refuse de démarrer sur une IP
  réseau sans certificat (sauf `ALLOW_INSECURE_LAN=true`). Génération :
  `npm run gen-cert` (auto-signé, SAN = localhost + IP des cartes réseau). Les
  identifiants — y compris le mot de passe root de l'élévation — sont ainsi
  **chiffrés sur le réseau**.
- **Cookies `Secure` + `HttpOnly` + `SameSite=Strict`** (vérifié sur HTTPS LAN).
- **`trust proxy: loopback`** : les en-têtes `X-Forwarded-*` ne sont acceptés que
  depuis la boucle locale (le tunnel Cloudflare). Un client direct sur le LAN ne
  peut **pas usurper `X-Forwarded-For`** pour contourner le rate-limit de login
  (vérifié : le 429 se déclenche malgré des XFF tournants).
- Rôles, confinement par dossier, jail terminal et refus WebSocket : identiques
  et re-vérifiés sur l'accès LAN/HTTPS.

**Recommandé** : restreindre par pare-feu au sous-réseau de confiance, p. ex.
`sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp` (et refuser le
reste), et conserver un mot de passe fort par compte.

## Tests de sécurité effectués

Suite d'attaques exécutée contre le serveur réel (toutes **bloquées**) :

- **Accès sans session** sur toutes les routes API → 401 (jamais de fuite).
- **Évasion de confinement** (éditeur) : `..`, chemins absolus, double-encodage
  `%2e`, octet nul, racine d'un autre utilisateur → refus.
- **Lecteur en écriture** (write/mkdir/delete/rename/upload) → 403.
- **Élévation de rôle** : éditeur/lecteur vers `users`, `services`, `reboot`,
  `elevate` → 403.
- **Injection de commande** : nom de service `x; touch …`, champ utilisateur
  d'élévation `root; …` → rejetés par liste blanche ; aucun fichier témoin créé.
- **Cookie forgé / session invalide** → 401.
- **Dépassement de quota** stockage (507) et **sur-allocation** CPU/RAM globale → refus.
- **Pas de mot de passe en clair** dans `audit.log`.
- **WebSocket terminal** sans session ou rôle lecteur → refusé avant tout spawn.

## Ce qui n'est PAS couvert en v1 (compromis assumés)

- **Pas de 2FA applicative.** Le second facteur est délégué à Cloudflare Access
  (OTP, SSO, clés). L'application elle-même n'a qu'un mot de passe par compte.
- **Quota de stockage = soft (API).** Le quota disque est vérifié sur l'API
  fichiers. Dans le **terminal éditeur**, le CPU et la RAM sont strictement
  bornés (cgroups), mais l'écriture disque dans le dossier monté n'est pas
  plafonnée sans quotas de système de fichiers (XFS/ext4 `prjquota`). Pour un
  plafond disque strict, activer un quota fs sur le dossier de l'éditeur.
- **Racines des éditeurs/lecteurs.** Le confinement est logique (même utilisateur
  OS que le serveur). **Ne jamais** attribuer à un non-admin une racine contenant
  le dossier de l'application, `.env`, `data/users.json` ou des secrets : il
  pourrait les lire via l'API fichiers. Choisir des dossiers dédiés et isolés.
- **Isolation terminal = bubblewrap (espaces de noms).** Solide contre l'accès
  fichiers/réseau, mais repose sur le noyau ; une faille noyau d'évasion de
  namespace sort du périmètre. Pour une isolation maximale, conteneur/VM dédié.
- **La sécurité repose en amont sur Cloudflare Access.** Si l'application était
  exposée directement (sans tunnel/Access), elle ne disposerait que de son mot
  de passe + rate limiting : insuffisant pour un accès root. **Ne jamais
  exposer le port directement.**
- **CSP `style-src 'unsafe-inline'`** : nécessaire car `xterm.js` injecte une
  feuille de style en ligne. Le `script-src` reste strict (`'self'`,
  aucun script inline).
- **Store de session en mémoire** : convient à un process unique mono-compte ;
  les sessions sont perdues au redémarrage (reconnexion simple). Pas de store
  partagé.
- **Pas de protection CSRF par token dédié.** Mitigé par `sameSite=strict` +
  l'API qui exige `Content-Type: application/json` (les formulaires HTML
  cross-site ne peuvent pas la forger) + Cloudflare Access en amont. Un token
  CSRF reste recommandé pour un durcissement ultérieur.
- **Pas de limite de débit globale** hors login ; une session authentifiée est
  considérée de confiance.
- **Le terminal et le gestionnaire de fichiers s'exécutent avec les privilèges
  du process.** Le déploiement **recommandé** (voir `DEPLOIEMENT.md`) fait tourner
  le service sous un compte **non-root** dédié (`panel`) : au quotidien le panneau
  n'a aucun privilège, et les actions root passent par une **élévation `su`**
  ponctuelle. Une compromission de session ne donne alors PAS un root immédiat.
  Si le service est malgré tout lancé en root, il donne un accès root complet
  (« contrôle total ») et toute compromission de session = compromission machine.

## Recommandations de durcissement

1. **Toujours** activer une politique Cloudflare Access stricte sur le hostname.
2. Restreindre `FILE_ROOT` si l'accès à tout `/` n'est pas requis.
3. Privilégier un utilisateur dédié + règles `sudo`/`polkit` ciblées plutôt que
   root, par exemple dans `/etc/sudoers.d/admin-panel` :
   ```
   admin-panel ALL=(root) NOPASSWD: /usr/bin/systemctl start *, /usr/bin/systemctl stop *, /usr/bin/systemctl restart *, /usr/bin/systemctl reboot
   ```
   (et adapter `services.js` pour préfixer `sudo`), ou des règles polkit
   équivalentes.
4. Rotation / archivage du `audit.log` (logrotate).
5. Surveiller les échecs de connexion et `terminal_denied` dans l'audit.

## Durcissement complémentaire (2026-06-20)

- **CSRF** : jeton par session (cookie lisible `csrf` + en-tête `X-CSRF-Token`
  exigé sur toute mutation authentifiée), en plus de `SameSite=strict`. La
  WebSocket du terminal refuse aussi les handshakes d'une autre origine.
- **Bannissement d'IP (fail2ban interne)** : les anomalies NON authentifiées
  (4xx : sondes 404, accès refusés, injections rejetées) sont comptées par IP ;
  au-delà du seuil (`BAN_THRESHOLD`, défaut 20/min) l'IP est bloquée
  (`BAN_DURATION_MS`, défaut 15 min). Loopback (tunnel/local) et compte
  propriétaire exemptés.
- **Journal d'accès complet** : toute réponse anormale (4xx/5xx) est tracée avec
  méthode, chemin, statut, IP et user-agent (`access_unauth`, `access_forbidden`,
  `probe_notfound`, `request_rejected`, `rate_limited`, `ip_banned`,
  `csrf_denied`…). Affichage intégral + export complet (archives incluses).
- **Rotation du journal** : `audit.log` tourne au-delà de `AUDIT_MAX_BYTES`
  (défaut 5 Mo, `AUDIT_KEEP` archives) → l'usage disque reste borné même sous un
  flot de sondes. Lecture du journal fichier par fichier (mémoire bornée).
- **Quotas éditeur en root** : `systemd-run --scope` (scope système) applique
  CPU/RAM même sans session utilisateur — les quotas fonctionnent en déploiement
  root. Pré-vérification d'accès au dossier de l'éditeur (erreur claire au lieu
  d'un échec bwrap cryptique).
- **Limite d'upload** bornée par défaut (5 Gio, `MAX_UPLOAD_BYTES`, 0 = illimité).

## Déploiement non-root recommandé (2026-06-22)

- **Service sous compte `panel` non privilégié** (unité systemd `User=panel`). Le
  terminal admin n'est **plus root par défaut** ; les opérations privilégiées
  (écritures système, `systemctl`, reboot) déclenchent une **élévation `su`**
  (mot de passe root, TTL 15 min, jamais journalisé) — mécanisme déjà en place.
- **`NoNewPrivileges`/`ProtectSystem` volontairement désactivés** dans l'unité :
  ils casseraient `su` (élévation) et les écritures système, raison d'être de
  l'outil. Le durcissement repose sur : compte non privilégié + TLS + mot de
  passe fort + pare-feu.
- **Secrets retirés de l'environnement du shell admin** : `env`/`printenv` dans le
  terminal ne révèle ni `SESSION_SECRET`, ni les hash, ni l'existence du compte
  propriétaire (`GOD_USER`/`GOD_PASSWORD_HASH`).
- **Quotas éditeur en non-root** : appliqués si `loginctl enable-linger panel`
  (session `--user`) ; sinon l'isolation fichiers (bubblewrap) reste active et un
  avertissement clair est tracé dans `journalctl`.

## Audit du 2026-06-19 (mode LAN + HTTPS)

Audit complet mené contre le serveur réel en HTTPS (localhost + IP LAN), 3 rôles.
**Tout bloqué / conforme** :

- **Auth/session** (6) : APIs protégées → 401, page → redirect `/login`, cookie
  forgé → 401, mauvais mot de passe → pas de session, cookie
  `HttpOnly+Secure+SameSite=Strict`.
- **Escalade de rôle** (7) : éditeur refusé sur `/api/users`, `/api/logs`,
  `/api/elevate`, `/api/services`, reboot → 403 ; lecteur → stats 403, write 403.
- **Confinement chemins** (6) : `/etc/passwd`, `../../`, lien symbolique, octet
  nul → tous refusés ; lecture/écriture dans la racine OK (contrôle positif).
- **Injection commande** (2) : unité `ssh;reboot` → 400 ; `$()` inopérant.
- **Quotas** (2) : CPU > cœurs et RAM > total → rejetés.
- **Transport/en-têtes** (4) : HTTP clair refusé, CSP + `nosniff` présents,
  `x-powered-by` masqué.
- **Exposition secrets** (5) : `.env`, `users.json`, `audit.log`, `config.js`,
  `package.json` non servis ; **0 secret** dans les 279 lignes du journal réel.
- **Terminal WebSocket** (5) : sans session → 401, lecteur → 403, cookie forgé →
  401, éditeur/admin → acceptés.
- **Jail éditeur** (bubblewrap) : `/home/Hsavatra/Bureau/serveur/.env` et tout
  voisinage **inaccessibles**, réseau coupé, arborescence hôte invisible.

**Correctif issu de l'audit** : le dossier de l'éditeur est désormais monté sur
`/coffre` (point neutre) au lieu de son chemin absolu — supprime la divulgation
du nom d'utilisateur / de l'arborescence de l'hôte au shell confiné.

## Signaler un problème

Projet personnel mono-utilisateur : corrigez et redéployez. En cas de doute sur
une compromission, révoquer la session (`npm start` redémarre = sessions
purgées), changer le mot de passe (`scripts/hash-password.js`) et le
`SESSION_SECRET`.
