# Data pipeline

Appka je pořád čistý statický web (HTML/CSS/vanilla JS), žádný framework,
žádná databáze. Soubory v téhle složce jsou ale výjimka z pravidla
"appka si všechno tahá živě z API v prohlížeči" — generuje je automat
(GitHub Actions) na pozadí, ne appka sama při načtení stránky.

Důvod je jeden ze dvou:
1. **Potřeba API klíč** (ŘSD/NDIC) — klíč nejde dát do klientského JS appky,
   protože by byl veřejně vidět úplně každému (appka nemá žádný server, kde
   by se dal schovat). Skript ho drží jako tajný GitHub Actions secret.
2. **Zdroj nemá CORS hlavičky** (ČHMÚ, PID GTFS) — prohlížeč by fetch z
   `github.io` sám zablokoval, ať by appka dělala cokoli. Žádný klíč tu
   není potřeba, jen musí to volání proběhnout mimo prohlížeč.

V obou případech: malý skript běží na časovač mimo appku, výsledek
zjednoduší a uloží sem jako obyčejný JSON. Appka pak ten soubor čte úplně
stejně snadno jako Open-Meteo.

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

## Výstrahy ČHMÚ (`alerts.json`)

- **Zdroj:** opendata.chmi.cz, CAP/XML formát (celostátní bulletin, ~2 MB)
- **Aktualizace:** `.github/workflows/update-alerts.yml`, každých 10 minut
- **Filtrování:** appka je pro obec Zlonice, která spadá pod **ORP Slaný**
  (kód CISORP `2124`) — ne ORP Kladno, i když je Zlonice v okrese Kladno.
  Tohle je ověřený detail (ČSÚ + přímo v CAP datech), ne odhad — záměna by
  appce dávala výstrahy pro jinou oblast.
- **Bezpečnostní pravidla, která se neobcházejí** (viz komentáře přímo ve
  `scripts/update-alerts.mjs`):
  - Když cokoli selže (síť, formát dat), skript napíše explicitní
    `status: "error"`, nikdy tiše "beze zvláštních výstrah".
  - Appka sama kontroluje stáří pole `updated` — když se pipeline zasekne
    (stalo se nám to u GitHub Pages, může se to stát i tady), appka
    přestane věřit starým datům a ukáže "nelze ověřit", ne poslední
    známý stav.

## Autobusy (`departures.json`)

- **Zdroj:** PID (Pražská integrovaná doprava) GTFS statická data,
  `data.pid.cz/PID_GTFS.zip` (~46 MB, CC-BY licence, PID ho sám generuje
  jednou denně kolem 4:00)
- **Aktualizace:** `.github/workflows/update-departures.yml`, jednou denně
  (jde jen o jízdní řád, ne živou polohu — častější běh by nic nezměnil)
- **Filtrování:** appka je pro Zlonice, takže se z celého PID systému
  (metro, tramvaje, stovky linek) vybírají jen linky **590, 591, 594**
  a zastávky se jménem začínajícím "Zlonice" — jinak by výsledný soubor
  musel obsahovat kus celého Česka.
- **Co appka počítá sama, ne pipeline:** "další odjezdy za X minut" se
  počítá v prohlížeči z aktuálního data/dne v týdnu a kalendáře platnosti
  spojů (`calendar.txt` + výjimky z `calendar_dates.txt`), ne z
  předpočítaného seznamu — jinak by po pár hodinách appka ukazovala
  odjezdy, co už dávno ujely.
- **Co appka NEukazuje:** zpoždění, výluky, live polohu autobusu — to by
  vyžadovalo Golemio real-time API s API klíčem a mnohem častější refresh
  (minuty, ne jednou denně). Je to jasně popsané jako "jízdní řád", ne
  živá data.
