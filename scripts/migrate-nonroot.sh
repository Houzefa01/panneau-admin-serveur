#!/usr/bin/env bash
#
# Migration du panneau d'administration : service root -> compte NON-ROOT « panel ».
# Convertit une installation existante en place : crée le compte de service,
# déplace le journal, ajuste les droits, installe l'unité systemd et redémarre.
#
# IDEMPOTENT : peut être relancé sans danger.
# À EXÉCUTER EN ROOT sur le serveur :
#
#     sudo bash scripts/migrate-nonroot.sh
#
# Variables d'environnement (optionnelles) :
#     APP=/opt/admin-panel   chemin d'installation
#     SVC_USER=panel         compte de service à créer / utiliser
#     UNIT=admin-panel       nom de l'unité systemd
#
# Pour revenir en root : voir le bloc « ROLLBACK » affiché à la fin.

set -euo pipefail

APP="${APP:-/opt/admin-panel}"
SVC_USER="${SVC_USER:-panel}"
UNIT="${UNIT:-admin-panel}"

g(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
y(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
r(){ printf '  \033[31m✗\033[0m %s\n' "$*"; }
step(){ printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die(){ r "$*"; exit 1; }

# Lit une variable du .env (dernière occurrence), retire d'éventuels guillemets.
get_env(){ sed -n "s/^$1=//p" "$APP/.env" 2>/dev/null | tail -1 | tr -d '"'\'''; }
# Résout un chemin (absolu tel quel, relatif par rapport à APP).
resolve(){ case "$1" in /*) printf '%s' "$1";; *) printf '%s/%s' "$APP" "${1#./}";; esac; }

# --- Pré-vérifications ---------------------------------------------------------
[ "$(id -u)" -eq 0 ]                     || die "À lancer en root (sudo bash scripts/migrate-nonroot.sh)."
command -v systemctl >/dev/null          || die "systemctl introuvable (système non-systemd ?)."
[ -d "$APP" ]                            || die "Dossier introuvable : $APP  (définir APP=/chemin)."
[ -f "$APP/.env" ]                       || die "$APP/.env manquant — l'appli n'est pas encore configurée."
[ -f "$APP/systemd/$UNIT.service" ]      || die "Unité source absente : $APP/systemd/$UNIT.service"
grep -q '^User=panel' "$APP/systemd/$UNIT.service" \
  || y "L'unité source ne contient pas 'User=panel' — vérifiez qu'elle est bien à jour."

printf '\033[1mMigration -> non-root\033[0m  APP=%s  compte=%s  unité=%s\n' "$APP" "$SVC_USER" "$UNIT"

# --- 1. Arrêt du service -------------------------------------------------------
step "1/7  Arrêt du service"
if systemctl stop "$UNIT" 2>/dev/null; then g "service arrêté"; else y "service non démarré (ok)"; fi

# --- 2. Compte de service ------------------------------------------------------
step "2/7  Compte de service « $SVC_USER »"
if id "$SVC_USER" &>/dev/null; then
  g "$SVC_USER existe déjà"
else
  useradd --system --create-home --home-dir "/home/$SVC_USER" --shell /usr/sbin/nologin "$SVC_USER"
  g "$SVC_USER créé (système, sans login)"
fi

# --- 3. Journal -> data/ (historique conservé) ---------------------------------
step "3/7  Journal déplacé vers $APP/data/"
mkdir -p "$APP/data"
if [ -f "$APP/audit.log" ]; then mv -f "$APP/audit.log" "$APP/data/audit.log"; g "audit.log déplacé"; else y "pas d'audit.log à la racine (ok)"; fi
moved=0
for n in $(seq 1 20); do
  if [ -f "$APP/audit.log.$n" ]; then mv -f "$APP/audit.log.$n" "$APP/data/audit.log.$n"; moved=$((moved+1)); fi
done
[ "$moved" -gt 0 ] && g "$moved archive(s) de journal déplacée(s)" || true

# --- 4. AUDIT_LOG dans .env ----------------------------------------------------
step "4/7  AUDIT_LOG dans .env"
if grep -q '^AUDIT_LOG=' "$APP/.env"; then
  sed -i "s#^AUDIT_LOG=.*#AUDIT_LOG=$APP/data/audit.log#" "$APP/.env"
else
  printf 'AUDIT_LOG=%s/data/audit.log\n' "$APP" >> "$APP/.env"
fi
g "AUDIT_LOG=$APP/data/audit.log"

# --- 5. Droits des fichiers ----------------------------------------------------
step "5/7  Droits des fichiers"
chown -R root:"$SVC_USER" "$APP"
chmod -R u=rwX,g=rX,o= "$APP"              # code lisible/traversable par panel, non modifiable
g "code -> root:$SVC_USER, lecture seule pour le service"
chown -R "$SVC_USER":"$SVC_USER" "$APP/data"
chmod 750 "$APP/data"
g "data/ -> inscriptible par $SVC_USER (users.json + journal)"
chmod 640 "$APP/.env"
g ".env -> 640 (lisible par $SVC_USER, pas par les autres)"
# Clé/cert TLS : chemins lus dans .env, résolus par rapport à APP.
for v in TLS_KEY TLS_CERT; do
  p="$(get_env "$v")"; [ -n "$p" ] || continue
  f="$(resolve "$p")"
  if [ -f "$f" ]; then chown root:"$SVC_USER" "$f"; chmod 640 "$f"; g "$v ($f) -> 640"; else y "$v introuvable : $f"; fi
done

# --- 6. Unité systemd ----------------------------------------------------------
step "6/7  Unité systemd (User=$SVC_USER)"
cp "$APP/systemd/$UNIT.service" "/etc/systemd/system/$UNIT.service"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null 2>&1 || true
systemctl start "$UNIT"
g "unité installée + service démarré"

# --- 7. Vérification -----------------------------------------------------------
step "7/7  Vérification"
sleep 2
mainpid="$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
if [ "${mainpid:-0}" -gt 0 ]; then
  runas="$(ps -o user= -p "$mainpid" 2>/dev/null | tr -d ' ')"
  [ "$runas" = "$SVC_USER" ] && g "process node (pid $mainpid) sous « $runas »" \
                              || y "process node sous « $runas » (attendu « $SVC_USER »)"
else
  y "MainPID indisponible — service peut-être en échec"
fi
PORT="$(get_env PORT)"; PORT="${PORT:-3000}"
health=0
for _ in $(seq 1 12); do
  code="$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:$PORT/api/health" 2>/dev/null || true)"
  [ "$code" = "200" ] && { g "sonde HTTPS : 200 (https://localhost:$PORT/api/health)"; health=1; break; }
  sleep 1
done
[ "$health" = 1 ] || y "sonde HTTPS non confirmée — voir : journalctl -u $UNIT -e"
systemctl is-active --quiet "$UNIT" && g "service actif" || r "service INACTIF — journalctl -u $UNIT -e"

# --- Récapitulatif -------------------------------------------------------------
cat <<EOF

$(printf '\033[1m=== Migration terminée ===\033[0m')

Le service tourne désormais sous « $SVC_USER » (non-root). Dans le navigateur,
une action root (écriture système, systemctl, reboot) demandera le mot de passe
root : c'est l'élévation ponctuelle (TTL 15 min, jamais journalisée).

À VÉRIFIER ENSUITE :
  • Dossiers des éditeurs : doivent être lisibles+traversables par « $SVC_USER »,
    sinon leur terminal isolé ne démarrera pas. Corriger si besoin :
        chmod o+rx /chemin/dossier_editeur   # (+ ses parents)
    ou   chown -R $SVC_USER:$SVC_USER /srv/editeurs/<nom>
  • Si un terminal éditeur échoue (erreur de « namespace ») — activer les
    user namespaces non privilégiés :
        echo 'kernel.unprivileged_userns_clone=1' >/etc/sysctl.d/00-userns.conf && sysctl --system
  • Quotas CPU/RAM des éditeurs (optionnel) :
        loginctl enable-linger $SVC_USER
    puis dé-commenter « Environment=XDG_RUNTIME_DIR=/run/user/%U » dans l'unité,
    « systemctl daemon-reload && systemctl restart $UNIT ».

ROLLBACK (revenir en root) :
    systemctl stop $UNIT
    sed -i 's/^User=$SVC_USER/User=root/; /^Group=$SVC_USER/d' /etc/systemd/system/$UNIT.service
    chown -R root:root $APP
    systemctl daemon-reload && systemctl start $UNIT
EOF
