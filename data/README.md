# Data pipeline

Appka je pořád čistý statický web (HTML/CSS/vanilla JS), žádný framework,
žádná databáze. Soubory v téhle složce jsou ale výjimka z pravidla
"appka si všechno tahá živě z API v prohlížeči" — generuje je automat
(GitHub Actions) na pozadí, ne appka sama při načtení stránky.

Důvod: některá data (např. ŘSD/NDIC) vyžadují API klíč. Klíč nejde dát do
klientského JS appky, protože by byl veřejně vidět úplně každému (appka
nemá žádný server, kde by se dal schovat). Řešení: malý skript běží na
časovač mimo appku, drží klíč jako tajný GitHub Actions secret, zavolá
API, výsledek zjednoduší a uloží sem jako obyčejný JSON bez klíče. Appka
pak ten soubor čte úplně stejně snadno jako Open-Meteo.

## Doprava (`traffic.json`)

- **Zdroj:** ŘSD/NDIC, portál mobilitydata.rsd.cz (formát DATEX II)
- **Aktualizace:** `.github/workflows/update-traffic.yml`, každých 15 minut
- **Vyžaduje:** registraci na mobilitydata.rsd.cz + repo secret `RSD_API_KEY`
  (Settings → Secrets and variables → Actions → New repository secret)
- **Dokud secret není nastavený:** workflow nic nemění, soubor zůstává ve
  stavu `pending_access` a appka v sekci "Dopravní nehody v okolí" ukazuje
  "připravujeme" — ne vymyšlená čísla.

Až přijde přístup od ŘSD, zbývá doplnit skutečné volání API do
`scripts/update-traffic.mjs` (přesné místo je tam označené `TODO`) a
appku napojit na čtení `data/traffic.json` místo textu "připravujeme".
