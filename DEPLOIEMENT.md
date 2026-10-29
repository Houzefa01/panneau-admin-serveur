# Déploiement sur Debian 12 (LAN + HTTPS, service NON-ROOT + élévation)

Procédure pour installer le panneau sur un serveur Debian 12, accessible sur le
réseau local en HTTPS, tournant sous un **compte dédié non privilégié** (`panel`)
via systemd. Quand une action exige root, le panneau demande une **élévation
ponctuelle** (mot de passe root, via `su`, valable 15 min, jamais journalisé).
Le tunnel Cloudflare viendra plus tard sans rien changer (voir [`cloudflare/`](cloudflare/)).

> Pourquoi non-root ? Au quotidien (terminal admin, navigation fichiers, Vitals)
> le service n'a aucun privilège : une faille du panneau ne donne donc PAS un
> root immédiat. Les actions privilégiées (écrire hors des dossiers autorisés,
> `systemctl`, reboot) restent possibles mais exigent une ré-authentification.

> Les commandes serveur sont à lancer en root (ou préfixées de `sudo`).

> **Vous avez déjà une installation qui tourne en root ?** Un script de migration
> automatique convertit tout en place (compte `panel`, journal, droits, unité,
> redémarrage + vérification) — sautez aux §1 (prérequis) puis lancez simplement :
> ```bash
> sudo bash /opt/admin-panel/scripts/migrate-nonroot.sh
> ```
> Les sections ci-dessous décrivent la même chose étape par étape (install neuve).

---

## 1. Prérequis système (une fois)

`node-pty` et `bcrypt` sont des **modules natifs** : il faut une toolchain de
compilation pour `npm ci`.

```bash
apt update
# Node.js 20 LTS (le dépôt Debian est trop ancien) :
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Toolchain native (node-pty, bcrypt) + outils du projet :
apt install -y build-essential python3 bubblewrap openssl git unzip
```

Vérifs :
```bash
node -v          # v20.x
which bwrap      # /usr/bin/bwrap  (jail des éditeurs)
```

> **bubblewrap en non-root** : le jail des éditeurs utilise des *user namespaces*
> non privilégiés. Sur Debian 12 ils sont généralement actifs. Si le terminal
> d'un éditeur échoue avec une erreur de *namespace*, activez-les :
> ```bash
> echo 'kernel.unprivileged_userns_clone=1' > /etc/sysctl.d/00-userns.conf
> sysctl --system
> ```

---

## 2. Créer le compte de service `panel`

```bash
# Compte système, sans possibilité de connexion directe (le service exec node) :
useradd --system --create-home --home-dir /home/panel --shell /usr/sbin/nologin panel
```

> Ce compte n'a **aucun** privilège sudo : c'est voulu. L'élévation se fait dans
> le panneau en saisissant le mot de passe **root** (compte cible de `su`).

---

## 3. Transférer le projet

**Option A — l'archive zip** (depuis votre poste) :
```bash
scp panneau-admin-serveur-*.zip root@IP_SERVEUR:/tmp/
mkdir -p /opt/admin-panel
unzip /tmp/panneau-admin-serveur-*.zip -d /opt/admin-panel
```

**Option B — git** :
```bash
git clone <votre-remote> /opt/admin-panel
```

---

## 4. Installer les dépendances

```bash
cd /opt/admin-panel
npm ci               # compile node-pty + bcrypt (d'où la toolchain ci-dessus)
```

---

## 5. Configurer (`.env`) + certificat TLS

```bash
cd /opt/admin-panel
cp .env.example .env

# Secret de session (48 octets aléatoires) :
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(48).toString('hex'))" >> .env

# Hash du mot de passe admin (le mot de passe en clair n'est jamais écrit) :
node scripts/hash-password.js 'VOTRE_MOT_DE_PASSE_FORT'
#   -> copiez la ligne ADMIN_PASSWORD_HASH=... affichée

nano .env
```

`.env` doit contenir **au minimum** :
```ini
HOST=0.0.0.0
PORT=3000
SESSION_SECRET=...            # (déjà ajouté ci-dessus)
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=$2b$12$...# collez le hash généré
COOKIE_SECURE=true
FILE_ROOT=/                   # racine d'administration (lecture libre ; écritures
                              # protégées -> élévation quand nécessaire)
TLS_KEY=./certs/key.pem
TLS_CERT=./certs/cert.pem
# Journal dans data/ (dossier inscriptible par le compte panel) :
AUDIT_LOG=/opt/admin-panel/data/audit.log
```

Générer le certificat auto-signé (il inclut automatiquement l'IP LAN du serveur) :
```bash
mkdir -p /opt/admin-panel/data
npm run gen-cert
```

> Si l'IP du serveur change un jour, relancez `npm run gen-cert`, refaites
> l'étape 6 (droits sur `certs/`), puis `systemctl restart admin-panel`.

---

## 6. Droits des fichiers (verrouillage)

Le compte `panel` ne doit **lire** que ce qu'il faut, et **écrire** que les
données (comptes + journal). Le code, lui, lui est en lecture seule.

```bash
cd /opt

# Code : appartient à root, groupe panel ; le service lit/traverse mais ne peut
# PAS modifier son propre code. Les autres comptes : aucun accès.
chown -R root:panel /opt/admin-panel
chmod -R u=rwX,g=rX,o= /opt/admin-panel

# Données inscriptibles par le service (data/users.json, audit.log + archives) :
chown -R panel:panel /opt/admin-panel/data
chmod 750 /opt/admin-panel/data

# Secrets lisibles par le service uniquement (via le groupe panel) :
chmod 640 /opt/admin-panel/.env
chown root:panel /opt/admin-panel/certs/key.pem /opt/admin-panel/certs/cert.pem
chmod 640 /opt/admin-panel/certs/key.pem /opt/admin-panel/certs/cert.pem
```

---

## 7. Service systemd

L'unité fournie est déjà réglée sur `User=panel` / `Group=panel`.

```bash
cp /opt/admin-panel/systemd/admin-panel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now admin-panel
systemctl status admin-panel          # doit être "active (running)"
journalctl -u admin-panel -f          # logs en direct (Ctrl+C pour quitter)
```

Vous devez voir dans les logs : `LISTENING https://0.0.0.0:3000` et la ligne
`Accès LAN : https://<ip-serveur>:3000`.

> Port < 1024 (ex. 443) ? Un compte non-root ne peut pas s'y lier sans capacité.
> Dé-commentez `AmbientCapabilities=CAP_NET_BIND_SERVICE` dans l'unité.

---

## 8. Pare-feu — restreindre au réseau de confiance

Le port 3000 ne doit être joignable que depuis votre LAN (pas exposé à Internet).
Avec `ufw` (adaptez le sous-réseau, ex. `192.168.1.0/24`) :

```bash
apt install -y ufw
ufw allow OpenSSH                                   # NE PAS se verrouiller dehors
ufw allow from 192.168.0.0/16 to any port 3000 proto tcp
ufw enable
ufw status
```

> Ne faites **jamais** une simple redirection de port du 3000 depuis Internet.
> Pour l'accès distant, utilisez le tunnel Cloudflare (étape 11).

---

## 9. Vérifier

**a) Test de bout en bout** (exerce réellement HTTP + WebSocket + fichiers) — à
lancer **en root** (il écrit dans un bac à sable temporaire) :
```bash
cd /opt/admin-panel
npm run verify        # doit afficher : ALL CHECKS PASSED
```

**b) Test du jail bubblewrap en non-root** (la partie dépendante du noyau ;
exécutée sous le compte `panel`, comme le fera le service) :
```bash
sudo -u panel bwrap --unshare-all --ro-bind /usr /usr \
      --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
      --proc /proc --dev /dev --tmpfs /tmp \
      /usr/bin/bash -c 'echo bwrap-ok; ls /home 2>&1'
# Attendu : "bwrap-ok" puis "/home: Aucun fichier..." (= isolation OK).
# Si erreur de namespace -> activez unprivileged_userns_clone (voir §1).
```

**c) Sonde HTTPS** :
```bash
curl -k https://localhost:3000/api/health      # -> {"ok":true}
```

**d) Test de l'élévation** — connecté en admin dans le navigateur, ouvrez un
fichier appartenant à root hors de votre dossier (ex. `/etc/hosts`) et tentez de
l'enregistrer, ou redémarrez un service : le panneau demande le **mot de passe
root**. Saisissez-le → l'action passe. C'est le cœur du mode non-root.

> **Compte unique au départ** : seul l'**admin** (amorcé depuis `.env`) existe.
> Créez les éditeurs / lecteurs depuis l'onglet **Utilisateurs**.

---

## 10. (Optionnel) Quotas CPU/RAM des éditeurs

En non-root, les quotas cgroups des éditeurs ne s'appliquent que si le compte
`panel` dispose d'une session systemd `--user`. Le journal affiche un
avertissement `[terminal] Quotas CPU/RAM des éditeurs NON appliqués…` sinon.
Pour les activer :

```bash
loginctl enable-linger panel        # démarre user@<uid>.service au boot
```
Puis dans l'unité, dé-commentez :
```ini
Environment=XDG_RUNTIME_DIR=/run/user/%U
```
et `systemctl daemon-reload && systemctl restart admin-panel`.

> Sans cette étape : l'isolation **fichiers** (bubblewrap) des éditeurs reste
> active, seuls les plafonds CPU/RAM ne sont pas imposés.

---

## 11. Plus tard — exposer via Cloudflare Tunnel

Quand vous voudrez un accès distant chiffré sans ouvrir de port : suivez
[`cloudflare/README.md`](cloudflare/README.md). Aucun changement de code ; vous
pourrez même refermer le LAN en repassant `HOST=127.0.0.1`.

---

## Exploitation courante

```bash
systemctl restart admin-panel      # redémarrer (purge les sessions)
systemctl stop admin-panel         # arrêter
journalctl -u admin-panel -e       # consulter les logs
```

Mettre à jour vers une nouvelle version :
```bash
systemctl stop admin-panel
# remplacer les fichiers de /opt/admin-panel SAUF .env, certs/, data/
cd /opt/admin-panel && npm ci
# re-appliquer les droits du code (étape 6, 1er bloc) après remplacement :
chown -R root:panel /opt/admin-panel && chmod -R u=rwX,g=rX,o= /opt/admin-panel
chown -R panel:panel /opt/admin-panel/data
systemctl start admin-panel
```

## Notes propres au mode non-root

- Le terminal admin et le gestionnaire de fichiers tournent **sous `panel`**, pas
  root. Une lecture protégée ou une écriture hors des dossiers accessibles
  déclenche une **demande d'élévation** (mot de passe root, TTL 15 min).
- L'élévation utilise `su` : **n'activez pas** `NoNewPrivileges=yes` dans l'unité,
  cela la casserait (c'est commenté/expliqué dans le fichier `.service`).
- Quotas éditeurs : voir §10 (linger). Sinon isolation fichiers seule.
- Sécurité : compte non privilégié **+** TLS **+** mot de passe fort **+** pare-feu.
  Sauvegardez `.env`, `certs/` et `data/users.json` (hors archive).
