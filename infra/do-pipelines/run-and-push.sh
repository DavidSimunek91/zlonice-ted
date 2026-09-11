#!/usr/bin/env bash
# Obecný "wrapper" pro jeden datový pipeline skript, spouštěný ze skutečného
# Linuxového cronu na vlastním serveru (droplet) — místo GitHub Actions
# `schedule:` triggeru, který má u tohohle repa dlouhodobě zdokumentované
# zpoždění v řádu hodin (viz commit, co tenhle adresář přidal). Skutečný
# cron na skutečném stroji tenhle problém nemá — spustí se přesně, kdy má.
#
# Použití (viz crontab.example):
#   run-and-push.sh <cesta-ke-skriptu> <cesta-k-datovemu-souboru> "<commit zpráva>"
#
# Např.:
#   run-and-push.sh scripts/update-water.mjs data/water.json "Update water data"
#
# Co dělá, v pořádí:
#   1. Zamkne se (flock) — víc pipeline sdílí jeden git klon, takže dva
#      souběžné běhy (např. voda i výstrahy ve stejnou minutu) by si jinak
#      šláply na git checkout/commit. Čeká max 60s na uvolnění zámku.
#   2. Natvrdo srovná pracovní kopii na aktuální origin/main (git fetch +
#      reset --hard) — tenhle klon je čistě pro automatizaci, nikdy se v
#      něm ručně needituje, takže "zahodit lokální stav" je tady bezpečné
#      a žádoucí (žádné riziko ztráty rozdělané práce).
#   3. Spustí daný node skript — sám si zapíše výsledek (ok/error) do
#      datového souboru, viz komentáře v jednotlivých scripts/update-*.mjs.
#   4. Když se výstupní soubor změnil, commitne a pushne — se stejnou
#      rebase+retry logikou jako .github/workflows/*.yml, pro případ, že
#      by GitHub Actions bot pushnul něco jiného mezitím.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SCRIPT="$1"
DATA_FILE="$2"
MSG="$3"

LOG_TAG="[$(basename "$SCRIPT" .mjs)]"
log() { echo "$(date -u +%FT%TZ) $LOG_TAG $*"; }

LOCK_FILE="/tmp/zlonice-ted-git.lock"
exec 200>"$LOCK_FILE"
if ! flock -w 60 200; then
  log "nezískal jsem git zámek do 60s, přeskakuji tenhle běh"
  exit 1
fi

if ! git fetch origin main -q; then
  log "git fetch selhal, přeskakuji tenhle běh"
  exit 1
fi
git checkout -q main
git reset -q --hard origin/main

if ! node "$SCRIPT"; then
  log "skript skončil s chybou (viz jeho vlastní status:\"error\" výstup, pokud existuje)"
fi

git add "$DATA_FILE"
if git diff --staged --quiet; then
  log "beze změny, nic k odeslání"
  exit 0
fi
git commit -q -m "$MSG [skip ci]"

for attempt in 1 2 3 4 5; do
  if git push -q; then
    log "pushnuto"
    exit 0
  fi
  log "push odmítnut (pokus $attempt/5), rebasuju na aktuální main"
  git fetch origin main -q
  git rebase origin/main -q || { log "rebase selhal, vzdávám se"; exit 1; }
  sleep $((attempt * 2))
done

log "push se nepovedl ani po 5 pokusech"
exit 1
