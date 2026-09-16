# Počítadlo návštěv vezlonicich.cz

Malý "maják" běžící natrvalo na DigitalOcean droplu (stejný, co už máš z
`infra/do-pipelines/`). Appka na něj z prohlížeče při každém načtení
stránky pošle tichý požadavek (jen IP adresa + čas, žádné cookies) —
server si to zapíše do souboru a `scripts/aggregate-visits.mjs`, spouštěný
z cronu, z toho pravidelně spočítá přehled na `/stats.html` a zároveň ze
zdrojového logu zahodí všechno starší než 7 dní.

Proč vlastní řešení, ne GitHub Pages statistiky: GitHub Pages žádné
přístupové logy majiteli repa neposkytuje.

## 1. DNS — nasměrovat subdoménu na droplet

Na Active24 (stejné místo, kde je nastavený GitHub Pages CNAME), přidej
**A záznam**:

```
beacon.vezlonicich.cz  →  165.22.188.88
```

## 2. Na droplu — stáhnout novou verzi repa

```bash
cd ~/zlonice-ted && git pull
```

## 3. Zkontrolovat, jestli na droplu už běží Caddy

```bash
sudo systemctl status caddy
```

**Pokud Caddy už běží** (např. kvůli jinému projektu na droplu): jen
přidej nový blok do existujícího `/etc/caddy/Caddyfile`:

```
beacon.vezlonicich.cz {
  reverse_proxy 127.0.0.1:8788
}
```

a restartuj: `sudo systemctl restart caddy`

**Pokud Caddy neběží / není nainstalovaný:**

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy

sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
beacon.vezlonicich.cz {
  reverse_proxy 127.0.0.1:8788
}
EOF

sudo systemctl restart caddy
```

## 4. Nainstalovat a spustit beacon server (systemd)

Zkontroluj nejdřív skutečnou cestu k `node`:

```bash
which node
```

Pokud je jiná než `/root/.nvm/versions/node/v22.23.2/bin/node`, uprav
`ExecStart` v souboru níž, než ho zkopíruješ.

```bash
sudo cp ~/zlonice-ted/infra/visit-log/vezlonicich-beacon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vezlonicich-beacon
sudo systemctl status vezlonicich-beacon   # měl by být "active (running)"
```

## 5. Otestovat

```bash
curl -i https://beacon.vezlonicich.cz/hit
```

Očekává se `HTTP/2 204` (bez těla) — znamená to, že Caddy i beacon server
fungují a zapsaly si test do logu. Ověř:

```bash
cat ~/vezlonicich-visits.ndjson
```

## 6. Přidat do crontabu shrnutí návštěv

```bash
grep -E "^\*/15.*aggregate-visits" ~/zlonice-ted/infra/do-pipelines/crontab.example | \
  sed -e "s|<CESTA_K_ENV_SOUBORU>|$HOME/zlonice-ted.env|g" \
      -e "s|<CESTA_K_REPU>|$HOME/zlonice-ted|g" > /tmp/visits-cron-line

crontab -l > /tmp/existing-crontab
cat /tmp/existing-crontab /tmp/visits-cron-line | crontab -
crontab -l
```

Počkej ~15 minut, pak zkontroluj `data/stats.json` v repu (nebo rovnou
`vezlonicich.cz/stats.html`) — měl by tam být čerstvý přehled.
