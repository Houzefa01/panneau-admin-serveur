# Tunnel Cloudflare — préparation (pour plus tard)

> **État : non activé.** Le panneau tourne aujourd'hui en LAN + HTTPS. Ce dossier
> regroupe ce qu'il faudra le jour où vous voudrez l'exposer sur Internet via un
> tunnel Cloudflare, **sans ouvrir de port** sur votre box/pare-feu.
>
> **Aucun changement de code n'est nécessaire** : l'application est déjà prête
> (`trust proxy: loopback`, origine HTTPS sur la boucle locale).

## Pourquoi un tunnel

- Pas de port ouvert / pas de redirection NAT : `cloudflared` établit une
  connexion **sortante** vers Cloudflare.
- TLS public géré par Cloudflare (certificat valide, pas d'avertissement).
- **Cloudflare Access** ajoute une 1re barrière d'authentification (email/OTP/clé)
  *avant même* d'atteindre l'application.

## Procédure (le jour venu)

```bash
# 1. Installer cloudflared (Debian)
curl -L https://pkg.cloudflare.com/cloudflared.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# 2. S'authentifier et créer le tunnel
cloudflared tunnel login
cloudflared tunnel create admin-panel        # note l'ID + le fichier de creds

# 3. Router un hostname vers le tunnel
cloudflared tunnel route dns admin-panel admin.example.com

# 4. Config : copier l'exemple et remplacer l'ID / le hostname
sudo cp cloudflare/config.example.yml /etc/cloudflared/config.yml
sudo $EDITOR /etc/cloudflared/config.yml      # <ID-DE-VOTRE-TUNNEL>, hostname

# 5. Lancer en service
sudo cloudflared service install
sudo systemctl restart cloudflared
sudo systemctl status cloudflared
```

## Sécurité — à NE PAS oublier

1. **Activer une politique Cloudflare Access stricte** sur `admin.example.com`
   (limiter aux emails autorisés). C'est la barrière principale.
2. Le panneau garde sa propre authentification (bcrypt, rôles, rate limiting) :
   défense en profondeur.
3. Le code ne fait confiance aux en-têtes `X-Forwarded-*` que depuis la boucle
   locale, donc l'IP réelle (rate limiting) et le schéma `https` viennent bien du
   tunnel — pas d'usurpation possible depuis le LAN.
4. Vous pouvez alors **refermer l'accès LAN direct** si vous le souhaitez en
   repassant `HOST=127.0.0.1` (le tunnel se connecte en loopback) — ou garder
   les deux. Voir [`../SECURITY.md`](../SECURITY.md).

## Coexistence LAN + tunnel

- `HOST=0.0.0.0` : accessible à la fois sur le LAN (`https://<ip>:3000`) **et**
  via le tunnel (qui se connecte sur `127.0.0.1:3000`).
- `HOST=127.0.0.1` : accessible **uniquement** via le tunnel (le plus étanche).

Le reste de la configuration TLS (`certs/`, `TLS_KEY`, `TLS_CERT`) ne change pas.
