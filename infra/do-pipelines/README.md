# Datové pipeline na vlastním droplu (DigitalOcean)

## Proč tohle vůbec existuje

GitHub Actions `schedule:` trigger má u tohohle repa dlouhodobě zdokumentované
zpoždění v řádu **hodin**, ne minut — ověřeno napříč týdny historie běhů
(`update-departures.yml`, cron `0 6 * * *`, reálně startuje konzistentně
kolem 10:00–10:10 UTC, ne v 6:00). Není to bug v našem YAML ani v `.mjs`
skriptech (ty vždy doběhnou v pořádku, ČHMÚ i ŘSD samy o sobě odpovídají za
1–2 vteřiny) — je to limit GitHubova vlastního plánovače, který nejde
opravit úpravou cronu. GitHub sám dokumentuje jen "může se zpozdit", bez
horní meze.

Řešení: spouštět tytéž `.mjs` skripty, co dnes běží v GitHub Actions, ze
**skutečného Linuxového cronu** na droplu, který už máš (běží na něm
`ebru-rsvp`). Skutečný cron na vlastním stroji tenhle problém nemá.

Bonus: droplet má vlastní, stálou veřejnou IP adresu — pokud ji ŘSD
neblokuje (viz krok 1), řeší se tím **i** nespolehlivost dopravní pipeline
(ŘSD blokuje datacenter IP rozsahy GitHub Actions a měl problémy i s
Cloudflare Workers sdíleným IP fondem — ~25 % úspěšnost). Vlastní droplet
skript pak volá ŘSD přímo, bez jakéhokoli relaye.

GitHub Actions workflow soubory (`.github/workflows/update-*.yml`)
zůstávají beze změny — dál běží jako záloha/pro ruční spuštění
(`workflow_dispatch`), jen přestanou být jediným zdrojem pravdy. Nic se
nemaže, nic se nevypíná.

`update-tradespeople.yml` (týdenní pipeline) se tímhle vůbec nezabývá —
u týdenní aktualizace 4hodinové zpoždění nikomu nevadí, necháváme ji čistě
na GitHub Actions.

---

## Co je potřeba udělat ručně (na droplu / v GitHubu)

### Krok 1 — Otestovat, jestli ŘSD blokuje i IP tohohle droplu

Nejlevnější test hned na začátku — určí, jestli budeme vůbec potřebovat
Cloudflare Worker jako zálohu pro dopravu.

```bash
ssh <uzivatel>@<IP-droplu>

curl -sS -i -u '<RSD_USERNAME>:<RSD_PASSWORD>' \
  --max-time 20 \
  'https://mobilitydata.rsd.cz/Resources/Dynamic/CommonTIDatex_v2/'
```

- **Dostaneš zpátky XML/DATEX II data (HTTP 200)** → droplet není
  blokovaný, super, nic dalšího k dopravě řešit nemusíš, jen v `env`
  souboru (krok 4) nech `RSD_PROXY_URL`/`PROXY_KEY` zakomentované.
- **Timeout / connection refused** → droplet je blokovaný stejně jako
  GitHub Actions. V `env` souboru pak odkomentuj `RSD_PROXY_URL`/
  `PROXY_KEY` a nech dopravu jet přes existující Cloudflare Worker (funguje
  dál, jen s tou nižší ~25% úspěšností — ale aspoň se o to droplet bude
  pokoušet co 15 minut místo jednou za několik hodin).

### Krok 2 — Deploy key pro push do GitHubu

Droplet potřebuje vlastní přístup k pushnutí do `zlonice-ted` — samostatný
klíč jen pro tenhle repo (ne tvůj osobní SSH klíč).

Na droplu:

```bash
ssh-keygen -t ed25519 -C "zlonice-ted-droplet" -f ~/.ssh/zlonice-ted-deploy -N ""
cat ~/.ssh/zlonice-ted-deploy.pub
```

Zkopíruj vypsaný veřejný klíč (celý řádek začínající `ssh-ed25519`).

V GitHubu: **davidsimunek91/zlonice-ted → Settings → Deploy keys → Add
deploy key**
- Title: `do-droplet`
- Key: vlož zkopírovaný veřejný klíč
- ☑ **Allow write access** (bez tohohle by droplet mohl jen číst, ne
  pushovat)
- Add key

Zpátky na droplu, ať git ví, který klíč použít pro GitHub:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com-zlonice-ted
  HostName github.com
  User git
  IdentityFile ~/.ssh/zlonice-ted-deploy
  IdentitiesOnly yes
EOF
```

### Krok 3 — Naklonovat repo do vlastního adresáře

Záměrně **oddělený klon**, ne ten samý adresář jako `ebru-rsvp` — žádné
sdílení, žádné riziko zásahu do druhého projektu.

```bash
git clone git@github.com-zlonice-ted:davidsimunek91/zlonice-ted.git ~/zlonice-ted
cd ~/zlonice-ted
git config user.name "do-droplet-bot"
git config user.email "actions@github.com"
```

### Krok 4 — Soubor s tajnými hodnotami

```bash
cp infra/do-pipelines/env.example ~/zlonice-ted.env
nano ~/zlonice-ted.env   # vyplň RSD_USERNAME/RSD_PASSWORD, případně GOLEMIO_API_KEY
chmod 600 ~/zlonice-ted.env
```

**Tenhle soubor zůstává mimo git** (je v `~/`, ne v repu) — obsahuje
skutečné přihlašovací údaje, nikdy ho necommituj.

### Krok 5 — Nainstalovat crontab

```bash
cd ~/zlonice-ted
sed -e "s|<CESTA_K_ENV_SOUBORU>|$HOME/zlonice-ted.env|g" \
    -e "s|<CESTA_K_REPU>|$HOME/zlonice-ted|g" \
    infra/do-pipelines/crontab.example > /tmp/zlonice-ted-crontab

crontab -l 2>/dev/null > /tmp/existing-crontab || true
cat /tmp/existing-crontab /tmp/zlonice-ted-crontab | crontab -
crontab -l   # zkontroluj, že je tam všech 5 řádků A cokoliv, co tam bylo předtím (ebru-rsvp apod.)
```

### Krok 6 — Ověřit, že to běží

Počkej ~15–20 minut, pak:

```bash
tail -30 ~/zlonice-ted-cron.log
```

Měl bys vidět řádky jako `[update-water] pushnuto` bez chyb. Pak zkontroluj
přímo na `vezlonicich.cz` (tvrdý refresh, Ctrl+Shift+R), jestli dlaždice
Voda/Výstrahy/Doprava ukazují čerstvý čas, ne "nelze ověřit".

### (Jen pokud krok 1 ukázal, že ŘSD droplet blokuje)

Pak dává smysl znovu zvážit `infra/rsd-relay/` (Caddy + `relay-server.mjs`)
přímo na tomhle droplu — postup je stejný jako v `infra/rsd-relay/README.md`,
jen přeskoč kroky 1–4 (ty jsou pro Oracle Cloud, tenhle droplet už existuje
a má stálou IP) a rovnou pokračuj od kroku 5 (DNS). Než instalovat Caddy
znovu, zkontroluj `sudo systemctl status caddy` — pokud už běží kvůli
`ebru-rsvp`, stačí do existujícího `Caddyfile` přidat blok pro
`rsd-relay.vezlonicich.cz` (viz `infra/rsd-relay/Caddyfile`), ne instalovat
druhou instanci.
