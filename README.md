# Panneau d'administration serveur

Panneau web de contrôle complet pour un serveur Debian 12 personnel : état
système, terminal intégré, gestionnaire de fichiers, contrôle des services
systemd. **Multi-utilisateurs** (admin / éditeur / lecteur).

**Mode de déploiement actuel : réseau local en HTTPS** (`HOST=0.0.0.0` + TLS).
Le serveur **refuse de démarrer sur une IP réseau sans TLS**, pour ne jamais
exposer les identifiants en clair.

> **Tunnel Cloudflare : prévu plus tard, pas activé pour l'instant.** L'archi
> est déjà compatible (voir [« Déploiement derrière Cloudflare Tunnel »](#déploiement-derrière-cloudflare-tunnel-pour-plus-tard)
> et le dossier [`cloudflare/`](cloudflare/)). Aucun changement de code ne sera
> nécessaire le jour venu — uniquement la config `cloudflared`.

---

## Pile technique

- **Backend** : Node.js + Express 5
- **Terminal** : `node-pty` (PTY serveur) + `xterm.js` + `@xterm/addon-fit`, via WebSocket (`ws`)
- **Frontend** : HTML/CSS/JS vanilla, sans framework
- **Stats** : `systeminformation`
- **Auth** : `express-session` + `bcrypt` + `express-rate-limit`
- **Sécurité HTTP** : `helmet`
- **Upload** : `multer`  — **Archives** : `archiver` (téléchargement de dossier zippé)
- **Config** : `dotenv`

---

## Installation

```bash
# 1. Dépendances
npm ci          # installe exactement le contenu de package-lock.json

# 2. Configuration
cp .env.example .env
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(48).toString('hex'))" >> .env
node scripts/hash-password.js 'VOTRE_MOT_DE_PASSE'   # copiez ADMIN_PASSWORD_HASH dans .env
$EDITOR .env    # renseignez ADMIN_USER, et le hash généré

# 3. Vérification de bout en bout
npm run verify  # doit afficher : ALL CHECKS PASSED

# 4. Tests unitaires
npm test

# 5. Démarrage
npm start
```

Avec le `.env` par défaut (LAN + HTTPS), le serveur écoute sur
`https://0.0.0.0:3000` et affiche les URL `https://<ip-lan>:3000`. Voir
[« Accès sur le réseau local »](#accès-sur-le-réseau-local-lan).

### Génération du hash de mot de passe

```bash
node scripts/hash-password.js 'mon mot de passe'
# -> imprime ADMIN_PASSWORD_HASH=$2b$12$....   (le mot de passe en clair n'est jamais écrit)
```

Astuce : préfixez la commande d'un espace (` node ...`) pour éviter qu'elle
n'entre dans l'historique du shell, ou lancez le script sans argument et
saisissez le mot de passe au prompt.

---

## Accès sur le réseau local (LAN) — mode actuel

C'est le mode de déploiement par défaut. Le `.env` fourni est déjà réglé ainsi :

```bash
npm run gen-cert          # certificat TLS auto-signé (inclut vos IP réseau)
# dans .env (déjà en place) :
#   HOST=0.0.0.0
#   TLS_KEY=./certs/key.pem
#   TLS_CERT=./certs/cert.pem
#   COOKIE_SECURE=true
npm start                 # affiche les URL https://<ip-lan>:3000
```

Accès : `https://localhost:3000` (sur la machine) ou `https://<ip-lan>:3000`
(depuis le réseau). Le serveur **refuse de démarrer sur une IP réseau sans TLS**
(pour ne pas exposer les mots de passe en clair). Le navigateur avertira une
fois pour le certificat auto-signé : acceptez-le. Recommandé : limiter l'accès
au sous-réseau de confiance par pare-feu (voir `SECURITY.md`).

> ⚠️ En HTTPS, utilisez bien `https://…`. Un `http://localhost:3000` ne répond
> pas : le serveur ne parle que HTTPS quand `TLS_KEY`/`TLS_CERT` sont définis.

---

## Déploiement derrière Cloudflare Tunnel (pour plus tard)

> **Non activé actuellement.** Cette section et le dossier
> [`cloudflare/`](cloudflare/) décrivent l'ajout futur d'un tunnel pour
> exposer le panneau sur Internet **sans ouvrir de port**. Aucun changement de
> code n'est requis : seule la config `cloudflared` ci-dessous.

Le tunnel chiffre et authentifie tout l'accès distant. Comme l'origine tourne
désormais en **HTTPS auto-signé** sur la boucle locale, l'ingress pointe sur
`https://127.0.0.1:3000` avec `noTLSVerify: true` (certificat local non vérifié,
mais le trafic reste chiffré jusqu'à l'application). Bloc pour
`/etc/cloudflared/config.yml` (copie prête dans
[`cloudflare/config.example.yml`](cloudflare/config.example.yml)) :

```yaml
tunnel: <ID-DE-VOTRE-TUNNEL>
credentials-file: /etc/cloudflared/<ID-DE-VOTRE-TUNNEL>.json

ingress:
  - hostname: admin.example.com
    service: https://127.0.0.1:3000
    originRequest:
      # Origine en certificat auto-signé sur la boucle locale.
      noTLSVerify: true
      # La WebSocket du terminal a besoin de connexions longues.
      connectTimeout: 30s
      disableChunkedEncoding: false
  # Règle de repli obligatoire.
  - service: http_status:404
```

Puis :

```bash
sudo systemctl restart cloudflared
```

**Protégez `admin.example.com` avec une politique Cloudflare Access** (email,
OTP, ou clé) : c'est la première barrière d'authentification, en amont de
l'application. Le code fait déjà confiance aux en-têtes `X-Forwarded-*`
**uniquement** depuis la boucle locale (`trust proxy: loopback`), donc l'IP
réelle du client (rate limiting) et le schéma `https` sont correctement repris
du tunnel sans risque d'usurpation depuis le LAN.

## Service systemd

Un fichier d'exemple est fourni dans [`systemd/admin-panel.service`](systemd/admin-panel.service),
réglé pour tourner sous un **compte non-root dédié (`panel`)** :

```bash
sudo cp systemd/admin-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now admin-panel
```

La procédure complète (création du compte `panel`, droits des fichiers, TLS,
pare-feu, quotas) est détaillée dans [`DEPLOIEMENT.md`](DEPLOIEMENT.md).

Le terminal admin et les fichiers s'exécutent **sans privilège** ; les actions
root (services systemd, reboot, écritures système) déclenchent une **élévation
ponctuelle** (mot de passe root via `su`) — voir [`SECURITY.md`](SECURITY.md).

---

## Fonctionnalités

| Module        | Détail |
|---------------|--------|
| Auth & rôles  | comptes multiples (`data/users.json`), bcrypt, rate limiting sur `/login`, sessions régénérées. Rôles **admin / éditeur / lecteur** |
| Utilisateurs  | l'admin crée/modifie/supprime des comptes, attribue un dossier racine ; pour un **éditeur**, des quotas **CPU / RAM / stockage** |
| Profil        | chaque compte change son propre mot de passe |
| Terminal      | **plusieurs terminaux en onglets** (sessions indépendantes). admin : shell complet. **Éditeur : shell isolé** (bubblewrap — ne voit que son dossier, sans réseau) + quotas CPU/RAM (cgroups). Lecteur : aucun. Session vérifiée avant tout spawn |
| Fichiers      | navigateur + **éditeur multi-onglets** (plusieurs fichiers ouverts séparément, indicateur de modifications, Ctrl+S). list / read / write / mkdir / create / rename / move / copy / delete / upload (drag&drop) / download (fichier ou dossier zippé), **confiné à la racine du compte**. Lecteur = lecture seule |
| Élévation     | admin uniquement : si une opération bute sur une permission, demande utilisateur + mot de passe root (`su`) et rejoue en root |
| Monitoring    | CPU, RAM, disque, réseau, uptime, charge — jauges rafraîchies |
| Services      | admin : lister / start / stop / restart systemd + reboot, **via `execFile` uniquement** |
| Journal       | **toutes les activités** (connexion, navigation, lecture/écriture, uploads/downloads, tentatives refusées, terminal, services, élévations, comptes) horodatées avec utilisateur/rôle/IP dans `audit.log`. Onglet **Journal** (admin) : filtrage par utilisateur/événement/recherche + export brut |

---

## Structure

```
server/      index.js, config.js, auth.js, paths.js, audit.js,
             terminal.js, files.js, stats.js, services.js
public/      login.html, index.html, css/, js/
scripts/     hash-password.js, verify.js
test/        paths.test.js, auth.test.js
systemd/     admin-panel.service
```

## Scripts npm

- `npm start` — démarre le serveur
- `npm run hash` — génère un hash bcrypt
- `npm test` — tests unitaires (validation de chemin + middleware d'auth)
- `npm run verify` — démarre le serveur et l'exerce réellement ; affiche
  `ALL CHECKS PASSED` si tout est conforme

---

Voir [`SECURITY.md`](SECURITY.md) pour le modèle de menace et les limites de la v1.
